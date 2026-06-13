import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { VitePWA } from "vite-plugin-pwa";

// IMPORTANTE: troque "/ascend/" pelo nome EXATO do seu repositório no GitHub.
// Se o site for https://SEU-USUARIO.github.io/ascend/ -> base = "/ascend/"
const base = "/ascend/";

export default defineConfig({
  base,
  plugins: [
    react(),
    VitePWA({
      registerType: "prompt",
      includeAssets: ["icon.svg", "pwa-192x192.png", "pwa-512x512.png"],
      manifest: {
        name: "Ascend",
        short_name: "Ascend",
        description: "Sistema pessoal de desenvolvimento — à prova de mim.",
        theme_color: "#080b0a",
        background_color: "#080b0a",
        display: "standalone",
        orientation: "portrait",
        scope: base,
        start_url: base,
        icons: [
          { src: "pwa-192x192.png", sizes: "192x192", type: "image/png" },
          { src: "pwa-512x512.png", sizes: "512x512", type: "image/png" },
          { src: "pwa-512x512.png", sizes: "512x512", type: "image/png", purpose: "maskable" }
        ]
      },
      workbox: {
        globPatterns: ["**/*.{js,css,html,svg,png,woff2}"],
        cleanupOutdatedCaches: true
      }
    })
  ]
});
