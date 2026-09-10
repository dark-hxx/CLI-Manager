import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig, loadEnv } from "vite";

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, ".", "");
  const httpTarget = env.VITE_WEB_SERVER_URL?.trim() || "http://127.0.0.1:8787";
  const wsTarget = env.VITE_WEB_SERVER_WS_URL?.trim() || httpTarget.replace(/^http/i, "ws");
  return {
    plugins: [react(), tailwindcss()],
    server: {
      proxy: {
        "/api": httpTarget,
        "/ws": { target: wsTarget, ws: true },
      },
    },
  };
});
