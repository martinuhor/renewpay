import { readFileSync } from "node:fs";
import type { IncomingMessage } from "node:http";
import type { Connect } from "vite";
import { defineConfig, type ProxyOptions } from "vite";
import react from "@vitejs/plugin-react";
import { GET, POST } from "./api/events/route";

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

function readRequestBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > 16_384) {
        reject(new Error("too large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function eventsMiddleware(): Connect.NextHandleFunction {
  return async (req, res, next) => {
    const url = req.url ?? "";
    if (!url.startsWith("/api/events")) {
      next();
      return;
    }
    try {
      const host = req.headers.host ?? "127.0.0.1:5173";
      const request = new Request(`http://${host}${url}`, {
        method: req.method,
        headers: { "content-type": req.headers["content-type"] ?? "application/json" },
        body: req.method === "POST" ? await readRequestBody(req) : undefined,
      });
      const response = req.method === "POST" ? await POST(request) : await GET(request);
      res.statusCode = response.status;
      response.headers.forEach((value, key) => res.setHeader(key, value));
      res.end(Buffer.from(await response.arrayBuffer()));
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : "The signed feed failed.";
      res.statusCode = message === "too large" ? 413 : 500;
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ error: message === "too large" ? "The body is too large." : "The signed feed failed." }));
    }
  };
}

function attachEvents(server: { middlewares: Connect.Server }) {
  server.middlewares.use(eventsMiddleware());
}

export default defineConfig({
  plugins: [
    react(),
    {
      name: "renewpay-events",
      configureServer: attachEvents,
      configurePreviewServer: attachEvents,
    },
  ],
  server: {
    host: "127.0.0.1",
    port: 5173,
    proxy: { "/inbox": inboxProxy },
  },
  build: { chunkSizeWarningLimit: 800 },
});
