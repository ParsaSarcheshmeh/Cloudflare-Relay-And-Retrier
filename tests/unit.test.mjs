import test from "node:test";
import assert from "node:assert/strict";

import { __internals } from "../worker.js";

const {
  applyAuthHeaders,
  buildTargetUrl,
  computeBackoffDelay,
  createDirectiveState,
  createTraversalContext,
  detectCompatibilityFromPath,
  extractDirectivesFromText,
  findBlockedHostReason,
  isRetryableStatus,
  joinProviderPath,
  normalizeCompatibility,
  parseDirectiveAt,
  parseIPv4,
  parseIPv6,
  parseRetryAfter,
  readBodyWithCap,
  redact,
  resolveConfig,
  traverseJson,
  validateProviderUrl,
} = __internals;

const cfg = resolveConfig({});
const cfgHttp = resolveConfig({ RELAY_ALLOW_HTTP: "true" });
const cfgPrivate = resolveConfig({ RELAY_ALLOW_HTTP: "true", RELAY_ALLOW_PRIVATE_NETWORKS: "true" });

/** Convenience: parse one string and return { state, text }. */
function parse(text) {
  const state = createDirectiveState();
  const result = extractDirectivesFromText(text, state);
  return { state, text: result.text, changed: result.changed };
}

/* -------------------------------------------------------------------------- *
 * Directive parsing
 * -------------------------------------------------------------------------- */

test("spec test 1: first directive wins and the text is cleaned", () => {
  const { state, text } = parse("hello [model=N] idk [model=G]");
  assert.equal(state.values.model, "N");
  assert.equal(text, "hello  idk");
});

test("spec test 2: Persian text and emoji survive untouched", () => {
  const { state, text } = parse("سلام دنیا 😄 [model=gpt-test]");
  assert.equal(state.values.model, "gpt-test");
  assert.equal(text, "سلام دنیا 😄");
});
test("combining marks, CJK, Arabic and RTL text are preserved byte-for-byte", () => {
  const samples = [
    ["این متن فارسی است 😄🔥 [provider=https://api.example.com/v1]", "این متن فارسی است 😄🔥"],
    ["こんにちは 👋 [model=test-model]", "こんにちは 👋"],
    ["مرحبا بالعالم [compatibility=anthropic]", "مرحبا بالعالم"],
    ["नमस्ते ज़्यादा é\u0301 [model=x]", "नमस्ते ज़्यादा é\u0301"],
  ];
  for (const [input, expected] of samples) {
    assert.equal(parse(input).text, expected);
  }
  assert.equal(parse(samples[0][0]).state.values.provider, "https://api.example.com/v1");
  assert.equal(parse(samples[2][0]).state.values.compatibility, "anthropic");
});

test("a directive-only block disappears together with its blank lines", () => {
  const input = [
    "Hello, explain quantum computing.",
    "",
    "[model=gpt-5]",
    "[provider=https://api.example.com/v1]",
    "[key=123]",
  ].join("\n");
  const { state, text } = parse(input);
  assert.equal(text, "Hello, explain quantum computing.");
  assert.deepEqual(
    { model: state.values.model, provider: state.values.provider, apiKey: state.values.apiKey },
    { model: "gpt-5", provider: "https://api.example.com/v1", apiKey: "123" },
  );
});

test("inline directives keep the surrounding line", () => {
  const { text } = parse("line one\nkeep [model=x] this\nline three");
  assert.equal(text, "line one\nkeep  this\nline three");
});

test("directive names are case-insensitive and values keep their case", () => {
  assert.equal(parse("[MODEL=GPT-5]").state.values.model, "GPT-5");
  assert.equal(parse("[Model=Gpt-5]").state.values.model, "Gpt-5");
  assert.equal(parse("[model = spaced-value ]").state.values.model, "spaced-value");
});

