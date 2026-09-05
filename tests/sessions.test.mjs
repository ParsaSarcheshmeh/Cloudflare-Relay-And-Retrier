import test from "node:test";
import assert from "node:assert/strict";

import { __internals } from "../worker.js";

const {
  createDirectiveState,
  decodeSessionToken,
  encodeSessionToken,
  parseNamedProviders,
  resolveConfig,
  stripSessionTokensFromText,
} = __internals;

const cfg = resolveConfig({});
const secretCfg = resolveConfig({ RELAY_SESSION_SECRET: "unit-test-secret-material" });

function stateWith(values) {
  const state = createDirectiveState();
  for (const [key, value] of Object.entries(values)) {
    state.values[key] = value;
  }
  state.found = true;
  return state;
}

test("session token round-trips unsigned", async () => {
  const state = stateWith({
    provider: "https://api.example.com/v1",
    model: "gpt-5",
    compatibility: "responses",
    apiKey: "sk-abc-123",
  });
  const token = await encodeSessionToken(state, cfg);
  assert.match(token, /^rls1_[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
  const decoded = await decodeSessionToken(token, cfg);
  assert.deepEqual(decoded, {
    provider: "https://api.example.com/v1",
    model: "gpt-5",
    compatibility: "responses",
    apiKey: "sk-abc-123",
  });
});

test("session token round-trips encrypted and leaks nothing", async () => {
  const state = stateWith({
    provider: "https://api.example.com/v1",
    model: "gpt-5",
    apiKey: "sk-abc-123",
  });
  const token = await encodeSessionToken(state, secretCfg);
  assert.equal(token.includes("sk-abc-123"), false, "the key must not be readable");
  assert.equal(token.includes("api.example"), false, "the provider must not be readable");
  // Every encryption of the same state differs (random IV)...
  const token2 = await encodeSessionToken(state, secretCfg);
  assert.notEqual(token, token2);
  // ...yet decodes to the same values.
  assert.deepEqual(await decodeSessionToken(token, secretCfg), await decodeSessionToken(token2, secretCfg));
});

test("tampered tokens are rejected", async () => {
  const state = stateWith({ provider: "https://a.example/v1", apiKey: "k" });
  for (const source of [cfg, secretCfg]) {
    const token = await encodeSessionToken(state, source);
    assert.equal(await decodeSessionToken(token.slice(0, -3) + "xyz", source), null, "tag flip");
    const payloadTampered = token.replace("rls1_", "rls1_x");
    assert.equal(await decodeSessionToken(payloadTampered, source), null, "payload flip");
  }
});

test("a token signed with a different secret is rejected", async () => {
  const token = await encodeSessionToken(stateWith({ provider: "https://a.example/v1" }), secretCfg);
  assert.equal(await decodeSessionToken(token, resolveConfig({ RELAY_SESSION_SECRET: "other-secret" })), null);
  assert.equal(await decodeSessionToken(token, cfg), null);
});

test("expired tokens are rejected", async () => {
  const expiredCfg = resolveConfig({ RELAY_SESSION_TTL_SECONDS: "60" });
  const token = await encodeSessionToken(stateWith({ provider: "https://a.example/v1" }), expiredCfg, Date.now() - 120000);
  assert.equal(await decodeSessionToken(token, cfg), null);
  // A fresh token is accepted.
  const fresh = await encodeSessionToken(stateWith({ provider: "https://a.example/v1" }), expiredCfg);
  assert.ok(await decodeSessionToken(fresh, cfg));
});

test("garbage and lookalike strings never decode", async () => {
  for (const bad of [
    null,
    "",
    "rls1_",
    "rls1_abc.def",
    "rls1_eyJhIjox.definitely-not-a-tag",
    "not-a-token",
    `rls1_${"A".repeat(25000)}.${"B".repeat(22)}`,
  ]) {
    assert.equal(await decodeSessionToken(bad, cfg), null, String(bad).slice(0, 40));
  }
});

test("tokens with partial values only restore what they carry", async () => {
  const token = await encodeSessionToken(stateWith({ model: "solo-model" }), cfg);
  assert.deepEqual(await decodeSessionToken(token, cfg), { model: "solo-model" });
});

test("REGRESSION: tokens pasted into prompt text are stripped and captured", async () => {
  const state = stateWith({
    provider: "https://api.example.com/v1",
    model: "parent-model",
    apiKey: "sk-parent-key",
  });
  const token = await encodeSessionToken(state, secretCfg);
  const prompt = `You are a subagent.\nRelay session: ${token}\nDo the task carefully. انتهى 😄`;
  const sessionState = createDirectiveState();
  const { text, changed, applied } = await stripSessionTokensFromText(prompt, sessionState, secretCfg);

  assert.equal(changed, true);
  assert.equal(applied, true);
  assert.equal(text.includes("rls1_"), false, "the token must be removed from the text");
  assert.equal(text.includes("Do the task carefully. انتهى 😄"), true, "surrounding text survives");
  assert.deepEqual(JSON.parse(JSON.stringify(sessionState.values)), {
    provider: "https://api.example.com/v1",
    model: "parent-model",
    apiKey: "sk-parent-key",
  });
});

test("invalid lookalikes are left untouched", async () => {
  const sessionState = createDirectiveState();
  const text = "the token rls1_not-real-at-all.definitely-not is just prose";
  const { text: out, changed } = await stripSessionTokensFromText(text, sessionState, cfg);
  assert.equal(changed, false);
  assert.equal(out, text);
  assert.equal(sessionState.found, false);
});

test("empty tokens carry nothing", async () => {
  const token = await encodeSessionToken(createDirectiveState(), cfg);
  // A state with no directives produces a token with only version+expiry.
  const decoded = await decodeSessionToken(token, cfg);
  assert.deepEqual(decoded, {});
});

test("named providers parse from the environment string", () => {
  const map = parseNamedProviders("OpenAI=https://api.openai.com/v1, anthropic=https://api.anthropic.com\nmock=http://127.0.0.1:9911");
  assert.equal(map.get("openai"), "https://api.openai.com/v1");
  assert.equal(map.get("anthropic"), "https://api.anthropic.com");
  assert.equal(map.get("mock"), "http://127.0.0.1:9911");
  assert.equal(parseNamedProviders("").size, 0);
  assert.equal(parseNamedProviders("no-equals-sign,=bad,ok=https://fine.example").get("ok"), "https://fine.example");
  assert.equal(parseNamedProviders("bad name! https://x.example").size, 0);
});
