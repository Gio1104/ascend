import React, { useState, useEffect, useRef, useCallback, useMemo } from "react";
const AI_ENDPOINT = (typeof window !== "undefined" && window.__ASCEND_AI_ENDPOINT__) || "https://api.anthropic.com/v1/messages";

// ============================================================
// ASCEND — sistema de self-improvement "à prova de mim"
// Score = check-in (EWMA) + metas (fluxo c/ decaimento por horizonte)
// Árbitro: auditoria semanal/mensal via Coach IA
//
// ESTRUTURA DO ARQUIVO (cortes naturais p/ virar módulos num repo Vite):
//   [CONFIG]      → config.js  (todos os números/cores ajustáveis)
//   [LÓGICA]      → logic/     (datas, score, streak, migração — funções puras)
//   [DADOS]       → data/      (buildDefault, banco de perguntas)
//   [COMPONENTES] → components/ (Dashboard, CheckIn, Goals, Conquistas, Coach…)
//   [APP]         → App.jsx
// Ao publicar: mover cada seção para seu arquivo. A config já está isolada.
// ============================================================

// ---------------- [CONFIG] — edite aqui, não no meio do código ----------------
const VERSION = "1.2.0";
const SCHEMA_VERSION = 2;

const CONFIG = {
  colors: { accent: "#3ddc97", gold: "#cba14d", warn: "#e07a9b", info: "#7aa2ff" },
  // média móvel do check-in (dias de meia-vida): menor = reage mais rápido
  checkinHalfLifeDays: 10,
  // horizontes de meta: peso no fluxo e meia-vida do "frescor" (dias)
  horizons: {
    curto: { label: "Curto prazo", mult: 1, hl: 14, color: "#3ddc97" },
    medio: { label: "Médio prazo", mult: 2, hl: 42, color: "#cba14d" },
    longo: { label: "Longo prazo", mult: 3, hl: 84, color: "#7aa2ff" },
  },
  // mix por tipo de categoria (peso do check-in vs. peso das metas)
  typeMix: {
    habito: { ci: 0.75, goal: 0.25, label: "Hábito" },
    conquista: { ci: 0.4, goal: 0.6, label: "Conquista" },
    equilibrio: { ci: 0.55, goal: 0.45, label: "Equilíbrio" },
  },
  // regras de streak/escudos
  streak: { startShields: 1, maxShields: 2, grantEvery: 7 },
  streakMilestones: [
    { n: 3, label: "Aquecendo" }, { n: 7, label: "Uma semana!" }, { n: 14, label: "Duas semanas" },
    { n: 21, label: "Hábito formado" }, { n: 30, label: "Um mês!" }, { n: 50, label: "Imparável" },
    { n: 100, label: "Centurião" }, { n: 200, label: "Lendário" }, { n: 365, label: "Um ano inteiro" },
  ],
};

// Constantes derivadas (não edite — mude no CONFIG acima)
const ACCENT = CONFIG.colors.accent;
const GOLD = CONFIG.colors.gold;
const WARN = CONFIG.colors.warn;
const HORIZON = CONFIG.horizons;
const TYPE_MIX = CONFIG.typeMix;

// ---------------- [LÓGICA] — date helpers ----------------
function todayKey(d = new Date()) { return d.toISOString().slice(0, 10); }
function addDays(key, n) { const d = new Date(key + "T00:00:00"); d.setDate(d.getDate() + n); return todayKey(d); }
function dayDiff(a, b) { return Math.round((new Date(b + "T00:00:00") - new Date(a + "T00:00:00")) / 86400000); }
function weekKeyOf(key) { const d = new Date(key + "T00:00:00"); const off = (d.getDay() + 6) % 7; d.setDate(d.getDate() - off); return todayKey(d); }

function buildDefault() {
  const T = todayKey();
  const ago = (n) => addDays(T, -n);
  return {
    createdAt: T,
    lastWeeklyCheck: T,
    lastMonthlyReview: T,
    lastSemesterReview: T,
    lastYearReview: T,
    schemaVersion: SCHEMA_VERSION,
    virtuesSeeded: true,
    routinesSeeded: true,
    streak: { count: 0, lastDay: null, shields: CONFIG.streak.startShields },
    onboarded: true,
    north: "Gerar impacto no mundo e construir a vida que projetei para os 29 anos.",
    objectives: [
      { id: "obj_pe", cat: "prof", title: "Construir carreira em private equity" },
      { id: "obj_corpo", cat: "saude", title: "Corpo pleno e durável" },
      { id: "obj_mente", cat: "intel", title: "Mente afiada e bem formada" },
    ],
    categories: [
      { id: "saude", name: "Saúde", glyph: "✦", weight: 1, accent: "#3ddc97", type: "habito" },
      { id: "prof", name: "Profissional", glyph: "▲", weight: 1.5, accent: "#cba14d", type: "conquista" },
      { id: "intel", name: "Intelectual", glyph: "◆", weight: 1, accent: "#7aa2ff", type: "conquista", mix: { ci: 0.35, goal: 0.65, label: "Conquista" } },
      { id: "mental", name: "Mental & Foco", glyph: "●", weight: 1.25, accent: "#e07a9b", type: "habito" },
      { id: "social", name: "Social & Liderança", glyph: "✧", weight: 1, accent: "#e8a657", type: "equilibrio" },
    ],
    questions: [
      { id: "q_treino", cat: "saude", text: "Treinou ou se exercitou hoje?", type: "bool" },
      { id: "q_alim", cat: "saude", text: "Como foi sua alimentação?", type: "scale" },
      { id: "q_stack", cat: "saude", text: "Tomou o stacking de suplementos?", type: "bool" },
      { id: "q_meta", cat: "prof", text: "Avançou em alguma meta profissional?", type: "bool" },
      { id: "q_foco", cat: "prof", text: "Quanto de foco profundo no trabalho?", type: "scale" },
      { id: "q_leu", cat: "intel", text: "Leu hoje?", type: "bool" },
      { id: "q_aprend", cat: "intel", text: "Aprendeu algo novo de valor?", type: "scale" },
      { id: "q_sono", cat: "mental", text: "Qualidade do sono na última noite?", type: "scale" },
      { id: "q_cel", cat: "mental", text: "Controlou o uso do celular hoje?", type: "bool" },
      { id: "q_conex", cat: "social", text: "Teve uma conexão de qualidade hoje?", type: "scale" },
      { id: "q_net", cat: "social", text: "Fez networking ou liderou algo?", type: "bool" },
    ],
    goals: [
      { ...mkGoal("g1", "prof", "curto", 8, "Validar o piloto do EBV no 1º mês", "milestone",
        ["Confirmar acesso real a fundadores", "Avaliar comissão efetiva", "Decidir se segue além do 1º mês"], ago(4)), objId: "obj_pe" },
      { ...mkGoal("g2", "prof", "medio", 10, "Fechar estágio em IB/PE (BTG / Advent)", "milestone",
        ["CV em inglês pronto", "Aplicar em 5 processos", "Passar 1ª fase", "Receber oferta"], ago(9)), objId: "obj_pe" },
      { ...mkGoal("g3", "prof", "longo", 10, "Trajetória rumo ao PE via EQT (Londres)", "milestone",
        ["Dominar modelagem LBO", "1º estágio relevante", "Rede internacional ativa", "Passaporte/visto resolvido"], ago(20)), objId: "obj_pe" },
      { ...mkMetric("g4", "intel", "curto", 6, "Terminar 'The Laws of Human Nature'", 7, 18, "capítulos", ago(6)), track: "book", objId: "obj_mente" },
      { ...mkGoal("g5", "saude", "medio", 7, "Recuperar o LTFA e voltar à rotina plena", "milestone",
        ["Concluir tratamento conservador", "Liberação médica", "Retomar treino de impacto"], ago(12)), objId: "obj_corpo" },
      mkTrophy("t1", "prof", "medio", 9, "Selecionado para o Brasil Project (Harvard / MIT)", "2026-04-22", null, "Selecionado para a delegação do Insper na conferência em Harvard e MIT. Construí vínculo com um grupo de dez e fiz contato direto com Jorge Paulo Lemann, Tabata Amaral e Milton Beck."),
      mkTrophy("t2", "social", "medio", 8, "Tornar-se Embaixador Insper", "2026-05-02", null, "Assumi o papel de Embaixador Insper, ampliando presença institucional e rede de contatos, com posts no LinkedIn de bom alcance orgânico."),
      mkTrophy("t3", "prof", "curto", 5, "Avançou à dinâmica final da Ultrapar", "2026-05-15", null, "Aprovado na entrevista e convocado para a dinâmica de grupo presencial do processo seletivo da Ultrapar."),
    ],
    skills: [
      mkSkill("sk_own", "prof", "Ownership", "Assumir responsabilidade total pelos resultados, sem terceirizar culpa, e ir até o fim.",
        ["Assumir um erro antes de ser cobrado", "Levar o problema já com uma proposta de solução", "Cumprir o prometido mesmo sem ninguém cobrando"], 2),
      mkSkill("sk_lead", "social", "Liderança", "Mobilizar pessoas em torno de um objetivo servindo mais do que mandando (rumo à presidência da AgroInsper).",
        ["Dar crédito público a alguém do time", "Tomar uma decisão impopular necessária", "Ouvir de verdade antes de impor a própria visão"], 2),
      mkSkill("sk_crit", "mental", "Receber crítica", "Digerir feedback duro sem defensividade, extraindo o sinal em vez de reagir.",
        ["Agradecer uma crítica sem se justificar na hora", "Pedir feedback proativamente", "Aplicar uma mudança concreta a partir de um feedback recente"], 1),
      ...cardinalVirtues(),
    ],
    routines: seedRoutines(T),
    learn: { track: "rotativo", today: null, streak: { count: 0, lastDay: null }, log: [] },
    ui: { learnCollapsed: false, routinesCollapsed: false },
    checkIns: {},
  };
}

function mkGoal(id, cat, horizon, importance, title, kind, milestoneTexts, lastProgressDate) {
  return {
    id, cat, horizon, importance, title, kind: "milestone",
    milestones: milestoneTexts.map((t, i) => ({ id: id + "_m" + i, text: t, done: false, doneDate: null, provisional: false })),
    lastProgressDate: lastProgressDate || todayKey(),
    createdAt: lastProgressDate || todayKey(),
    completed: false, completedDate: null,
  };
}
function mkMetric(id, cat, horizon, importance, title, current, target, unit, lastProgressDate) {
  return {
    id, cat, horizon, importance, title, kind: "metric",
    metricCurrent: current, metricTarget: target, metricUnit: unit, metricProvisional: false,
    lastProgressDate: lastProgressDate || todayKey(),
    createdAt: lastProgressDate || todayKey(),
    completed: false, completedDate: null,
  };
}
function mkTrophy(id, cat, horizon, importance, title, date, track, note) {
  return {
    id, cat, horizon, importance, title, kind: "milestone", track: track || null, note: note || null,
    milestones: [{ id: id + "_m0", text: "Conquistado", done: true, doneDate: date, provisional: false }],
    lastProgressDate: date, createdAt: date, completed: true, completedDate: date, trophyVerified: true, archived: true,
  };
}
function mkSkill(id, cat, name, why, behaviors, level, kind) {
  return { id, cat, name, why, kind: kind || "skill", level: level || 0, note: "", lastAssessed: null, behaviors: (behaviors || []).map((t, i) => ({ id: id + "_b" + i, text: t })) };
}
const SKILL_LEVELS = ["Não avaliado", "Iniciante", "Em desenvolvimento", "Consistente", "Forte", "Exemplar"];
const LEARN_TRACKS = [
  { id: "rotativo", label: "Rotativo", desc: "Alterna entre todas as trilhas" },
  { id: "pe", label: "Finanças & PE", desc: "Valuation, LBO, mercado, M&A, micro/macro" },
  { id: "lideranca", label: "Liderança & gestão", desc: "Times, decisão, influência, comunicação" },
  { id: "filosofia", label: "Filosofia & virtudes", desc: "Clássicos, ética, EBV, Filosofia do Zero" },
];
const LEARN_LABEL = (id) => (LEARN_TRACKS.find((x) => x.id === id) || {}).label || id;
function cardinalVirtues() {
  return [
    mkSkill("vt_prud", "intel", "Prudência", "Discernir o bem em cada situação e escolher os meios certos para alcançá-lo — a sabedoria prática que orienta as demais virtudes.",
      ["Pensar nas consequências antes de agir no impulso", "Buscar conselho antes de uma decisão importante", "Separar o urgente do que de fato importa"], 0, "virtude"),
    mkSkill("vt_just", "social", "Justiça", "Dar a cada um o que lhe é devido; retidão e verdade nas relações.",
      ["Cumprir os compromissos que assumiu", "Dar crédito honesto a quem merece", "Reparar um erro com quem você prejudicou"], 0, "virtude"),
    mkSkill("vt_fort", "mental", "Fortaleza", "Firmeza para perseverar no bem diante do medo, da dor e da dificuldade.",
      ["Encarar a tarefa difícil que vinha evitando", "Manter a disciplina sem depender de motivação", "Defender o que é certo sob pressão social"], 0, "virtude"),
    mkSkill("vt_temp", "mental", "Temperança", "Moderar os desejos e prazeres, ordenando-os à razão.",
      ["Resistir a um impulso (celular, doce, compra)", "Parar antes do excesso", "Escolher o difícil saudável sobre o fácil prazeroso"], 0, "virtude"),
  ];
}
function seedRoutines(T) {
  const ago = (n) => addDays(T, -n);
  return [
    { id: "rt_cama", name: "Trocar roupa de cama", everyDays: 7, lastDone: ago(8) },
    { id: "rt_faxina", name: "Faxina do quarto", everyDays: 7, lastDone: ago(7) },
    { id: "rt_roupa", name: "Lavar roupa", everyDays: 4, lastDone: ago(2) },
    { id: "rt_toalha", name: "Trocar toalha", everyDays: 5, lastDone: ago(5) },
  ];
}
function routineStatus(r, today) {
  if (!r.lastDone) return { due: true, over: 9999, label: "fazer", color: GOLD };
  const since = dayDiff(r.lastDone, today);
  const remaining = r.everyDays - since;
  if (remaining < 0) return { due: true, over: -remaining, label: `atrasada ${-remaining}d`, color: WARN };
  if (remaining === 0) return { due: true, over: 0, label: "vence hoje", color: GOLD };
  return { due: false, in: remaining, label: `em ${remaining}d`, color: "#7d877f" };
}

// ---------- scoring engine ----------
function checkInEWMA(state, catId, asOf) {
  const qs = state.questions.filter((q) => q.cat === catId);
  if (!qs.length) return null;
  const dates = Object.keys(state.checkIns).filter((d) => d <= asOf).sort();
  if (!dates.length) return null;
  const start = dates[0];
  const halfLife = CONFIG.checkinHalfLifeDays;
  const alpha = 1 - Math.pow(0.5, 1 / halfLife);
  let ewma = null, prevObs = null;
  const total = dayDiff(start, asOf);
  for (let i = 0; i <= total; i++) {
    const d = addDays(start, i);
    const ci = state.checkIns[d];
    let obs;
    if (ci) {
      let tot = 0, cnt = 0;
      qs.forEach((q) => {
        const v = ci[q.id];
        if (v !== undefined && v !== null) {
          tot += q.type === "bool" ? (v ? 100 : 0) : Math.max(0, Math.min(10, v)) * 10;
          cnt++;
        }
      });
      obs = cnt ? tot / cnt : null;
    } else { obs = prevObs === null ? 0 : 0.5 * prevObs; }
    if (obs === null) continue;
    ewma = ewma === null ? obs : alpha * obs + (1 - alpha) * ewma;
    prevObs = obs;
  }
  return ewma;
}

function goalProgress(g) {
  if (g.completed) return 1;
  if (g.kind === "metric") return g.metricTarget ? Math.max(0, Math.min(1, (g.metricCurrent || 0) / g.metricTarget)) : 0;
  if (!g.milestones || !g.milestones.length) return 0;
  return g.milestones.filter((m) => m.done).length / g.milestones.length;
}
function goalFreshness(g, asOf) {
  const last = g.completed ? (g.completedDate || g.lastProgressDate) : (g.lastProgressDate || g.createdAt);
  const days = Math.max(0, dayDiff(last, asOf));
  return Math.pow(0.5, days / (HORIZON[g.horizon] || HORIZON.medio).hl);
}
function goalFlowForCat(state, catId, asOf) {
  const gs = state.goals.filter((g) => g.cat === catId && !g.archived);
  if (!gs.length) return null;
  let num = 0, den = 0;
  gs.forEach((g) => {
    const w = (HORIZON[g.horizon] || HORIZON.medio).mult * (g.importance || 5);
    num += goalProgress(g) * goalFreshness(g, asOf) * 100 * w;
    den += w;
  });
  return den ? num / den : null;
}
function categoryScore(state, catId, asOf = todayKey()) {
  const cat = state.categories.find((c) => c.id === catId);
  const mix = cat?.mix || TYPE_MIX[cat?.type] || TYPE_MIX.equilibrio;
  const ci = checkInEWMA(state, catId, asOf);
  const gl = goalFlowForCat(state, catId, asOf);
  if (ci === null && gl === null) return 0;
  if (ci === null) return gl;
  if (gl === null) return ci;
  const total = mix.ci + mix.goal;
  return (ci * mix.ci + gl * mix.goal) / total;
}
function overallScore(state, asOf = todayKey()) {
  const w = state.categories.reduce((a, c) => a + c.weight, 0);
  if (!w) return 0;
  return state.categories.reduce((a, c) => a + categoryScore(state, c.id, asOf) * c.weight, 0) / w;
}
function trend(now, then) {
  const d = now - then;
  if (d > 1.2) return { g: "▲", c: ACCENT };
  if (d < -1.2) return { g: "▼", c: WARN };
  return { g: "—", c: "#7d877f" };
}
function computeStreak(state) {
  if (state.streak && typeof state.streak.count === "number") return state.streak.count;
  let s = 0;
  for (let i = 0; i < 365; i++) {
    const d = addDays(todayKey(), -i);
    if (state.checkIns[d]) s++;
    else if (i === 0) continue;
    else break;
  }
  return s;
}
function advanceStreak(prev, today) {
  const p = prev || { count: 0, lastDay: null, shields: CONFIG.streak.startShields };
  let count = p.count || 0, shields = typeof p.shields === "number" ? p.shields : CONFIG.streak.startShields, lastDay = p.lastDay || null;
  let usedShield = false, grantedShield = false;
  if (lastDay !== today) {
    if (!lastDay) count = 1;
    else {
      const gap = dayDiff(lastDay, today);
      if (gap === 1) count += 1;
      else if (gap > 1) {
        const missed = gap - 1;
        if (count > 0 && shields >= missed) { shields -= missed; count += 1; usedShield = true; }
        else count = 1;
      }
    }
    lastDay = today;
    if (count > 0 && count % CONFIG.streak.grantEvery === 0 && shields < CONFIG.streak.maxShields) { shields += 1; grantedShield = true; }
  }
  return { streak: { count, lastDay, shields }, usedShield, grantedShield };
}
function freshnessChip(f) {
  if (f >= 0.7) return { label: "em dia", color: ACCENT };
  if (f >= 0.4) return { label: "esfriando", color: GOLD };
  return { label: "parado", color: WARN };
}
function hasProvisional(g) {
  if (g.kind === "metric") return !!g.metricProvisional;
  return (g.milestones || []).some((m) => m.provisional);
}
function achType(g) {
  if (g.track === "book") return "book";
  if (g.horizon === "longo" || (g.importance || 0) >= 8) return "trophy";
  return "medal";
}

// ---------- ring ----------
function Ring({ value, size = 220, stroke = 14, color = ACCENT, children }) {
  const r = (size - stroke) / 2, c = 2 * Math.PI * r, off = c - (value / 100) * c;
  return (
    <div style={{ position: "relative", width: size, height: size }}>
      <svg width={size} height={size} style={{ transform: "rotate(-90deg)" }}>
        <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="rgba(255,255,255,0.07)" strokeWidth={stroke} />
        <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke={color} strokeWidth={stroke}
          strokeDasharray={c} strokeDashoffset={off} strokeLinecap="round"
          style={{ transition: "stroke-dashoffset 1.1s cubic-bezier(.2,.8,.2,1)", filter: `drop-shadow(0 0 10px ${color}66)` }} />
      </svg>
      <div style={{ position: "absolute", inset: 0, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center" }}>{children}</div>
    </div>
  );
}
function Flame({ size = 16, color = GOLD, strokeWidth = 1.8, glow }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth={strokeWidth} strokeLinecap="round" strokeLinejoin="round" style={glow ? { filter: `drop-shadow(0 0 8px ${color}88)` } : undefined}>
      <path d="M8.5 14.5A2.5 2.5 0 0 0 11 12c0-1.38-.5-2-1-3-1.072-2.143-.224-4.054 2-6 .5 2.5 2 4.9 4 6.5 2 1.6 3 3.5 3 5.5a7 7 0 1 1-14 0c0-1.153.433-2.294 1-3a2.5 2.5 0 0 0 2.5 2.5z" />
    </svg>
  );
}

function Shield({ size = 12, color = "#7aa2ff", filled }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill={filled ? color : "none"} stroke={color} strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 2l8 3v6c0 5-3.5 8.5-8 11-4.5-2.5-8-6-8-11V5z" />
    </svg>
  );
}