test("aliases resolve to the canonical directive and first-wins spans aliases", () => {
  const { state } = parse("[apikey=first] [key=second] [base_url=https://a.example/v1] [provider=https://b.example]");
  assert.equal(state.values.apiKey, "first");
  assert.equal(state.values.provider, "https://a.example/v1");
});

test("the compatiblity typo and other compatibility aliases normalize", () => {
  assert.equal(parse("[compatiblity=responses]").state.values.compatibility, "responses");
  assert.equal(normalizeCompatibility("chat-completions"), "openai");
  assert.equal(normalizeCompatibility("CLAUDE"), "anthropic");
  assert.equal(normalizeCompatibility("whisper"), "stt");
  assert.equal(normalizeCompatibility("not-a-mode"), undefined);
});
test("unknown bracket text, Markdown links and JSON in prose stay untouched", () => {
  const input =
    'See [docs](https://example.com) and [key=abc](https://example.com/x) plus [foo=bar] and {"model":"keep"}';
  const { state, text, changed } = parse(input);
  assert.equal(changed, false);
  assert.equal(text, input);
  assert.equal(state.values.apiKey, undefined);
});

test("empty and invalid directive values are ignored with a warning", () => {
  const { state, text } = parse("a [model=] b [timeout=abc] c");
  assert.equal(state.values.model, undefined);
  assert.equal(state.values.timeoutMs, undefined);
  assert.equal(state.warnings.length, 2);
  assert.equal(text, "a  b  c");
});

test("extra directives parse into typed values", () => {
  const { state } = parse("[stream=true] [timeout=1500] [max_retries=7] [temperature=0.25]");
  assert.equal(state.values.stream, true);
  assert.equal(state.values.timeoutMs, 1500);
  assert.equal(state.values.maxRetries, 7);
  assert.equal(state.values.temperature, 0.25);
});

test("[header=...] is repeatable, first-wins per header name, and cannot smuggle transport headers", () => {
  const { state } = parse(
    "[header=X-Custom: abc] [header=X-Custom: zzz] [header=X-Other:1] [header=Host: evil.example] [header=CF-Connecting-IP: 1.2.3.4]",
  );
  assert.deepEqual(state.extraHeaders, [
    { name: "X-Custom", value: "abc" },
    { name: "X-Other", value: "1" },
  ]);
});

test("a directive with a line break inside is not a directive", () => {
  const input = "[model=gpt\n5]";
  const { state, changed } = parse(input);
  assert.equal(changed, false);
  assert.equal(state.values.model, undefined);
});

test("long prompts with many brackets stay linear and correct", () => {
  const filler = "لورم ایپسوم [not=a directive] ".repeat(20000);
  const started = Date.now();
  const { state, text } = parse(`${filler}[model=fast]`);
  assert.equal(state.values.model, "fast");
  assert.equal(text.includes("[not=a directive]"), true);
  assert.ok(Date.now() - started < 2000, "directive scan should stay fast");
});
/* -------------------------------------------------------------------------- *
 * JSON traversal
 * -------------------------------------------------------------------------- */

/** Run the traversal the way the Worker does and return the rewritten body. */
function traverse(body) {
  const state = createDirectiveState();
  const ctx = createTraversalContext(state, cfg);
  const output = traverseJson(body, ctx);
  return { state, output, mutated: ctx.mutated };
}

test("first directive wins across several messages in document order", () => {
  const { state, output } = traverse({
    model: "original",
    messages: [
      { role: "system", content: "You are helpful." },
      { role: "user", content: "hello [model=A]" },
      { role: "user", content: "second [model=B]" },
    ],
  });
  assert.equal(state.values.model, "A");
  assert.equal(output.messages[1].content, "hello");
  assert.equal(output.messages[2].content, "second");
});

