import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import zlib from "node:zlib";
import { once } from "node:events";
import { createHash } from "node:crypto";

import worker from "../worker.js";
import { __internals } from "../worker.js";

const { decodeSessionToken, resolveConfig } = __internals;

/* -------------------------------------------------------------------------- *
 * Mock provider
 * -------------------------------------------------------------------------- */

const state = {
  requests: [],
  counters: new Map(),
};

function bump(key) {
  const next = (state.counters.get(key) || 0) + 1;
  state.counters.set(key, next);
  return next;
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

function sendJson(res, status, payload, extraHeaders = {}) {
  const body = Buffer.from(JSON.stringify(payload), "utf8");
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": String(body.byteLength),
    ...extraHeaders,
  });
  res.end(body);
}

const server = http.createServer(async (req, res) => {
  const body = await readBody(req);
  // Derive the scheme+host from the request so port-bearing URLs (redirect targets)
  // are correct.
  const url = new URL(req.url, `http://${req.headers.host || "127.0.0.1"}`);
  state.requests.push({
    method: req.method,
    path: url.pathname,
    search: url.search,
    headers: { ...req.headers },
    body,
  });
  const path = url.pathname;

  if (path === "/v1/audio/speech") {
    // Deliberately non-UTF8 bytes: the relay must never decode a binary response.
    const audio = Buffer.from([0xff, 0xfb, 0x90, 0x00, 0x01, 0x02, 0xfe, 0xff, 0x00, 0x7f]);
    res.writeHead(200, { "Content-Type": "audio/mpeg", "Content-Length": String(audio.byteLength) });
    res.end(audio);
    return;
  }

  if (path === "/v1/sse") {
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    });
    res.write('data: {"delta":"first"}\n\n');
    setTimeout(() => {
      res.write('data: {"delta":"دوم 😄"}\n\n');
      res.write("data: [DONE]\n\n");
      res.end();
    }, 250);
    return;
  }

  if (path === "/v1/flaky") {
    const hit = bump("flaky");
    if (hit <= 3) {
      sendJson(res, 429, { error: { message: "slow down" } }, { "Retry-After": "0" });
      return;
    }
    sendJson(res, 200, { ok: true, attempt: hit });
    return;
  }

  if (path === "/v1/unauthorized") {
    bump("unauthorized");
    sendJson(res, 401, { error: { message: "invalid api key", type: "auth" } }, { "X-Request-Id": "req-401" });
    return;
  }

  if (path === "/v1/always-503") {
    bump("always503");
    sendJson(res, 503, { error: { message: "upstream down" } }, { "Retry-After": "0" });
    return;
  }

  if (path === "/v1/slow-503") {
    bump("slow503");
    setTimeout(() => sendJson(res, 503, { error: { message: "still down" } }), 60);
    return;
  }
  if (path === "/v1/timeout-once") {
    const hit = bump("timeoutOnce");
    if (hit === 1) return; // never answers: forces the per-attempt timeout to fire
    sendJson(res, 200, { ok: true, attempt: hit });
    return;
  }

  if (path === "/v1/redirect-relative") {
    bump("redirectRelative");
    res.writeHead(307, { Location: "/v1/redirect-target" });
    res.end();
    return;
  }

  if (path === "/v1/redirect-target") {
    bump("redirectTarget");
    sendJson(res, 200, { ok: true, arrivedAt: path, method: req.method, body: body.toString("utf8") });
    return;
  }

  if (path === "/v1/redirect-see-other") {
    res.writeHead(303, { Location: "/v1/redirect-target" });
    res.end();
    return;
  }

  if (path === "/v1/redirect-private") {
    res.writeHead(302, { Location: "http://169.254.169.254/latest/meta-data/" });
    res.end();
    return;
  }

  if (path === "/v1/redirect-bad-scheme") {
    res.writeHead(302, { Location: "ftp://files.example.com/data" });
    res.end();
    return;
  }

  if (path === "/v1/redirect-cross-origin") {
    // Bounce to the same server via a different origin string ("localhost" vs
    // "127.0.0.1") so the relay sees a cross-origin redirect.
    const other = `http://localhost:${url.port}/v1/echo-headers`;
    res.writeHead(307, { Location: other });
    res.end();
    return;
  }

  if (path === "/v1/echo-headers") {
    sendJson(res, 200, {
      path,
      authorization: req.headers.authorization ?? null,
      apiKeyHeader: req.headers["x-api-key"] ?? null,
    });
    return;
  }

  if (path === "/v1/cookies") {
    res.writeHead(200, {
      "Content-Type": "text/plain",
      "Content-Length": "2",
      "Set-Cookie": ["a=1; Path=/", "b=2; Path=/"],
    });
    res.end("ok");
    return;
  }

  if (path === "/v1/compressed") {
    // A genuinely gzipped body: the runtime decompresses it, so the relay must strip
    // the stale Content-Encoding / Content-Length headers before streaming it on.
    const body = zlib.gzipSync(Buffer.from(JSON.stringify({ ok: true }), "utf8"));
    res.writeHead(200, {
      "Content-Type": "application/json",
      "Content-Encoding": "gzip",
      "Content-Length": String(body.byteLength),
    });
    res.end(body);
    return;
  }

  const contentType = req.headers["content-type"] || "";
  const isJson = contentType.includes("json");
  sendJson(
    res,
    200,
    {
      ok: true,
      method: req.method,
      path,
      search: url.search,
      contentType,
      authorization: req.headers.authorization ?? null,
      apiKeyHeader: req.headers["x-api-key"] ?? null,
      anthropicVersion: req.headers["anthropic-version"] ?? null,
      receivedRaw: isJson ? body.toString("utf8") : null,
      received: isJson && body.length ? JSON.parse(body.toString("utf8")) : null,
      bodyBase64: isJson ? null : body.toString("base64"),
      bodySha256: createHash("sha256").update(body).digest("hex"),
      bodyLength: body.byteLength,
      headerNames: Object.keys(req.headers).sort(),
    },
    { ETag: 'W/"abc123"', "RateLimit-Remaining": "42" },
  );
});

let origin = "";

test.before(async () => {
  // Dual-stack listener: the cross-origin redirect test reaches the server through
  // "localhost" (which may resolve to ::1) as well as "127.0.0.1".
  server.listen({ port: 0, host: "::", ipv6Only: false });
  await once(server, "listening");
  const address = server.address();
  origin = `http://127.0.0.1:${address.port}`;
});

test.after(async () => {
  server.close();
  await once(server, "close");
});

