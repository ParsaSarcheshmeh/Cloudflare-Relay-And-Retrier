/**
 * Local development server for worker.js — zero dependencies, no wrangler needed.
 *
 *   node dev-server.mjs                # http://localhost:8787
 *   PORT=9000 node dev-server.mjs      # custom port
 *   node dev-server.mjs --port 9000
 *
 * If the preferred port is already taken (leftover wrangler/workerd sessions like to
 * sit on 8787), the server says what is holding it and automatically falls back to the
 * next free port — the banner always prints the port actually in use.
 *
 * It adapts Node's HTTP server to the Worker API (worker.fetch(request, env)) so the
 * exact same code that deploys to Cloudflare runs on your machine. Dev conveniences:
 *   - RELAY_ALLOW_HTTP and RELAY_ALLOW_PRIVATE_NETWORKS default to "true" here so you
 *     can point [provider=...] at localhost services. Set them explicitly to "false"
 *     to rehearse production's SSRF behaviour.
 *   - All other RELAY_* variables from your shell are passed through unchanged.
 *
 * For the most faithful local environment (workerd, real subrequest limits, request
 * signals, WebSocket handling) use `wrangler dev` instead — see README.md.
 */
import http from "node:http";
import { execFileSync } from "node:child_process";
import worker from "./worker.js";

const args = process.argv.slice(2);
const portFlag = args.indexOf("--port");
const PREFERRED_PORT = Number(
  portFlag !== -1 ? args[portFlag + 1] : process.env.PORT || 8787,
);
/** How many consecutive ports to try before giving up. */
const MAX_PORT_ATTEMPTS = 25;

/** Dev-friendly defaults; explicit environment variables always win. */
const ENV = {
  RELAY_ALLOW_HTTP: process.env.RELAY_ALLOW_HTTP ?? "true",
  RELAY_ALLOW_PRIVATE_NETWORKS: process.env.RELAY_ALLOW_PRIVATE_NETWORKS ?? "true",
  ...process.env,
};

const ctx = { waitUntil() {}, passThroughOnException() {} };

async function readRequestBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return Buffer.concat(chunks);
}

async function handle(req, res) {
  const started = Date.now();
  try {
    const url = `http://${req.headers.host || `localhost:${PREFERRED_PORT}`}${req.url}`;
    const method = req.method.toUpperCase();
    const hasBody = method !== "GET" && method !== "HEAD";
    const body = hasBody ? await readRequestBody(req) : undefined;

    // Local stand-in for Cloudflare's edge header so IP-based features work. An
    // explicitly provided value is honored so several IPs can be simulated locally
    // (the real edge always replaces this header, so production is unaffected).
    const requestHeaders = { ...req.headers };
    if (!requestHeaders["cf-connecting-ip"]) {
      requestHeaders["cf-connecting-ip"] = (req.socket.remoteAddress || "127.0.0.1").replace(/^::ffff:/, "");
    }

    const request = new Request(url, {
      method,
      headers: requestHeaders,
      body: body && body.byteLength > 0 ? body : undefined,
    });

    const response = await worker.fetch(request, ENV, ctx);

    const headers = {};
    for (const [name, value] of response.headers.entries()) headers[name] = value;
    // Keep repeated Set-Cookie headers separate, like the platform does.
    if (typeof response.headers.getSetCookie === "function") {
      const cookies = response.headers.getSetCookie();
      if (cookies.length > 0) headers["set-cookie"] = cookies;
    }

    res.writeHead(response.status, response.statusText, headers);
    if (response.body) {
      const reader = response.body.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        res.write(value);
      }
    }
    res.end();
    console.log(`${method} ${req.url} -> ${response.status} (${Date.now() - started}ms)`);
  } catch (error) {
    console.error("dev-server error:", error);
    if (!res.headersSent) {
      res.writeHead(500, { "Content-Type": "application/json" });
    }
    res.end(
      JSON.stringify({
        error: {
          type: "relay_error",
          code: "internal_error",
          message: "dev-server crashed handling this request",
        },
      }),
    );
  }
}

/** Best effort: name the process holding a port, so "EADDRINUSE" is actionable. */
function whoHoldsPort(port) {
  try {
    const output = execFileSync("ss", ["-tlnp"], { encoding: "utf8" });
    const line = output.split("\n").find((l) => l.includes(`:${port} `));
    const match = line && line.match(/users:\(\("([^"]+)",pid=(\d+)/);
    if (match) return `${match[1]} (pid ${match[2]})`;
  } catch {
    /* ss not available or no permission — not important */
  }
  return null;
}

function start(port, attemptsLeft) {
  const server = http.createServer(handle);

  server.on("error", (error) => {
    if (error.code === "EADDRINUSE" && attemptsLeft > 0) {
      const holder = whoHoldsPort(port);
      console.log(
        `port ${port} is already in use` +
          (holder ? ` by ${holder}` : "") +
          ` — falling back to ${port + 1}...`,
      );
      start(port + 1, attemptsLeft - 1);
      return;
    }
    console.error(`dev-server could not bind port ${port}:`, error.message);
    process.exitCode = 1;
  });

  server.listen(port, () => {
    const actual = server.address().port;
    console.log(`AI relay dev server ready on http://localhost:${actual}`);
    if (actual !== PREFERRED_PORT) {
      console.log(`  (requested port ${PREFERRED_PORT} was busy)`);
    }
    console.log("  GET  /__relay/health   health check");
    console.log("  GET  /                 usage document");
    console.log("  POST /v1/chat/completions   (or any provider path)");
    console.log("  env: RELAY_ALLOW_HTTP=true RELAY_ALLOW_PRIVATE_NETWORKS=true (dev defaults)");
  });
}

start(PREFERRED_PORT, MAX_PORT_ATTEMPTS);