test("multimodal chat content: text is cleaned, image_url is untouched", () => {
  const body = {
    messages: [
      {
        role: "user",
        content: [
          { type: "text", text: "describe this [model=vision-1]" },
          { type: "image_url", image_url: { url: "https://cdn.example/a.png?x=[model=nope]", detail: "high" } },
          { type: "image_url", image_url: { url: "data:image/png;base64,iVBORw0KGgo=" } },
        ],
      },
    ],
  };
  const { state, output } = traverse(structuredClone(body));
  assert.equal(state.values.model, "vision-1");
  assert.equal(output.messages[0].content[0].text, "describe this");
  assert.deepEqual(output.messages[0].content[1], body.messages[0].content[1]);
  assert.deepEqual(output.messages[0].content[2], body.messages[0].content[2]);
});

test("Responses-style input (string and structured) is handled", () => {
  const stringForm = traverse({ input: "hello [model=x]" });
  assert.equal(stringForm.state.values.model, "x");
  assert.equal(stringForm.output.input, "hello");
  const structured = traverse({
    input: [
      {
        role: "user",
        content: [
          { type: "input_text", text: "describe this [model=y] [key=SECRET]" },
          { type: "input_image", image_url: "https://cdn.example/b.png" },
        ],
      },
    ],
  });
  assert.equal(structured.state.values.model, "y");
  assert.equal(structured.state.values.apiKey, "SECRET");
  assert.equal(structured.output.input[0].content[0].text, "describe this");
  assert.equal(structured.output.input[0].content[1].image_url, "https://cdn.example/b.png");
});

test("Anthropic bodies: system, string content and content blocks", () => {
  const { state, output } = traverse({
    system: "be terse [compatibility=anthropic]",
    messages: [
      { role: "user", content: "hello [model=claude-model]" },
      {
        role: "user",
        content: [
          { type: "text", text: "and this [provider=https://api.anthropic-compatible.com]" },
          { type: "image", source: { type: "base64", media_type: "image/png", data: "AAAA[model=no]" } },
        ],
      },
    ],
  });
  assert.equal(state.values.compatibility, "anthropic");
  assert.equal(state.values.model, "claude-model");
  assert.equal(state.values.provider, "https://api.anthropic-compatible.com");
  assert.equal(output.system, "be terse");
  assert.equal(output.messages[0].content, "hello");
  assert.equal(output.messages[1].content[0].text, "and this");
  assert.equal(output.messages[1].content[1].source.data, "AAAA[model=no]");
});

test("spec test 7: unknown provider-specific video fields survive exactly", () => {
  const body = {
    model: "video-1",
    prompt: "cinematic city [model=video-2]",
    video: { url: "https://cdn.example/in.mp4", trim: { start: 1.5, end: 9 } },
    video_urls: ["https://a/1.mp4", "https://b/2.mp4"],
    attachments: [{ file: "abc", mime: "video/mp4", data: "ZmFrZQ==" }],
    media: { frames: [1, 2, 3], weird_provider_flag: true },
    files: ["f-1", "f-2"],
    custom_provider_block: { nested: { deep: [{ keep: "as-is [model=nope]" }] } },
  };
  const original = structuredClone(body);
  const { state, output } = traverse(body);
  assert.equal(state.values.model, "video-2");
  assert.equal(output.prompt, "cinematic city");
  for (const key of ["video", "video_urls", "attachments", "media", "files", "custom_provider_block"]) {
    assert.deepEqual(output[key], original[key], `${key} must be preserved`);
  }
});

test("credential-ish and schema fields are never scanned or rewritten", () => {
  const body = {
    api_key: "sk-[model=leak]",
    authorization: "Bearer [model=leak]",
    tools: [{ type: "function", function: { name: "f", description: "desc [model=leak]" } }],
    response_format: { type: "json_schema", json_schema: { description: "[model=leak]" } },
    metadata: { note: "kept [model=leak]" },
  };
  const original = structuredClone(body);
  const { state, output } = traverse(body);
  assert.equal(state.values.model, undefined);
  assert.deepEqual(output, original);
});

test("embeddings input arrays are processed element by element", () => {
  const { state, output } = traverse({ input: ["first [model=emb-1]", "second [model=emb-2]"] });
  assert.equal(state.values.model, "emb-1");
  assert.deepEqual(output.input, ["first", "second"]);
});