test.beforeEach(() => {
  state.requests.length = 0;
  state.counters.clear();
});

/** Worker env: private/http upstreams allowed, retries fast, no jitter. */
const ENV = {
  RELAY_ALLOW_HTTP: "true",
  RELAY_ALLOW_PRIVATE_NETWORKS: "true",
  RELAY_BASE_DELAY_MS: "1",
  RELAY_MAX_DELAY_MS: "4",
  RELAY_MIN_DELAY_MS: "1",
  RELAY_JITTER: "false",
  RELAY_MAX_ATTEMPTS: "8",
  // Safety net so a hanging upstream can never stall the suite.
  RELAY_ATTEMPT_TIMEOUT_MS: "3000",
};

function callWorker(path, init = {}, env = ENV) {
  const request = new Request(`https://relay.workers.dev${path}`, init);
  return worker.fetch(request, env, { waitUntil() {}, passThroughOnException() {} });
}

/** POST a JSON body to the relay and return the parsed relay + upstream views. */
async function postJson(path, body, { env = ENV, headers = {} } = {}) {
  const response = await callWorker(path, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
  }, env);
  const text = await response.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* non-JSON relay response */
  }
  return { response, text, json, upstream: state.requests[state.requests.length - 1] };
}
/* -------------------------------------------------------------------------- *
 * Chat completions / provider / key / model
 * -------------------------------------------------------------------------- */

test("spec test 3: provider + key + model directives drive the upstream call", async () => {
  const { response, json, upstream } = await postJson("/v1/chat/completions", {
    model: "client-default",
    messages: [
      { role: "system", content: "You are helpful." },
      {
        role: "user",
        content: `Hello, explain quantum computing.\n\n[provider=${origin}/v1]\n[model=gpt-5]\n[key=ABC]`,
      },
    ],
  });

  assert.equal(response.status, 200);
  assert.equal(upstream.path, "/v1/chat/completions");
  assert.equal(upstream.headers.authorization, "Bearer ABC");
  assert.equal(json.received.model, "gpt-5");
  assert.equal(json.received.messages[1].content, "Hello, explain quantum computing.");
  assert.equal(json.received.messages[0].content, "You are helpful.");
  assert.equal(JSON.stringify(json.received).includes("ABC"), false, "the key must not reach the model");
  assert.equal(response.headers.get("X-Relay-Attempts"), "1");
  assert.equal(response.headers.get("X-Relay-Compatibility"), "openai");
  assert.equal(response.headers.get("X-Relay-Model"), "gpt-5");
});

test("spec test 4: a free provider gets no authorization header", async () => {
  const { json, upstream } = await postJson("/v1/chat/completions", {
    messages: [{ role: "user", content: `hi [provider=${origin}/v1]` }],
  });
  assert.equal(upstream.headers.authorization, undefined);
  assert.equal(json.authorization, null);
  assert.equal(json.received.model, undefined, "no model directive must not invent a model");
});

test("the model directive overrides the client model, and its absence preserves it", async () => {
  const overridden = await postJson("/v1/chat/completions", {
    model: "client-model",
    messages: [{ role: "user", content: `hi [provider=${origin}/v1][model=forced]` }],
  });
  assert.equal(overridden.json.received.model, "forced");

  const preserved = await postJson("/v1/chat/completions", {
    model: "client-model",
    messages: [{ role: "user", content: `hi [provider=${origin}/v1]` }],
  });
  assert.equal(preserved.json.received.model, "client-model");
});
test("spec test 5: anthropic compatibility switches the auth style", async () => {
  const { json } = await postJson("/v1/messages", {
    max_tokens: 100,
    messages: [
      {
        role: "user",
        content: `hello [provider=${origin}][compatibility=anthropic][key=ABC][model=claude-model]`,
      },
    ],
  });
  assert.equal(json.path, "/v1/messages");
  assert.equal(json.apiKeyHeader, "ABC");
  assert.equal(json.authorization, null);
  assert.equal(json.anthropicVersion, "2023-06-01");
  assert.equal(json.received.model, "claude-model");
  assert.equal(json.received.messages[0].content, "hello");
});

test("spec test 6: vision payloads reach the provider unchanged", async () => {
  const imagePart = {
    type: "image_url",
    image_url: {
      url: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8AAAwAB/AF+0Q0AAAAASUVORK5CYII=",
      detail: "high",
    },
  };
  const remotePart = { type: "image_url", image_url: { url: "https://cdn.example.com/a.png" } };
  const { json } = await postJson("/v1/chat/completions", {
    messages: [
      {
        role: "user",
        content: [
          { type: "text", text: `describe this image [provider=${origin}/v1][model=vision-x]` },
          imagePart,
          remotePart,
        ],
      },
    ],
  });
  assert.equal(json.received.model, "vision-x");
  assert.equal(json.received.messages[0].content[0].text, "describe this image");
  assert.deepEqual(json.received.messages[0].content[1], imagePart);
  assert.deepEqual(json.received.messages[0].content[2], remotePart);
});

test("unicode survives the whole round trip byte-for-byte", async () => {
  const prompt = "سلام دنیا 😄🔥 — こんにちは 👋 — مرحبا — नमस्ते é\u0301 — 🇮🇷\ttab\nnewline";
  const { json } = await postJson("/v1/chat/completions", {
    messages: [{ role: "user", content: `${prompt} [provider=${origin}/v1][model=uni]` }],
  });
  assert.equal(json.received.messages[0].content, prompt);
});
test("an untouched JSON body is forwarded byte-for-byte", async () => {
  const raw = '{"zzz":1,"messages":[{"role":"user","content":"plain question"}],"aaa":[1.50,2e3]}';
  const { json } = await postJson("/v1/chat/completions", raw, {
    headers: { "X-Relay-Provider": `${origin}/v1` },
  });
  assert.equal(json.receivedRaw, raw, "no directives in the body means no re-serialization");
});

/* -------------------------------------------------------------------------- *
 * Binary, streaming and multipart
 * -------------------------------------------------------------------------- */

test("spec test 8: TTS audio is streamed back as untouched binary", async () => {
  const response = await callWorker("/v1/audio/speech", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model: "tts-model", input: `Hello [provider=${origin}/v1][model=tts-new]` }),
  });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("Content-Type"), "audio/mpeg");
  const bytes = Buffer.from(await response.arrayBuffer());
  assert.deepEqual([...bytes], [0xff, 0xfb, 0x90, 0x00, 0x01, 0x02, 0xfe, 0xff, 0x00, 0x7f]);

  const upstream = state.requests[0];
  const sent = JSON.parse(upstream.body.toString("utf8"));
  assert.equal(sent.input, "Hello");
  assert.equal(sent.model, "tts-new");
});

