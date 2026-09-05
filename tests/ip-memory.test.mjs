import test from "node:test";
import assert from "node:assert/strict";

import { __internals } from "../worker.js";

const {
  clearIpMemory,
  createDirectiveState,
  extractModelFlags,
  ipMemorySnapshot,
  parseNamedProviders,
  recallDirectivesForIp,
  rememberDirectivesForIp,
  resolveClientIp,
  resolveConfig,
} = __internals;

const cfg = resolveConfig({});
const namedCfg = resolveConfig({ RELAY_NAMED_PROVIDERS: "b-ai=https://api.b.ai/v1" });

function stateWith(values) {
  const state = createDirectiveState();
  for (const [key, value] of Object.entries(values)) state.values[key] = value;
  state.found = true;
  return state;
}

function requestWithIp(ip, extra = {}) {
  return new Request("https://relay.dev/v1/chat/completions", {
    method: "POST",
    headers: ip ? { "cf-connecting-ip": ip, ...extra } : extra,
    body: "{}",
  });
}

/* -------------------------------------------------------------------------- *
 * Model-name routing flags
 * -------------------------------------------------------------------------- */

test("model@url extracts model and provider", () => {
  assert.deepEqual(extractModelFlags("glm-5.3-flash@https://api.b.ai/v1", cfg), {
    model: "glm-5.3-flash",
    provider: "https://api.b.ai/v1",
    apiKey: undefined,
    compatibility: undefined,
    reasoning: undefined,
  });
});

test("model@bare-host prepends https://", () => {
  assert.deepEqual(extractModelFlags("gpt-5@api.b.ai/v1", cfg), {
    model: "gpt-5",
    provider: "https://api.b.ai/v1",
    apiKey: undefined,
    compatibility: undefined,
    reasoning: undefined,
  });
});

test("model@provider@key=... chains multiple flags; first of a kind wins", () => {
  assert.deepEqual(
    extractModelFlags("glm-5.3-flash@https://api.b.ai/v1@key=sk-first@k=sk-second", cfg),
    { model: "glm-5.3-flash", provider: "https://api.b.ai/v1", apiKey: "sk-first", compatibility: undefined, reasoning: undefined },
  );
  assert.deepEqual(
    extractModelFlags("m@api.b.ai@apikey=abc@c=anthropic", cfg),
    { model: "m", provider: "https://api.b.ai", apiKey: "abc", compatibility: "anthropic", reasoning: undefined },
  );
});

test("REGRESSION: reasoning is a valid model flag, including levels, budgets and aliases", () => {
  assert.deepEqual(
    extractModelFlags("glm-5.3-flash@https://api.b.ai/v1@key=sk-x@reasoning=max", cfg),
    { model: "glm-5.3-flash", provider: "https://api.b.ai/v1", apiKey: "sk-x", compatibility: undefined, reasoning: { level: "max" } },
  );
  assert.deepEqual(
    extractModelFlags("m@api.b.ai@reasoning=8192", cfg).reasoning,
    { budget: 8192 },
  );
  assert.deepEqual(
    extractModelFlags("m@api.b.ai@effort=low", cfg).reasoning,
    { level: "low" },
  );
  assert.deepEqual(
    extractModelFlags("m@api.b.ai@thinking=off", cfg).reasoning,
    { level: "none" },
  );
  // An invalid reasoning value voids the whole extraction, like compatibility.
  assert.equal(extractModelFlags("m@api.b.ai@reasoning=whenever", cfg), null);
});

test("named providers work as model flags", () => {
  assert.deepEqual(extractModelFlags("claude-x@b-ai", namedCfg), {
    model: "claude-x",
    provider: "https://api.b.ai/v1",
    apiKey: undefined,
    compatibility: undefined,
    reasoning: undefined,
  });
});

test("model names with @ but no recognizable flags stay untouched", () => {
  for (const name of ["llama@3", "foo@bar", "weird@@name", "a@b@c", "model@notathing"]) {
    assert.equal(extractModelFlags(name, cfg), null, name);
  }
  assert.equal(extractModelFlags("plain-model", cfg), null);
  assert.equal(extractModelFlags("@https://api.b.ai", cfg), null, "empty model part");
  assert.equal(extractModelFlags(undefined, cfg), null);
});

test("an invalid compatibility flag voids the whole extraction", () => {
  assert.equal(extractModelFlags("m@api.b.ai@c=nonsense", cfg), null);
});

/* -------------------------------------------------------------------------- *
 * Client IP resolution
 * -------------------------------------------------------------------------- */

test("only cf-connecting-ip is trusted by default", () => {
  assert.equal(resolveClientIp(requestWithIp("203.0.113.7"), cfg), "203.0.113.7");
  // Spoofed forwarded headers are ignored...
  const spoofer = requestWithIp(null, { "x-forwarded-for": "1.2.3.4", "x-real-ip": "1.2.3.4" });
  assert.equal(resolveClientIp(spoofer, cfg), null);
  assert.equal(resolveClientIp(new Request("https://r.dev/", { method: "POST" }), cfg), null);
});