test("a content part that was only a directive is dropped, but never the last one", () => {
  const many = traverse({
    messages: [
      {
        role: "user",
        content: [
          { type: "text", text: "[provider=https://api.example.com]" },
          { type: "text", text: "real question" },
        ],
      },
    ],
  });
  assert.deepEqual(many.output.messages[0].content, [{ type: "text", text: "real question" }]);

  const only = traverse({
    messages: [{ role: "user", content: [{ type: "text", text: "[model=solo]" }] }],
  });
  assert.equal(JSON.stringify(only.output.messages[0].content), JSON.stringify([{ type: "text", text: "" }]));
  assert.equal(only.state.values.model, "solo");
});
/* -------------------------------------------------------------------------- *
 * Path joining and target URL
 * -------------------------------------------------------------------------- */

test("provider path joining never duplicates or drops segments", () => {
  const cases = [
    ["", "/v1/chat/completions", "/v1/chat/completions"],
    ["/", "/v1/chat/completions", "/v1/chat/completions"],
    ["/v1", "/v1/chat/completions", "/v1/chat/completions"],
    ["/v1/", "/v1/chat/completions", "/v1/chat/completions"],
    ["/api/v1", "/v1/messages", "/api/v1/messages"],
    ["/v1beta/openai", "/v1/chat/completions", "/v1beta/openai/chat/completions"],
    ["/openai/v1", "/v1/embeddings", "/openai/v1/embeddings"],
    ["/v1", "/v1", "/v1"],
    ["/v1", "/", "/v1"],
    ["", "/models", "/models"],
    ["/proxy", "/v1/audio/speech", "/proxy/v1/audio/speech"],
  ];
  for (const [base, incoming, expected] of cases) {
    assert.equal(joinProviderPath(base, incoming, "smart"), expected, `${base} + ${incoming}`);
  }
  assert.equal(joinProviderPath("/openai/deployments/gpt", "/v1/chat/completions", "drop"), "/openai/deployments/gpt/chat/completions");
  assert.equal(joinProviderPath("/proxy", "/v1/chat/completions", "keep"), "/proxy/v1/chat/completions");
  assert.equal(joinProviderPath("/v1", "/v1/files/", "smart"), "/v1/files/");
});

test("target URL keeps the incoming query string and drops consumed relay params", () => {
  const target = buildTargetUrl({
    providerUrl: new URL("https://api.example.com/v1?api-version=2024-05-01"),
    incomingUrl: new URL("https://worker.dev/v1/models?limit=100&provider=x&order=desc"),
    cfg,
    compatibility: "generic",
    consumedQueryParams: ["provider"],
  });
  assert.equal(target.origin + target.pathname, "https://api.example.com/v1/models");
  assert.equal(target.searchParams.get("limit"), "100");
  assert.equal(target.searchParams.get("order"), "desc");
  assert.equal(target.searchParams.get("api-version"), "2024-05-01");
  assert.equal(target.searchParams.has("provider"), false);
});

test("a bare / uses the compatibility's canonical endpoint", () => {
  const anthropic = buildTargetUrl({
    providerUrl: new URL("https://api.anthropic-compatible.com"),
    incomingUrl: new URL("https://worker.dev/"),
    cfg,
    compatibility: "anthropic",
    consumedQueryParams: [],
  });
  assert.equal(anthropic.toString(), "https://api.anthropic-compatible.com/v1/messages");
});
/* -------------------------------------------------------------------------- *
 * SSRF protection
 * -------------------------------------------------------------------------- */

test("numeric IPv4 notations all normalize to the same address", () => {
  assert.equal(parseIPv4("127.0.0.1"), 0x7f000001);
  assert.equal(parseIPv4("127.1"), 0x7f000001);
  assert.equal(parseIPv4("2130706433"), 0x7f000001);
  assert.equal(parseIPv4("0x7f000001"), 0x7f000001);
  assert.equal(parseIPv4("0177.0.0.1"), 0x7f000001);
  assert.equal(parseIPv4("example.com"), null);
  assert.equal(parseIPv4("999.1.1.1"), null);
});

