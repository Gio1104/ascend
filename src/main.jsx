import "./storage.js"; // precisa vir antes do App (define window.storage)
import React from "react";
import { createRoot } from "react-dom/client";
import { registerSW } from "virtual:pwa-register";
import App from "./App.jsx";

// --- Service Worker: avisa quando há nova versão (não fica preso em cache antigo) ---
const updateSW = registerSW({
  onNeedRefresh() {
    const bar = document.createElement("div");
    bar.style.cssText =
      "position:fixed;left:50%;bottom:calc(20px + env(safe-area-inset-bottom));transform:translateX(-50%);z-index:9999;background:#141a17;border:1px solid #cba14d66;color:#eef2ef;padding:12px 16px;border-radius:14px;font-family:sans-serif;font-size:14px;display:flex;gap:12px;align-items:center;box-shadow:0 12px 40px rgba(0,0,0,.5)";
    bar.innerHTML =
      '<span>Nova versão disponível</span><button id="asc-upd" style="background:linear-gradient(135deg,#3ddc97,#cba14d);border:none;color:#080b0a;font-weight:700;padding:7px 14px;border-radius:10px;cursor:pointer">Atualizar</button>';
    document.body.appendChild(bar);
    document.getElementById("asc-upd").onclick = () => updateSW(true);
  },
});

createRoot(document.getElementById("root")).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