// ---- Ascend brand mark: laurel (left) + Nike wing (right) + golden axis ----
function ascLeaf(cx, cy, s, rot, fill) {
  return `<g transform="translate(${cx.toFixed(2)},${cy.toFixed(2)}) rotate(${rot.toFixed(1)})"><path d="M0,0 Q ${(s * 0.62).toFixed(2)},${(-s * 0.55).toFixed(2)} 0,${(-s * 1.5).toFixed(2)} Q ${(-s * 0.62).toFixed(2)},${(-s * 0.55).toFixed(2)} 0,0 Z" fill="${fill}"/></g>`;
}
function ascLaurelLeft(fill) {
  const P0 = [60, 88], C = [33, 58], P1 = [28, 32];
  const B = (t) => [(1 - t) ** 2 * P0[0] + 2 * (1 - t) * t * C[0] + t * t * P1[0], (1 - t) ** 2 * P0[1] + 2 * (1 - t) * t * C[1] + t * t * P1[1]];
  let s = `<path d="M${P0[0]},${P0[1]} Q ${C[0]},${C[1]} ${P1[0]},${P1[1]}" fill="none" stroke="${fill}" stroke-width="1.7" stroke-linecap="round"/>`;
  const n = 7;
  for (let i = 0; i < n; i++) {
    const t = (i + 0.5) / n; const [x, y] = B(t);
    const size = 3.3 * (1 - 0.42 * t) + 2.3;
    s += ascLeaf(x - 1.5, y, size, -44 - 22 * t, fill);
    if (i < n - 1) s += ascLeaf(x + 1.2, y + 0.5, size * 0.82, -14 - 16 * t, fill);
  }
  return s;
}
function ascWing(px, py, n, fill, scale) {
  let s = "";
  for (let i = 0; i < n; i++) {
    const t = i / (n - 1);
    const len = (15 + t * 30) * scale, ang = -16 - t * 60, ar = ang * Math.PI / 180;
    const ex = px + len * Math.cos(ar), ey = py + len * Math.sin(ar);
    const w = (3.3 + t * 2.1) * scale, mx = (px + ex) / 2, my = (py + ey) / 2;
    const nx = Math.cos((ang + 90) * Math.PI / 180) * w, ny = Math.sin((ang + 90) * Math.PI / 180) * w;
    s += `<path d="M${px.toFixed(2)},${py.toFixed(2)} Q ${(mx + nx).toFixed(2)},${(my + ny).toFixed(2)} ${ex.toFixed(2)},${ey.toFixed(2)} Q ${(mx - nx).toFixed(2)},${(my - ny).toFixed(2)} ${px.toFixed(2)},${py.toFixed(2)} Z" fill="${fill}"/>`;
  }
  return s;
}
function ascLogoInner(animated) {
  const id = "ascgrad";
  const defs = `<defs><linearGradient id="${id}" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stop-color="#e6cd8f"/><stop offset="100%" stop-color="${GOLD}"/></linearGradient></defs>`;
  const fill = `url(#${id})`;
  const lc = animated ? ' class="asc-laurel"' : "", wc = animated ? ' class="asc-wing"' : "", dc = animated ? ' class="asc-divider"' : "", xc = animated ? ' class="asc-dia"' : "";
  return defs
    + `<g${lc}>${ascLaurelLeft(fill)}</g>`
    + `<g${wc}>${ascWing(60, 88, 6, fill, 1.0)}</g>`
    + `<line${dc} x1="60" y1="90" x2="60" y2="30" stroke="${fill}" stroke-width="2" stroke-linecap="round"/>`
    + `<path${xc} d="M60,26 l4,5 -4,5 -4,-5 z" fill="${fill}"/>`;
}
function AscendLogo({ size = 120, animated = false }) {
  return <svg viewBox="0 0 120 120" width={size} height={size} style={{ display: "block" }} dangerouslySetInnerHTML={{ __html: ascLogoInner(animated) }} />;
}

function Sparkline({ values, color = GOLD, height = 46 }) {
  if (!values || values.length < 2) return null;
  const w = 100, h = height;
  const max = Math.max(...values, 1), min = Math.min(...values, 0);
  const span = max - min || 1;
  const pts = values.map((v, i) => `${(i / (values.length - 1)) * w},${h - 6 - ((v - min) / span) * (h - 12)}`);
  const last = values[values.length - 1];
  const lx = w, ly = h - 6 - ((last - min) / span) * (h - 12);
  return (
    <svg viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none" style={{ width: "100%", height }}>
      <defs>
        <linearGradient id="spk" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={color} stopOpacity="0.28" />
          <stop offset="100%" stopColor={color} stopOpacity="0" />
        </linearGradient>
      </defs>
      <polygon points={`0,${h} ${pts.join(" ")} ${w},${h}`} fill="url(#spk)" />
      <polyline points={pts.join(" ")} fill="none" stroke={color} strokeWidth="1.6" strokeLinejoin="round" strokeLinecap="round" vectorEffect="non-scaling-stroke" />
      <circle cx={lx} cy={ly} r="2.4" fill={color} />
    </svg>
  );
}

function tier(s) {
  if (s >= 85) return { name: "Ápice", color: GOLD };
  if (s >= 70) return { name: "Ascensão", color: ACCENT };
  if (s >= 50) return { name: "Construção", color: "#7aa2ff" };
  if (s >= 30) return { name: "Fundação", color: "#e8a657" };
  return { name: "Início", color: WARN };
}

function freshState() {
  const base = buildDefault();
  return { ...base, north: "", objectives: [], goals: [], checkIns: {}, onboarded: false, streak: { count: 0, lastDay: null, shields: CONFIG.streak.startShields } };
}

// Migração de dados salvos: preenche campos novos com padrões, sem corromper o existente.
// Cada release que mudar o formato adiciona um passo aqui e bumpa SCHEMA_VERSION.
function migrate(raw) {
  const s = { ...raw };
  const T = todayKey();
  if (!s.createdAt) s.createdAt = T;
  if (!s.checkIns || typeof s.checkIns !== "object") s.checkIns = {};
  if (!Array.isArray(s.categories)) return buildDefault();
  if (!Array.isArray(s.questions)) s.questions = buildDefault().questions;
  if (!Array.isArray(s.goals)) s.goals = [];
  if (!Array.isArray(s.objectives)) s.objectives = [];
  if (!Array.isArray(s.skills)) s.skills = [];
  if (!Array.isArray(s.routines)) s.routines = [];
  if (!s.learn || typeof s.learn !== "object") s.learn = { track: "rotativo", today: null, streak: { count: 0, lastDay: null }, log: [] };
  if (!s.learn.streak) s.learn.streak = { count: 0, lastDay: null };
  if (!Array.isArray(s.learn.log)) s.learn.log = [];
  if (!s.learn.track) s.learn.track = "rotativo";
  if (!s.ui || typeof s.ui !== "object") s.ui = { learnCollapsed: false, routinesCollapsed: false };
  if (!s.routinesSeeded) { if (s.routines.length === 0) s.routines = seedRoutines(T); s.routinesSeeded = true; }
  if (!s.virtuesSeeded) {
    const have = new Set(s.skills.map((x) => (x.name || "").toLowerCase()));
    cardinalVirtues().forEach((v) => { if (!have.has(v.name.toLowerCase())) s.skills.push(v); });
    s.virtuesSeeded = true;
  }
  if (typeof s.north !== "string") s.north = "";
  ["lastWeeklyCheck", "lastMonthlyReview", "lastSemesterReview", "lastYearReview"].forEach((k) => { if (!s[k]) s[k] = s.createdAt; });
  if (!s.streak || typeof s.streak.count !== "number") {
    let c = 0; for (let i = 0; i < 365; i++) { const d = addDays(T, -i); if (s.checkIns[d]) c++; else if (i === 0) continue; else break; }
    s.streak = { count: c, lastDay: s.checkIns[T] ? T : (c > 0 ? addDays(T, -(c - 1)) : null), shields: CONFIG.streak.startShields };
  }
  if (typeof s.onboarded !== "boolean") s.onboarded = (s.goals.length > 0 || Object.keys(s.checkIns).length > 0);
  s.schemaVersion = SCHEMA_VERSION;
  return s;
}

function Onboarding({ categories, onDone, onSkip }) {
  const [step, setStep] = useState(0);
  const [north, setNorth] = useState("");
  const [objCat, setObjCat] = useState(categories[0] ? categories[0].id : "prof");
  const [objTitle, setObjTitle] = useState("");
  const [goalTitle, setGoalTitle] = useState("");
  const [goalHz, setGoalHz] = useState("curto");
  const next = () => setStep((s) => s + 1);
  const wrap = (children) => (
    <div style={{ minHeight: "100vh", background: "#080b0a", color: "#eef2ef", fontFamily: "'Schibsted Grotesk', sans-serif", display: "flex", flexDirection: "column", justifyContent: "center", padding: "32px 24px", maxWidth: 560, margin: "0 auto" }}>
      <style>{`@import url('https://fonts.googleapis.com/css2?family=Fraunces:opsz,wght@9..144,400;9..144,500;9..144,600&family=Schibsted+Grotesk:wght@400;500;600;700&display=swap'); *{box-sizing:border-box;} textarea,input{font-family:inherit;}`}</style>
      <div className="rise">{children}</div>
    </div>
  );
  const dots = (
    <div style={{ display: "flex", gap: 6, justifyContent: "center", marginTop: 28 }}>
      {[0, 1, 2, 3].map((i) => <div key={i} style={{ width: 7, height: 7, borderRadius: 99, background: i === step ? GOLD : "rgba(255,255,255,0.18)" }} />)}
    </div>
  );
  const btn = (label, onClick, disabled) => (
    <button onClick={onClick} disabled={disabled} style={{ width: "100%", marginTop: 22, padding: "15px", borderRadius: 14, border: "none", background: disabled ? "rgba(255,255,255,0.06)" : `linear-gradient(135deg, ${ACCENT}, ${GOLD})`, color: disabled ? "#6b756d" : "#080b0a", fontWeight: 700, fontSize: 15, cursor: disabled ? "not-allowed" : "pointer" }}>{label}</button>
  );
  const skip = <button onClick={onSkip} style={{ width: "100%", marginTop: 12, padding: "8px", border: "none", background: "transparent", color: "#6b756d", fontSize: 12.5, cursor: "pointer" }}>Pular e explorar com exemplos</button>;

  if (step === 0) return wrap(<><div style={{ fontFamily: "'Fraunces',serif", fontSize: 40, fontWeight: 500 }}>Ascend</div><p style={{ fontSize: 15, color: "#aeb6ae", lineHeight: 1.6, marginTop: 14 }}>Antes de medir o dia a dia, vamos ancorar o porquê. Em 3 passos você define seu Norte, um objetivo e a primeira meta.</p>{btn("Começar", next)}{skip}{dots}</>);
  if (step === 1) return wrap(<><div style={{ fontSize: 10, color: GOLD, letterSpacing: "0.16em", textTransform: "uppercase", fontWeight: 700 }}>✦ Passo 1 · Seu Norte</div><h2 style={{ fontFamily: "'Fraunces',serif", fontSize: 24, fontWeight: 500, margin: "10px 0 6px" }}>Qual é o seu sonho?</h2><p style={{ fontSize: 13, color: "#7d877f", marginBottom: 14 }}>O destino amplo que dá sentido a tudo. Não precisa ser mensurável.</p><textarea value={north} onChange={(e) => setNorth(e.target.value)} rows={3} placeholder="Ex.: gerar impacto no mundo e construir a vida que projetei…" style={{ width: "100%", background: "rgba(255,255,255,0.04)", border: "1px solid rgba(255,255,255,0.12)", borderRadius: 12, padding: "12px 14px", color: "#eef2ef", fontSize: 15, outline: "none", resize: "vertical", lineHeight: 1.5 }} />{btn("Continuar", next, !north.trim())}{dots}</>);
  if (step === 2) return wrap(<><div style={{ fontSize: 10, color: GOLD, letterSpacing: "0.16em", textTransform: "uppercase", fontWeight: 700 }}>✦ Passo 2 · Um objetivo</div><h2 style={{ fontFamily: "'Fraunces',serif", fontSize: 24, fontWeight: 500, margin: "10px 0 6px" }}>Uma direção que te leva ao Norte</h2><p style={{ fontSize: 13, color: "#7d877f", marginBottom: 14 }}>Qualitativo, por área. Ex.: "construir carreira em PE".</p><div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginBottom: 12 }}>{categories.map((c) => <button key={c.id} onClick={() => setObjCat(c.id)} style={{ padding: "7px 12px", borderRadius: 9, border: "1px solid", borderColor: objCat === c.id ? c.accent : "rgba(255,255,255,0.12)", background: objCat === c.id ? `${c.accent}22` : "transparent", color: objCat === c.id ? c.accent : "#aeb6ae", fontSize: 12.5, fontWeight: 600, cursor: "pointer" }}>{c.name}</button>)}</div><input value={objTitle} onChange={(e) => setObjTitle(e.target.value)} placeholder="Título do objetivo" style={{ width: "100%", background: "rgba(255,255,255,0.04)", border: "1px solid rgba(255,255,255,0.12)", borderRadius: 12, padding: "12px 14px", color: "#eef2ef", fontSize: 15, outline: "none" }} />{btn("Continuar", next, !objTitle.trim())}{dots}</>);
  return wrap(<><div style={{ fontSize: 10, color: GOLD, letterSpacing: "0.16em", textTransform: "uppercase", fontWeight: 700 }}>✦ Passo 3 · Primeira meta</div><h2 style={{ fontFamily: "'Fraunces',serif", fontSize: 24, fontWeight: 500, margin: "10px 0 6px" }}>Um passo concreto</h2><p style={{ fontSize: 13, color: "#7d877f", marginBottom: 14 }}>Específico e mensurável, dentro desse objetivo.</p><input value={goalTitle} onChange={(e) => setGoalTitle(e.target.value)} placeholder="Ex.: fechar um estágio até dez/2026" style={{ width: "100%", background: "rgba(255,255,255,0.04)", border: "1px solid rgba(255,255,255,0.12)", borderRadius: 12, padding: "12px 14px", color: "#eef2ef", fontSize: 15, outline: "none", marginBottom: 12 }} /><div style={{ display: "flex", gap: 6 }}>{[["curto", "Curto"], ["medio", "Médio"], ["longo", "Longo"]].map(([v, l]) => <button key={v} onClick={() => setGoalHz(v)} style={{ flex: 1, padding: "9px", borderRadius: 9, border: "1px solid", borderColor: goalHz === v ? HORIZON[v].color : "rgba(255,255,255,0.12)", background: goalHz === v ? `${HORIZON[v].color}22` : "transparent", color: goalHz === v ? HORIZON[v].color : "#aeb6ae", fontSize: 12.5, fontWeight: 600, cursor: "pointer" }}>{l}</button>)}</div>{btn("Concluir", () => onDone({ north: north.trim(), objCat, objTitle: objTitle.trim(), goalTitle: goalTitle.trim(), goalHz }), !goalTitle.trim())}{dots}</>);
}