test("IPv6 literals expand correctly", () => {
  assert.deepEqual(parseIPv6("::1"), [0, 0, 0, 0, 0, 0, 0, 1]);
  assert.deepEqual(parseIPv6("[::ffff:127.0.0.1]"), [0, 0, 0, 0, 0, 0xffff, 0x7f00, 1]);
  assert.equal(parseIPv6("2001:db8::1")[0], 0x2001);
  assert.equal(parseIPv6("gggg::1"), null);
  assert.equal(parseIPv6("1::2::3"), null);
});

test("spec tests 13 + 14: loopback and RFC1918 providers are rejected", () => {
  const blocked = [
    "http://127.0.0.1:8000",
    "https://127.0.0.1",
    "https://192.168.1.1",
    "https://10.0.0.5/v1",
    "https://172.16.4.4/v1",
    "https://169.254.169.254/latest/meta-data",
    "https://[::1]/v1",
    "https://[::ffff:127.0.0.1]/v1",
    "https://0.0.0.0",
    "https://2130706433/v1",
    "https://0x7f000001/v1",
    "https://localhost:11434/v1",
    "https://metadata.google.internal/computeMetadata/v1",
    "https://my-service.internal/v1",
    "https://intranet/v1",
    "https://100.100.100.200/v1",
  ];
  for (const provider of blocked) {
    const result = validateProviderUrl(provider, cfgHttp);
    assert.ok(result.error, `${provider} should be rejected`);
    assert.ok(
      ["blocked_provider", "invalid_provider"].includes(result.error.code),
      `${provider} -> ${result.error.code}`,
    );
  }
});
test("spec test 15: a malformed provider is invalid_provider", () => {
  for (const bad of ["hello", "not a url", "ftp://example.com/v1", "file:///etc/passwd", "javascript:alert(1)"]) {
    const result = validateProviderUrl(bad, cfg);
    assert.equal(result.error.code, "invalid_provider", bad);
  }
});

test("http:// is rejected by default and allowed only when configured", () => {
  assert.equal(validateProviderUrl("http://api.example.com/v1", cfg).error.code, "invalid_provider");
  assert.equal(validateProviderUrl("http://api.example.com/v1", cfgHttp).url.protocol, "http:");
});

test("URLs with embedded credentials are rejected", () => {
  assert.equal(
    validateProviderUrl("https://user:pass@api.example.com/v1", cfg).error.code,
    "invalid_provider",
  );
});

test("public HTTPS providers pass, and a bare host gets https:// prepended", () => {
  assert.equal(validateProviderUrl("https://api.openai.com/v1", cfg).url.host, "api.openai.com");
  assert.equal(validateProviderUrl("api.example.com/v1", cfg).url.toString(), "https://api.example.com/v1");
  assert.equal(findBlockedHostReason("api.openai.com", cfg), null);
});

test("the allowlist is authoritative when it is not empty", () => {
  const allowlisted = resolveConfig({ RELAY_PROVIDER_ALLOWLIST: "api.openai.com,*.openai.azure.com" });
  assert.ok(validateProviderUrl("https://api.openai.com/v1", allowlisted).url);
  assert.ok(validateProviderUrl("https://west.openai.azure.com/openai", allowlisted).url);
  assert.equal(
    validateProviderUrl("https://api.anthropic.com/v1", allowlisted).error.code,
    "blocked_provider",
  );
});

test("private hosts become reachable only when the operator opts in", () => {
  assert.ok(validateProviderUrl("http://127.0.0.1:8000/v1", cfgPrivate).url);
  assert.equal(findBlockedHostReason("127.0.0.1", cfgPrivate), null);
});

