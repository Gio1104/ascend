# Ascend — subir para o GitHub Pages (PWA)

Guia do zero ao app instalado no celular. Tempo estimado: 20–30 min.

---

## Antes de começar (instalar uma vez)
- **Node.js** (versão 18+): https://nodejs.org → baixe o LTS e instale.
- **Git**: https://git-scm.com → instale.
- **Conta no GitHub**: https://github.com (se ainda não tiver).

Confira no terminal:
```bash
node -v
git --version
```

---

## Parte 1 — Pegar os arquivos
Você recebeu a pasta `ascend-pwa`. Coloque-a onde quiser (ex.: `Documentos`).
Abra o terminal **dentro** dessa pasta:
```bash
cd caminho/para/ascend-pwa
```

---

## Parte 2 — Rodar no seu computador (testar)
```bash
npm install
npm run dev
```
Abra o endereço que aparecer (ex.: `http://localhost:5173`). O app deve abrir com a animação do logo. `Ctrl+C` encerra.

> Obs.: as funções de IA (Coach, resumo, pílula) **ainda não funcionam** aqui — isso é a Parte 7.

---

## Parte 3 — Ajustar o nome do repositório
Você vai criar um repositório no GitHub. **Decida o nome agora** (ex.: `ascend`).
Abra `vite.config.js` e confirme a linha:
```js
const base = "/ascend/";   // troque "ascend" pelo nome EXATO do seu repo
```
Se o nome do repo for diferente, ajuste aqui.

---

## Parte 4 — Criar o repositório e enviar o código
1. No GitHub: **New repository** → nome `ascend` (igual ao base) → **Create**.
2. No terminal, dentro da pasta:
```bash
git init
git add .
git commit -m "Ascend v1"
git branch -M main
git remote add origin https://github.com/SEU-USUARIO/ascend.git
git push -u origin main
```

---

## Parte 5 — Publicar no GitHub Pages
```bash
npm run deploy
```
Isso compila o app e publica na branch `gh-pages`.

Depois, no GitHub:
**Settings → Pages →** em "Build and deployment", Source = **Deploy from a branch**, Branch = **gh-pages** / **/(root)** → Save.

Aguarde ~1 min. Seu app estará em:
```
https://SEU-USUARIO.github.io/ascend/
```

> Para atualizar o app no futuro: faça suas mudanças, depois
> `git add . && git commit -m "..." && git push` e `npm run deploy` de novo.
> Quem já tem o app instalado verá o aviso **"Nova versão disponível → Atualizar"**.

---

## Parte 6 — Instalar no celular (S24)
1. Abra o link do app no **Chrome** do celular.
2. Menu (⋮) → **Adicionar à tela inicial** / **Instalar app**.
3. Pronto: ícone do Ascend na tela inicial, abre em tela cheia.

> Seus dados ficam salvos **no aparelho** (localStorage). Faça **backup** pelo ⚙️ Ajustes → Exportar de tempos em tempos.

---

## Parte 7 — Ligar a IA (Coach, resumo, pílula, avaliações)
GitHub Pages é só estático, então a IA precisa de um **proxy** que guarde sua chave da Anthropic com segurança (nunca coloque a chave no app — ela ficaria exposta).

### 7.1 — Pegue uma chave da Anthropic
https://console.anthropic.com → API Keys → crie uma chave. (Uso é pago por consumo.)

### 7.2 — Crie o proxy no Cloudflare (grátis)
1. Conta em https://dash.cloudflare.com → **Workers & Pages** → **Create Worker**.
2. Substitua o código pelo conteúdo de `worker/worker.js` (está na pasta).
3. **Deploy**.
4. No Worker → **Settings → Variables and Secrets** → adicione um **Secret**:
   - Nome: `ANTHROPIC_API_KEY`
   - Valor: sua chave da Anthropic
5. Copie a URL do Worker (ex.: `https://ascend-proxy.SEU-USER.workers.dev`).

### 7.3 — Apontar o app para o proxy
Abra `index.html` e descomente/edite a linha:
```html
<script>
  window.__ASCEND_AI_ENDPOINT__ = "https://ascend-proxy.SEU-USER.workers.dev/v1/messages";
</script>
```
Depois `npm run deploy` de novo. Pronto — Coach, resumo semanal, pílula e avaliações funcionando.

> Dica de segurança: no `worker.js`, troque `ALLOWED_ORIGIN = "*"` pelo seu domínio
> `"https://SEU-USUARIO.github.io"` para só o seu app poder usar o proxy.

---

## Parte 8 — Trazer seu histórico
Se você já usava o Ascend e exportou um backup `.json`:
no app publicado, ⚙️ Ajustes → cole o backup em **Importar** → Importar. Tudo volta intacto.

---

## Resumo dos comandos do dia a dia
```bash
npm run dev        # rodar local
git add . && git commit -m "msg" && git push   # versionar
npm run deploy     # publicar a nova versão
```

Qualquer erro, me manda a mensagem do terminal que eu te desencalho. 🔥