function GearIcon({ size = 18 }) {
  return (<svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="3" /><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" /></svg>);
}

function Settings({ state, setState, onClose }) {
  const [imp, setImp] = useState("");
  const [msg, setMsg] = useState("");
  const exportData = () => {
    const json = JSON.stringify(state, null, 2);
    try {
      const blob = new Blob([json], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a"); a.href = url; a.download = `ascend-backup-${todayKey()}.json`; a.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      setMsg("Backup baixado.");
    } catch (e) { setMsg("Copie o JSON abaixo e guarde."); setImp(json); }
  };
  const importData = () => {
    try { const obj = JSON.parse(imp); if (!obj || !obj.categories) throw new Error("inválido"); setState(migrate(obj)); setMsg("Dados importados!"); setTimeout(onClose, 600); }
    catch (e) { setMsg("JSON inválido. Verifique e tente de novo."); }
  };
  const reset = () => { if (confirm("Reiniciar do zero? Isso apaga TODAS as suas metas, conquistas e reflexões. Faça um backup antes.")) { setState(freshState()); onClose(); } };
  return (
    <div onClick={onClose} style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.65)", backdropFilter: "blur(4px)", zIndex: 80, display: "flex", alignItems: "center", justifyContent: "center", padding: 20 }}>
      <div onClick={(e) => e.stopPropagation()} style={{ background: "#111814", border: "1px solid rgba(255,255,255,0.1)", borderRadius: 18, padding: "22px 20px", maxWidth: 420, width: "100%", maxHeight: "85vh", overflowY: "auto" }}>
        <div style={{ fontFamily: "'Fraunces',serif", fontSize: 20, fontWeight: 500, marginBottom: 4 }}>Ajustes</div>
        <p style={{ fontSize: 12.5, color: "#7d877f", marginBottom: 18 }}>Seus dados vivem só neste aparelho. Faça backups com frequência.</p>
        <button onClick={exportData} style={{ width: "100%", padding: "12px", borderRadius: 11, border: `1px solid ${ACCENT}55`, background: `${ACCENT}18`, color: ACCENT, fontWeight: 600, fontSize: 13.5, cursor: "pointer", marginBottom: 10 }}>Exportar backup (.json)</button>
        <div style={{ fontSize: 12, color: "#9aa39a", margin: "10px 0 6px" }}>Importar (cole um backup):</div>
        <textarea value={imp} onChange={(e) => setImp(e.target.value)} rows={3} placeholder='{"categories":[...]}' style={{ width: "100%", background: "rgba(255,255,255,0.04)", border: "1px solid rgba(255,255,255,0.12)", borderRadius: 10, padding: "10px 12px", color: "#eef2ef", fontSize: 12, outline: "none", resize: "vertical", fontFamily: "monospace" }} />
        <button onClick={importData} disabled={!imp.trim()} style={{ width: "100%", padding: "11px", borderRadius: 11, border: "1px solid rgba(255,255,255,0.14)", background: "transparent", color: imp.trim() ? "#eef2ef" : "#6b756d", fontWeight: 600, fontSize: 13.5, cursor: imp.trim() ? "pointer" : "not-allowed", marginTop: 8 }}>Importar</button>
        {msg && <div style={{ fontSize: 12, color: ACCENT, marginTop: 10, textAlign: "center" }}>{msg}</div>}
        <div style={{ borderTop: "1px solid rgba(255,255,255,0.08)", margin: "18px 0 14px" }} />
        <button onClick={reset} style={{ width: "100%", padding: "11px", borderRadius: 11, border: `1px solid ${WARN}44`, background: "transparent", color: WARN, fontWeight: 600, fontSize: 13, cursor: "pointer" }}>Reiniciar do zero</button>
        <button onClick={onClose} style={{ width: "100%", padding: "11px", borderRadius: 11, border: "none", background: "transparent", color: "#7d877f", fontWeight: 600, fontSize: 13, cursor: "pointer", marginTop: 6 }}>Fechar</button>
        <div style={{ textAlign: "center", fontSize: 10.5, color: "#5e6862", marginTop: 12, letterSpacing: "0.08em" }}>Ascend v{VERSION}</div>
      </div>
    </div>
  );
}

export default function App() {
  const [state, setState] = useState(buildDefault());
  const [loaded, setLoaded] = useState(false);
  const [tab, setTab] = useState("dash");
  const [toast, setToast] = useState(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [routinesOpen, setRoutinesOpen] = useState(false);
  const [learnOpen, setLearnOpen] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const [splashDone, setSplashDone] = useState(false);

  useEffect(() => {
    const t = setTimeout(() => setSplashDone(true), 2150);
    return () => clearTimeout(t);
  }, []);

  useEffect(() => {
    (async () => {
      try { const r = await window.storage.get("ascend_v2"); if (r && r.value) setState(migrate(JSON.parse(r.value))); } catch (e) {}
      setLoaded(true);
    })();
  }, []);
  useEffect(() => {
    if (!loaded) return;
    (async () => { try { await window.storage.set("ascend_v2", JSON.stringify(state)); } catch (e) {} })();
  }, [state, loaded]);

  const showToast = useCallback((m) => { setToast(m); setTimeout(() => setToast(null), 2800); }, []);

  const overall = useMemo(() => overallScore(state), [state]);
  const overallThen = useMemo(() => overallScore(state, addDays(todayKey(), -7)), [state]);
  const t = tier(overall);
  const streak = computeStreak(state);
  const weeklyDue = dayDiff(state.lastWeeklyCheck, todayKey()) >= 7;
  const monthlyDue = dayDiff(state.lastMonthlyReview, todayKey()) >= 30;
  const semesterDue = dayDiff(state.lastSemesterReview || state.createdAt, todayKey()) >= 180;
  const yearDue = dayDiff(state.lastYearReview || state.createdAt, todayKey()) >= 365;
  const topReview = yearDue ? "Retrospectiva anual" : semesterDue ? "Retrospectiva semestral" : monthlyDue ? "Revisão mensal" : weeklyDue ? "Check semanal" : null;
  const auditDue = !!topReview;
  const isRetro = yearDue || semesterDue;

  if (!loaded || !splashDone) {
    return (
      <div style={{ minHeight: "100vh", background: "radial-gradient(120% 80% at 50% 38%, #11160f 0%, #080b0a 60%)", color: "#eef2ef", fontFamily: "'Schibsted Grotesk', sans-serif", display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center" }}>
        <style>{`
          @import url('https://fonts.googleapis.com/css2?family=Fraunces:opsz,wght@9..144,400;9..144,500;9..144,600&family=Schibsted+Grotesk:wght@400;600&display=swap');
          html,body{margin:0;background:#080b0a;}
          @keyframes flameRise { 0%{opacity:0; transform: translateY(22px) scale(.55);} 55%{opacity:1; transform: translateY(0) scale(1.06);} 100%{opacity:1; transform: translateY(0) scale(1);} }
          @keyframes flameGlow { 0%,100%{filter: drop-shadow(0 0 9px ${GOLD}77);} 50%{filter: drop-shadow(0 0 20px ${GOLD}c0);} }
          @keyframes letterIn { from{opacity:0; transform: translateY(12px);} to{opacity:1; transform: none;} }
          @keyframes lineDraw { from{transform: scaleX(0);} to{transform: scaleX(1);} }
          @keyframes ascLft { from{opacity:0; transform: translateX(-9px);} to{opacity:1; transform:none;} }
          @keyframes ascRgt { from{opacity:0; transform: translateX(9px);} to{opacity:1; transform:none;} }
          @keyframes ascDraw { to{ stroke-dashoffset:0; } }
          @keyframes ascPop { 0%{opacity:0; transform:scale(.3);} 60%{transform:scale(1.25);} 100%{opacity:1; transform:scale(1);} }
          .asc-flame { animation: flameRise .95s cubic-bezier(.2,.85,.25,1) both; }
          .asc-flame-inner { animation: flameGlow 2.6s ease-in-out 1s infinite; }
          .asc-laurel { opacity:0; animation: ascLft .7s cubic-bezier(.2,.85,.25,1) .2s both; }
          .asc-wing { opacity:0; animation: ascRgt .7s cubic-bezier(.2,.85,.25,1) .2s both; }
          .asc-divider { stroke-dasharray:62; stroke-dashoffset:62; animation: ascDraw .7s ease .5s forwards; }
          .asc-dia { opacity:0; transform-box:fill-box; transform-origin:center; animation: ascPop .45s cubic-bezier(.2,.85,.25,1) 1s forwards; }
          .asc-word span { display:inline-block; animation: letterIn .42s cubic-bezier(.2,.85,.25,1) both; }
          .asc-line { height:2px; border-radius:2px; background: linear-gradient(90deg, ${ACCENT}, ${GOLD}); transform-origin:left center; animation: lineDraw .6s ease 1.45s both; }
        `}</style>
        <div className="asc-flame"><div className="asc-flame-inner"><AscendLogo size={104} animated /></div></div>
        <div className="asc-word" style={{ fontFamily: "'Fraunces', serif", fontSize: 40, fontWeight: 500, letterSpacing: "0.01em", marginTop: 14, display: "flex" }}>
          {"Ascend".split("").map((ch, i) => <span key={i} style={{ animationDelay: `${0.85 + i * 0.07}s` }}>{ch}</span>)}
        </div>
        <div className="asc-line" style={{ width: 132, marginTop: 12 }} />
      </div>
    );
  }

  if (loaded && !state.onboarded && (state.goals || []).length === 0 && Object.keys(state.checkIns || {}).length === 0) {
    return <Onboarding categories={state.categories} onSkip={() => setState((s) => ({ ...s, onboarded: true }))} onDone={(p) => setState((s) => {
      const objId = "obj_" + Date.now().toString(36);
      const gid = "g" + Date.now().toString(36);
      const objective = { id: objId, cat: p.objCat, title: p.objTitle };
      const goal = { ...mkGoal(gid, p.objCat, p.goalHz, 7, p.goalTitle, "milestone", ["Definir 1º passo"], todayKey()), objId };
      return { ...s, north: p.north, objectives: [objective], goals: [goal], onboarded: true };
    })} />;
  }

  return (
    <div style={{ minHeight: "100vh", background: "#080b0a", color: "#eef2ef", fontFamily: "'Schibsted Grotesk', sans-serif", paddingBottom: "calc(96px + env(safe-area-inset-bottom))", position: "relative", overflowX: "hidden" }}>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=Fraunces:opsz,wght@9..144,400;9..144,500;9..144,600&family=Schibsted+Grotesk:wght@400;500;600;700&display=swap');
        html, body { margin: 0; background: #080b0a; -webkit-font-smoothing: antialiased; -moz-osx-font-smoothing: grayscale; text-rendering: optimizeLegibility; overscroll-behavior-y: none; -webkit-text-size-adjust: 100%; }
        * { box-sizing: border-box; -webkit-tap-highlight-color: transparent; }
        ::selection { background: ${ACCENT}44; }
        ::-webkit-scrollbar { width: 0; }
        button { font-family: inherit; color: inherit; transition: transform .1s ease, color .2s, background .2s; }
        button:active { transform: scale(0.975); }
        textarea, input { font-family: inherit; }
        @keyframes rise { from {opacity:0; transform: translateY(14px);} to {opacity:1; transform:none;} }
        @keyframes toastIn { from {opacity:0; transform: translate(-50%,12px);} to {opacity:1; transform:translate(-50%,0);} }
        @keyframes pulse { 0%,100%{opacity:1;} 50%{opacity:.55;} }
        @keyframes shimmer { 0%{background-position:200% 0;} 100%{background-position:-200% 0;} }
        @keyframes shineSweep { 0%{transform:translateX(-130%);} 100%{transform:translateX(240%);} }
        @keyframes confetti { to { transform: translate(var(--tx),var(--ty)) rotate(var(--rot)); opacity:0; } }
        @keyframes popIn { 0%{transform:scale(.5);opacity:0;} 60%{transform:scale(1.18);} 100%{transform:scale(1);opacity:1;} }
        @keyframes trophyGlow { 0%,100%{box-shadow:0 0 0 rgba(203,161,77,0);} 50%{box-shadow:0 0 22px rgba(203,161,77,.35);} }
        .rise { animation: rise .55s cubic-bezier(.2,.8,.2,1) both; }
      `}</style>
      <div style={{ position: "fixed", top: -120, left: "50%", transform: "translateX(-50%)", width: 480, height: 480, background: `radial-gradient(circle, ${t.color}22, transparent 70%)`, pointerEvents: "none", zIndex: 0 }} />

      <div style={{ maxWidth: 560, margin: "0 auto", padding: "0 20px", position: "relative", zIndex: 1 }}>
        <button onClick={() => setSearchOpen(true)} title="Buscar" style={{ position: "absolute", top: "calc(18px + env(safe-area-inset-top))", right: 50, background: "none", border: "none", color: "#5e6862", cursor: "pointer", zIndex: 4, padding: 4 }}><SearchIcon size={17} /></button>
        <button onClick={() => setSettingsOpen(true)} title="Ajustes" style={{ position: "absolute", top: "calc(18px + env(safe-area-inset-top))", right: 18, background: "none", border: "none", color: "#5e6862", cursor: "pointer", zIndex: 4, padding: 4 }}><GearIcon size={17} /></button>
        <header style={{ padding: "calc(34px + env(safe-area-inset-top)) 0 12px", display: "flex", alignItems: "baseline", justifyContent: "space-between" }}>
          <div>
            <div style={{ fontFamily: "'Fraunces', serif", fontSize: 30, fontWeight: 500, letterSpacing: "-0.02em" }}>Ascend</div>
            <div style={{ fontSize: 12, color: "#7d877f", letterSpacing: "0.14em", textTransform: "uppercase", marginTop: 2 }}>Giovanni de Gennaro Rocha</div>
          </div>
          <div style={{ textAlign: "right" }}>
            <div style={{ display: "flex", alignItems: "center", gap: 6, justifyContent: "flex-end" }}>
              <Flame size={19} color={GOLD} glow={streak > 0} />
              <span style={{ fontFamily: "'Fraunces', serif", fontSize: 22, color: GOLD }}>{streak}</span>
            </div>
            <div style={{ fontSize: 10, color: "#7d877f", letterSpacing: "0.14em", marginTop: 2 }}>DIAS SEGUIDOS</div>
            {state.streak && state.streak.shields > 0 && (
              <div style={{ display: "flex", alignItems: "center", gap: 3, justifyContent: "flex-end", marginTop: 3 }}>
                {[...Array(state.streak.shields)].map((_, i) => <Shield key={i} size={11} color="#7aa2ff" filled />)}
                <span style={{ fontSize: 9, color: "#7d877f", marginLeft: 2 }}>escudo{state.streak.shields > 1 ? "s" : ""}</span>
              </div>
            )}
          </div>
        </header>

        {auditDue && tab !== "ai" && (
          <button onClick={() => setTab("ai")} style={{ width: "100%", textAlign: "left", background: `linear-gradient(135deg, ${GOLD}22, ${WARN}18)`, border: `1px solid ${GOLD}55`, borderRadius: 14, padding: "12px 16px", marginBottom: 14, cursor: "pointer", color: "#eef2ef", display: "flex", alignItems: "center", gap: 12 }}>
            <span style={{ fontSize: 18, color: GOLD, animation: "pulse 2s infinite" }}>✦</span>
            <span style={{ fontSize: 13.5, lineHeight: 1.4 }}>
              <strong>{topReview} pendente.</strong> Abra o Coach IA para {isRetro ? "fazer sua retrospectiva" : "auditar seu progresso"}.
            </span>
          </button>
        )}

        {tab === "dash" && <Dashboard state={state} setState={setState} overall={overall} overallThen={overallThen} t={t} onManageRoutines={() => setRoutinesOpen(true)} onLearn={() => setLearnOpen(true)} />}
        {tab === "today" && <DailyHub state={state} setState={setState} onManageRoutines={() => setRoutinesOpen(true)} onLearn={() => setLearnOpen(true)} />}
        {tab === "checkin" && <CheckIn state={state} setState={setState} showToast={showToast} goDash={() => setTab("dash")} />}
        {tab === "goals" && <Goals state={state} setState={setState} />}
        {tab === "trophies" && <Conquistas state={state} />}
        {tab === "ai" && <AICoach state={state} setState={setState} showToast={showToast} weeklyDue={weeklyDue} monthlyDue={monthlyDue} semesterDue={semesterDue} yearDue={yearDue} />}
      </div>

      {toast && (
        <div style={{ position: "fixed", bottom: 108, left: "50%", transform: "translateX(-50%)", background: "#141a17", border: `1px solid ${ACCENT}55`, color: "#eef2ef", padding: "12px 20px", borderRadius: 14, fontSize: 14, zIndex: 50, animation: "toastIn .35s both", maxWidth: 440, textAlign: "center", boxShadow: "0 12px 40px rgba(0,0,0,.5)" }}>{toast}</div>
      )}

      {settingsOpen && <Settings state={state} setState={setState} onClose={() => setSettingsOpen(false)} />}
      {routinesOpen && <RoutinesManageModal state={state} setState={setState} onClose={() => setRoutinesOpen(false)} />}
      {learnOpen && <LearnModal state={state} setState={setState} onClose={() => setLearnOpen(false)} />}
      {searchOpen && <SearchModal state={state} onClose={() => setSearchOpen(false)} goTab={(tb) => setTab(tb)} />}

      <nav style={{ position: "fixed", bottom: 0, left: 0, right: 0, background: "rgba(10,14,12,0.92)", backdropFilter: "blur(18px)", WebkitBackdropFilter: "blur(18px)", borderTop: "1px solid rgba(255,255,255,0.06)", display: "flex", justifyContent: "space-around", padding: "12px 0 calc(22px + env(safe-area-inset-bottom))", zIndex: 40 }}>
        {[{ id: "dash", label: "Painel", g: "◎" }, { id: "today", label: "Hoje", g: "✸" }, { id: "checkin", label: "Check-in", g: "✓" }, { id: "goals", label: "Metas", g: "▲" }, { id: "trophies", label: "Troféus", g: "★" }, { id: "ai", label: "Coach", g: "✦" }].map((n) => (
          <button key={n.id} onClick={() => setTab(n.id)} style={{ background: "none", border: "none", cursor: "pointer", display: "flex", flexDirection: "column", alignItems: "center", gap: 4, color: tab === n.id ? ACCENT : "#6b756d", position: "relative", minWidth: 46 }}>
            <span style={{ fontSize: 16, transform: tab === n.id ? "scale(1.14)" : "none", transition: "transform .2s" }}>{n.g}</span>
            <span style={{ fontSize: 9.5, fontWeight: 600 }}>{n.label}</span>
            {n.id === "ai" && auditDue && <span style={{ position: "absolute", top: -2, right: 2, width: 7, height: 7, borderRadius: 99, background: GOLD, boxShadow: `0 0 6px ${GOLD}` }} />}
          </button>
        ))}
      </nav>
    </div>
  );
}

function NorthBanner({ north, onSave }) {
  const [editing, setEditing] = useState(false);
  const [val, setVal] = useState(north || "");
  useEffect(() => { setVal(north || ""); }, [north]);
  if (editing) {
    return (
      <div style={{ background: "linear-gradient(135deg, rgba(203,161,77,0.12), rgba(255,255,255,0.02))", border: `1px solid ${GOLD}55`, borderRadius: 16, padding: "14px 16px", marginBottom: 4 }}>
        <div style={{ fontSize: 10, color: GOLD, letterSpacing: "0.16em", textTransform: "uppercase", fontWeight: 700, marginBottom: 8 }}>✦ Meu Norte</div>
        <textarea value={val} onChange={(e) => setVal(e.target.value)} rows={3} autoFocus style={{ width: "100%", background: "rgba(255,255,255,0.05)", border: "1px solid rgba(255,255,255,0.12)", borderRadius: 10, padding: "10px 12px", color: "#eef2ef", fontSize: 14, outline: "none", fontFamily: "inherit", resize: "vertical", lineHeight: 1.45 }} />
        <div style={{ display: "flex", gap: 8, marginTop: 10 }}>
          <button onClick={() => { onSave(val.trim()); setEditing(false); }} style={{ flex: 1, padding: "9px", borderRadius: 9, border: "none", background: `linear-gradient(135deg, ${ACCENT}, ${GOLD})`, color: "#080b0a", fontWeight: 700, fontSize: 13, cursor: "pointer" }}>Salvar</button>
          <button onClick={() => { setVal(north || ""); setEditing(false); }} style={{ padding: "9px 16px", borderRadius: 9, border: "1px solid rgba(255,255,255,0.12)", background: "transparent", color: "#aeb6ae", fontWeight: 600, fontSize: 13, cursor: "pointer" }}>Cancelar</button>
        </div>
      </div>
    );
  }
  return (
    <div onClick={() => setEditing(true)} style={{ background: "linear-gradient(135deg, rgba(203,161,77,0.1), rgba(255,255,255,0.015))", border: `1px solid ${GOLD}33`, borderRadius: 16, padding: "14px 16px", marginBottom: 4, cursor: "pointer", position: "relative", overflow: "hidden" }}>
      <div style={{ position: "absolute", top: 0, bottom: 0, left: 0, width: "28%", background: "linear-gradient(90deg,transparent,rgba(255,255,255,.06),transparent)", animation: "shineSweep 6s ease-in-out infinite" }} />
      <div style={{ fontSize: 10, color: GOLD, letterSpacing: "0.16em", textTransform: "uppercase", fontWeight: 700, marginBottom: 6 }}>✦ Meu Norte</div>
      <div style={{ fontFamily: "'Fraunces', serif", fontSize: 16, color: "#eef2ef", lineHeight: 1.4, fontStyle: north ? "normal" : "italic", opacity: north ? 1 : 0.6 }}>{north || "Toque para definir seu sonho — o porquê maior de tudo isto."}</div>
    </div>
  );
}

function RoutinesCard({ state, setState, onManage, collapsed, onToggle }) {
  const T = todayKey();
  const routines = state.routines || [];
  const withStatus = routines.map((r) => ({ r, s: routineStatus(r, T) }));
  const due = withStatus.filter((x) => x.s.due).sort((a, b) => b.s.over - a.s.over);
  const upcoming = withStatus.filter((x) => !x.s.due).sort((a, b) => a.s.in - b.s.in);
  const markDone = (id) => setState((s) => ({ ...s, routines: (s.routines || []).map((r) => (r.id === id ? { ...r, lastDone: T } : r)) }));

  return (
    <div className="rise" style={{ background: "linear-gradient(145deg, rgba(255,255,255,0.04), rgba(255,255,255,0.01))", border: "1px solid rgba(255,255,255,0.07)", borderRadius: 18, padding: "14px 18px", marginTop: 12 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: collapsed ? 0 : 10 }}>
        <span style={{ fontSize: 11, color: "#7d877f", letterSpacing: "0.12em", textTransform: "uppercase", fontWeight: 600 }}>Rotinas de casa{collapsed && due.length ? ` · ${due.length} pendente${due.length > 1 ? "s" : ""}` : ""}</span>
        <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
          <button onClick={onManage} style={{ background: "none", border: "none", color: ACCENT, fontSize: 12, fontWeight: 600, cursor: "pointer", padding: 0 }}>gerir</button>
          <button onClick={onToggle} style={{ background: "none", border: "none", color: "#7d877f", cursor: "pointer", padding: 2, display: "inline-flex", transform: collapsed ? "none" : "rotate(180deg)", transition: "transform .2s" }}>▾</button>
        </div>
      </div>
      {!collapsed && (due.length ? due.map(({ r, s }) => (
        <div key={r.id} style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10, padding: "9px 0", borderTop: "1px solid rgba(255,255,255,0.04)" }}>
          <div>
            <div style={{ fontSize: 14, color: "#eef2ef" }}>{r.name}</div>
            <div style={{ fontSize: 11, color: s.color, marginTop: 2 }}>{s.label}</div>
          </div>
          <button onClick={() => markDone(r.id)} style={{ flexShrink: 0, padding: "8px 16px", borderRadius: 10, border: `1px solid ${ACCENT}55`, background: `${ACCENT}18`, color: ACCENT, fontSize: 12.5, fontWeight: 600, cursor: "pointer" }}>Feito</button>
        </div>
      )) : (
        <div style={{ display: "flex", alignItems: "center", gap: 8, color: "#7d877f", fontSize: 13 }}>
          <span style={{ color: ACCENT }}>✓</span> Tudo em dia{upcoming.length ? ` · próxima: ${upcoming[0].r.name} em ${upcoming[0].s.in}d` : ""}
        </div>
      ))}
    </div>
  );
}

function RoutinesManageModal({ state, setState, onClose }) {
  const [newName, setNewName] = useState("");
  const [newEvery, setNewEvery] = useState(7);
  const routines = state.routines || [];
  const addRoutine = () => { if (!newName.trim()) return; setState((s) => ({ ...s, routines: [...(s.routines || []), { id: "rt_" + Date.now().toString(36), name: newName.trim(), everyDays: Math.max(1, parseInt(newEvery) || 7), lastDone: null }] })); setNewName(""); setNewEvery(7); };
  const delRoutine = (id) => setState((s) => ({ ...s, routines: (s.routines || []).filter((r) => r.id !== id) }));
  const setEvery = (id, v) => setState((s) => ({ ...s, routines: (s.routines || []).map((r) => (r.id === id ? { ...r, everyDays: Math.max(1, r.everyDays + v) } : r)) }));
  return (
    <div onClick={onClose} style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.78)", backdropFilter: "blur(6px)", WebkitBackdropFilter: "blur(6px)", zIndex: 90, display: "flex", alignItems: "center", justifyContent: "center", padding: 20 }}>
      <div onClick={(e) => e.stopPropagation()} style={{ background: "#111814", border: "1px solid rgba(255,255,255,0.1)", borderRadius: 18, padding: "22px 20px", maxWidth: 420, width: "100%", maxHeight: "85vh", overflowY: "auto", boxShadow: "0 24px 60px rgba(0,0,0,0.6)" }}>
        <div style={{ fontFamily: "'Fraunces',serif", fontSize: 20, fontWeight: 500, marginBottom: 4 }}>Rotinas de casa</div>
        <p style={{ fontSize: 12.5, color: "#7d877f", marginBottom: 16 }}>Lembretes recorrentes — fora do score, sem nota.</p>
        {routines.map((r) => (
          <div key={r.id} style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8, padding: "10px 0", borderBottom: "1px solid rgba(255,255,255,0.05)" }}>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontSize: 14 }}>{r.name}</div>
              <div style={{ fontSize: 11, color: "#7d877f", marginTop: 2 }}>a cada {r.everyDays} dia{r.everyDays > 1 ? "s" : ""}</div>
            </div>
            <div style={{ display: "flex", alignItems: "center", gap: 4, flexShrink: 0 }}>
              <button onClick={() => setEvery(r.id, -1)} style={{ width: 28, height: 28, borderRadius: 8, border: "1px solid rgba(255,255,255,0.15)", background: "transparent", color: "#aeb6ae", cursor: "pointer" }}>−</button>
              <button onClick={() => setEvery(r.id, 1)} style={{ width: 28, height: 28, borderRadius: 8, border: "1px solid rgba(255,255,255,0.15)", background: "transparent", color: "#aeb6ae", cursor: "pointer" }}>+</button>
              <button onClick={() => delRoutine(r.id)} style={{ width: 28, height: 28, borderRadius: 8, border: `1px solid ${WARN}44`, background: "transparent", color: WARN, cursor: "pointer", fontSize: 15 }}>×</button>
            </div>
          </div>
        ))}
        <div style={{ display: "flex", gap: 8, marginTop: 16 }}>
          <input value={newName} onChange={(e) => setNewName(e.target.value)} placeholder="Nova rotina" style={{ flex: 1, minWidth: 0, background: "rgba(255,255,255,0.04)", border: "1px solid rgba(255,255,255,0.12)", borderRadius: 10, padding: "10px 12px", color: "#eef2ef", fontSize: 14, outline: "none" }} />
          <input value={newEvery} onChange={(e) => setNewEvery(e.target.value)} type="number" min="1" style={{ width: 60, background: "rgba(255,255,255,0.04)", border: "1px solid rgba(255,255,255,0.12)", borderRadius: 10, padding: "10px 6px", color: "#eef2ef", fontSize: 14, outline: "none", textAlign: "center" }} />
        </div>
        <div style={{ fontSize: 10.5, color: "#6b756d", marginTop: 6 }}>dias entre repetições</div>
        <button onClick={addRoutine} disabled={!newName.trim()} style={{ width: "100%", marginTop: 12, padding: "11px", borderRadius: 11, border: "none", background: newName.trim() ? `linear-gradient(135deg, ${ACCENT}, ${GOLD})` : "rgba(255,255,255,0.06)", color: newName.trim() ? "#080b0a" : "#6b756d", fontWeight: 700, fontSize: 13.5, cursor: newName.trim() ? "pointer" : "not-allowed" }}>Adicionar rotina</button>
        <button onClick={onClose} style={{ width: "100%", marginTop: 8, padding: "10px", borderRadius: 11, border: "none", background: "transparent", color: "#7d877f", fontWeight: 600, fontSize: 13, cursor: "pointer" }}>Fechar</button>
      </div>
    </div>
  );
}

function SearchIcon({ size = 17 }) {
  return (<svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round"><circle cx="11" cy="11" r="7" /><path d="M21 21l-4.3-4.3" /></svg>);
}

function SearchModal({ state, onClose, goTab }) {
  const [q, setQ] = useState("");
  const qq = q.trim().toLowerCase();
  const has = (s) => s && s.toLowerCase().includes(qq);
  let results = [];
  if (qq.length >= 2) {
    (state.goals || []).forEach((g) => { if (has(g.title)) results.push({ type: g.completed ? "Conquista" : "Meta", label: g.title, color: g.completed ? GOLD : ACCENT, tab: g.completed ? "trophies" : "goals" }); });
    (state.objectives || []).forEach((o) => { if (has(o.title)) results.push({ type: "Objetivo", label: o.title, color: "#7aa2ff", tab: "goals" }); });
    (state.skills || []).forEach((sk) => { if (has(sk.name)) results.push({ type: sk.kind === "virtude" ? "Virtude" : "Competência", label: sk.name, color: GOLD, tab: "goals" }); });
    (state.routines || []).forEach((r) => { if (has(r.name)) results.push({ type: "Rotina", label: r.name, color: "#7d877f", tab: "dash" }); });
    ((state.learn || {}).log || []).forEach((l) => { if (has(l.title)) results.push({ type: "Aprendizado", label: l.title, color: GOLD, tab: "dash" }); });
  }
  return (
    <div onClick={onClose} style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.8)", backdropFilter: "blur(6px)", WebkitBackdropFilter: "blur(6px)", zIndex: 90, display: "flex", alignItems: "flex-start", justifyContent: "center", paddingTop: "calc(60px + env(safe-area-inset-top))" }}>
      <div onClick={(e) => e.stopPropagation()} style={{ background: "#111814", border: "1px solid rgba(255,255,255,0.1)", borderRadius: 18, padding: "18px", maxWidth: 460, width: "calc(100% - 32px)", maxHeight: "70vh", overflowY: "auto", boxShadow: "0 24px 60px rgba(0,0,0,0.6)" }}>
        <input autoFocus value={q} onChange={(e) => setQ(e.target.value)} placeholder="Buscar metas, conquistas, competências…" style={{ width: "100%", background: "rgba(255,255,255,0.05)", border: "1px solid rgba(255,255,255,0.12)", borderRadius: 12, padding: "12px 14px", color: "#eef2ef", fontSize: 15, outline: "none" }} />
        <div style={{ marginTop: 14 }}>
          {qq.length < 2 ? <div style={{ fontSize: 12.5, color: "#6b756d", textAlign: "center", padding: "16px 0" }}>Digite ao menos 2 letras.</div>
            : results.length === 0 ? <div style={{ fontSize: 12.5, color: "#6b756d", textAlign: "center", padding: "16px 0" }}>Nada encontrado.</div>
              : results.map((r, i) => (
                <button key={i} onClick={() => { goTab(r.tab); onClose(); }} style={{ width: "100%", textAlign: "left", display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10, padding: "11px 12px", borderRadius: 10, border: "1px solid rgba(255,255,255,0.06)", background: "rgba(255,255,255,0.02)", cursor: "pointer", marginBottom: 6 }}>
                  <span style={{ fontSize: 14, color: "#eef2ef" }}>{r.label}</span>
                  <span style={{ fontSize: 10, color: r.color, border: `1px solid ${r.color}55`, borderRadius: 6, padding: "2px 7px", whiteSpace: "nowrap" }}>{r.type}</span>
                </button>
              ))}
        </div>
      </div>
    </div>
  );
}

function WeeklyDigest({ state, setState }) {
  const T = todayKey();
  const wk = weekKeyOf(T);
  const digest = state.weeklyDigest;
  const current = digest && digest.weekKey === wk ? digest : null;
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState("");
  const enoughData = Object.keys(state.checkIns || {}).length >= 3 || (state.goals || []).length > 0;

  const generate = async () => {
    setLoading(true); setErr("");
    const now = overallScore(state), then = overallScore(state, addDays(T, -7));
    const cats = state.categories.map((c) => ({ area: c.name, nota: Math.round(categoryScore(state, c.id)) }));
    const advanced = (state.goals || []).filter((g) => !g.archived && !g.completed && g.lastProgressDate && dayDiff(g.lastProgressDate, T) <= 7).map((g) => g.title);
    const completedWk = (state.goals || []).filter((g) => g.completed && g.completedDate && dayDiff(g.completedDate, T) <= 7).map((g) => g.title);
    const ciWk = Object.keys(state.checkIns || {}).filter((d) => { const x = dayDiff(d, T); return x >= 0 && x < 7; }).length;
    const refs = Object.keys(state.checkIns || {}).sort().slice(-7).map((d) => (state.checkIns[d]._qa && state.checkIns[d]._qa[0]) || state.checkIns[d]._reflection).filter(Boolean).slice(-5);
    const sys = `Você é o coach do Giovanni (Gio), que mira carreira em private equity (EQT/Advent) e impacto. Escreva o RESUMO DA SEMANA dele: curto, honesto, tom de mentor no time dele. Dados — score agora ${Math.round(now)} (7 dias atrás ${Math.round(then)}); por área ${JSON.stringify(cats)}; check-ins na semana ${ciWk}/7; metas que avançaram ${JSON.stringify(advanced)}; concluídas ${JSON.stringify(completedWk)}; reflexões recentes ${JSON.stringify(refs)}. Responda SOMENTE JSON: {"summary":"2-3 frases sobre como foi a semana","win":"a vitória da semana em 1 frase","focus":"1 foco concreto e específico para a próxima semana"}.`;
    try {
      const res = await fetch(AI_ENDPOINT, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ model: "claude-sonnet-4-20250514", max_tokens: 500, system: sys, messages: [{ role: "user", content: "Gere meu resumo da semana." }] }) });
      const data = await res.json();
      let txt = data.content.filter((b) => b.type === "text").map((b) => b.text).join("\n").replace(/```json|```/g, "").trim();
      const p = JSON.parse(txt);
      setState((s) => ({ ...s, weeklyDigest: { weekKey: wk, summary: p.summary, win: p.win, focus: p.focus, generatedAt: T } }));
    } catch (e) { setErr("Não consegui gerar agora."); }
    setLoading(false);
  };

  useEffect(() => { if (!current && enoughData && !loading) generate(); }, [wk]);

  if (!enoughData) return null;
  return (
    <div className="rise" style={{ background: "linear-gradient(145deg, rgba(122,162,255,0.08), rgba(255,255,255,0.01))", border: "1px solid rgba(122,162,255,0.28)", borderRadius: 18, padding: "16px 18px", marginTop: 12 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: current || loading ? 10 : 0 }}>
        <span style={{ fontSize: 11, color: "#7aa2ff", letterSpacing: "0.12em", textTransform: "uppercase", fontWeight: 600 }}>Resumo da semana</span>
        {current && !loading && <button onClick={generate} style={{ background: "none", border: "none", color: "#7aa2ff", fontSize: 12, fontWeight: 600, cursor: "pointer", padding: 0 }}>atualizar</button>}
      </div>
      {loading ? <div style={{ fontSize: 13, color: "#9aa39a" }}>Gerando seu resumo…</div>
        : current ? (
          <>
            <p style={{ fontSize: 14, color: "#dfe6e0", lineHeight: 1.55, marginBottom: 12 }}>{current.summary}</p>
            <div style={{ fontSize: 12.5, color: "#cdd4cd", marginBottom: 8 }}><span style={{ color: GOLD, fontWeight: 600 }}>Vitória:</span> {current.win}</div>
            <div style={{ fontSize: 12.5, color: "#cdd4cd" }}><span style={{ color: ACCENT, fontWeight: 600 }}>Foco da semana:</span> {current.focus}</div>
          </>
        ) : err ? <button onClick={generate} style={{ fontSize: 13, color: WARN, background: "none", border: "none", cursor: "pointer", padding: 0 }}>{err} Tocar para tentar de novo.</button>
          : <div style={{ fontSize: 13, color: "#9aa39a" }}>Preparando…</div>}
    </div>
  );
}

function LearnCard({ state, onOpen, collapsed, onToggle }) {
  const T = todayKey();
  const learn = state.learn || {};
  const todayTopic = learn.today && learn.today.date === T ? learn.today : null;
  const streak = (learn.streak && learn.streak.count) || 0;
  return (
    <div className="rise" style={{ background: `linear-gradient(145deg, ${GOLD}12, rgba(255,255,255,0.01))`, border: `1px solid ${GOLD}33`, borderRadius: 18, padding: "15px 18px", marginTop: 12 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: collapsed ? 0 : 8 }}>
        <span style={{ fontSize: 11, color: GOLD, letterSpacing: "0.12em", textTransform: "uppercase", fontWeight: 600 }}>Conhecimento do dia</span>
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          {streak > 0 && <span style={{ fontSize: 11, color: "#7d877f" }}>{streak} dia{streak > 1 ? "s" : ""}</span>}
          <button onClick={onToggle} style={{ background: "none", border: "none", color: "#7d877f", cursor: "pointer", padding: 2, display: "inline-flex", transform: collapsed ? "none" : "rotate(180deg)", transition: "transform .2s" }}>▾</button>
        </div>
      </div>
      {!collapsed && (
        <div onClick={onOpen} style={{ cursor: "pointer" }}>
          {todayTopic && todayTopic.done ? (
            <div><span style={{ color: ACCENT }}>✓</span> <span style={{ fontSize: 14 }}>{todayTopic.title}</span><div style={{ fontSize: 11, color: "#6b756d", marginTop: 2 }}>concluído hoje · toque para revisar</div></div>
          ) : todayTopic ? (
            <div><div style={{ fontSize: 14 }}>{todayTopic.title}</div><div style={{ fontSize: 11.5, color: GOLD, marginTop: 3 }}>continuar →</div></div>
          ) : (
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
              <span style={{ fontSize: 14, color: "#dfe6e0" }}>Aprenda um conceito hoje</span>
              <span style={{ color: GOLD, fontSize: 18 }}>→</span>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function LearnModal({ state, setState, onClose }) {
  const T = todayKey();
  const learn = state.learn || {};
  const todayTopic = learn.today && learn.today.date === T ? learn.today : null;
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState("");
  const [picks, setPicks] = useState({});
  const [graded, setGraded] = useState(todayTopic && todayTopic.done ? true : false);
  const [trackPick, setTrackPick] = useState(false);
  const log = learn.log || [];
  const accuracy = log.length ? Math.round(log.reduce((a, l) => a + (l.total ? l.correct / l.total : 0), 0) / log.length * 100) : null;

  const pickRotating = () => {
    const recent = log.slice(-3).map((l) => l.track);
    const pool = ["pe", "lideranca", "filosofia"].filter((t) => !recent.includes(t));
    const arr = pool.length ? pool : ["pe", "lideranca", "filosofia"];
    return arr[Math.floor(Math.random() * arr.length)];
  };

  const generate = async () => {
    setLoading(true); setErr(""); setGraded(false); setPicks({});
    const track = learn.track === "rotativo" ? pickRotating() : learn.track;
    const recentTitles = log.slice(-12).map((l) => l.title);
    const trackDesc = (LEARN_TRACKS.find((x) => x.id === track) || {}).desc || "";
    const sys = `Você prepara a "pílula de conhecimento do dia" do Giovanni (Gio), 19 anos, estudante de Economia no Insper, mirando carreira em private equity (EQT/Advent) e consultoria. Trilha de hoje: ${LEARN_LABEL(track)} (${trackDesc}). Escolha UM conceito específico e valioso dessa trilha, no nível de alguém ambicioso que já sabe o básico — nada raso. Explique de forma clara, concreta e memorável, em português, com um exemplo real quando ajudar. Evite estes tópicos já vistos: ${JSON.stringify(recentTitles)}.
Responda SOMENTE JSON válido, sem markdown: {"title":"nome curto do conceito","explanation":"3 a 5 parágrafos curtos separados por \\n\\n","quiz":[{"q":"pergunta","options":["a","b","c","d"],"answer":0},{...},{...}]}. Exatamente 3 perguntas de múltipla escolha, 4 alternativas cada, "answer" = índice (0-3) da correta. As perguntas devem testar compreensão real, não decoreba.`;
    try {
      const res = await fetch(AI_ENDPOINT, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ model: "claude-sonnet-4-20250514", max_tokens: 1400, system: sys, messages: [{ role: "user", content: "Gere a pílula de hoje." }] }) });
      const data = await res.json();
      let txt = data.content.filter((b) => b.type === "text").map((b) => b.text).join("\n").replace(/```json|```/g, "").trim();
      const parsed = JSON.parse(txt);
      if (!parsed.title || !Array.isArray(parsed.quiz)) throw new Error("formato");
      const topic = { date: T, track, title: parsed.title, explanation: parsed.explanation || "", quiz: parsed.quiz.slice(0, 3), done: false };
      setState((s) => ({ ...s, learn: { ...(s.learn || {}), today: topic } }));
    } catch (e) {
      setErr("Não consegui gerar agora. Tente de novo em instantes.");
    }
    setLoading(false);
  };

  const setTrack = (id) => { setState((s) => ({ ...s, learn: { ...(s.learn || {}), track: id } })); setTrackPick(false); };

  const allPicked = todayTopic && Object.keys(picks).length === (todayTopic.quiz || []).length;
  const grade = () => {
    let correct = 0; const total = (todayTopic.quiz || []).length;
    todayTopic.quiz.forEach((q, i) => { if (picks[i] === q.answer) correct++; });
    setGraded(true);
    setState((s) => {
      const ln = { ...(s.learn || {}) };
      const today = { ...ln.today, done: true, score: { correct, total }, picks };
      const st = ln.streak || { count: 0, lastDay: null };
      let count = st.count || 0, lastDay = st.lastDay;
      if (lastDay !== T) { if (!lastDay) count = 1; else { const gap = dayDiff(lastDay, T); count = gap === 1 ? count + 1 : 1; } lastDay = T; }
      const newLog = [...(ln.log || []), { date: T, track: today.track, title: today.title, correct, total }].slice(-60);
      return { ...s, learn: { ...ln, today, streak: { count, lastDay }, log: newLog } };
    });
  };

  const reviewPicks = graded && todayTopic ? (todayTopic.picks || picks) : picks;

  return (
    <div onClick={onClose} style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.82)", backdropFilter: "blur(6px)", WebkitBackdropFilter: "blur(6px)", zIndex: 90, display: "flex", alignItems: "flex-end", justifyContent: "center" }}>
      <div onClick={(e) => e.stopPropagation()} style={{ background: "#0d1411", border: "1px solid rgba(255,255,255,0.1)", borderTopLeftRadius: 22, borderTopRightRadius: 22, padding: "20px 20px calc(28px + env(safe-area-inset-bottom))", maxWidth: 560, width: "100%", maxHeight: "92vh", overflowY: "auto", boxShadow: "0 -16px 50px rgba(0,0,0,0.6)" }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 6 }}>
          <span style={{ fontSize: 11, color: GOLD, letterSpacing: "0.14em", textTransform: "uppercase", fontWeight: 700 }}>Conhecimento do dia</span>
          <button onClick={onClose} style={{ background: "none", border: "none", color: "#7d877f", fontSize: 20, cursor: "pointer", lineHeight: 1 }}>×</button>
        </div>

        <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 16, flexWrap: "wrap" }}>
          <button onClick={() => setTrackPick((v) => !v)} style={{ fontSize: 11.5, color: "#aeb6ae", background: "rgba(255,255,255,0.05)", border: "1px solid rgba(255,255,255,0.1)", borderRadius: 99, padding: "5px 12px", cursor: "pointer" }}>Trilha: {LEARN_LABEL(learn.track)} ▾</button>
          {(learn.streak && learn.streak.count > 0) ? <span style={{ fontSize: 11, color: "#7d877f" }}>🔥 {learn.streak.count}d</span> : null}
          {accuracy !== null && <span style={{ fontSize: 11, color: "#7d877f" }}>· acerto médio {accuracy}%</span>}
        </div>

        {trackPick && (
          <div style={{ marginBottom: 16, display: "flex", flexDirection: "column", gap: 6 }}>
            {LEARN_TRACKS.map((tr) => (
              <button key={tr.id} onClick={() => setTrack(tr.id)} style={{ textAlign: "left", padding: "10px 12px", borderRadius: 10, border: `1px solid ${learn.track === tr.id ? GOLD + "66" : "rgba(255,255,255,0.1)"}`, background: learn.track === tr.id ? `${GOLD}14` : "transparent", color: "#eef2ef", cursor: "pointer" }}>
                <div style={{ fontSize: 13.5, fontWeight: 600 }}>{tr.label}</div>
                <div style={{ fontSize: 11, color: "#7d877f", marginTop: 2 }}>{tr.desc}</div>
              </button>
            ))}
          </div>
        )}

        {!todayTopic ? (
          <div style={{ textAlign: "center", padding: "24px 0" }}>
            <p style={{ fontSize: 14, color: "#aeb6ae", lineHeight: 1.6, marginBottom: 20 }}>Um conceito por dia, explicado e fixado com um quiz rápido. Pequenos depósitos compostos no seu repertório.</p>
            {err && <p style={{ fontSize: 12.5, color: WARN, marginBottom: 14 }}>{err}</p>}
            <button onClick={generate} disabled={loading} style={{ padding: "14px 32px", borderRadius: 14, border: "none", background: loading ? "rgba(255,255,255,0.06)" : `linear-gradient(135deg, ${ACCENT}, ${GOLD})`, color: loading ? "#6b756d" : "#080b0a", fontWeight: 700, fontSize: 15, cursor: loading ? "default" : "pointer" }}>{loading ? "Gerando…" : "Gerar tópico de hoje"}</button>
          </div>
        ) : (
          <>
            <div style={{ fontSize: 10, color: "#7d877f", letterSpacing: "0.1em", textTransform: "uppercase", marginBottom: 6 }}>{LEARN_LABEL(todayTopic.track)}</div>
            <h2 style={{ fontFamily: "'Fraunces',serif", fontSize: 24, fontWeight: 500, margin: "0 0 14px", lineHeight: 1.25 }}>{todayTopic.title}</h2>
            {(todayTopic.explanation || "").split("\n\n").filter(Boolean).map((p, i) => (
              <p key={i} style={{ fontSize: 14.5, color: "#dfe6e0", lineHeight: 1.65, marginBottom: 12 }}>{p}</p>
            ))}

            <div style={{ borderTop: "1px solid rgba(255,255,255,0.08)", marginTop: 18, paddingTop: 18 }}>
              <div style={{ fontSize: 11, color: GOLD, letterSpacing: "0.12em", textTransform: "uppercase", fontWeight: 600, marginBottom: 14 }}>Fixar — quiz</div>
              {(todayTopic.quiz || []).map((q, qi) => (
                <div key={qi} style={{ marginBottom: 18 }}>
                  <div style={{ fontSize: 14, color: "#eef2ef", marginBottom: 10, lineHeight: 1.4 }}>{qi + 1}. {q.q}</div>
                  <div style={{ display: "flex", flexDirection: "column", gap: 7 }}>
                    {q.options.map((opt, oi) => {
                      const chosen = reviewPicks[qi] === oi;
                      const isCorrect = q.answer === oi;
                      let bd = "rgba(255,255,255,0.1)", bg = "transparent", cl = "#cdd4cd";
                      if (graded) {
                        if (isCorrect) { bd = ACCENT + "88"; bg = `${ACCENT}1e`; cl = ACCENT; }
                        else if (chosen) { bd = WARN + "88"; bg = `${WARN}1e`; cl = WARN; }
                      } else if (chosen) { bd = GOLD + "88"; bg = `${GOLD}1e`; cl = "#eef2ef"; }
                      return (
                        <button key={oi} disabled={graded} onClick={() => setPicks((p) => ({ ...p, [qi]: oi }))} style={{ textAlign: "left", padding: "10px 13px", borderRadius: 10, border: `1px solid ${bd}`, background: bg, color: cl, fontSize: 13.5, cursor: graded ? "default" : "pointer", lineHeight: 1.4 }}>{opt}{graded && isCorrect ? "  ✓" : ""}</button>
                      );
                    })}
                  </div>
                </div>
              ))}
              {!graded ? (
                <button onClick={grade} disabled={!allPicked} style={{ width: "100%", marginTop: 6, padding: "14px", borderRadius: 14, border: "none", background: allPicked ? `linear-gradient(135deg, ${ACCENT}, ${GOLD})` : "rgba(255,255,255,0.06)", color: allPicked ? "#080b0a" : "#6b756d", fontWeight: 700, fontSize: 15, cursor: allPicked ? "pointer" : "not-allowed" }}>{allPicked ? "Concluir" : "Responda as 3 perguntas"}</button>
              ) : (
                <div style={{ textAlign: "center", marginTop: 8 }}>
                  <div style={{ fontFamily: "'Fraunces',serif", fontSize: 26, color: GOLD }}>{(todayTopic.score ? todayTopic.score.correct : 0)}/{(todayTopic.quiz || []).length}</div>
                  <p style={{ fontSize: 13, color: "#9aa39a", marginTop: 4 }}>Registrado. Quer ir mais fundo? Pergunte ao Coach sobre "{todayTopic.title}".</p>
                  <button onClick={onClose} style={{ marginTop: 14, padding: "12px 32px", borderRadius: 14, border: "1px solid rgba(255,255,255,0.14)", background: "transparent", color: "#eef2ef", fontWeight: 600, fontSize: 14, cursor: "pointer" }}>Fechar</button>
                </div>
              )}
            </div>
          </>
        )}
      </div>
    </div>
  );
}

function Dashboard({ state, setState, overall, overallThen, t, onManageRoutines, onLearn }) {
  const tr = trend(overall, overallThen);
  const series30 = useMemo(() => [...Array(30)].map((_, k) => overallScore(state, addDays(todayKey(), -(29 - k)))), [state]);
  const catSeries = useMemo(() => { const o = {}; state.categories.forEach((c) => { o[c.id] = [...Array(14)].map((_, k) => categoryScore(state, c.id, addDays(todayKey(), -(13 - k)))); }); return o; }, [state]);
  const DOW = ["D", "S", "T", "Q", "Q", "S", "S"];
  const week = [...Array(7)].map((_, k) => {
    const dk = addDays(todayKey(), -(6 - k));
    return { on: !!state.checkIns[dk], today: dk === todayKey(), letter: DOW[new Date(dk + "T00:00:00").getDay()] };
  });
  return (
    <div>
      <div className="rise"><NorthBanner north={state.north} onSave={(v) => setState((s) => ({ ...s, north: v }))} /></div>
      <div className="rise" style={{ display: "flex", flexDirection: "column", alignItems: "center", padding: "20px 0 8px" }}>
        <Ring value={overall} color={t.color}>
          <div style={{ fontFamily: "'Fraunces', serif", fontSize: 56, fontWeight: 500, lineHeight: 1 }}>{Math.round(overall)}</div>
          <div style={{ fontSize: 12, color: "#7d877f", letterSpacing: "0.18em", textTransform: "uppercase", marginTop: 4 }}>Overall</div>
          <div style={{ fontSize: 13, color: t.color, fontWeight: 600, marginTop: 8 }}>{t.name} <span style={{ color: tr.c, marginLeft: 4 }}>{tr.g}</span></div>
        </Ring>
      </div>
      <div className="rise" style={{ display: "flex", gap: 7, justifyContent: "center", marginTop: 12, marginBottom: 2 }}>
        {week.map((w, i) => (
          <div key={i} style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 6 }}>
            <div style={{ width: 10, height: 10, borderRadius: 99, background: w.on ? GOLD : "transparent", border: `1.5px solid ${w.on ? GOLD : w.today ? ACCENT : "rgba(255,255,255,0.18)"}`, boxShadow: w.on ? `0 0 7px ${GOLD}77` : "none" }} />
            <span style={{ fontSize: 9, color: w.today ? ACCENT : "#6b756d", fontWeight: w.today ? 700 : 400 }}>{w.letter}</span>
          </div>
        ))}
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: 12, marginTop: 18 }}>
        {state.categories.map((c, i) => {
          const s = categoryScore(state, c.id);
          const sThen = categoryScore(state, c.id, addDays(todayKey(), -7));
          const ctr = trend(s, sThen);
          const mix = c.mix || TYPE_MIX[c.type];
          return (
            <div key={c.id} className="rise" style={{ animationDelay: `${0.08 + i * 0.06}s`, background: "linear-gradient(145deg, rgba(255,255,255,0.04), rgba(255,255,255,0.01))", border: "1px solid rgba(255,255,255,0.07)", borderRadius: 18, padding: "16px 18px" }}>
              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 10 }}>
                <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                  <span style={{ color: c.accent, fontSize: 16 }}>{c.glyph}</span>
                  <span style={{ fontWeight: 600, fontSize: 15 }}>{c.name}</span>
                  <span style={{ fontSize: 10, color: "#7d877f", border: "1px solid rgba(255,255,255,0.1)", borderRadius: 6, padding: "1px 6px" }}>{mix?.label}</span>
                </div>
                <span style={{ fontFamily: "'Fraunces', serif", fontSize: 22, color: c.accent }}>{Math.round(s)}<span style={{ fontSize: 13, color: ctr.c, marginLeft: 5 }}>{ctr.g}</span></span>
              </div>
              <div style={{ height: 7, background: "rgba(255,255,255,0.06)", borderRadius: 99, overflow: "hidden" }}>
                <div style={{ height: "100%", width: `${s}%`, background: `linear-gradient(90deg, ${c.accent}99, ${c.accent})`, borderRadius: 99, transition: "width 1s cubic-bezier(.2,.8,.2,1)", boxShadow: `0 0 12px ${c.accent}66` }} />
              </div>
              <div style={{ marginTop: 8, opacity: 0.85 }}><Sparkline values={catSeries[c.id]} color={c.accent} height={26} /></div>
            </div>
          );
        })}
      </div>
      <div className="rise" style={{ background: "linear-gradient(145deg, rgba(255,255,255,0.04), rgba(255,255,255,0.01))", border: "1px solid rgba(255,255,255,0.07)", borderRadius: 18, padding: "14px 18px 8px", marginTop: 12 }}>
        <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", marginBottom: 8 }}>
          <span style={{ fontSize: 11, color: "#7d877f", letterSpacing: "0.12em", textTransform: "uppercase", fontWeight: 600 }}>Tendência · 30 dias</span>
          <span style={{ fontFamily: "'Fraunces',serif", fontSize: 18, color: t.color }}>{Math.round(overall)}</span>
        </div>
        <Sparkline values={series30} color={t.color} />
      </div>
    </div>
  );
}

function DailyHub({ state, setState, onManageRoutines, onLearn }) {
  const ui = state.ui || {};
  const toggleUI = (key) => setState((s) => ({ ...s, ui: { ...(s.ui || {}), [key]: !(s.ui || {})[key] } }));
  return (
    <div className="rise">
      <h2 style={{ fontFamily: "'Fraunces', serif", fontSize: 24, fontWeight: 500, margin: "12px 0 4px" }}>Hoje</h2>
      <p style={{ color: "#7d877f", fontSize: 13, marginBottom: 4 }}>Seu resumo da semana, a pílula de conhecimento e as rotinas de casa.</p>
      <WeeklyDigest state={state} setState={setState} />
      <LearnCard state={state} onOpen={onLearn} collapsed={!!ui.learnCollapsed} onToggle={() => toggleUI("learnCollapsed")} />
      <RoutinesCard state={state} setState={setState} onManage={onManageRoutines} collapsed={!!ui.routinesCollapsed} onToggle={() => toggleUI("routinesCollapsed")} />
    </div>
  );
}

// Banco de perguntas noturnas, ancorado em evidências de psicologia:
// Três Coisas Boas (Seligman 2005), gratidão com significado, escrita expressiva (Pennebaker),
// distanciamento de si / autocompaixão, reframe CBT, alinhamento de valores, WOOP/intenções de implementação.
const NIGHT_POOL = [
  // — Três Coisas Boas / vitórias + a CAUSA (Seligman)
  "Qual foi a melhor coisa de hoje — e por que ela aconteceu?",
  "Cite uma vitória de hoje e o que VOCÊ fez para que ela acontecesse.",
  "Que pequeno momento bom de hoje quase passou despercebido?",
  "O que te deu mais orgulho hoje, e o que isso revela sobre você?",
  "O que te fez sorrir de verdade hoje?",
  "Que progresso real, por menor que seja, você fez numa meta hoje?",
  // — Gratidão com significado
  "Pelo que você é grato hoje, e por que isso importa pra você?",
  "Quem fez algo por você hoje que merece reconhecimento?",
  "Pelo que, hoje, você diria obrigado a Deus?",
  "Você foi grato às pessoas que te formaram (família) hoje?",
  // — Escrita expressiva / processamento de emoção (Pennebaker)
  "Qual emoção foi mais forte hoje, e o que ela está tentando te dizer?",
  "O que mais te incomodou hoje — e o que pode estar por trás disso?",
  "Tem algo pesando na sua cabeça que você ainda não colocou em palavras?",
  "Qual foi o momento mais difícil do dia, e como você reagiu?",
  // — Reframe cognitivo (CBT)
  "Que pensamento negativo te pegou hoje? Qual a evidência a favor e contra ele?",
  "Que medo apareceu hoje — quão provável ele realmente é?",
  "Onde você foi duro demais consigo mesmo hoje?",
  // — Distanciamento de si / autocompaixão
  "Se seu melhor amigo tivesse vivido o seu dia, que conselho você daria a ele?",
  "Olhando de fora, o que você diria sobre como reagiu hoje?",
  // — Alinhamento de valores
  "Suas ações de hoje estiveram alinhadas com seus valores? Onde não?",
  "Você agiu pelos seus princípios ou pela conveniência hoje?",
  "Você foi honesto consigo mesmo hoje em tudo?",
  "O que hoje testou seu caráter?",
  // — WOOP / plano "se… então…" para amanhã
  "Qual o maior obstáculo provável amanhã, e qual seu plano 'se… então…' pra ele?",
  "Qual a única coisa que, feita amanhã, tornaria o dia um sucesso?",
  "Que hábito de hoje você quer repetir amanhã, e como vai garantir isso?",
  "O que você faria diferente se pudesse repetir o dia?",
  // — Eu futuro / sentido (Best Possible Self)
  "Que decisão de hoje o seu 'eu de 29 anos' aprovaria?",
  "O que hoje te aproximou ou afastou da pessoa que você quer ser?",
  "Que semente você plantou hoje que só colhe lá na frente?",
  "Que parte do seu dia te aproximou do PE?",
  "Qual lição de hoje você passaria a um futuro filho seu?",
  // — Foco, disciplina e pontos cegos (seus)
  "Quanto tempo você perdeu no celular hoje, de verdade?",
  "O que você adiou hoje — e por quê?",
  "Em que você foi disciplinado hoje sem precisar de motivação?",
  "Você buscou reconhecimento hoje mais do que devia?",
  "O que você evitou hoje sabendo que devia fazer?",
  "Você se moveu pelo essencial ou só pelo urgente hoje?",
  "Você disse 'não' a algo que precisava recusar?",
  // — Energia e corpo (autorregulação)
  "O que te deu e o que te drenou energia hoje?",
  "O que seu corpo te pediu hoje que você ignorou?",
  "Você descansou o suficiente pra render amanhã?",
  "Como estava sua energia ao acordar, e o que isso te diz?",
  // — Relacionamentos
  "Você tratou a Sofia e as pessoas próximas como merecem hoje?",
  "Qual conversa de hoje importou de verdade?",
  "Você foi generoso com alguém hoje sem esperar nada em troca?",
  // — Fé e interior
  "Como você cuidou da sua fé ou do seu interior hoje?",
  // — Coragem e crescimento
  "Onde você foi corajoso hoje?",
  "Qual desconforto de hoje valeu a pena?",
  "O que você aprendeu hoje que vale levar pra vida?",
  "Qual ideia nova te empolgou hoje?",
  // — Autoavaliação e savoring
  "Se hoje fosse um treino, que nota você se daria, e por quê?",
  "O que você faria exatamente igual de novo?",
  "Qual foi o melhor uso do seu tempo hoje?",
  "Que pequeno prazer você se permitiu hoje — e mereceu?",
  "Qual foi o momento em que você se sentiu mais vivo?",
  "Quem você admirou hoje, e por quê?",
  "Que verdade você está evitando encarar?",
  "Que problema você resolveu hoje que vinha empurrando?",
  "Você cumpriu o que prometeu a si mesmo ontem?",
];
function nightQuestions(dateKey) {
  const d = new Date(dateKey + "T00:00:00");
  const seed = d.getFullYear() * 366 + d.getMonth() * 31 + d.getDate();
  const i = seed % NIGHT_POOL.length;
  let j = (seed * 7 + 5) % NIGHT_POOL.length;
  if (j === i) j = (j + 1) % NIGHT_POOL.length;
  return [NIGHT_POOL[i], NIGHT_POOL[j]];
}

const STREAK_MILES = CONFIG.streakMilestones;
function streakMilestone(n) { return STREAK_MILES.find((m) => m.n === n) || null; }

function VoiceTextarea({ value, onChange, placeholder, rows = 3 }) {
  const [listening, setListening] = useState(false);
  const recRef = useRef(null);
  const valRef = useRef(value);
  useEffect(() => { valRef.current = value; }, [value]);
  const supported = typeof window !== "undefined" && (window.SpeechRecognition || window.webkitSpeechRecognition);
  const toggle = () => {
    if (listening) { try { recRef.current && recRef.current.stop(); } catch (e) {} setListening(false); return; }
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition; if (!SR) return;
    const r = new SR(); r.lang = "pt-BR"; r.continuous = true; r.interimResults = false;
    r.onresult = (e) => { const res = e.results[e.results.length - 1]; if (res.isFinal) { const t = res[0].transcript.trim(); const base = valRef.current ? valRef.current.replace(/\s*$/, "") + " " : ""; onChange(base + t); } };
    r.onerror = () => setListening(false); r.onend = () => setListening(false);
    recRef.current = r; try { r.start(); setListening(true); } catch (e) {}
  };
  return (
    <div>
      <div style={{ position: "relative" }}>
        <textarea value={value} onChange={(e) => onChange(e.target.value)} placeholder={placeholder} rows={rows} style={{ width: "100%", background: "rgba(255,255,255,0.04)", border: `1px solid ${listening ? ACCENT : "rgba(255,255,255,0.1)"}`, borderRadius: 10, padding: "12px 14px", paddingRight: 46, color: "#eef2ef", fontSize: 14, outline: "none", fontFamily: "inherit", resize: "vertical", lineHeight: 1.5 }} />
        {supported && (
          <button onClick={toggle} title={listening ? "Parar" : "Falar"} style={{ position: "absolute", right: 9, bottom: 11, width: 32, height: 32, borderRadius: 99, border: "none", background: listening ? ACCENT : "rgba(255,255,255,0.08)", color: listening ? "#080b0a" : "#aeb6ae", cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center", animation: listening ? "pulse 1.4s infinite" : "none" }}>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><rect x="9" y="2" width="6" height="12" rx="3" /><path d="M5 10v1a7 7 0 0 0 14 0v-1" /><line x1="12" y1="19" x2="12" y2="22" /></svg>
          </button>
        )}
      </div>
      {listening && <div style={{ fontSize: 11, color: ACCENT, marginTop: 6 }}>Ouvindo… toque no microfone para parar.</div>}
    </div>
  );
}

function CheckIn({ state, setState, showToast, goDash }) {
  const today = todayKey();
  const saved = state.checkIns[today] || {};
  const dailyQ = nightQuestions(today)[0];
  const yPlan = (state.checkIns[addDays(today, -1)] || {})._tomorrowPlan || "";
  const [answers, setAnswers] = useState(saved);
  const [ans, setAns] = useState((saved._qa && saved._qa[0]) || "");
  const [note, setNote] = useState(saved._reflection || "");
  const [planKept, setPlanKept] = useState(saved._planKept ?? null);
  const [tomorrowPlan, setTomorrowPlan] = useState(saved._tomorrowPlan || "");
  const [energy, setEnergy] = useState(saved._energy || 0);
  const [result, setResult] = useState(null);

  const setA = (id, v) => setAnswers((a) => ({ ...a, [id]: v }));
  const quantDone = state.questions.every((q) => answers[q.id] !== undefined);
  const done = quantDone; // reflexão é opcional — só as áreas são exigidas, para o uso diário ser leve

  const save = async () => {
    const dayObj = { ...answers, _q: [dailyQ], _qa: [ans.trim()], _reflection: note.trim(), _prompt: dailyQ, _tomorrowPlan: tomorrowPlan.trim(), _planKept: planKept, _energy: energy };
    const newCheckIns = { ...state.checkIns, [today]: dayObj };
    const adv = advanceStreak(state.streak, today);
    setState((s) => ({ ...s, checkIns: newCheckIns, streak: adv.streak }));
    const streak = adv.streak.count;
    const mile = streakMilestone(streak);
    setResult({ loading: true, streak, mile, shields: adv.streak.shields, usedShield: adv.usedShield, grantedShield: adv.grantedShield });

    const catAvgs = state.categories.map((c) => {
      const cq = state.questions.filter((q) => q.cat === c.id);
      let tot = 0, cnt = 0;
      cq.forEach((q) => { const v = answers[q.id]; if (v !== undefined) { tot += q.type === "bool" ? (v ? 100 : 0) : v * 10; cnt++; } });
      return { area: c.name, nota: cnt ? Math.round(tot / cnt) : null };
    });
    const reflexoes = [{ pergunta: dailyQ, resposta: ans }];
    const planoOntem = yPlan ? { plano: yPlan, cumpriu: planKept } : null;
    const sys = `Você é o coach do Giovanni (Gio) no app Ascend. Ele acabou de fazer o check-in noturno. Em português, tom de mentor exigente mas no time dele, gere uma avaliação curtíssima do dia + UMA dica concreta para amanhã. Considere a ambição dele (carreira em PE, EQT/Advent, impacto) e seus pontos cegos (procrastinação, dependência de celular/dopamina). Se ele tinha um plano de ontem, comente se cumpriu. Se o streak bateu um marco, comemore com sobriedade. Responda SOMENTE JSON válido: {"message":"2-3 frases avaliando o dia","tip":"1 frase, uma ação concreta para amanhã"}.
Dados de hoje — notas por área: ${JSON.stringify(catAvgs)}; energia (1-5, 0=não informou): ${energy}; reflexões: ${JSON.stringify(reflexoes)}; nota livre: ${JSON.stringify((note || "").slice(0, 200))}; plano de ontem: ${JSON.stringify(planoOntem)}; intenção p/ amanhã: ${JSON.stringify(tomorrowPlan.slice(0, 160))}; streak: ${streak} dias${mile ? " (marco: " + mile.label + ")" : ""}.`;
    try {
      const res = await fetch(AI_ENDPOINT, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ model: "claude-sonnet-4-20250514", max_tokens: 400, system: sys, messages: [{ role: "user", content: "Avalie meu dia." }] }) });
      const data = await res.json();
      let txt = data.content.filter((b) => b.type === "text").map((b) => b.text).join("\n").replace(/```json|```/g, "").trim();
      let parsed; try { parsed = JSON.parse(txt); } catch { parsed = { message: txt || "Dia registrado. Constância é o que constrói.", tip: "Comece amanhã pela tarefa que você mais quer evitar." }; }
      setResult((r) => ({ ...r, loading: false, message: parsed.message, tip: parsed.tip }));
    } catch (e) {
      setResult((r) => ({ ...r, loading: false, message: `Mais um dia no quadro, Gio — ${streak} seguido(s). A constância é o que separa quem fala de quem faz.`, tip: "Amanhã, ataque primeiro a tarefa que você mais quer evitar." }));
    }
  };

  if (result) {
    return (
      <div className="rise" style={{ minHeight: "70vh", display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", textAlign: "center", padding: "20px 0" }}>
        <div style={{ fontSize: 12, color: "#7d877f", letterSpacing: "0.18em", textTransform: "uppercase" }}>Check-in concluído</div>
        <div style={{ marginTop: 14, display: "flex", justifyContent: "center" }}><Flame size={58} color={GOLD} strokeWidth={1.5} glow /></div>
        <div style={{ fontFamily: "'Fraunces',serif", fontSize: 40, fontWeight: 500, marginTop: 4 }}>{result.streak} <span style={{ fontSize: 17, color: "#7d877f" }}>dias seguidos</span></div>
        {result.mile && <div style={{ marginTop: 12, display: "inline-block", background: `${GOLD}1f`, border: `1px solid ${GOLD}55`, color: GOLD, borderRadius: 99, padding: "6px 16px", fontSize: 13, fontWeight: 700, animation: "popIn .5s both" }}>✦ {result.mile.label}</div>}
        {result.usedShield && <div style={{ marginTop: 10, display: "flex", alignItems: "center", gap: 6, color: "#7aa2ff", fontSize: 12.5 }}><Shield size={14} color="#7aa2ff" filled /> Um escudo protegeu seu streak.</div>}
        {result.grantedShield && <div style={{ marginTop: 8, display: "flex", alignItems: "center", gap: 6, color: "#7aa2ff", fontSize: 12.5 }}><Shield size={14} color="#7aa2ff" filled /> Novo escudo conquistado!</div>}
        <div style={{ marginTop: 24, maxWidth: 460, width: "100%" }}>
          {result.loading ? (
            <div style={{ color: "#7d877f", fontSize: 14 }}>O Coach está anotando uma observação… pode continuar.</div>
          ) : (
            <>
              <p style={{ fontSize: 15, lineHeight: 1.6, color: "#eef2ef" }}>{result.message}</p>
              <div style={{ marginTop: 18, background: "rgba(255,255,255,0.04)", border: `1px solid ${ACCENT}33`, borderRadius: 14, padding: "14px 16px", textAlign: "left" }}>
                <div style={{ fontSize: 11, color: ACCENT, letterSpacing: "0.12em", textTransform: "uppercase", fontWeight: 600, marginBottom: 6 }}>Para amanhã</div>
                <div style={{ fontSize: 14, color: "#dfe6e0", lineHeight: 1.5 }}>{result.tip}</div>
              </div>
            </>
          )}
        </div>
        <button onClick={goDash} style={{ marginTop: 26, padding: "14px 44px", borderRadius: 14, border: "none", background: `linear-gradient(135deg, ${ACCENT}, ${GOLD})`, color: "#080b0a", fontWeight: 700, fontSize: 15, cursor: "pointer" }}>Continuar</button>
      </div>
    );
  }

  return (
    <div className="rise">
      <h2 style={{ fontFamily: "'Fraunces', serif", fontSize: 24, fontWeight: 500, margin: "12px 0 4px" }}>Check-in de hoje</h2>
      <p style={{ color: "#7d877f", fontSize: 13, marginBottom: 20 }}>Notas rápidas e a reflexão da noite. Menos de 5 minutos, e mantém seu streak vivo.</p>
      {state.categories.map((cat) => {
        const qs = state.questions.filter((q) => q.cat === cat.id);
        if (!qs.length) return null;
        return (
          <div key={cat.id} style={{ marginBottom: 22 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 10, color: cat.accent, fontSize: 12, letterSpacing: "0.12em", textTransform: "uppercase", fontWeight: 600 }}><span>{cat.glyph}</span>{cat.name}</div>
            {qs.map((q) => (
              <div key={q.id} style={{ background: "rgba(255,255,255,0.03)", border: "1px solid rgba(255,255,255,0.06)", borderRadius: 14, padding: "14px 16px", marginBottom: 10 }}>
                <div style={{ fontSize: 14, marginBottom: 12 }}>{q.text}</div>
                {q.type === "bool" ? (
                  <div style={{ display: "flex", gap: 8 }}>
                    {[{ v: true, l: "Sim" }, { v: false, l: "Não" }].map((o) => (
                      <button key={o.l} onClick={() => setA(q.id, o.v)} style={{ flex: 1, padding: "10px", borderRadius: 10, border: "1px solid", borderColor: answers[q.id] === o.v ? cat.accent : "rgba(255,255,255,0.1)", background: answers[q.id] === o.v ? `${cat.accent}22` : "transparent", color: answers[q.id] === o.v ? cat.accent : "#aeb6ae", fontWeight: 600, cursor: "pointer", fontSize: 14 }}>{o.l}</button>
                    ))}
                  </div>
                ) : (
                  <div style={{ display: "flex", gap: 5, flexWrap: "wrap" }}>
                    {[...Array(11)].map((_, n) => (
                      <button key={n} onClick={() => setA(q.id, n)} style={{ width: 30, height: 34, borderRadius: 8, border: "1px solid", borderColor: answers[q.id] === n ? cat.accent : "rgba(255,255,255,0.08)", background: answers[q.id] === n ? cat.accent : "transparent", color: answers[q.id] === n ? "#080b0a" : "#aeb6ae", fontWeight: 600, cursor: "pointer", fontSize: 13 }}>{n}</button>
                    ))}
                  </div>
                )}
              </div>
            ))}
          </div>
        );
      })}

      <div style={{ marginBottom: 18, background: "rgba(255,255,255,0.03)", border: "1px solid rgba(255,255,255,0.06)", borderRadius: 14, padding: "14px 16px" }}>
        <div style={{ fontSize: 13, color: "#9aa39a", marginBottom: 10 }}>Energia hoje (opcional)</div>
        <div style={{ display: "flex", gap: 7 }}>
          {[{ v: 1, l: "Muito baixa" }, { v: 2, l: "Baixa" }, { v: 3, l: "Média" }, { v: 4, l: "Alta" }, { v: 5, l: "Muito alta" }].map((o) => {
            const on = energy === o.v;
            const col = o.v <= 2 ? WARN : o.v === 3 ? GOLD : ACCENT;
            return <button key={o.v} onClick={() => setEnergy(on ? 0 : o.v)} style={{ flex: 1, padding: "8px 2px", borderRadius: 9, border: "1px solid", borderColor: on ? col : "rgba(255,255,255,0.1)", background: on ? `${col}1e` : "transparent", color: on ? col : "#8a938a", fontSize: 10.5, fontWeight: 600, cursor: "pointer", lineHeight: 1.2 }}>{o.l}</button>;
          })}
        </div>
      </div>

      <div style={{ marginBottom: 22 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 12, color: GOLD, fontSize: 12, letterSpacing: "0.12em", textTransform: "uppercase", fontWeight: 600 }}><span>✦</span>Reflexão da noite</div>
        {yPlan && (
          <div style={{ background: `${ACCENT}10`, border: `1px solid ${ACCENT}33`, borderRadius: 14, padding: "14px 16px", marginBottom: 10 }}>
            <div style={{ fontSize: 10.5, color: ACCENT, letterSpacing: "0.08em", textTransform: "uppercase", fontWeight: 600, marginBottom: 6 }}>Seu plano de ontem</div>
            <div style={{ fontSize: 14, color: "#dfe6e0", lineHeight: 1.4, marginBottom: 12, fontStyle: "italic" }}>"{yPlan}"</div>
            <div style={{ fontSize: 12.5, color: "#9aa39a", marginBottom: 8 }}>Você cumpriu?</div>
            <div style={{ display: "flex", gap: 8 }}>
              {[{ v: true, l: "Cumpri" }, { v: false, l: "Não" }].map((o) => (
                <button key={o.l} onClick={() => setPlanKept(o.v)} style={{ flex: 1, padding: "9px", borderRadius: 10, border: "1px solid", borderColor: planKept === o.v ? ACCENT : "rgba(255,255,255,0.1)", background: planKept === o.v ? `${ACCENT}22` : "transparent", color: planKept === o.v ? ACCENT : "#aeb6ae", fontWeight: 600, cursor: "pointer", fontSize: 13 }}>{o.l}</button>
              ))}
            </div>
          </div>
        )}
        <div style={{ background: "rgba(255,255,255,0.03)", border: "1px solid rgba(255,255,255,0.06)", borderRadius: 14, padding: "14px 16px", marginBottom: 10 }}>
          <div style={{ fontSize: 10.5, color: GOLD, letterSpacing: "0.08em", textTransform: "uppercase", fontWeight: 600, marginBottom: 8 }}>Reflexão de hoje · opcional</div>
          <div style={{ fontSize: 14, marginBottom: 12, color: "#dfe6e0", lineHeight: 1.4 }}>{dailyQ}</div>
          <VoiceTextarea value={ans} onChange={setAns} placeholder="Escreva ou fale…" rows={3} />
        </div>
        <div style={{ background: "rgba(255,255,255,0.03)", border: "1px solid rgba(255,255,255,0.06)", borderRadius: 14, padding: "14px 16px" }}>
          <div style={{ fontSize: 13, marginBottom: 4, color: "#9aa39a" }}>Intenção para amanhã (opcional)</div>
          <div style={{ fontSize: 11, color: "#6b756d", marginBottom: 10 }}>Formato "se… então…" — ex.: "Se bater preguiça às 8h, então abro o material antes do café."</div>
          <VoiceTextarea value={tomorrowPlan} onChange={setTomorrowPlan} placeholder="Se… então…" rows={2} />
        </div>
        <p style={{ fontSize: 11, color: "#6b756d", marginTop: 10, lineHeight: 1.5 }}>Seu diário fica guardado em privado — não aparece em nenhuma tela. Só o Coach IA lê, e te dá leituras sinceras quando você pedir (ex.: "o que você percebe nas minhas reflexões?").</p>
      </div>

      <button onClick={save} disabled={!done} style={{ width: "100%", padding: "16px", borderRadius: 14, border: "none", background: done ? `linear-gradient(135deg, ${ACCENT}, ${GOLD})` : "rgba(255,255,255,0.06)", color: done ? "#080b0a" : "#6b756d", fontWeight: 700, fontSize: 15, cursor: done ? "pointer" : "not-allowed" }}>{done ? "Registrar check-in" : "Responda as áreas para registrar"}</button>
    </div>
  );
}

function ProgBar({ pct, color, big }) {
  return (
    <div style={{ height: big ? 11 : 9, background: "rgba(255,255,255,0.06)", borderRadius: 99, overflow: "hidden", position: "relative" }}>
      <div style={{ height: "100%", width: pct + "%", borderRadius: 99, transition: "width .9s cubic-bezier(.2,.8,.2,1)", background: `linear-gradient(90deg, ${color}, ${color}aa, ${color})`, backgroundSize: "200% 100%", animation: "shimmer 2.6s linear infinite", boxShadow: `0 0 12px ${color}88`, position: "relative", overflow: "hidden" }}>
        <div style={{ position: "absolute", top: 0, bottom: 0, width: "38%", background: "linear-gradient(90deg,transparent,rgba(255,255,255,.4),transparent)", animation: "shineSweep 2.4s ease-in-out infinite" }} />
      </div>
    </div>
  );
}

function Confetti() {
  const cols = [ACCENT, GOLD, "#7aa2ff", WARN, "#e8a657"];
  const pieces = Array.from({ length: 18 }, (_, i) => {
    const ang = (Math.PI * 2 * i) / 18 + (i % 3) * 0.4;
    const dist = 42 + (i % 5) * 14;
    return { tx: Math.cos(ang) * dist, ty: Math.sin(ang) * dist - 12, rot: (i * 47) % 360, c: cols[i % cols.length], d: (i % 4) * 0.04 };
  });
  return (
    <div style={{ position: "absolute", left: "50%", top: "50%", pointerEvents: "none", zIndex: 6 }}>
      {pieces.map((p, i) => (
        <span key={i} style={{ position: "absolute", width: 7, height: 7, borderRadius: 1, background: p.c, "--tx": p.tx + "px", "--ty": p.ty + "px", "--rot": p.rot + "deg", animation: `confetti .95s ease-out ${p.d}s forwards` }} />
      ))}
    </div>
  );
}

function SkillBar({ level, color }) {
  return (
    <div style={{ display: "flex", gap: 4 }}>
      {[1, 2, 3, 4, 5].map((i) => (
        <div key={i} style={{ flex: 1, height: 6, borderRadius: 99, background: i <= level ? color : "rgba(255,255,255,0.08)", boxShadow: i <= level ? `0 0 6px ${color}77` : "none", transition: "background .4s" }} />
      ))}
    </div>
  );
}

function Competencias({ state }) {
  const [detail, setDetail] = useState(null);
  const skills = state.skills || [];
  const virtues = skills.filter((s) => s.kind === "virtude");
  const others = skills.filter((s) => s.kind !== "virtude");
  const colorOf = (sk) => sk.kind === "virtude" ? GOLD : (state.categories.find((c) => c.id === sk.cat)?.accent || ACCENT);

  const renderSkill = (sk) => {
    const color = colorOf(sk);
    const lvl = sk.level || 0;
    return (
      <div key={sk.id} onClick={() => setDetail(sk)} style={{ background: "linear-gradient(145deg, rgba(255,255,255,0.04), rgba(255,255,255,0.01))", border: "1px solid rgba(255,255,255,0.07)", borderRadius: 16, padding: "16px 18px", marginBottom: 11, cursor: "pointer" }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: 9 }}>
          <span style={{ fontWeight: 600, fontSize: 15.5 }}>{sk.name}</span>
          <span style={{ fontSize: 11, color: lvl ? color : "#6b756d" }}>{SKILL_LEVELS[lvl]}{lvl ? ` · ${lvl}/5` : ""}</span>
        </div>
        <SkillBar level={lvl} color={color} />
        <div style={{ fontSize: 12.5, color: "#9aa39a", marginTop: 10, lineHeight: 1.45 }}>{sk.why}</div>
        {sk.lastAssessed && <div style={{ fontSize: 10.5, color: "#6b756d", marginTop: 8 }}>Última leitura do Coach · {sk.lastAssessed}</div>}
      </div>
    );
  };

  return (
    <div>
      <p style={{ color: "#7d877f", fontSize: 13, marginBottom: 20, lineHeight: 1.5 }}>Quem você está se tornando. O Coach avalia seu nível com base em evidência do seu diário — você sobe agindo, não se declarando.</p>

      {virtues.length > 0 && (
        <div style={{ marginBottom: 26 }}>
          <div style={{ fontSize: 12, letterSpacing: "0.12em", textTransform: "uppercase", fontWeight: 600, color: GOLD, marginBottom: 4 }}>Virtudes cardeais</div>
          <p style={{ fontSize: 11.5, color: "#6b756d", marginBottom: 14, lineHeight: 1.5 }}>As quatro raízes do caráter — prudência, justiça, fortaleza e temperança.</p>
          {virtues.map(renderSkill)}
        </div>
      )}

      {others.length > 0 && (
        <div>
          <div style={{ fontSize: 12, letterSpacing: "0.12em", textTransform: "uppercase", fontWeight: 600, color: "#7d877f", marginBottom: 14 }}>Competências</div>
          {others.map(renderSkill)}
        </div>
      )}

      {!skills.length && <p style={{ color: "#6b756d", fontSize: 13, textAlign: "center", marginTop: 40, lineHeight: 1.6 }}>Nenhuma competência ainda.<br />Peça ao Coach: "crie a competência ownership".</p>}

      {detail && (() => {
        const color = colorOf(detail);
        const kindLabel = detail.kind === "virtude" ? "virtude" : "competência";
        return (
          <div onClick={() => setDetail(null)} style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.65)", backdropFilter: "blur(4px)", zIndex: 60, display: "flex", alignItems: "center", justifyContent: "center", padding: 20 }}>
            <div onClick={(e) => e.stopPropagation()} style={{ background: "#111814", border: `1px solid ${color}44`, borderRadius: 18, padding: "22px 20px", maxWidth: 420, width: "100%", maxHeight: "82vh", overflowY: "auto" }}>
              {detail.kind === "virtude" && <div style={{ fontSize: 10, letterSpacing: "0.14em", textTransform: "uppercase", color: GOLD, fontWeight: 700, marginBottom: 6 }}>Virtude cardeal</div>}
              <div style={{ fontFamily: "'Fraunces',serif", fontSize: 22, fontWeight: 500 }}>{detail.name}</div>
              <div style={{ fontSize: 11.5, color: detail.level ? color : "#6b756d", margin: "6px 0 12px" }}>{SKILL_LEVELS[detail.level || 0]}{detail.level ? ` · nível ${detail.level} de 5` : ""}</div>
              <SkillBar level={detail.level || 0} color={color} />
              <div style={{ fontSize: 13.5, color: "#cdd4cd", lineHeight: 1.6, marginTop: 16 }}>{detail.why}</div>
              <div style={{ fontSize: 11, letterSpacing: "0.1em", textTransform: "uppercase", color: "#7d877f", marginTop: 18, marginBottom: 9 }}>Comportamentos a praticar</div>
              <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                {(detail.behaviors || []).map((b) => (
                  <div key={b.id} style={{ display: "flex", alignItems: "flex-start", gap: 10, fontSize: 13, color: "#cdd4cd", lineHeight: 1.4 }}>
                    <span style={{ color: color, marginTop: 2 }}>▸</span>{b.text}
                  </div>
                ))}
              </div>
              {detail.note && (<>
                <div style={{ fontSize: 11, letterSpacing: "0.1em", textTransform: "uppercase", color: "#7d877f", marginTop: 18, marginBottom: 7 }}>Última leitura do Coach</div>
                <div style={{ fontSize: 13, color: "#dfe6e0", lineHeight: 1.55, fontStyle: "italic" }}>"{detail.note}"</div>
              </>)}
              <div style={{ fontSize: 11.5, color: "#6b756d", marginTop: 18, lineHeight: 1.5 }}>Para evoluir, peça ao Coach: "avalie minha {kindLabel} de {detail.name.toLowerCase()}".</div>
              <button onClick={() => setDetail(null)} style={{ width: "100%", marginTop: 18, padding: "11px", borderRadius: 10, border: "1px solid rgba(255,255,255,0.12)", background: "transparent", color: "#aeb6ae", fontWeight: 600, fontSize: 13, cursor: "pointer" }}>Fechar</button>
            </div>
          </div>
        );
      })()}
    </div>
  );
}

function Goals({ state, setState }) {
  const [skillView, setSkillView] = useState("metas");
  const [openArea, setOpenArea] = useState(null);
  const [openPrazo, setOpenPrazo] = useState(null);
  const [noteEdit, setNoteEdit] = useState(null);
  const [noteDraft, setNoteDraft] = useState("");
  const saveNote = (goalId) => { setState((s) => ({ ...s, goals: s.goals.map((g) => (g.id === goalId ? { ...g, notes: noteDraft.trim() } : g)) })); setNoteEdit(null); };
  const [celebrating, setCelebrating] = useState(null);
  const active = state.goals.filter((g) => !g.completed && !g.archived);
  const T = todayKey();

  const fireCelebration = (id) => { setCelebrating(id); setTimeout(() => setCelebrating((c) => (c === id ? null : c)), 1600); };

  const toggleMilestone = (goalId, mId) => {
    const g0 = state.goals.find((x) => x.id === goalId);
    let willComplete = false;
    if (g0 && g0.kind === "milestone") {
      const after = g0.milestones.map((m) => (m.id === mId ? { ...m, done: !m.done } : m));
      willComplete = after.length > 0 && after.every((m) => m.done);
    }
    setState((s) => {
      let ns = JSON.parse(JSON.stringify(s));
      const g = ns.goals.find((x) => x.id === goalId); if (!g) return s;
      const m = g.milestones.find((x) => x.id === mId); if (!m) return s;
      m.done = !m.done; m.doneDate = m.done ? T : null; m.provisional = m.done;
      if (m.done) g.lastProgressDate = T;
      return ns;
    });
    if (willComplete) fireCelebration(goalId);
  };
  const stepMetric = (goalId, delta) => {
    const g0 = state.goals.find((x) => x.id === goalId);
    let willComplete = false;
    if (g0 && g0.kind === "metric") {
      const next = Math.max(0, Math.min(g0.metricTarget, (g0.metricCurrent || 0) + delta));
      willComplete = next >= g0.metricTarget && delta > 0;
    }
    setState((s) => {
      let ns = JSON.parse(JSON.stringify(s));
      const g = ns.goals.find((x) => x.id === goalId); if (!g || g.kind !== "metric") return s;
      g.metricCurrent = Math.max(0, Math.min(g.metricTarget, (g.metricCurrent || 0) + delta));
      g.metricProvisional = true; g.lastProgressDate = T;
      return ns;
    });
    if (willComplete) fireCelebration(goalId);
  };
  const conquer = (goalId) => {
    setState((s) => { let ns = JSON.parse(JSON.stringify(s)); const g = ns.goals.find((x) => x.id === goalId); if (g) { g.completed = true; g.completedDate = todayKey(); g.lastProgressDate = todayKey(); g.trophyVerified = false; } return ns; });
  };

  const renderCard = (g) => {
    const cat = state.categories.find((c) => c.id === g.cat);
    const obj = (state.objectives || []).find((o) => o.id === g.objId);
    const prog = Math.round(goalProgress(g) * 100);
    const H = HORIZON[g.horizon];
    const chip = freshnessChip(goalFreshness(g, T));
    const prov = hasProvisional(g);
    const celeb = celebrating === g.id;
    return (
      <div key={g.id} style={{ background: celeb ? `linear-gradient(145deg, ${GOLD}1c, rgba(255,255,255,0.02))` : "rgba(255,255,255,0.03)", border: `1px solid ${celeb ? GOLD + "66" : "rgba(255,255,255,0.06)"}`, borderRadius: 14, padding: "14px 16px", marginBottom: 10, position: "relative", overflow: "hidden", transition: "all .4s", animation: celeb ? "trophyGlow 1.5s ease" : "none" }}>
        {celeb && <Confetti />}
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 10, marginBottom: 8 }}>
          <div style={{ fontSize: 14, lineHeight: 1.35 }}>{g.title}</div>
          <span style={{ fontFamily: "'Fraunces', serif", fontSize: 20, color: prog === 100 ? GOLD : H.color, whiteSpace: "nowrap" }}>{prog}%</span>
        </div>
        <div style={{ marginBottom: 12 }}><ProgBar pct={prog} color={prog === 100 ? GOLD : H.color} /></div>
        <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 12, flexWrap: "wrap" }}>
          <span style={{ fontSize: 10, color: obj ? cat?.accent : "#7d877f" }}>{obj ? "↳ " + obj.title : "sem objetivo"}</span>
          <span style={{ fontSize: 10, color: "#7d877f" }}>· imp. {g.importance}</span>
          <span style={{ fontSize: 10, color: chip.color, border: `1px solid ${chip.color}55`, borderRadius: 6, padding: "1px 6px" }}>{chip.label}</span>
          {prov && <span style={{ fontSize: 10, color: GOLD, border: `1px solid ${GOLD}55`, borderRadius: 6, padding: "1px 6px" }}>aguardando auditoria</span>}
        </div>
        {g.kind === "milestone" ? (
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            {g.milestones.map((m) => (
              <div key={m.id} onClick={() => toggleMilestone(g.id, m.id)} style={{ display: "flex", alignItems: "center", gap: 10, fontSize: 13, color: m.done ? "#aeb6ae" : "#cdd4cd", cursor: "pointer", userSelect: "none", padding: "3px 0" }}>
                <span style={{ width: 20, height: 20, borderRadius: 6, border: `1.5px solid ${m.done ? ACCENT : "rgba(255,255,255,0.25)"}`, background: m.done ? ACCENT : "transparent", color: "#080b0a", fontSize: 12, display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}>{m.done ? "✓" : ""}</span>
                <span style={{ textDecoration: m.done ? "line-through" : "none", flex: 1 }}>{m.text}</span>
                {m.provisional && <span style={{ color: GOLD, fontSize: 14 }}>•</span>}
              </div>
            ))}
          </div>
        ) : (
          <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
            <button onClick={() => stepMetric(g.id, -1)} style={{ width: 36, height: 36, borderRadius: 10, border: "1px solid rgba(255,255,255,0.15)", background: "transparent", color: "#aeb6ae", fontSize: 18, cursor: "pointer" }}>−</button>
            <div style={{ flex: 1, textAlign: "center", fontSize: 14, color: "#cdd4cd" }}><strong style={{ color: H.color, fontFamily: "'Fraunces',serif", fontSize: 18 }}>{g.metricCurrent}</strong> / {g.metricTarget} {g.metricUnit}</div>
            <button onClick={() => stepMetric(g.id, 1)} style={{ width: 36, height: 36, borderRadius: 10, border: `1px solid ${H.color}66`, background: `${H.color}18`, color: H.color, fontSize: 18, cursor: "pointer" }}>+</button>
          </div>
        )}
        {prog === 100 && (
          <button onClick={() => conquer(g.id)} style={{ width: "100%", marginTop: 13, padding: "12px", borderRadius: 11, border: "none", background: `linear-gradient(135deg, ${GOLD}, #e3c074)`, color: "#080b0a", fontWeight: 700, fontSize: 13.5, cursor: "pointer" }}>🏆 Eternizar como conquista</button>
        )}
        {noteEdit === g.id ? (
          <div style={{ marginTop: 12 }}>
            <textarea value={noteDraft} onChange={(e) => setNoteDraft(e.target.value)} rows={2} placeholder="Anotações: contexto, links, próximos passos…" style={{ width: "100%", background: "rgba(255,255,255,0.04)", border: "1px solid rgba(255,255,255,0.12)", borderRadius: 10, padding: "10px 12px", color: "#eef2ef", fontSize: 13, outline: "none", resize: "vertical", lineHeight: 1.45 }} />
            <div style={{ display: "flex", gap: 8, marginTop: 6 }}>
              <button onClick={() => saveNote(g.id)} style={{ flex: 1, padding: "8px", borderRadius: 9, border: "none", background: `${ACCENT}22`, color: ACCENT, fontWeight: 600, fontSize: 12.5, cursor: "pointer" }}>Salvar</button>
              <button onClick={() => setNoteEdit(null)} style={{ flex: 1, padding: "8px", borderRadius: 9, border: "1px solid rgba(255,255,255,0.12)", background: "transparent", color: "#9aa39a", fontWeight: 600, fontSize: 12.5, cursor: "pointer" }}>Cancelar</button>
            </div>
          </div>
        ) : g.notes ? (
          <div onClick={() => { setNoteEdit(g.id); setNoteDraft(g.notes || ""); }} style={{ marginTop: 12, fontSize: 12.5, color: "#9aa39a", background: "rgba(255,255,255,0.02)", borderRadius: 10, padding: "9px 12px", cursor: "pointer", lineHeight: 1.45, borderLeft: `2px solid ${cat?.accent || ACCENT}66`, whiteSpace: "pre-wrap" }}>{g.notes}</div>
        ) : (
          <button onClick={() => { setNoteEdit(g.id); setNoteDraft(""); }} style={{ marginTop: 10, background: "none", border: "none", color: "#6b756d", fontSize: 11.5, cursor: "pointer", padding: 0 }}>+ nota</button>
        )}
      </div>
    );
  };

  return (
    <div className="rise">
      <h2 style={{ fontFamily: "'Fraunces', serif", fontSize: 24, fontWeight: 500, margin: "12px 0 12px" }}>Desenvolvimento</h2>
      <div style={{ display: "flex", gap: 6, background: "rgba(255,255,255,0.04)", borderRadius: 12, padding: 4, marginBottom: 20 }}>
        {[{ id: "metas", l: "Metas" }, { id: "competencias", l: "Competências" }].map((v) => (
          <button key={v.id} onClick={() => setSkillView(v.id)} style={{ flex: 1, padding: "9px", borderRadius: 9, border: "none", background: skillView === v.id ? `linear-gradient(135deg, ${ACCENT}, ${GOLD})` : "transparent", color: skillView === v.id ? "#080b0a" : "#aeb6ae", fontWeight: 700, fontSize: 13, cursor: "pointer", transition: "all .2s" }}>{v.l}</button>
        ))}
      </div>
      {skillView === "competencias" ? <Competencias state={state} /> : (<>
      <p style={{ color: "#7d877f", fontSize: 13, marginBottom: 18 }}>Toque numa área, depois no prazo, para abrir suas metas.</p>

      {state.categories.map((cat) => {
        const areaGoals = active.filter((g) => g.cat === cat.id);
        if (!areaGoals.length) return null;
        const isOpen = openArea === cat.id;
        return (
          <div key={cat.id} style={{ marginBottom: 10 }}>
            <button onClick={() => { setOpenArea(isOpen ? null : cat.id); setOpenPrazo(null); }} style={{ width: "100%", textAlign: "left", display: "flex", alignItems: "center", justifyContent: "space-between", background: isOpen ? `${cat.accent}14` : "rgba(255,255,255,0.03)", border: `1px solid ${isOpen ? cat.accent + "55" : "rgba(255,255,255,0.07)"}`, borderLeft: `3px solid ${cat.accent}`, borderRadius: 14, padding: "15px 16px", cursor: "pointer", transition: "all .2s" }}>
              <span style={{ display: "flex", alignItems: "center", gap: 11 }}>
                <span style={{ color: cat.accent, fontSize: 17 }}>{cat.glyph}</span>
                <span style={{ fontWeight: 600, fontSize: 15 }}>{cat.name}</span>
              </span>
              <span style={{ display: "flex", alignItems: "center", gap: 10 }}>
                <span style={{ fontSize: 11, color: "#7d877f" }}>{areaGoals.length} meta{areaGoals.length > 1 ? "s" : ""}</span>
                <span style={{ color: cat.accent, display: "inline-block", transform: isOpen ? "rotate(90deg)" : "none", transition: "transform .2s", fontSize: 12 }}>▸</span>
              </span>
            </button>
            {isOpen && (
              <div style={{ paddingLeft: 8, marginTop: 8 }}>
                {Object.keys(HORIZON).map((hk) => {
                  const pg = areaGoals.filter((g) => g.horizon === hk);
                  if (!pg.length) return null;
                  const H = HORIZON[hk];
                  const pOpen = openPrazo === hk;
                  return (
                    <div key={hk} style={{ marginBottom: 8 }}>
                      <button onClick={() => setOpenPrazo(pOpen ? null : hk)} style={{ width: "100%", textAlign: "left", display: "flex", justifyContent: "space-between", alignItems: "center", background: pOpen ? `${H.color}10` : "rgba(255,255,255,0.02)", border: `1px solid ${pOpen ? H.color + "44" : "rgba(255,255,255,0.06)"}`, borderRadius: 11, padding: "11px 14px", cursor: "pointer" }}>
                        <span style={{ display: "flex", alignItems: "center", gap: 8, color: H.color, fontSize: 12.5, fontWeight: 600 }}>{H.label} <span style={{ fontSize: 9, color: "#7d877f", border: "1px solid rgba(255,255,255,0.1)", borderRadius: 6, padding: "1px 5px" }}>×{H.mult}</span></span>
                        <span style={{ display: "flex", alignItems: "center", gap: 9 }}>
                          <span style={{ fontSize: 10.5, color: "#7d877f" }}>{pg.length}</span>
                          <span style={{ color: H.color, display: "inline-block", transform: pOpen ? "rotate(90deg)" : "none", transition: "transform .2s", fontSize: 11 }}>▸</span>
                        </span>
                      </button>
                      {pOpen && <div style={{ marginTop: 9 }}>{pg.map(renderCard)}</div>}
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        );
      })}

      {!active.length && (
        <p style={{ color: "#6b756d", fontSize: 13, textAlign: "center", marginTop: 40, lineHeight: 1.6 }}>Nenhuma meta ativa.<br />Peça ao Coach IA para criar uma.</p>
      )}
      </>)}
    </div>
  );
}

function TrophyCard({ g, cat, onClick }) {
  return (
    <div onClick={onClick} style={{ background: `linear-gradient(160deg, ${GOLD}1f, rgba(255,255,255,0.02))`, border: `1px solid ${GOLD}3a`, borderRadius: 16, padding: "20px 14px", position: "relative", overflow: "hidden", minHeight: 158, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", textAlign: "center", cursor: "pointer" }}>
      <div style={{ position: "absolute", top: 0, bottom: 0, left: 0, width: "30%", background: "linear-gradient(90deg,transparent,rgba(255,255,255,.14),transparent)", animation: "shineSweep 4.5s ease-in-out infinite" }} />
      {!g.trophyVerified && <span style={{ position: "absolute", top: 8, right: 8, fontSize: 8.5, color: GOLD, border: `1px solid ${GOLD}66`, borderRadius: 6, padding: "1px 5px", background: "#080b0a99" }}>a confirmar</span>}
      <div style={{ fontSize: 40, marginBottom: 10, opacity: g.trophyVerified ? 1 : 0.7 }}>🏆</div>
      <div style={{ fontSize: 13, fontWeight: 600, lineHeight: 1.3 }}>{g.title}</div>
      <div style={{ fontSize: 9.5, color: cat?.accent, marginTop: 9 }}>{cat?.name}</div>
      <div style={{ fontSize: 9.5, color: GOLD, marginTop: 2 }}>{g.completedDate}</div>
    </div>
  );
}

function MedalCard({ g, cat, onClick }) {
  return (
    <div onClick={onClick} style={{ background: "linear-gradient(160deg, rgba(255,255,255,0.06), rgba(255,255,255,0.015))", border: "1px solid rgba(255,255,255,0.1)", borderRadius: 14, padding: "14px 8px", minHeight: 116, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", textAlign: "center", position: "relative", cursor: "pointer" }}>
      {!g.trophyVerified && <span style={{ position: "absolute", top: 6, right: 6, fontSize: 7.5, color: GOLD, border: `1px solid ${GOLD}66`, borderRadius: 5, padding: "0px 4px" }}>a confirmar</span>}
      <div style={{ fontSize: 26, opacity: g.trophyVerified ? 1 : 0.7 }}>🥇</div>
      <div style={{ fontSize: 10.5, fontWeight: 600, lineHeight: 1.25, marginTop: 7, color: "#dfe6e0" }}>{g.title}</div>
      <div style={{ fontSize: 9, color: cat?.accent, marginTop: 5 }}>{g.completedDate}</div>
    </div>
  );
}

function bookLabel(t) {
  let s = t.replace(/^Terminar\s+/i, "").replace(/^Ler\s+/i, "").replace(/['"]/g, "");
  return s.length > 26 ? s.slice(0, 24) + "…" : s;
}
function bookInitials(t) {
  const s = t.replace(/^Terminar\s+/i, "").replace(/^Ler\s+/i, "").replace(/['"]/g, "");
  const skip = new Set(["de", "da", "do", "das", "dos", "e", "a", "o", "of", "the", "and", "to", "in", "for"]);
  const words = s.split(/\s+/).filter((w) => w && !skip.has(w.toLowerCase()));
  return words.map((w) => w[0].toUpperCase()).join("").slice(0, 4) || s.slice(0, 2).toUpperCase();
}

function BookSpine({ g, color, active, onClick }) {
  const done = g.completed;
  const pct = Math.round(goalProgress(g) * 100);
  return (
    <div onClick={onClick} style={{ width: 38, height: 122, borderRadius: "5px 5px 2px 2px", border: `1px solid ${active ? color : done ? color : "rgba(255,255,255,0.22)"}`, background: done ? "transparent" : "rgba(255,255,255,0.02)", position: "relative", overflow: "hidden", flexShrink: 0, cursor: "pointer", boxShadow: active ? `0 0 12px ${color}aa` : "none", transition: "box-shadow .2s" }}>
      <div style={{ position: "absolute", bottom: 0, left: 0, right: 0, height: (done ? 100 : pct) + "%", background: color, opacity: done ? 0.9 : 0.4, transition: "height .8s ease" }} />
      <span style={{ position: "absolute", inset: 0, display: "flex", alignItems: "center", justifyContent: "center", writingMode: "vertical-rl", transform: "rotate(180deg)", fontSize: 11, fontWeight: 700, letterSpacing: 1.5, color: done ? "#08110d" : "#cdd4cd" }}>{bookInitials(g.title)}</span>
    </div>
  );
}

function Conquistas({ state }) {
  const [view, setView] = useState("parede");
  const [selectedBook, setSelectedBook] = useState(null);
  const [detail, setDetail] = useState(null);
  const byDateDesc = (a, b) => (b.completedDate || "").localeCompare(a.completedDate || "");
  const completed = state.goals.filter((g) => g.completed);
  const trophies = completed.filter((g) => achType(g) === "trophy").sort(byDateDesc);
  const medals = completed.filter((g) => achType(g) === "medal").sort(byDateDesc);
  const books = state.goals.filter((g) => g.track === "book");
  const timeline = completed.slice().sort(byDateDesc);
  const bookColors = ["#3ddc97", "#cba14d", "#7aa2ff", "#e07a9b", "#e8a657", "#9d7eaf"];
  const glyphFor = (g) => (achType(g) === "trophy" ? "🏆" : achType(g) === "book" ? "📖" : "🥇");

  const Section = ({ title, children }) => (
    <div style={{ marginBottom: 28 }}>
      <div style={{ fontSize: 12, letterSpacing: "0.12em", textTransform: "uppercase", fontWeight: 600, color: GOLD, marginBottom: 12 }}>{title}</div>
      {children}
    </div>
  );

  return (
    <div className="rise">
      <h2 style={{ fontFamily: "'Fraunces', serif", fontSize: 24, fontWeight: 500, margin: "12px 0 4px" }}>Conquistas</h2>
      <p style={{ color: "#7d877f", fontSize: 13, marginBottom: 16 }}>Tudo aqui passou pela auditoria do Coach. Troféus para os grandes marcos, medalhas para as vitórias menores, estante para as leituras.</p>

      <div style={{ display: "flex", gap: 6, background: "rgba(255,255,255,0.04)", borderRadius: 12, padding: 4, marginBottom: 22 }}>
        {[{ id: "parede", l: "Parede" }, { id: "timeline", l: "Timeline" }].map((v) => (
          <button key={v.id} onClick={() => setView(v.id)} style={{ flex: 1, padding: "9px", borderRadius: 9, border: "none", background: view === v.id ? `linear-gradient(135deg, ${ACCENT}, ${GOLD})` : "transparent", color: view === v.id ? "#080b0a" : "#aeb6ae", fontWeight: 700, fontSize: 13, cursor: "pointer", transition: "all .2s" }}>{v.l}</button>
        ))}
      </div>

      {view === "parede" && (
        <div>
          <Section title={`Troféus ${trophies.length ? "· " + trophies.length : ""}`}>
            {trophies.length ? (
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
                {trophies.map((g) => <TrophyCard key={g.id} g={g} cat={state.categories.find((c) => c.id === g.cat)} onClick={() => setDetail(g)} />)}
              </div>
            ) : <p style={{ color: "#6b756d", fontSize: 12.5 }}>Seus grandes marcos aparecerão aqui.</p>}
          </Section>

          <Section title={`Medalhas ${medals.length ? "· " + medals.length : ""}`}>
            {medals.length ? (
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 9 }}>
                {medals.map((g) => <MedalCard key={g.id} g={g} cat={state.categories.find((c) => c.id === g.cat)} onClick={() => setDetail(g)} />)}
              </div>
            ) : <p style={{ color: "#6b756d", fontSize: 12.5 }}>Vitórias menores viram medalhas aqui.</p>}
          </Section>

          <Section title="Estante">
            {books.length ? (
              <div>
                <div style={{ display: "flex", flexWrap: "wrap", gap: 5, alignItems: "flex-end", padding: "0 4px" }}>
                  {books.map((g, i) => <BookSpine key={g.id} g={g} color={bookColors[i % bookColors.length]} active={selectedBook === g.id} onClick={() => setSelectedBook((s) => (s === g.id ? null : g.id))} />)}
                </div>
                <div style={{ height: 9, background: "linear-gradient(180deg, #6b4f2a, #3a2c18)", borderRadius: "2px 2px 4px 4px", boxShadow: "0 6px 14px rgba(0,0,0,.45)", marginTop: -1 }} />
                {selectedBook && (() => {
                  const b = books.find((x) => x.id === selectedBook);
                  if (!b) return null;
                  const bp = Math.round(goalProgress(b) * 100);
                  return (
                    <div style={{ marginTop: 12, background: "rgba(255,255,255,0.04)", border: "1px solid rgba(255,255,255,0.08)", borderRadius: 10, padding: "10px 13px", display: "flex", alignItems: "center", gap: 10 }}>
                      <span style={{ fontFamily: "'Fraunces',serif", fontSize: 14, color: GOLD, flexShrink: 0 }}>{bookInitials(b.title)}</span>
                      <span style={{ fontSize: 13, color: "#dfe6e0", flex: 1 }}>{b.title.replace(/^Terminar\s+/i, "").replace(/['"]/g, "")}</span>
                      <span style={{ fontSize: 11, color: b.completed ? ACCENT : "#7d877f", flexShrink: 0 }}>{b.completed ? "lido ✓" : bp + "%"}</span>
                    </div>
                  );
                })()}
                <p style={{ fontSize: 10.5, color: "#6b756d", marginTop: 8 }}>Toque num livro para ver o título. Em leitura aparecem translúcidos; ao terminar ganham cor.</p>
              </div>
            ) : <p style={{ color: "#6b756d", fontSize: 12.5 }}>Adicione uma meta de leitura para erguer sua estante.</p>}
          </Section>
        </div>
      )}

      {view === "timeline" && (
        timeline.length ? (
          <div style={{ position: "relative", paddingLeft: 26 }}>
            <div style={{ position: "absolute", left: 7, top: 6, bottom: 6, width: 2, background: `linear-gradient(${ACCENT}, ${GOLD})`, opacity: 0.5 }} />
            {timeline.map((g) => {
              const cat = state.categories.find((c) => c.id === g.cat);
              return (
                <div key={g.id} style={{ position: "relative", marginBottom: 22 }}>
                  <div style={{ position: "absolute", left: -26, top: 1, width: 16, height: 16, borderRadius: 99, background: cat?.accent || ACCENT, border: "3px solid #080b0a", boxShadow: `0 0 10px ${cat?.accent || ACCENT}aa` }} />
                  <div style={{ fontSize: 11, color: GOLD, marginBottom: 3 }}>{g.completedDate}</div>
                  <div style={{ fontSize: 14, fontWeight: 600, lineHeight: 1.35 }}>{glyphFor(g)} {g.title}</div>
                  <div style={{ fontSize: 11, color: cat?.accent, marginTop: 2 }}>{cat?.name}</div>
                </div>
              );
            })}
          </div>
        ) : <p style={{ color: "#6b756d", fontSize: 13, textAlign: "center", marginTop: 40, lineHeight: 1.6 }}>Sua linha do tempo começa com a primeira conquista auditada.</p>
      )}

      {detail && (() => {
        const cat = state.categories.find((c) => c.id === detail.cat);
        const tp = achType(detail);
        return (
          <div onClick={() => setDetail(null)} style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.65)", backdropFilter: "blur(4px)", zIndex: 60, display: "flex", alignItems: "center", justifyContent: "center", padding: 20 }}>
            <div onClick={(e) => e.stopPropagation()} style={{ background: "#111814", border: `1px solid ${GOLD}44`, borderRadius: 18, padding: "24px 20px", maxWidth: 420, width: "100%", maxHeight: "82vh", overflowY: "auto", boxShadow: "0 20px 60px rgba(0,0,0,.6)" }}>
              <div style={{ fontSize: 38, textAlign: "center" }}>{tp === "trophy" ? "🏆" : tp === "book" ? "📖" : "🥇"}</div>
              <div style={{ fontFamily: "'Fraunces',serif", fontSize: 19, fontWeight: 500, textAlign: "center", marginTop: 8, lineHeight: 1.3 }}>{detail.title}</div>
              <div style={{ display: "flex", justifyContent: "center", gap: 10, marginTop: 10, flexWrap: "wrap" }}>
                <span style={{ fontSize: 11, color: cat?.accent }}>{cat?.name}</span>
                <span style={{ fontSize: 11, color: GOLD }}>{detail.completedDate}</span>
                {detail.trophyVerified === false && <span style={{ fontSize: 10, color: GOLD, border: `1px solid ${GOLD}66`, borderRadius: 6, padding: "1px 6px" }}>a confirmar</span>}
              </div>
              {detail.note && <p style={{ fontSize: 13.5, color: "#cdd4cd", lineHeight: 1.6, marginTop: 16 }}>{detail.note}</p>}
              <div style={{ fontSize: 11, letterSpacing: "0.1em", textTransform: "uppercase", color: "#7d877f", marginTop: 18, marginBottom: 9 }}>O que você fez</div>
              {detail.kind === "metric" ? (
                <div style={{ fontSize: 13.5, color: "#dfe6e0" }}>Atingiu {detail.metricCurrent} / {detail.metricTarget} {detail.metricUnit}.</div>
              ) : (
                <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                  {detail.milestones.map((m) => (
                    <div key={m.id} style={{ display: "flex", alignItems: "center", gap: 10, fontSize: 13, color: "#cdd4cd" }}>
                      <span style={{ width: 17, height: 17, borderRadius: 5, background: m.done ? ACCENT : "transparent", border: `1px solid ${m.done ? ACCENT : "rgba(255,255,255,0.2)"}`, color: "#08110d", fontSize: 11, display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}>{m.done ? "✓" : ""}</span>
                      {m.text}
                    </div>
                  ))}
                </div>
              )}
              <button onClick={() => setDetail(null)} style={{ width: "100%", marginTop: 22, padding: "11px", borderRadius: 10, border: "1px solid rgba(255,255,255,0.12)", background: "transparent", color: "#aeb6ae", fontWeight: 600, fontSize: 13, cursor: "pointer" }}>Fechar</button>
            </div>
          </div>
        );
      })()}
    </div>
  );
}

// ---------- AI Coach / Árbitro ----------
function AICoach({ state, setState, showToast, weeklyDue, monthlyDue, semesterDue, yearDue }) {
  const intro = yearDue
    ? "Fala, Gio. Hora da sua RETROSPECTIVA ANUAL ✨ — o balanço grande. Vou revisar os troféus, medalhas e leituras do ano, sua trajetória de score e o que ficou pra trás. Antes: me conta, olhando o ano todo, do que você mais se orgulha — e o que te frustrou?"
    : semesterDue
    ? "Fala, Gio. Chegou a RETROSPECTIVA SEMESTRAL ✨. Vamos olhar os últimos 6 meses: o que você conquistou, o que travou e o que carrega pro próximo semestre. Começa me dizendo: qual foi a vitória que mais importou nesse semestre?"
    : monthlyDue
    ? "Fala, Gio. Está na hora da REVISÃO MENSAL — a auditoria profunda. Vou passar pelas suas metas e troféus 'a confirmar', te cobrar evidência, e revogar o que não tiver lastro. Me atualiza: o que de fato andou no último mês?"
    : weeklyDue
    ? "Fala, Gio. Check semanal: me conta em quais metas você avançou e me mostra evidência. Confirmo o que tem lastro e estorno (ou revogo o troféu) do que não tiver."
    : "Fala, Gio. Sou seu árbitro no Ascend. Me diz o que avançou, peça pra criar/ajustar metas, ou peça pra rodar a auditoria/retrospectiva. Posso também ler seu diário de reflexões e te dizer com sinceridade os padrões que vejo — é só perguntar. Progresso e troféus entram provisórios até a gente revisar com evidência.";
  const [messages, setMessages] = useState([{ role: "assistant", text: intro }]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const scrollRef = useRef(null);
  useEffect(() => { scrollRef.current?.scrollTo(0, scrollRef.current.scrollHeight); }, [messages, busy]);

  const findGoal = (ns, ref) => ns.goals.find((g) => g.id === ref || g.title === ref || (g.title || "").toLowerCase().includes((ref || "").toLowerCase()));

  const applyActions = (actions) => {
    if (!Array.isArray(actions) || !actions.length) return;
    const T = todayKey();
    setState((s) => {
      let ns = JSON.parse(JSON.stringify(s));
      actions.forEach((a) => {
        try {
          if (a.type === "add_goal") {
            const id = "g" + Date.now() + Math.random().toString(36).slice(2, 5);
            if (a.kind === "metric") ns.goals.push(mkMetric(id, a.cat || "prof", a.horizon || "medio", a.importance || 5, a.title, a.metricCurrent || 0, a.metricTarget || 1, a.metricUnit || "", T));
            else ns.goals.push(mkGoal(id, a.cat || "prof", a.horizon || "medio", a.importance || 5, a.title, "milestone", a.milestones && a.milestones.length ? a.milestones : ["Definir 1º passo"], T));
            const ng = ns.goals[ns.goals.length - 1];
            if (a.track === "book") ng.track = "book";
            if (a.objective) { const o = (ns.objectives || []).find((x) => x.id === a.objective || (x.title || "").toLowerCase().includes((a.objective || "").toLowerCase())); if (o) ng.objId = o.id; }
          } else if (a.type === "add_objective") {
            if (!ns.objectives) ns.objectives = [];
            ns.objectives.push({ id: "obj_" + Date.now().toString(36), cat: a.cat || "prof", title: a.title });
          } else if (a.type === "add_skill") {
            if (!ns.skills) ns.skills = [];
            ns.skills.push({ id: "sk_" + Date.now().toString(36), cat: a.cat || "prof", name: a.name, why: a.why || "", level: 0, note: "", lastAssessed: null, behaviors: (a.behaviors || []).map((t, i) => ({ id: "b" + i + Date.now().toString(36), text: t })) });
          } else if (a.type === "assess_skill") {
            const sk = (ns.skills || []).find((x) => x.id === a.skill || (x.name || "").toLowerCase().includes((a.skill || "").toLowerCase()));
            if (sk) { if (typeof a.level === "number") sk.level = Math.max(0, Math.min(5, a.level)); if (a.note) sk.note = a.note; sk.lastAssessed = T; }
          } else if (a.type === "add_skill_behavior") {
            const sk = (ns.skills || []).find((x) => x.id === a.skill || (x.name || "").toLowerCase().includes((a.skill || "").toLowerCase()));
            if (sk) { if (!sk.behaviors) sk.behaviors = []; sk.behaviors.push({ id: "b" + Date.now().toString(36), text: a.text }); }
          } else if (a.type === "set_north") {
            ns.north = a.text || "";
          } else if (a.type === "assign_objective") {
            const g = findGoal(ns, a.goal);
            const o = (ns.objectives || []).find((x) => x.id === a.objective || (x.title || "").toLowerCase().includes((a.objective || "").toLowerCase()));
            if (g && o) g.objId = o.id;
          } else if (a.type === "add_milestone") {
            const g = findGoal(ns, a.goal); if (g && g.kind === "milestone") g.milestones.push({ id: g.id + "_m" + Date.now(), text: a.text, done: false, doneDate: null, provisional: false });
          } else if (a.type === "set_milestone") {
            const g = findGoal(ns, a.goal);
            if (g && g.kind === "milestone") {
              const m = g.milestones.find((x) => x.text === a.milestone || (x.text || "").toLowerCase().includes((a.milestone || "").toLowerCase())) || g.milestones[a.index];
              if (m) { m.done = a.done !== false; m.doneDate = m.done ? T : null; m.provisional = m.done; if (m.done) g.lastProgressDate = T; }
            }
          } else if (a.type === "update_metric") {
            const g = findGoal(ns, a.goal); if (g && g.kind === "metric") { g.metricCurrent = a.current; g.metricProvisional = true; g.lastProgressDate = T; }
          } else if (a.type === "confirm_progress") {
            const g = findGoal(ns, a.goal); if (g) { (g.milestones || []).forEach((m) => (m.provisional = false)); g.metricProvisional = false; }
          } else if (a.type === "revert_progress") {
            const g = findGoal(ns, a.goal);
            if (g) {
              if (a.milestone) { const m = (g.milestones || []).find((x) => (x.text || "").toLowerCase().includes((a.milestone || "").toLowerCase())); if (m) { m.done = false; m.doneDate = null; m.provisional = false; } }
              else { (g.milestones || []).forEach((m) => { if (m.provisional) { m.done = false; m.doneDate = null; m.provisional = false; } }); if (g.metricProvisional && a.revertTo !== undefined) { g.metricCurrent = a.revertTo; } g.metricProvisional = false; }
            }
          } else if (a.type === "complete_goal") {
            const g = findGoal(ns, a.goal); if (g) { g.completed = true; g.completedDate = T; g.lastProgressDate = T; g.trophyVerified = true; (g.milestones || []).forEach((m) => { m.done = true; m.provisional = false; }); }
          } else if (a.type === "confirm_goal") {
            const g = findGoal(ns, a.goal); if (g) { g.trophyVerified = true; (g.milestones || []).forEach((m) => (m.provisional = false)); g.metricProvisional = false; }
          } else if (a.type === "revoke_goal") {
            const g = findGoal(ns, a.goal); if (g) { g.completed = false; g.completedDate = null; g.trophyVerified = false; }
          } else if (a.type === "add_category") {
            const id = (a.id || a.name.toLowerCase().replace(/[^a-z]/g, "").slice(0, 8)) + Date.now().toString(36).slice(-3);
            ns.categories.push({ id, name: a.name, glyph: a.glyph || "✦", weight: a.weight || 1, accent: a.accent || ACCENT, type: a.catType || "equilibrio" });
          } else if (a.type === "add_question") {
            ns.questions.push({ id: "q" + Date.now() + Math.random().toString(36).slice(2, 5), cat: a.cat, text: a.text, type: a.qtype === "scale" ? "scale" : "bool" });
          } else if (a.type === "set_category_weight") {
            const c = ns.categories.find((x) => x.id === a.cat || x.name === a.name); if (c) c.weight = a.weight;
          } else if (a.type === "complete_review") {
            if (a.kind === "year") { ns.lastYearReview = T; ns.lastSemesterReview = T; ns.lastMonthlyReview = T; ns.lastWeeklyCheck = T; }
            else if (a.kind === "semester") { ns.lastSemesterReview = T; ns.lastMonthlyReview = T; ns.lastWeeklyCheck = T; }
            else if (a.kind === "monthly") { ns.lastMonthlyReview = T; ns.lastWeeklyCheck = T; }
            else { ns.lastWeeklyCheck = T; }
          } else if (a.type === "edit_goal") {
            const g = findGoal(ns, a.goal);
            if (g) { if (a.title) g.title = a.title; if (typeof a.importance === "number") g.importance = Math.max(1, Math.min(10, a.importance)); if (a.horizon) g.horizon = a.horizon; if (a.cat) g.cat = a.cat; }
          } else if (a.type === "delete_goal") {
            const g = findGoal(ns, a.goal); if (g) ns.goals = ns.goals.filter((x) => x.id !== g.id);
          } else if (a.type === "set_goal_note") {
            const g = findGoal(ns, a.goal); if (g) g.notes = a.note || "";
          } else if (a.type === "edit_objective") {
            const o = (ns.objectives || []).find((x) => x.id === a.objective || (x.title || "").toLowerCase().includes((a.objective || "").toLowerCase()));
            if (o) { if (a.title) o.title = a.title; if (a.cat) o.cat = a.cat; }
          } else if (a.type === "remove_objective") {
            const o = (ns.objectives || []).find((x) => x.id === a.objective || (x.title || "").toLowerCase().includes((a.objective || "").toLowerCase()));
            if (o) { ns.objectives = ns.objectives.filter((x) => x.id !== o.id); (ns.goals || []).forEach((g) => { if (g.objId === o.id) g.objId = null; }); }
          } else if (a.type === "edit_category") {
            const c = ns.categories.find((x) => x.id === a.cat || x.name === a.name);
            if (c) { if (a.newName) c.name = a.newName; if (a.glyph) c.glyph = a.glyph; if (a.accent) c.accent = a.accent; if (a.catType) c.type = a.catType; if (typeof a.weight === "number") c.weight = a.weight; }
          } else if (a.type === "remove_category") {
            const c = ns.categories.find((x) => x.id === a.cat || x.name === a.name);
            if (c && ns.categories.length > 1) {
              const fallback = ns.categories.find((x) => x.id !== c.id).id;
              ns.categories = ns.categories.filter((x) => x.id !== c.id);
              ns.questions = ns.questions.filter((q) => q.cat !== c.id);
              (ns.goals || []).forEach((g) => { if (g.cat === c.id) g.cat = fallback; });
              (ns.skills || []).forEach((sk) => { if (sk.cat === c.id) sk.cat = fallback; });
              (ns.objectives || []).forEach((o) => { if (o.cat === c.id) o.cat = fallback; });
            }
          } else if (a.type === "remove_question") {
            ns.questions = ns.questions.filter((q) => !(q.id === a.question || (q.text || "").toLowerCase().includes((a.question || "").toLowerCase())));
          } else if (a.type === "edit_question") {
            const q = ns.questions.find((x) => x.id === a.question || (x.text || "").toLowerCase().includes((a.question || "").toLowerCase()));
            if (q) { if (a.text) q.text = a.text; if (a.qtype) q.type = a.qtype === "scale" ? "scale" : "bool"; }
          } else if (a.type === "remove_skill") {
            ns.skills = (ns.skills || []).filter((x) => !(x.id === a.skill || (x.name || "").toLowerCase().includes((a.skill || "").toLowerCase())));
          } else if (a.type === "add_trophy") {
            const id = "g" + Date.now() + Math.random().toString(36).slice(2, 5);
            ns.goals.push(mkTrophy(id, a.cat || "prof", a.horizon || "longo", a.importance || 8, a.title, a.date || T, a.track || null, a.note || null));
          } else if (a.type === "set_trophy_verified") {
            const g = findGoal(ns, a.goal); if (g) g.trophyVerified = a.verified !== false;
          } else if (a.type === "add_routine") {
            if (!ns.routines) ns.routines = [];
            ns.routines.push({ id: "rt_" + Date.now().toString(36), name: a.name, everyDays: Math.max(1, a.everyDays || 7), lastDone: null });
          } else if (a.type === "remove_routine") {
            ns.routines = (ns.routines || []).filter((r) => !(r.id === a.routine || (r.name || "").toLowerCase().includes((a.routine || "").toLowerCase())));
          } else if (a.type === "mark_routine") {
            const r = (ns.routines || []).find((x) => x.id === a.routine || (x.name || "").toLowerCase().includes((a.routine || "").toLowerCase())); if (r) r.lastDone = T;
          } else if (a.type === "set_learn_track") {
            if (!ns.learn) ns.learn = { track: "rotativo", today: null, streak: { count: 0, lastDay: null }, log: [] };
            ns.learn.track = a.track || "rotativo";
          }
        } catch (e) {}
      });
      return ns;
    });
  };

  const send = async () => {
    if (!input.trim() || busy) return;
    const userMsg = input.trim(); setInput("");
    const history = [...messages, { role: "user", text: userMsg }];
    setMessages(history); setBusy(true);

    const goalsCtx = state.goals.filter((g) => !g.archived).map((g) => ({
      title: g.title, cat: g.cat, horizon: g.horizon, kind: g.kind,
      progress: Math.round(goalProgress(g) * 100) + "%",
      milestones: g.kind === "milestone" ? g.milestones.map((m) => ({ text: m.text, done: m.done, provisional: m.provisional })) : undefined,
      metric: g.kind === "metric" ? `${g.metricCurrent}/${g.metricTarget} ${g.metricUnit}${g.metricProvisional ? " (provisório)" : ""}` : undefined,
      completed: g.completed,
      trofeuAConfirmar: g.completed && g.trophyVerified === false,
      objetivo: g.objId || null,
    }));
    const objetivosCtx = (state.objectives || []).map((o) => ({ id: o.id, area: o.cat, titulo: o.title }));
    const learnCtx = { trilha: (state.learn || {}).track, sequencia: ((state.learn || {}).streak || {}).count || 0, ultimosTopicos: ((state.learn || {}).log || []).slice(-10).map((l) => ({ topico: l.title, trilha: l.track, acerto: l.total ? `${l.correct}/${l.total}` : null })) };
    const skillsCtx = (state.skills || []).map((sk) => ({ nome: sk.name, tipo: sk.kind === "virtude" ? "virtude cardeal" : "competência", nivel: sk.level || 0, area: sk.cat, definicao: sk.why, comportamentos: (sk.behaviors || []).map((b) => b.text), ultimaLeitura: sk.note || null }));
    const periodDays = yearDue ? 365 : semesterDue ? 180 : 30;
    const recentDone = state.goals.filter((g) => g.completed && g.completedDate && dayDiff(g.completedDate, todayKey()) <= periodDays)
      .map((g) => ({ title: g.title, tipo: achType(g), data: g.completedDate, confirmado: g.trophyVerified !== false }));
    const retroCtx = { periodo: yearDue ? "ano" : semesterDue ? "semestre" : "mês", conquistas: recentDone, scoreAtual: Math.round(overallScore(state)) };
    const allDiaryKeys = Object.keys(state.checkIns).filter((d) => state.checkIns[d] && (state.checkIns[d]._reflection || (state.checkIns[d]._qa && state.checkIns[d]._qa[0]))).sort();
    const diario = allDiaryKeys.slice(-45).map((d) => {
      const ci = state.checkIns[d];
      return { data: d, pergunta: (ci._q && ci._q[0]) || ci._prompt || "", resposta: ((ci._qa && ci._qa[0]) || "").slice(0, 200), livre: (ci._reflection || "").slice(0, 200), energia: ci._energy || null, plano: ci._tomorrowPlan || null, cumpriu: ci._planKept === undefined ? null : ci._planKept };
    });
    const totalDiario = allDiaryKeys.length;

    const sys = `Você é o ÁRBITRO pessoal do Giovanni (Gio) no app "Ascend". Ele fala português. O lema do app é ser "à prova de mim": o score reflete progresso real, verificável — não autodeclaração inflada.

REGRAS DO SISTEMA:
- Metas têm progresso por MARCOS (checklist binário) ou MÉTRICA (atual/alvo). Nunca por slider manual.
- Quando o Gio alega progresso, você registra como PROVISÓRIO. No check semanal/revisão mensal, você cobra EVIDÊNCIA. Com evidência: confirm_progress. Sem evidência convincente: revert_progress (estorna).
- O Gio pode "eternizar" uma meta 100% como troféu na hora — mas ela entra como "a confirmar". Na auditoria você valida (confirm_goal) ou REVOGA o troféu (revoke_goal) se não houver evidência; revogado, volta a ser meta ativa.
- Seja um mentor exigente mas justo. Faça perguntas de auditoria concretas ("aplicou em 5 vagas? quais?"). Não aceite vago.
- ${yearDue ? "RETROSPECTIVA ANUAL DEVIDA: conduza um balanço reflexivo do ano (conquistas, trajetória, o que travou, o que carregar adiante), audite troféus a confirmar e ao final chame complete_review kind=year." : semesterDue ? "RETROSPECTIVA SEMESTRAL DEVIDA: balanço reflexivo dos 6 meses, audite troféus a confirmar e ao final chame complete_review kind=semester." : monthlyDue ? "REVISÃO MENSAL DEVIDA: auditoria profunda de metas e troféus a confirmar; ao final complete_review kind=monthly." : weeklyDue ? "CHECK SEMANAL DEVIDO: revise progresso recente e troféus a confirmar; ao final complete_review kind=weekly." : "Sem auditoria pendente agora."}

ESTADO — metas ativas: ${JSON.stringify(goalsCtx)}
NORTE (sonho/visão do Gio): ${JSON.stringify(state.north || "(não definido)")}
OBJETIVOS (direções por área; metas se penduram neles): ${JSON.stringify(objetivosCtx)}
COMPETÊNCIAS E VIRTUDES (skills em desenvolvimento; níveis 0-5: 1 Iniciante → 5 Exemplar): ${JSON.stringify(skillsCtx)}
CONHECIMENTO DIÁRIO (pílulas que o Gio estudou; use para acompanhar a evolução intelectual dele e como evidência ao avaliar a competência/categoria Intelectual): ${JSON.stringify(learnCtx)}
Você é o mentor e árbitro dessas competências e das quatro virtudes cardeais (Prudência, Justiça, Fortaleza, Temperança). Avalie o nível APENAS com base em evidência concreta (diário, check-ins, marcos) — nunca por auto-declaração. Para as virtudes, use o referencial clássico/aristotélico-cristão que o Gio estuda (EBV, Filosofia do Zero). Quando ele pedir para avaliar uma competência ou virtude, leia o diário e os dados, dê um nível honesto (subindo ou descendo), uma leitura curta e franca, e use assess_skill. Aponte os pontos cegos dele: dependência de reconhecimento, colaboração condicional, digestão lenta de crítica.
Resumo do período para retrospectiva: ${JSON.stringify(retroCtx)}
DIÁRIO PRIVADO de reflexões noturnas do Gio — ${totalDiario} entradas no total, as ${diario.length} mais recentes abaixo. É PERMANENTE e só você tem acesso; ele NÃO vê isso em nenhuma tela do app. ${JSON.stringify(diario)}. Quando ele perguntar sobre o diário/reflexões/padrões, ou nas auditorias e retrospectivas, leia tudo e responda com SINCERIDADE TOTAL: aponte padrões recorrentes, contradições entre o que ele diz e o que faz, evolução ao longo do tempo e pontos cegos. Não suavize — este diário existe para ele se ver com honestidade.
Categorias (id=nome, tipo): ${state.categories.map((c) => `${c.id}=${c.name}/${c.type}`).join(", ")}
Horizontes: curto, medio, longo.

Responda SOMENTE JSON válido, sem markdown:
{"reply":"mensagem curta em português, tom de mentor, conectando ao objetivo de longo prazo do Gio (PE/EQT/impacto) quando fizer sentido","actions":[...]}

Você pode MODIFICAR QUALQUER PARTE do app quando o Gio pedir: o painel (áreas/pesos/Norte), o check-in (perguntas e categorias), as metas e objetivos, os troféus/conquistas, as competências e virtudes, as rotinas e a trilha do Conhecimento do dia — criando, editando ou removendo. Quando ele pedir uma mudança, execute via actions e confirme no reply o que foi feito. Só peça confirmação antes se a ação for destrutiva e ampla (ex.: apagar uma área inteira ou várias metas). Para avaliações de nível, continue exigindo evidência.

Tipos de action:
- {"type":"add_goal","title":"...","cat":"<id>","horizon":"curto|medio|longo","importance":1-10,"kind":"milestone","milestones":["passo 1","passo 2"],"objective":"<id ou título do objetivo>"}
- {"type":"add_objective","title":"...","cat":"<id>"}  // cria um OBJETIVO (direção qualitativa) numa área
- {"type":"assign_objective","goal":"<titulo>","objective":"<id ou título>"}  // pendura uma meta num objetivo
- {"type":"set_north","text":"..."}  // define/edita o Norte (sonho/visão)
- {"type":"add_skill","name":"Ownership","cat":"<id>","why":"definição em 1 frase","behaviors":["comportamento 1","comportamento 2"]}  // cria uma COMPETÊNCIA
- {"type":"assess_skill","skill":"<nome>","level":0-5,"note":"leitura curta e honesta"}  // avalia o nível com base em evidência
- {"type":"add_skill_behavior","skill":"<nome>","text":"..."}  // adiciona um comportamento a praticar
- {"type":"add_goal","title":"...","cat":"<id>","horizon":"...","importance":1-10,"kind":"metric","metricCurrent":0,"metricTarget":10,"metricUnit":"capítulos","track":"book"}  // use track:"book" para LIVROS/leituras (vão para a Estante)
- {"type":"add_milestone","goal":"<titulo>","text":"..."}
- {"type":"set_milestone","goal":"<titulo>","milestone":"<texto do marco>","done":true}  // registra como provisório
- {"type":"update_metric","goal":"<titulo>","current":<num>}  // provisório
- {"type":"confirm_progress","goal":"<titulo>"}  // auditoria OK, tira o provisório
- {"type":"revert_progress","goal":"<titulo>","milestone":"<opcional: marco específico>"}  // estorna progresso sem evidência
- {"type":"complete_goal","goal":"<titulo>"}  // confirma e eterniza direto (já auditado): vira TROFÉU (longo prazo ou importância>=8), MEDALHA (menores) ou ESTANTE (track=book)
- {"type":"confirm_goal","goal":"<titulo>"}  // valida um troféu "a confirmar" após evidência
- {"type":"revoke_goal","goal":"<titulo>"}  // REVOGA o troféu sem evidência; volta a ser meta ativa
- {"type":"add_category","name":"...","glyph":"símbolo","accent":"#hex","catType":"habito|conquista|equilibrio"}
- {"type":"add_question","cat":"<id>","text":"...","qtype":"bool|scale"}
- {"type":"set_category_weight","cat":"<id>","weight":<num>}
- {"type":"edit_goal","goal":"<titulo atual>","title":"novo título","importance":1-10,"horizon":"curto|medio|longo","cat":"<id>"}  // edita qualquer campo da meta
- {"type":"delete_goal","goal":"<titulo>"}  // remove a meta de vez
- {"type":"set_goal_note","goal":"<titulo>","note":"texto da anotação"}  // edita as notas de uma meta
- {"type":"edit_objective","objective":"<id ou título>","title":"novo","cat":"<id>"}
- {"type":"remove_objective","objective":"<id ou título>"}  // remove objetivo; metas ficam sem objetivo
- {"type":"edit_category","cat":"<id>","newName":"...","glyph":"símbolo","accent":"#hex","catType":"habito|conquista|equilibrio","weight":<num>}  // edita uma área do painel
- {"type":"remove_category","cat":"<id>"}  // remove a área + suas perguntas (reatribui metas/competências à 1ª área restante)
- {"type":"edit_question","question":"<texto atual>","text":"novo texto","qtype":"bool|scale"}
- {"type":"remove_question","question":"<texto ou id>"}  // tira uma pergunta do check-in
- {"type":"remove_skill","skill":"<nome>"}  // remove uma competência/virtude
- {"type":"add_trophy","title":"...","cat":"<id>","importance":1-10,"track":"book|null","note":"o que ele fez","date":"YYYY-MM-DD"}  // registra direto uma conquista já realizada (troféu/medalha/estante)
- {"type":"set_trophy_verified","goal":"<titulo>","verified":true|false}  // confirma ou tira o "a confirmar" de um troféu
- {"type":"add_routine","name":"...","everyDays":<num>}  // cria rotina de casa (lembrete, fora do score)
- {"type":"remove_routine","routine":"<nome>"}
- {"type":"mark_routine","routine":"<nome>"}  // marca rotina como feita hoje
- {"type":"set_learn_track","track":"rotativo|pe|lideranca|filosofia"}  // muda a trilha do Conhecimento do dia
- {"type":"complete_review","kind":"weekly|monthly|semester|year"}  // chame ao final da auditoria/retrospectiva correspondente

Se for só conversa, actions:[]. Nunca confirme progresso sem antes pedir/receber evidência.`;

    try {
      const res = await fetch(AI_ENDPOINT, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model: "claude-sonnet-4-20250514", max_tokens: 1000, system: sys, messages: history.map((m) => ({ role: m.role, content: m.text })) }),
      });
      const data = await res.json();
      let text = data.content.filter((b) => b.type === "text").map((b) => b.text).join("\n").replace(/```json|```/g, "").trim();
      let parsed; try { parsed = JSON.parse(text); } catch { parsed = { reply: text || "Entendido, Gio.", actions: [] }; }
      applyActions(parsed.actions);
      setMessages((m) => [...m, { role: "assistant", text: parsed.reply || "Feito." }]);
      if (parsed.actions && parsed.actions.length) {
        const hasReview = parsed.actions.some((a) => a.type === "complete_review");
        showToast(hasReview ? "Auditoria concluída ✓" : "Atualizado ✓");
      }
    } catch (e) {
      setMessages((m) => [...m, { role: "assistant", text: "Tive um problema pra processar agora, Gio. Tenta de novo." }]);
    }
    setBusy(false);
  };

  return (
    <div className="rise" style={{ display: "flex", flexDirection: "column", height: "calc(100vh - 230px)" }}>
      <h2 style={{ fontFamily: "'Fraunces', serif", fontSize: 24, fontWeight: 500, margin: "12px 0 4px" }}>Coach IA <span style={{ fontSize: 13, color: GOLD }}>· árbitro</span></h2>
      <p style={{ color: "#7d877f", fontSize: 12, marginBottom: 12 }}>Progresso entra provisório e vira definitivo só com evidência.</p>
      <div ref={scrollRef} style={{ flex: 1, overflowY: "auto", display: "flex", flexDirection: "column", gap: 12, paddingBottom: 8 }}>
        {messages.map((m, i) => (
          <div key={i} style={{ alignSelf: m.role === "user" ? "flex-end" : "flex-start", maxWidth: "86%", background: m.role === "user" ? `${ACCENT}1f` : "rgba(255,255,255,0.04)", border: `1px solid ${m.role === "user" ? ACCENT + "44" : "rgba(255,255,255,0.07)"}`, borderRadius: 16, padding: "12px 15px", fontSize: 14, lineHeight: 1.5, whiteSpace: "pre-wrap" }}>{m.text}</div>
        ))}
        {busy && <div style={{ alignSelf: "flex-start", color: "#7d877f", fontSize: 13, padding: "4px 6px" }}>pensando…</div>}
      </div>
      <div style={{ display: "flex", gap: 8, marginTop: 10, paddingTop: 10, borderTop: "1px solid rgba(255,255,255,0.06)" }}>
        <input value={input} onChange={(e) => setInput(e.target.value)} onKeyDown={(e) => e.key === "Enter" && send()} placeholder="Fala comigo, Gio…" style={{ flex: 1, background: "rgba(255,255,255,0.05)", border: "1px solid rgba(255,255,255,0.1)", borderRadius: 12, padding: "13px 15px", color: "#eef2ef", fontSize: 14, outline: "none", fontFamily: "inherit" }} />
        <button onClick={send} disabled={busy} style={{ background: `linear-gradient(135deg, ${ACCENT}, ${GOLD})`, border: "none", borderRadius: 12, padding: "0 20px", color: "#080b0a", fontWeight: 700, cursor: "pointer", fontSize: 15 }}>↑</button>
      </div>
    </div>
  );
}