/* -------------------------------------------------------------------------- *
 * Retry maths
 * -------------------------------------------------------------------------- */

test("retryable statuses match the policy", () => {
  for (const status of [408, 425, 429, 500, 502, 503, 504, 520, 522, 524, 529]) {
    assert.equal(isRetryableStatus(status, cfg), true, String(status));
  }
  for (const status of [200, 201, 400, 401, 403, 404, 405, 409, 413, 415, 422]) {
    assert.equal(isRetryableStatus(status, cfg), false, String(status));
  }
  assert.equal(isRetryableStatus(409, resolveConfig({ RELAY_RETRY_409: "true" })), true);
});
test("backoff grows exponentially, is capped, and jitter stays inside the cap", () => {
  const noJitter = resolveConfig({ RELAY_JITTER: "false" });
  assert.equal(computeBackoffDelay(1, noJitter), 250);
  assert.equal(computeBackoffDelay(2, noJitter), 500);
  assert.equal(computeBackoffDelay(3, noJitter), 1000);
  assert.equal(computeBackoffDelay(20, noJitter), noJitter.retries.maxDelayMs);
  for (let attempt = 1; attempt <= 12; attempt += 1) {
    const delay = computeBackoffDelay(attempt, cfg);
    assert.ok(delay >= 0 && delay <= cfg.retries.maxDelayMs);
  }
});

test("Retry-After understands seconds, HTTP-dates and the configured cap", () => {
  assert.equal(parseRetryAfter("10", cfg), 10000);
  assert.equal(parseRetryAfter("0", cfg), 0);
  assert.equal(parseRetryAfter("100000", cfg), cfg.retries.maxRetryAfterMs);
  const now = Date.UTC(2026, 0, 1, 0, 0, 0);
  assert.equal(parseRetryAfter("Thu, 01 Jan 2026 00:00:05 GMT", cfg, now), 5000);
  assert.equal(parseRetryAfter("Thu, 01 Jan 2020 00:00:00 GMT", cfg, now), 0);
  assert.equal(parseRetryAfter("not-a-date", cfg), null);
  assert.equal(parseRetryAfter(null, cfg), null);
  assert.equal(parseRetryAfter("10", resolveConfig({ RELAY_HONOR_RETRY_AFTER: "false" })), null);
});

/* -------------------------------------------------------------------------- *
 * Compatibility + auth headers
 * -------------------------------------------------------------------------- */

test("compatibility is detected from the request path", () => {
  const cases = [
    ["/v1/chat/completions", "openai"],
    ["/v1/responses", "responses"],
    ["/v1/messages", "anthropic"],
    ["/v1/images/generations", "images"],
    ["/v1/audio/speech", "tts"],
    ["/v1/audio/transcriptions", "stt"],
    ["/v1/embeddings", "embeddings"],
    ["/v1/rerank", "rerank"],
    ["/v1/models", null],
    ["/something/custom", null],
  ];
  for (const [path, expected] of cases) {
    assert.equal(detectCompatibilityFromPath(path), expected, path);
  }
});

/** Build headers the way the Worker does for auth assertions. */
function authHeaders({ apiKey, compatibility, incoming = {}, config = cfg }) {
  const headers = new Headers(incoming);
  applyAuthHeaders(headers, { apiKey, compatibility, cfg: config });
  return headers;
}
test("spec test 3: a key directive becomes a bearer token", () => {
  const headers = authHeaders({ apiKey: "ABC", compatibility: "openai" });
  assert.equal(headers.get("Authorization"), "Bearer ABC");
  assert.equal(headers.has("x-api-key"), false);
});

test("spec test 4: no key means no authentication at all", () => {
  const headers = authHeaders({ apiKey: undefined, compatibility: "openai" });
  assert.equal(headers.has("Authorization"), false);
  assert.equal(headers.get("Authorization"), null);
});

