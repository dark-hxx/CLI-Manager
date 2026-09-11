import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig, loadEnv, type ProxyOptions } from "vite";

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, ".", "");
  const httpTarget = env.VITE_WEB_SERVER_URL?.trim() || "http://127.0.0.1:8787";
  const wsTarget = env.VITE_WEB_SERVER_WS_URL?.trim() || httpTarget.replace(/^http/i, "ws");
  const browserOrigin = env.VITE_WEB_SERVER_ORIGIN?.trim();
  const configureProxy = browserOrigin
    ? (proxy: Parameters<NonNullable<ProxyOptions["configure"]>>[0]) => {
        const proxyEvents = proxy as unknown as {
          on: (event: "proxyReq" | "proxyReqWs", listener: (request: { setHeader: (name: string, value: string) => void }) => void) => void;
        };
        const applyBrowserOrigin = (request: { setHeader: (name: string, value: string) => void }) => {
          request.setHeader("Origin", browserOrigin);
        };
        proxyEvents.on("proxyReq", applyBrowserOrigin);
        proxyEvents.on("proxyReqWs", applyBrowserOrigin);
      }
    : undefined;
  return {
    plugins: [react(), tailwindcss()],
    server: {
      proxy: {
        "/api": { target: httpTarget, configure: configureProxy },
        "/ws": { target: wsTarget, ws: true, configure: configureProxy },
      },
    },
  };
});
