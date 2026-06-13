// Proxy para a API da Anthropic — guarda sua chave em segredo (fora do navegador).
// Deploy grátis no Cloudflare Workers. Veja o GUIA.md (Parte 7).
//
// 1) Crie o Worker e cole este código.
// 2) Em Settings > Variables, adicione um SECRET chamado ANTHROPIC_API_KEY com a sua chave.
// 3) Pegue a URL do Worker (ex.: https://ascend-proxy.SEU-USER.workers.dev)
//    e no index.html do app aponte:
//    window.__ASCEND_AI_ENDPOINT__ = "https://ascend-proxy.SEU-USER.workers.dev/v1/messages";

const ALLOWED_ORIGIN = "*"; // troque pelo seu domínio do GitHub Pages para mais segurança

export default {
  async fetch(request, env) {
    const cors = {
      "Access-Control-Allow-Origin": ALLOWED_ORIGIN,
      "Access-Control-Allow-Methods": "POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
    };
    if (request.method === "OPTIONS") return new Response(null, { headers: cors });
    if (request.method !== "POST") return new Response("Method not allowed", { status: 405, headers: cors });

    const body = await request.text();
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": env.ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
      },
      body,
    });
    const out = await res.text();
    return new Response(out, {
      status: res.status,
      headers: { ...cors, "Content-Type": "application/json" },
    });
  },
};