test("spec test 5: anthropic uses x-api-key plus a version header", () => {
  const headers = authHeaders({ apiKey: "ABC", compatibility: "anthropic" });
  assert.equal(headers.get("x-api-key"), "ABC");
  assert.equal(headers.has("Authorization"), false);
  assert.equal(headers.get("anthropic-version"), "2023-06-01");

  const clientVersion = authHeaders({
    apiKey: "ABC",
    compatibility: "anthropic",
    incoming: { "anthropic-version": "2024-10-22" },
  });
  assert.equal(clientVersion.get("anthropic-version"), "2024-10-22");
});

test("the key directive overrides whatever the caller sent", () => {
  const headers = authHeaders({
    apiKey: "FROM-DIRECTIVE",
    compatibility: "anthropic",
    incoming: { Authorization: "Bearer CLIENT-KEY", "x-api-key": "CLIENT-KEY" },
  });
  assert.equal(headers.get("x-api-key"), "FROM-DIRECTIVE");
  assert.equal(headers.has("Authorization"), false);
});

test("without a key directive the caller's own auth header is forwarded", () => {
  const headers = authHeaders({
    apiKey: undefined,
    compatibility: "openai",
    incoming: { Authorization: "Bearer CLIENT-KEY" },
  });
  assert.equal(headers.get("Authorization"), "Bearer CLIENT-KEY");

  const stripped = authHeaders({
    apiKey: undefined,
    compatibility: "openai",
    incoming: { Authorization: "Bearer CLIENT-KEY" },
    config: resolveConfig({ RELAY_FORWARD_INCOMING_AUTH: "false" }),
  });
  assert.equal(stripped.has("Authorization"), false);
});
test("gemini and azure compatibilities use their own key headers", () => {
  assert.equal(authHeaders({ apiKey: "G", compatibility: "gemini" }).get("x-goog-api-key"), "G");
  assert.equal(authHeaders({ apiKey: "A", compatibility: "azure" }).get("api-key"), "A");
});

/* -------------------------------------------------------------------------- *
 * Review regressions
 * -------------------------------------------------------------------------- */

test("REGRESSION: an adversarial directive-shaped body scans in bounded time", () => {
  const state = createDirectiveState();
  const evil = "[   key    =   ".repeat(100000); // 1.5MB, never closes
  const started = Date.now();
  const { changed } = extractDirectivesFromText(evil, state);
  const elapsed = Date.now() - started;
  assert.equal(changed, false);
  assert.ok(elapsed < 1000, `adversarial scan took ${elapsed}ms`);
});

test("REGRESSION: a __proto__ key round-trips without prototype pollution", () => {
  const body = JSON.parse(
    '{"messages":[{"content":"hi [model=A]"}],"__proto__":{"injected":"yes"},"constructor":{"x":1}}',
  );
  const { state, output } = traverse(body);
  assert.equal(state.values.model, "A");

  // The payload must not leak into the prototype chain.
  assert.equal({}.injected, undefined);
  assert.equal(Object.prototype.injected, undefined);
  assert.equal(Object.keys(output).includes("__proto__") || "__proto__" in output, true);
  // ...and the key must survive re-serialization instead of being dropped.
  const serialized = JSON.stringify(output);
  assert.ok(serialized.includes('"__proto__"'), `the __proto__ key was dropped: ${serialized}`);
  assert.ok(serialized.includes('"injected":"yes"'), serialized);
});

test("REGRESSION: directives inside nested arrays are scanned", () => {
  const { state, output } = traverse({ content: [["first [model=nested]"], "plain"] });
  assert.equal(state.values.model, "nested");
  assert.deepEqual(output.content[0], ["first"]);
  assert.equal(output.content[1], "plain");
});

test("REGRESSION: an untouched subtree keeps its original objects (copy-on-write)", () => {
  const body = {
    messages: [{ role: "user", content: "hi [model=x]" }],
    video: { url: "https://cdn.example/v.mp4" },
  };
  const { output } = traverse(body);
  assert.equal(output.messages[0].content, "hi");
  assert.equal(output.video, body.video, "protected subtree must be the same object");
});