test("spec test 10: SSE reaches the client incrementally, not buffered", async () => {
  const response = await callWorker("/v1/sse", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      stream: true,
      messages: [{ role: "user", content: `stream please [provider=${origin}]` }],
    }),
  });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("Content-Type"), "text/event-stream");

  const started = Date.now();
  const reader = response.body.getReader();
  const first = await reader.read();
  const firstChunkAt = Date.now() - started;
  assert.equal(new TextDecoder().decode(first.value).includes('"first"'), true);
  assert.ok(firstChunkAt < 200, `first chunk should arrive immediately, took ${firstChunkAt}ms`);

  let rest = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    rest += new TextDecoder().decode(value);
  }
  assert.equal(rest.includes("دوم 😄"), true);
  assert.equal(rest.includes("[DONE]"), true);
  assert.ok(Date.now() - started >= 200, "the tail arrives only after the provider sends it");
});
test("spec test 9: multipart STT keeps the audio bytes and rewrites the model field", async () => {
  const audioBytes = new Uint8Array([0x52, 0x49, 0x46, 0x46, 0x00, 0xff, 0x10, 0x7f, 0x00, 0x01]);
  const form = new FormData();
  form.append("file", new Blob([audioBytes], { type: "audio/wav" }), "speech.wav");
  form.append("model", "whisper-1");
  form.append("language", "fa");
  form.append("prompt", `transcribe this [provider=${origin}/v1][model=whisper-large][key=STT-KEY]`);
  form.append("temperature", "0");

  const response = await callWorker("/v1/audio/transcriptions", { method: "POST", body: form });
  assert.equal(response.status, 200);
  const json = await response.json();

  assert.equal(json.path, "/v1/audio/transcriptions");
  assert.equal(json.authorization, "Bearer STT-KEY");
  assert.match(json.contentType, /^multipart\/form-data; boundary=/);

  // Re-parse the multipart body the provider received using the platform parser.
  const received = await new Response(Buffer.from(json.bodyBase64, "base64"), {
    headers: { "Content-Type": json.contentType },
  }).formData();

  assert.equal(received.get("model"), "whisper-large");
  assert.equal(received.get("prompt"), "transcribe this");
  assert.equal(received.get("language"), "fa");
  assert.equal(received.get("temperature"), "0");
  const file = received.get("file");
  assert.equal(file.name, "speech.wav");
  assert.equal(file.type, "audio/wav");
  assert.deepEqual(new Uint8Array(await file.arrayBuffer()), audioBytes);
});

