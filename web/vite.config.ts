import { readFileSync } from "node:fs";
import { defineConfig, type ProxyOptions } from "vite";
import react from "@vitejs/plugin-react";

function inboxSecret(): string {
  try {
    return readFileSync(new URL("./.webhook/secret", import.meta.url), "utf8").trim();
  } catch {
    return "";
  }
}

const inboxProxy: ProxyOptions = {
  target: "http://127.0.0.1:8787",
  configure(proxy) {
    proxy.on("proxyReq", (proxyReq) => {
      const secret = inboxSecret();
      if (secret) proxyReq.setHeader("x-renewpay-inbox", secret);
    });
  },
};

export default defineConfig({
  plugins: [react()],
  server: {
    host: "127.0.0.1",
    port: 5173,
    proxy: { "/inbox": inboxProxy },
  },
  build: { chunkSizeWarningLimit: 800 },
});