test("REGRESSION: stripPathPrefix only strips on a path boundary", () => {
  const build = (path, prefix) =>
    buildTargetUrl({
      providerUrl: new URL("https://api.example.com"),
      incomingUrl: new URL(`https://worker.dev${path}`),
      cfg: resolveConfig({ RELAY_STRIP_PATH_PREFIX: prefix }),
      compatibility: "generic",
      consumedQueryParams: [],
    }).pathname;
  assert.equal(build("/relay/v1/x", "/relay"), "/v1/x");
  assert.equal(build("/relay", "/relay"), "/");
  assert.equal(build("/relayhouse/v1/x", "/relay"), "/relayhouse/v1/x");
  assert.equal(build("/other/x", "/relay"), "/other/x");
});

test("REGRESSION: numeric-looking non-integers are rejected in numeric directives", () => {
  assert.equal(parse("[timeout=1e3]").state.values.timeoutMs, undefined);
  assert.equal(parse("[timeout=0x10]").state.values.timeoutMs, undefined);
  assert.equal(parse("[timeout=-5]").state.values.timeoutMs, undefined);
  assert.equal(parse("[timeout=1500]").state.values.timeoutMs, 1500);
});

test("REGRESSION: the per-request retry override is capped", () => {
  assert.equal(parse("[max_retries=999999999]").state.values.maxRetries, undefined);
  assert.equal(parse("[max_retries=1000]").state.values.maxRetries, 1000);
  assert.equal(parse("[max_retries=1001]").state.values.maxRetries, undefined);
});

test("REGRESSION: a directive value longer than the cap is never extracted", () => {
  const { state, changed } = parse(`[model=${"x".repeat(5000)}]`);
  assert.equal(changed, false);
  assert.equal(state.values.model, undefined);
});

test("REGRESSION: redact never reveals key material", () => {
  for (const secret of ["sk-1234567890abcdef", "short", "x"]) {
    assert.equal(redact(secret), "***");
  }
});

test("REGRESSION: header directive rejects non-ByteString values", () => {
  const { state } = parse("[header=X-Bad: a\u2028b] [header=X-Good: ok]");
  assert.deepEqual(state.extraHeaders, [{ name: "X-Good", value: "ok" }]);
});

test("REGRESSION: readBodyWithCap enforces the cap during the read", async () => {
  const makeRequest = () => ({
    body: new ReadableStream({
      start(controller) {
        for (let index = 0; index < 10; index += 1) {
          controller.enqueue(new Uint8Array(1000).fill(7));
        }
        controller.close();
      },
    }),
  });

  const fits = await readBodyWithCap(makeRequest(), 20000);
  assert.equal(fits.bytes.byteLength, 10000);

  const over = await readBodyWithCap(makeRequest(), 4096);
  assert.ok(over.stream, "over-cap reads must return a stream");
  assert.ok(over.bufferedBytes > 4096);
  const replayed = await new Response(over.stream).arrayBuffer();
  assert.equal(replayed.byteLength, 10000, "the streamed remainder must be complete");
});

test("REGRESSION: credentialed CORS is disabled when the origin is *", () => {
  const bad = resolveConfig({ RELAY_CORS_CREDENTIALS: "true" });
  assert.equal(bad.cors.allowCredentials, false);
  const good = resolveConfig({ RELAY_CORS_CREDENTIALS: "true", RELAY_CORS_ORIGIN: "https://app.example.com" });
  assert.equal(good.cors.allowCredentials, true);
});

test("REGRESSION: double trailing dots do not bypass the host blocklist", () => {
  const result = validateProviderUrl("https://127.0.0.1../", cfgHttp);
  assert.ok(result.error, "127.0.0.1.. must be rejected");
  assert.equal(result.error.code, "blocked_provider");
  assert.ok(validateProviderUrl("https://localhost../", cfgHttp).error);
});