test("an opaque binary upload is forwarded untouched using query directives", async () => {
  const payload = new Uint8Array(512);
  for (let index = 0; index < payload.length; index += 1) payload[index] = index % 256;
  const expected = createHash("sha256").update(payload).digest("hex");

  const response = await callWorker(
    `/v1/audio/transcriptions?provider=${encodeURIComponent(origin)}&key=QKEY&model=qmodel&keep=me`,
    {
      method: "POST",
      headers: { "Content-Type": "application/octet-stream" },
      body: payload,
    },
  );
  const json = await response.json();
  assert.equal(json.bodySha256, expected);
  assert.equal(json.bodyLength, payload.length);
  assert.equal(json.authorization, "Bearer QKEY");
  assert.equal(json.contentType, "application/octet-stream");
  assert.equal(json.search, "?keep=me", "relay params are consumed, others are preserved");
});
test("a streamed request body is forwarded but never retried", async () => {
  // Disable opaque-body buffering so the stream cannot be replayed at all.
  const env = { ...ENV, RELAY_MAX_BUFFER_BYTES: "0" };
  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode("chunk-1;"));
      controller.enqueue(new TextEncoder().encode("chunk-2"));
      controller.close();
    },
  });
  const response = await callWorker(
    `/v1/always-503?provider=${encodeURIComponent(origin)}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/octet-stream" },
      body: stream,
      duplex: "half",
    },
    env,
  );
  assert.equal(response.status, 503);
  const json = await response.json();
  assert.equal(json.error.code, "retry_exhausted");
  assert.equal(state.counters.get("always503"), 1, "a one-shot stream must not be replayed");
  assert.match(json.error.details.note, /one-shot stream/);
});

test("a small streamed body is buffered and therefore stays retryable", async () => {
  const { response } = await postJson("/v1/flaky", {
    messages: [{ role: "user", content: `retry me [provider=${origin}]` }],
  });
  // Sanity: the JSON path stays retryable.
  assert.equal(response.status, 200);

  // Fresh 429x3-then-200 burst for the streamed-body call.
  state.counters.set("flaky", 0);
  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode("chunk-1;chunk-2"));
      controller.close();
    },
  });
  const opaque = await callWorker(`/v1/flaky?provider=${encodeURIComponent(origin)}`, {
    method: "POST",
    headers: { "Content-Type": "application/octet-stream" },
    body: stream,
    duplex: "half",
  });
  assert.equal(opaque.status, 200);
  const opaqueJson = await opaque.json();
  assert.equal(opaqueJson.attempt, 4, "the buffered stream must be replayed on retries");
  assert.equal(state.counters.get("flaky"), 4);
});

test("REGRESSION: a cross-origin redirect drops credentials before following", async () => {
  // Direct call: the key header reaches the provider as usual...
  const direct = await postJson("/v1/echo-headers", {
    messages: [{ role: "user", content: `hi [provider=${origin}][key=DIRECT-KEY]` }],
  });
  assert.equal(direct.json.authorization, "Bearer DIRECT-KEY");

  // ...but a redirect to a different origin must not carry it along.
  const redirected = await postJson("/v1/redirect-cross-origin", {
    messages: [
      { role: "user", content: `hi [provider=${origin}][key=TOPSECRET][header=X-Api-Key: oops]` },
    ],
  });
  assert.equal(redirected.response.status, 200);
  assert.equal(redirected.json.authorization, null, "Authorization must be dropped on cross-origin redirect");
  assert.equal(redirected.json.apiKeyHeader, null, "x-api-key must be dropped on cross-origin redirect");
});

test("REGRESSION: multiple Set-Cookie headers survive the relay", async () => {
  const response = await callWorker(`/v1/cookies?provider=${encodeURIComponent(origin)}`, { method: "GET" });
  const cookies = response.headers.getSetCookie();
  assert.ok(cookies.includes("a=1; Path=/"), `missing cookie a, got: ${JSON.stringify(cookies)}`);
  assert.ok(cookies.includes("b=2; Path=/"), `missing cookie b, got: ${JSON.stringify(cookies)}`);
});

test("REGRESSION: stale Content-Encoding / Content-Length headers are not forwarded", async () => {
  const response = await callWorker(`/v1/compressed?provider=${encodeURIComponent(origin)}`, { method: "GET" });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("Content-Encoding"), null);
  assert.equal(response.headers.get("Content-Length"), null);
  assert.deepEqual(await response.json(), { ok: true });
});

/* -------------------------------------------------------------------------- *
 * Sticky sessions (subagents & compaction) + named providers
 * -------------------------------------------------------------------------- */

/** Parent-style request: full directives in the prompt. Returns the issued token. */
async function parentRequest() {
  const { response, json } = await postJson("/v1/chat/completions", {
    messages: [
      {
        role: "user",
        content: `Explain something. [provider=${origin}/v1][model=session-model][key=SESSION-KEY]`,
      },
    ],
  });
  assert.equal(response.status, 200);
  const token = response.headers.get("X-Relay-Session");
  assert.match(token, /^rls1_/);
  assert.equal(json.received.messages[0].content, "Explain something.");
  return { token, parentJson: json };
}

test("REGRESSION: a subagent with no directives inherits the session via header", async () => {
  const { token } = await parentRequest();

  // The subagent's harness sends a FRESH conversation: no directives anywhere.
  const { response, json } = await postJson("/v1/chat/completions", {
    messages: [{ role: "user", content: "subagent task without any directives" }],
  }, { headers: { "X-Relay-Session": token } });

  assert.equal(response.status, 200);
  assert.equal(json.path, "/v1/chat/completions");
  assert.equal(json.authorization, "Bearer SESSION-KEY", "session must restore the key");
  assert.equal(json.received.model, "session-model", "session must restore the model");
  assert.equal(json.received.messages[0].content, "subagent task without any directives");
  // The session is renewed so the chain can continue indefinitely.
  assert.match(response.headers.get("X-Relay-Session"), /^rls1_/);
  // Unsigned tokens are readable: decoding (no secret) must yield the key.
  const renewed = await decodeSessionToken(response.headers.get("X-Relay-Session"), resolveConfig({}));
  assert.equal(renewed.apiKey, "SESSION-KEY");
});

test("REGRESSION: a post-compaction request inherits the session via query param", async () => {
  const { token } = await parentRequest();

  // After compaction the history was replaced by a summary; the harness still has
  // the token and appends it to the URL.
  const { response, json } = await postJson(
    `/v1/chat/completions?relay_session=${encodeURIComponent(token)}`,
    { messages: [{ role: "user", content: "post-compaction turn" }] },
  );
  assert.equal(response.status, 200);
  assert.equal(json.authorization, "Bearer SESSION-KEY");
  assert.equal(json.received.model, "session-model");
  // The relay param is consumed and never reaches the provider.
  assert.equal(json.search, "");
});

test("REGRESSION: a post-compaction request inherits the session via cookie", async () => {
  const { token } = await parentRequest();
  const { response, json } = await postJson(
    "/v1/chat/completions",
    { messages: [{ role: "user", content: "browser turn" }] },
    { headers: { Cookie: `relay_session=${token}; other=1` } },
  );
  assert.equal(response.status, 200);
  assert.equal(json.authorization, "Bearer SESSION-KEY");
  assert.equal(json.received.model, "session-model");
  assert.equal(json.headerNames.includes("cookie"), false, "cookies are never forwarded upstream");
});

test("REGRESSION: a token pasted into a subagent prompt is applied and stripped", async () => {
  const { token } = await parentRequest();

  // The parent model included the token in the prompt it wrote for the subagent.
  const { response, json } = await postJson("/v1/chat/completions", {
    messages: [
      {
        role: "user",
        content: `You are a subagent. Relay session: ${token}\nNow do the task. سلام 😄`,
      },
    ],
  });
  assert.equal(response.status, 200);
  assert.equal(json.authorization, "Bearer SESSION-KEY");
  assert.equal(json.received.model, "session-model");
  assert.equal(
    JSON.stringify(json.received).includes("rls1_"),
    false,
    "the token must be stripped before the provider sees the prompt",
  );
  assert.equal(json.received.messages[0].content.includes("Now do the task. سلام 😄"), true);
});

test("request-level directives still win over the session (first occurrence wins)", async () => {
  const { token } = await parentRequest();
  const { response, json } = await postJson("/v1/chat/completions", {
    messages: [{ role: "user", content: "override [model=body-model]" }],
  }, { headers: { "X-Relay-Session": token } });
  assert.equal(response.status, 200);
  assert.equal(json.received.model, "body-model", "the in-request directive must win");
  assert.equal(json.authorization, "Bearer SESSION-KEY", "the session still fills the gaps");
});

test("a tampered token is ignored, not fatal", async () => {
  const { token } = await parentRequest();
  const { response, json } = await postJson(
    "/v1/chat/completions",
    { messages: [{ role: "user", content: "hi" }] },
    { headers: { "X-Relay-Session": `${token}XXXX` } },
  );
  assert.equal(response.status, 400);
  assert.equal(json.error.code, "missing_provider");
});

test("RELAY_SESSIONS=false disables issuance and inheritance", async () => {
  const env = { ...ENV, RELAY_SESSIONS: "false" };
  const first = await postJson("/v1/chat/completions", {
    messages: [{ role: "user", content: `hi [provider=${origin}/v1][model=m]` }],
  }, { env });
  assert.equal(first.response.headers.get("X-Relay-Session"), null);

  const token = (await parentRequest()).token;
  const second = await postJson("/v1/chat/completions", {
    messages: [{ role: "user", content: "no inheritance now" }],
  }, { env, headers: { "X-Relay-Session": token } });
  assert.equal(second.response.status, 400, "the token must be ignored when sessions are off");
  assert.equal(second.json.error.code, "missing_provider");
});

test("named providers route by first path segment and keep auth passthrough", async () => {
  const env = { ...ENV, RELAY_NAMED_PROVIDERS: `mock=${origin}` };
  const response = await callWorker("/mock/v1/models", {
    method: "GET",
    headers: { Authorization: "Bearer PATH-KEY" },
  }, env);
  const json = await response.json();
  assert.equal(response.status, 200);
  assert.equal(json.path, "/v1/models");
  assert.equal(json.authorization, "Bearer PATH-KEY");

  // Directives still win over the path provider, and the token captures the resolved route.
  const { response: r2, json: j2 } = await postJson("/mock/v1/chat/completions", {
    messages: [{ role: "user", content: "hi [model=nm]" }],
  }, { env });
  assert.equal(j2.received.model, "nm");
  assert.match(r2.headers.get("X-Relay-Session"), /^rls1_/);
});

test("[provider=name] expands through RELAY_NAMED_PROVIDERS", async () => {
  const env = { ...ENV, RELAY_NAMED_PROVIDERS: `mock=${origin}/v1` };
  const { json } = await postJson("/v1/chat/completions", {
    messages: [{ role: "user", content: "hi [provider=mock][model=short]" }],
  }, { env });
  assert.equal(json.path, "/v1/chat/completions");
  assert.equal(json.received.model, "short");
});

test("the usage document documents sessions and named providers", async () => {
  const response = await callWorker("/__relay/help", { method: "GET" });
  const help = await response.json();
  assert.equal(help.stickySessions.tokenPrefix, "rls1_");
  assert.match(help.stickySessions.how, /X-Relay-Session/);
  assert.ok(help.namedProviders);
});

/* -------------------------------------------------------------------------- *
 * Reasoning effort
 * -------------------------------------------------------------------------- */

test("reasoning directive reaches an OpenAI-style provider as reasoning_effort", async () => {
  const { response, json } = await postJson("/v1/chat/completions", {
    messages: [{ role: "user", content: `solve it [provider=${origin}/v1][model=gpt-5][reasoning=high]` }],
  });
  assert.equal(response.status, 200);
  assert.equal(json.received.reasoning_effort, "high");
  assert.equal(json.received.model, "gpt-5");
  assert.equal(json.received.messages[0].content, "solve it", "the directive is stripped from the prompt");
});

test("reasoning directive reaches the Responses API as reasoning.effort", async () => {
  const { json } = await postJson("/v1/responses", {
    input: [{ role: "user", content: [{ type: "input_text", text: `hi [provider=${origin}/v1][reasoning=max]` }] }],
    reasoning: { summary: "auto" },
  });
  assert.deepEqual(json.received.reasoning, { summary: "auto", effort: "max" });
  assert.equal(json.received.reasoning_effort, undefined);
});

test("reasoning directive becomes Claude thinking with a legal budget", async () => {
  const { json } = await postJson("/v1/messages", {
    model: "claude-sonnet-4-5",
    max_tokens: 16000,
    messages: [{ role: "user", content: `hi [provider=${origin}][compatibility=anthropic][reasoning=high]` }],
  });
  assert.deepEqual(json.received.thinking, { type: "enabled", budget_tokens: 12800 });
  assert.ok(json.received.thinking.budget_tokens < json.received.max_tokens);
  assert.equal(json.received.reasoning_effort, undefined, "Claude must not get the flat field");
});

test("[reasoning=off] disables Claude thinking explicitly", async () => {
  const { json } = await postJson("/v1/messages", {
    model: "claude-sonnet-4-5",
    max_tokens: 4000,
    messages: [{ role: "user", content: `hi [provider=${origin}][compatibility=anthropic][reasoning=off]` }],
  });
  assert.deepEqual(json.received.thinking, { type: "disabled" });
});

test("reasoning is not injected into endpoints without such a parameter", async () => {
  const response = await callWorker("/v1/audio/speech", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: "tts-1",
      input: `Hello [provider=${origin}/v1][reasoning=high]`,
    }),
  });
  assert.equal(response.status, 200);
  const sent = JSON.parse(state.requests[0].body.toString("utf8"));
  assert.equal(sent.reasoning_effort, undefined);
  assert.equal(sent.thinking, undefined);
  assert.equal(sent.input, "Hello");
});

test("reasoning can also arrive as a query param or an X-Relay header", async () => {
  const query = await postJson(
    `/v1/chat/completions?reasoning=low&provider=${encodeURIComponent(`${origin}/v1`)}`,
    { messages: [{ role: "user", content: "hi" }] },
  );
  assert.equal(query.json.received.reasoning_effort, "low");
  assert.equal(query.json.search, "", "relay params are consumed");

  const header = await postJson(
    "/v1/chat/completions",
    { messages: [{ role: "user", content: "hi" }] },
    { headers: { "X-Relay-Provider": `${origin}/v1`, "X-Relay-Reasoning": "minimal" } },
  );
  assert.equal(header.json.received.reasoning_effort, "minimal");
});

test("REGRESSION: a subagent inherits reasoning effort through the session token", async () => {
  const parent = await postJson("/v1/chat/completions", {
    messages: [
      {
        role: "user",
        content: `parent [provider=${origin}/v1][model=deep-model][key=RK][reasoning=xhigh]`,
      },
    ],
  });
  assert.equal(parent.json.received.reasoning_effort, "xhigh");
  const token = parent.response.headers.get("X-Relay-Session");

  const subagent = await postJson(
    "/v1/chat/completions",
    { messages: [{ role: "user", content: "subagent prompt with no directives" }] },
    { headers: { "X-Relay-Session": token } },
  );
  assert.equal(subagent.json.received.reasoning_effort, "xhigh", "effort must survive into the subagent");
  assert.equal(subagent.json.received.model, "deep-model");
  assert.equal(subagent.json.authorization, "Bearer RK");
});

test("an explicit numeric budget survives the session round trip", async () => {
  const parent = await postJson("/v1/messages", {
    model: "claude-sonnet-4-5",
    max_tokens: 20000,
    messages: [{ role: "user", content: `hi [provider=${origin}][compatibility=anthropic][reasoning=7000]` }],
  });
  assert.equal(parent.json.received.thinking.budget_tokens, 7000);

  const token = parent.response.headers.get("X-Relay-Session");
  const child = await postJson(
    "/v1/messages",
    { model: "claude-sonnet-4-5", max_tokens: 20000, messages: [{ role: "user", content: "child" }] },
    { headers: { "X-Relay-Session": token } },
  );
  assert.equal(child.json.received.thinking.budget_tokens, 7000);
});

/* -------------------------------------------------------------------------- *
 * Retry behaviour
 * -------------------------------------------------------------------------- */

test("spec test 11: three 429s then a 200 is retried transparently", async () => {
  const { response, json } = await postJson("/v1/flaky", {
    messages: [{ role: "user", content: `retry me [provider=${origin}]` }],
  });
  assert.equal(response.status, 200);
  assert.equal(json.ok, true);
  assert.equal(json.attempt, 4);
  assert.equal(response.headers.get("X-Relay-Attempts"), "4");
  assert.equal(state.counters.get("flaky"), 4);
});

test("spec test 12: a 401 is returned immediately and never retried", async () => {
  const { response, json } = await postJson("/v1/unauthorized", {
    messages: [{ role: "user", content: `hi [provider=${origin}]` }],
  });
  assert.equal(response.status, 401);
  assert.deepEqual(json, { error: { message: "invalid api key", type: "auth" } });
  assert.equal(response.headers.get("X-Request-Id"), "req-401");
  assert.equal(state.counters.get("unauthorized"), 1);
});

test("an exhausted retry budget reports the provider's own status", async () => {
  const { response, json } = await postJson(
    "/v1/always-503",
    { messages: [{ role: "user", content: `hi [provider=${origin}][max_retries=3]` }] },
  );
  assert.equal(response.status, 503);
  assert.equal(json.error.type, "relay_error");
  assert.equal(json.error.code, "retry_exhausted");
  assert.equal(json.error.details.upstream_status, 503);
  assert.equal(json.error.details.attempts, 4);
  assert.equal(state.counters.get("always503"), 4);
});

test("REGRESSION: an unresolvable provider hostname fails fast instead of retrying forever", async () => {
  // .invalid is guaranteed not to resolve. Before the fix this looped until the
  // client gave up; now it must return a single clear error immediately.
  const started = Date.now();
  const { response, json } = await postJson(
    "/v1/chat/completions",
    { messages: [{ role: "user", content: "hi [provider=https://no-such-host.invalid]" }] },
    { env: { ...ENV, RELAY_ALLOW_PRIVATE_NETWORKS: "true" } },
  );
  const elapsed = Date.now() - started;
  assert.equal(response.status, 502);
  assert.equal(json.error.code, "upstream_error");
  assert.equal(json.error.details.reason, "dns_not_found");
  assert.match(json.error.message, /could not be resolved/);
  assert.ok(elapsed < 5000, `DNS failure took ${elapsed}ms — it must not be retried`);
  assert.equal(response.headers.get("X-Relay-Attempts"), "1");
});
test("a per-attempt timeout is treated as a transient failure and retried", async () => {
  const { response, json } = await postJson("/v1/timeout-once", {
    messages: [{ role: "user", content: `hi [provider=${origin}][timeout=120]` }],
  });
  assert.equal(response.status, 200);
  assert.equal(json.attempt, 2);
});

test("a client disconnect stops the retry loop", async () => {
  const env = { ...ENV, RELAY_MAX_ATTEMPTS: "500" };
  const controller = new AbortController();
  const promise = callWorker(
    `/v1/slow-503?provider=${encodeURIComponent(origin)}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ messages: [{ role: "user", content: "hi" }] }),
      signal: controller.signal,
    },
    env,
  );
  await new Promise((resolve) => setTimeout(resolve, 100));
  const attemptsAtAbort = state.counters.get("slow503");
  assert.ok(attemptsAtAbort >= 1, "the loop should be retrying when the client goes away");
  controller.abort();

  const response = await promise;
  assert.equal(response.status, 499);
  const json = await response.json();
  assert.equal(json.error.code, "client_disconnected");

  await new Promise((resolve) => setTimeout(resolve, 150));
  assert.ok(
    state.counters.get("slow503") <= attemptsAtAbort + 1,
    "no new attempts may start after the abort",
  );
});