test("forwarded headers can be trusted explicitly (local proxy setups)", () => {
  const trusting = resolveConfig({ RELAY_IP_TRUST_FORWARDED: "true" });
  const proxyRequest = new Request("https://relay.dev/v1/x", {
    method: "POST",
    headers: { "x-forwarded-for": "198.51.100.9, 10.0.0.1" },
  });
  assert.equal(resolveClientIp(proxyRequest, trusting), "198.51.100.9");
  const real = new Request("https://relay.dev/v1/x", {
    method: "POST",
    headers: { "x-real-ip": "198.51.100.9" },
  });
  assert.equal(resolveClientIp(real, trusting), "198.51.100.9");
});

/* -------------------------------------------------------------------------- *
 * IP memory
 * -------------------------------------------------------------------------- */

test("directives are remembered per IP and recalled as a fallback state", () => {
  clearIpMemory();
  const state = stateWith({
    provider: "https://api.b.ai/v1",
    model: "glm-5.3-flash",
    apiKey: "sk-abc",
    reasoning: { level: "high" },
  });
  rememberDirectivesForIp("203.0.113.7", state, cfg);

  const recalled = recallDirectivesForIp("203.0.113.7", cfg);
  assert.ok(recalled);
  assert.deepEqual(JSON.parse(JSON.stringify(recalled.values)), {
    provider: "https://api.b.ai/v1",
    model: "glm-5.3-flash",
    apiKey: "sk-abc",
    reasoning: { level: "high" },
  });
});

test("another IP gets nothing", () => {
  clearIpMemory();
  rememberDirectivesForIp("203.0.113.7", stateWith({ provider: "https://a.example/v1" }), cfg);
  assert.equal(recallDirectivesForIp("203.0.113.8", cfg), null);
  assert.equal(recallDirectivesForIp(null, cfg), null);
});

test("expired entries are dropped and the TTL slides on use", async () => {
  const shortCfg = resolveConfig({ RELAY_IP_MEMORY_TTL_SECONDS: "10" }); // floor is 10s
  const t0 = Date.now();

  // Without any intervening recall the entry dies at t0+10s.
  clearIpMemory();
  rememberDirectivesForIp("203.0.113.9", stateWith({ provider: "https://a.example/v1" }), shortCfg, t0);
  assert.equal(recallDirectivesForIp("203.0.113.9", shortCfg, t0 + 10001), null);
  assert.equal(ipMemorySnapshot()["203.0.113.9"], undefined, "expired entry is removed");

  // Every hit slides the expiry forward by the full TTL.
  clearIpMemory();
  rememberDirectivesForIp("203.0.113.9", stateWith({ provider: "https://a.example/v1" }), shortCfg, t0);
  assert.ok(recallDirectivesForIp("203.0.113.9", shortCfg, t0 + 9000), "expires t0+19s after this use");
  assert.ok(recallDirectivesForIp("203.0.113.9", shortCfg, t0 + 15000), "expires t0+25s after this use");
  assert.equal(recallDirectivesForIp("203.0.113.9", shortCfg, t0 + 26000), null, "finally expires");
});

test("the key is not remembered when includeKey is off", () => {
  clearIpMemory();
  const noKeyCfg = resolveConfig({ RELAY_IP_MEMORY_INCLUDE_KEY: "false" });
  rememberDirectivesForIp("203.0.113.10", stateWith({ provider: "https://a.example/v1", apiKey: "sk-secret" }), noKeyCfg);
  const recalled = recallDirectivesForIp("203.0.113.10", noKeyCfg);
  assert.equal(recalled.values.apiKey, undefined);
  assert.equal(recalled.values.provider, "https://a.example/v1");
});

test("the memory table is capped and evicts the oldest IP", () => {
  clearIpMemory();
  const tinyCfg = resolveConfig({ RELAY_IP_MEMORY_MAX_ENTRIES: "2" });
  rememberDirectivesForIp("1.1.1.1", stateWith({ provider: "https://one.example/v1" }), tinyCfg);
  rememberDirectivesForIp("2.2.2.2", stateWith({ provider: "https://two.example/v1" }), tinyCfg);
  rememberDirectivesForIp("3.3.3.3", stateWith({ provider: "https://three.example/v1" }), tinyCfg);

  const snapshot = ipMemorySnapshot();
  assert.deepEqual(Object.keys(snapshot).sort(), ["2.2.2.2", "3.3.3.3"], "oldest evicted");
});

test("requests without directives do not populate the memory", () => {
  clearIpMemory();
  const empty = createDirectiveState();
  rememberDirectivesForIp("203.0.113.11", empty, cfg);
  assert.deepEqual(ipMemorySnapshot(), {});
});

test("ipMemory is disabled by config", () => {
  clearIpMemory();
  const off = resolveConfig({ RELAY_IP_MEMORY: "false" });
  rememberDirectivesForIp("203.0.113.12", stateWith({ provider: "https://a.example/v1" }), off);
  assert.deepEqual(ipMemorySnapshot(), {});
  assert.equal(recallDirectivesForIp("203.0.113.12", off), null);
});