/* -------------------------------------------------------------------------- *
 * Relay errors and local endpoints
 * -------------------------------------------------------------------------- */

test("a missing provider is a structured 400", async () => {
  const { response, json } = await postJson(
    "/v1/chat/completions",
    { messages: [{ role: "user", content: "hello" }] },
    { env: { ...ENV, RELAY_ACCEPT_QUERY_DIRECTIVES: "false" } },
  );
  assert.equal(response.status, 400);
  assert.equal(json.error.type, "relay_error");
  assert.equal(json.error.code, "missing_provider");
  assert.equal(state.requests.length, 0);
});

test("spec tests 13-15 through the handler: blocked and invalid providers", async () => {
  // With the production default (https only), an http:// upstream never gets that far.
  const httpsOnly = [
    ["http://127.0.0.1:8000", "invalid_provider", 400],
    ["https://192.168.1.1", "blocked_provider", 403],
    ["https://169.254.169.254", "blocked_provider", 403],
    ["hello", "invalid_provider", 400],
    ["https://user:pass@api.example.com/v1", "invalid_provider", 400],
  ];
  for (const [provider, code, status] of httpsOnly) {
    const { response, json } = await postJson(
      "/v1/chat/completions",
      { messages: [{ role: "user", content: `hi [provider=${provider}]` }] },
      { env: { RELAY_MAX_ATTEMPTS: "2" } },
    );
    assert.equal(response.status, status, provider);
    assert.equal(json.error.code, code, provider);
  }

  // Even with http:// enabled, loopback and RFC1918 hosts stay blocked.
  for (const provider of ["http://127.0.0.1:8000", "http://192.168.1.1", "http://127.1"]) {
    const { response, json } = await postJson(
      "/v1/chat/completions",
      { messages: [{ role: "user", content: `hi [provider=${provider}]` }] },
      { env: { RELAY_ALLOW_HTTP: "true", RELAY_MAX_ATTEMPTS: "2" } },
    );
    assert.equal(response.status, 403, provider);
    assert.equal(json.error.code, "blocked_provider", provider);
  }

  // IPv6 literals and numeric notations can only arrive through a query param or header
  // (a directive value stops at the first "]"), and they are blocked there too.
  for (const provider of [
    "http://[::1]:9000",
    "http://[::ffff:127.0.0.1]:9000",
    "http://2130706433",
    "http://0x7f000001",
    "http://metadata.google.internal",
  ]) {
    const response = await callWorker(
      `/v1/chat/completions?provider=${encodeURIComponent(provider)}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ messages: [{ role: "user", content: "hi" }] }),
      },
      { RELAY_ALLOW_HTTP: "true", RELAY_MAX_ATTEMPTS: "2" },
    );
    const json = await response.json();
    assert.equal(response.status, 403, provider);
    assert.equal(json.error.code, "blocked_provider", provider);
  }

  // A directive value cannot contain "]", so an IPv6 provider directive is malformed.
  const ipv6Directive = await postJson(
    "/v1/chat/completions",
    { messages: [{ role: "user", content: "hi [provider=http://[::1]:9000]" }] },
    { env: { RELAY_ALLOW_HTTP: "true", RELAY_MAX_ATTEMPTS: "2" } },
  );
  assert.equal(ipv6Directive.json.error.code, "invalid_provider");

  assert.equal(state.requests.length, 0, "nothing may be sent for a rejected provider");
});
test("malformed JSON with a JSON content type is reported as invalid_json", async () => {
  const { response, json } = await postJson("/v1/chat/completions", "{not json");
  assert.equal(response.status, 400);
  assert.equal(json.error.code, "invalid_json");
});

test("CORS preflight is answered locally", async () => {
  const response = await callWorker("/v1/chat/completions", {
    method: "OPTIONS",
    headers: { Origin: "https://app.example.com", "Access-Control-Request-Headers": "content-type, x-relay-key" },
  });
  assert.equal(response.status, 204);
  assert.equal(response.headers.get("Access-Control-Allow-Origin"), "*");
  assert.equal(response.headers.get("Access-Control-Allow-Headers"), "content-type, x-relay-key");
  assert.match(response.headers.get("Access-Control-Allow-Methods"), /POST/);
  assert.equal(state.requests.length, 0);
});

test("responses carry CORS and expose the relay's diagnostic headers", async () => {
  const { response } = await postJson("/v1/chat/completions", {
    messages: [{ role: "user", content: `hi [provider=${origin}/v1]` }],
  });
  assert.equal(response.headers.get("Access-Control-Allow-Origin"), "*");
  assert.match(response.headers.get("Access-Control-Expose-Headers"), /X-Relay-Attempts/);
  assert.equal(response.headers.get("ETag"), 'W/"abc123"');
  assert.equal(response.headers.get("RateLimit-Remaining"), "42");
});

test("GET / returns usage help, and /__relay/health reports ok", async () => {
  const help = await callWorker("/", { method: "GET" });
  assert.equal(help.status, 200);
  const helpJson = await help.json();
  assert.equal(helpJson.relay, "cloudflare-ai-relay");
  assert.ok(helpJson.directives["[provider=https://api.example.com/v1]"]);

  const health = await callWorker("/__relay/health", { method: "GET" });
  assert.equal(health.status, 200);
  assert.deepEqual((await health.json()).ok, true);
  assert.equal(state.requests.length, 0);
});

/* -------------------------------------------------------------------------- *
 * Header policy, methods and query strings
 * -------------------------------------------------------------------------- */

test("useful headers are forwarded and transport/Cloudflare headers are not", async () => {
  const { json } = await postJson(
    "/v1/chat/completions",
    { messages: [{ role: "user", content: `hi [provider=${origin}/v1]` }] },
    {
      headers: {
        "OpenAI-Beta": "assistants=v2",
        "OpenAI-Organization": "org-123",
        "Idempotency-Key": "idem-1",
        "User-Agent": "relay-test/1.0",
        Accept: "application/json",
        Cookie: "session=secret",
        "CF-Connecting-IP": "9.9.9.9",
        "X-Forwarded-For": "9.9.9.9",
        "X-Real-IP": "9.9.9.9",
        "CF-Ray": "abc",
      },
    },
  );
  const names = json.headerNames;
  for (const expected of ["openai-beta", "openai-organization", "idempotency-key", "user-agent", "accept"]) {
    assert.ok(names.includes(expected), `${expected} should be forwarded`);
  }
  for (const forbidden of ["cookie", "cf-connecting-ip", "cf-ray", "x-forwarded-for", "x-real-ip"]) {
    assert.equal(names.includes(forbidden), false, `${forbidden} must not be forwarded`);
  }
});

test("X-Relay-* directive headers work and are not forwarded upstream", async () => {
  const { json } = await postJson(
    "/v1/chat/completions",
    { messages: [{ role: "user", content: "plain body" }] },
    {
      headers: {
        "X-Relay-Provider": `${origin}/v1`,
        "X-Relay-Model": "header-model",
        "X-Relay-Key": "HEADER-KEY",
        "X-Relay-Header": "X-Custom: from-header",
      },
    },
  );
  assert.equal(json.received.model, "header-model");
  assert.equal(json.authorization, "Bearer HEADER-KEY");
  assert.equal(json.headerNames.includes("x-relay-provider"), false);
  assert.equal(json.headerNames.includes("x-custom"), true);
});

test("body directives win over query and header directives", async () => {
  const { json } = await postJson(
    `/v1/chat/completions?model=query-model`,
    { messages: [{ role: "user", content: `hi [provider=${origin}/v1][model=body-model]` }] },
    { headers: { "X-Relay-Model": "header-model" } },
  );
  assert.equal(json.received.model, "body-model");
});

test("query strings are preserved and GET requests pass through", async () => {
  const response = await callWorker(
    `/v1/models?limit=100&provider=${encodeURIComponent(`${origin}/v1`)}`,
    { method: "GET" },
  );
  const json = await response.json();
  assert.equal(json.method, "GET");
  assert.equal(json.path, "/v1/models");
  assert.equal(json.search, "?limit=100");
});

test("PUT, PATCH and DELETE are relayed unchanged", async () => {
  for (const method of ["PUT", "PATCH", "DELETE"]) {
    const response = await callWorker(`/v1/things/42?provider=${encodeURIComponent(origin)}`, {
      method,
      headers: { "Content-Type": "application/json" },
      body: method === "DELETE" ? undefined : JSON.stringify({ note: "keep me" }),
    });
    const json = await response.json();
    assert.equal(json.method, method);
    assert.equal(json.path, "/v1/things/42");
  }
});
test("HEAD requests return headers without a body", async () => {
  const response = await callWorker(`/v1/models?provider=${encodeURIComponent(origin)}`, { method: "HEAD" });
  assert.equal(response.status, 200);
  assert.equal(await response.text(), "");
});

/* -------------------------------------------------------------------------- *
 * Other endpoint shapes
 * -------------------------------------------------------------------------- */

test("image generation: the prompt is cleaned and the model forced", async () => {
  const { json } = await postJson("/v1/images/generations", {
    model: "old-image-model",
    prompt: `draw a cat [provider=${origin}/v1][model=image-model]`,
    size: "1024x1024",
    response_format: { type: "b64_json" },
  });
  assert.equal(json.path, "/v1/images/generations");
  assert.equal(json.received.prompt, "draw a cat");
  assert.equal(json.received.model, "image-model");
  assert.equal(json.received.size, "1024x1024");
});

test("embeddings and rerank bodies keep their shape", async () => {
  const embeddings = await postJson("/v1/embeddings", {
    input: [`first [provider=${origin}/v1][model=embed-1]`, "second"],
  });
  assert.equal(embeddings.json.received.model, "embed-1");
  assert.deepEqual(embeddings.json.received.input, ["first", "second"]);

  const rerank = await postJson("/v1/rerank", {
    query: `best cat [provider=${origin}/v1]`,
    documents: ["a", "b"],
    top_n: 2,
  });
  assert.equal(rerank.json.received.query, "best cat");
  assert.deepEqual(rerank.json.received.documents, ["a", "b"]);
});

test("the Responses API shape is relayed as-is", async () => {
  const { json } = await postJson("/v1/responses", {
    input: [
      {
        role: "user",
        content: [
          { type: "input_text", text: `hello [provider=${origin}/v1][compatibility=responses][model=r-1]` },
          { type: "input_image", image_url: "https://cdn.example.com/x.png" },
        ],
      },
    ],
    reasoning: { effort: "high" },
  });
  assert.equal(json.path, "/v1/responses");
  assert.equal(json.received.model, "r-1");
  assert.equal(json.received.input[0].content[0].text, "hello");
  assert.deepEqual(json.received.reasoning, { effort: "high" });
});
test("extra directives reach the wire: stream, temperature and custom headers", async () => {
  const { json } = await postJson("/v1/chat/completions", {
    messages: [
      {
        role: "user",
        content: `hi [provider=${origin}/v1][stream=true][temperature=0.25][header=X-Trace-Id: t-1]`,
      },
    ],
  });
  assert.equal(json.received.stream, true);
  assert.equal(json.received.temperature, 0.25);
  assert.equal(json.headerNames.includes("x-trace-id"), true);
});

test("text/plain and urlencoded bodies also carry directives", async () => {
  const plain = await callWorker("/v1/anything", {
    method: "POST",
    headers: { "Content-Type": "text/plain; charset=utf-8" },
    body: `سلام [provider=${origin}][model=plain-1]`,
  });
  const plainJson = await plain.json();
  assert.equal(Buffer.from(plainJson.bodyBase64, "base64").toString("utf8"), "سلام");

  const form = await callWorker("/v1/anything", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      model: "old",
      prompt: `hello [provider=${origin}][model=form-1]`,
    }).toString(),
  });
  const formJson = await form.json();
  const params = new URLSearchParams(Buffer.from(formJson.bodyBase64, "base64").toString("utf8"));
  assert.equal(params.get("prompt"), "hello");
  assert.equal(params.get("model"), "form-1");
});

test("a default provider from the environment is used when no directive is present", async () => {
  const { json } = await postJson(
    "/v1/chat/completions",
    { messages: [{ role: "user", content: "no directives at all" }] },
    { env: { ...ENV, RELAY_DEFAULT_PROVIDER: `${origin}/v1` } },
  );
  assert.equal(json.path, "/v1/chat/completions");
  assert.equal(json.received.messages[0].content, "no directives at all");
});

test("a 307 redirect is followed with the method and body intact", async () => {
  const { response, json } = await postJson("/v1/redirect-relative", {
    messages: [{ role: "user", content: `hi [provider=${origin}]` }],
  });
  assert.equal(response.status, 200);
  assert.equal(json.arrivedAt, "/v1/redirect-target");
  assert.equal(json.method, "POST");
  assert.equal(JSON.parse(json.body).messages[0].content, "hi");
  assert.equal(state.counters.get("redirectTarget"), 1);
});

test("a 303 redirect becomes a bodyless GET, like standard fetch", async () => {
  const { response, json } = await postJson("/v1/redirect-see-other", {
    messages: [{ role: "user", content: `hi [provider=${origin}]` }],
  });
  assert.equal(response.status, 200);
  assert.equal(json.method, "GET");
  assert.equal(json.body, "");
});

test("a redirect towards a private address is refused instead of followed", async () => {
  // The allowlist keeps the mock origin reachable while any other host — including the
  // metadata address — is refused by the allowlist mismatch on the redirect hop.
  const { response, json } = await postJson(
    "/v1/redirect-private",
    { messages: [{ role: "user", content: `hi [provider=${origin}]` }] },
    { env: { ...ENV, RELAY_PROVIDER_ALLOWLIST: "127.0.0.1" } },
  );
  assert.equal(response.status, 403);
  assert.equal(json.error.code, "blocked_provider");
});

test("the allowlist does not exempt private hosts from the network policy", async () => {
  // 127.0.0.1 is on the allowlist, but private-network blocking is on, so the request
  // is refused before any connection: the SSRF policy applies inside the allowlist too.
  const { response, json } = await postJson(
    "/v1/chat/completions",
    { messages: [{ role: "user", content: `hi [provider=${origin}]` }] },
    { env: { ...ENV, RELAY_ALLOW_PRIVATE_NETWORKS: "false", RELAY_PROVIDER_ALLOWLIST: "127.0.0.1" } },
  );
  assert.equal(response.status, 403);
  assert.equal(json.error.code, "blocked_provider");
  assert.match(json.error.message, /loopback|private/i);
});

test("a redirect to an unsupported protocol is refused", async () => {
  const { response, json } = await postJson("/v1/redirect-bad-scheme", {
    messages: [{ role: "user", content: `hi [provider=${origin}]` }],
  });
  assert.equal(response.status, 403);
  assert.equal(json.error.code, "blocked_provider");
});

test("redirects are handed back to the caller when following is disabled", async () => {
  const { response } = await postJson(
    "/v1/redirect-relative",
    { messages: [{ role: "user", content: `hi [provider=${origin}]` }] },
    { env: { ...ENV, RELAY_MAX_REDIRECTS: "0" } },
  );
  assert.equal(response.status, 307);
  // The Location is absolute so the client bounces to the provider, never to the relay.
  assert.equal(response.headers.get("Location"), `${origin}/v1/redirect-target`);
  assert.equal(state.counters.get("redirectTarget"), undefined);
});

test("an unknown provider path is still proxyable", async () => {
  const { json } = await postJson("/some/custom/endpoint", {
    prompt: `hi [provider=${origin}]`,
    provider_specific: { keep: [1, 2, 3] },
  });
  assert.equal(json.path, "/some/custom/endpoint");
  assert.deepEqual(json.received.provider_specific, { keep: [1, 2, 3] });
});

