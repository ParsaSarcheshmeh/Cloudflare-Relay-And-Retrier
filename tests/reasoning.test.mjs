import test from "node:test";
import assert from "node:assert/strict";

import { __internals } from "../worker.js";

const {
  REASONING_LEVELS,
  anthropicUsesAdaptive,
  applyDirectivesToJsonBody,
  createDirectiveState,
  createTraversalContext,
  extractDirectivesFromText,
  levelForBudget,
  parseReasoningValue,
  resolveConfig,
  resolveReasoningStyle,
} = __internals;

const cfg = resolveConfig({});

/** Apply a reasoning directive to a body the way the request pipeline does. */
function applyReasoning(body, value, { compatibility = "openai", host = "api.example.com", env = {} } = {}) {
  const config = Object.keys(env).length > 0 ? resolveConfig(env) : cfg;
  const state = createDirectiveState();
  state.values.reasoning = typeof value === "string" ? parseReasoningValue(value) : value;
  const ctx = createTraversalContext(state, config);
  applyDirectivesToJsonBody(body, state, ctx, { compatibility, host });
  return { body, state, mutated: ctx.mutated };
}

/* -------------------------------------------------------------------------- *
 * Directive parsing
 * -------------------------------------------------------------------------- */

test("every canonical level parses", () => {
  for (const level of REASONING_LEVELS) {
    assert.deepEqual(parseReasoningValue(level), { level }, level);
  }
  assert.deepEqual(REASONING_LEVELS, ["none", "minimal", "low", "medium", "high", "xhigh", "max"]);
});

test("aliases and casing map onto canonical levels", () => {
  const cases = [
    ["HIGH", "high"],
    ["High", "high"],
    ["off", "none"],
    ["false", "none"],
    ["disabled", "none"],
    ["min", "minimal"],
    ["med", "medium"],
    ["x-high", "xhigh"],
    ["xh", "xhigh"],
    ["extra-high", "xhigh"],
    ["ultra", "max"],
    ["maximum", "max"],
    ["true", "high"],
    ["on", "high"],
    ["think", "high"],
    ["  medium  ", "medium"],
    ["x_high", "xhigh"],
  ];
  for (const [input, expected] of cases) {
    assert.deepEqual(parseReasoningValue(input), { level: expected }, input);
  }
});

test("numeric values are explicit token budgets; 0 disables", () => {
  assert.deepEqual(parseReasoningValue("8192"), { budget: 8192 });
  assert.deepEqual(parseReasoningValue("1024"), { budget: 1024 });
  assert.deepEqual(parseReasoningValue("0"), { level: "none" });
  assert.equal(parseReasoningValue("999999999"), undefined);
  assert.equal(parseReasoningValue("-5"), undefined);
  assert.equal(parseReasoningValue("1e4"), undefined);
});

test("default/auto means provider default", () => {
  for (const input of ["default", "auto", "dynamic"]) {
    assert.deepEqual(parseReasoningValue(input), { auto: true }, input);
  }
});

test("unsupported values are rejected", () => {
  for (const input of ["", "sometimes", "very much", "high-ish", "3.5"]) {
    assert.equal(parseReasoningValue(input), undefined, input);
  }
});

test("the directive and all of its aliases are recognized in prompt text", () => {
  for (const name of ["reasoning", "reasoning_effort", "effort", "thinking"]) {
    const state = createDirectiveState();
    const { text } = extractDirectivesFromText(`please think [${name}=high] hard`, state);
    assert.deepEqual(state.values.reasoning, { level: "high" }, name);
    assert.equal(text, "please think  hard");
  }
});

test("an invalid reasoning value is ignored with a warning, not applied", () => {
  const state = createDirectiveState();
  extractDirectivesFromText("[reasoning=whenever]", state);
  assert.equal(state.values.reasoning, undefined);
  assert.equal(state.warnings.length, 1);
});

/* -------------------------------------------------------------------------- *
 * Style resolution
 * -------------------------------------------------------------------------- */

test("style is chosen from compatibility, then refined by host", () => {
  assert.equal(resolveReasoningStyle(cfg, "openai", "api.openai.com"), "effort");
  assert.equal(resolveReasoningStyle(cfg, "responses", "api.openai.com"), "responses");
  assert.equal(resolveReasoningStyle(cfg, "anthropic", "api.anthropic.com"), "anthropic");
  assert.equal(resolveReasoningStyle(cfg, "gemini", "generativelanguage.googleapis.com"), "gemini");
  assert.equal(resolveReasoningStyle(cfg, "azure", "x.openai.azure.com"), "effort");
  assert.equal(resolveReasoningStyle(cfg, "generic", "some.gateway.dev"), "effort");
  // OpenRouter does not accept the flat field, so the host wins over compatibility.
  assert.equal(resolveReasoningStyle(cfg, "openai", "openrouter.ai"), "openrouter");
  assert.equal(resolveReasoningStyle(cfg, "openai", "api.z.ai"), "glm");
  // Endpoints without any reasoning parameter.
  for (const compatibility of ["images", "videos", "tts", "stt", "embeddings", "rerank"]) {
    assert.equal(resolveReasoningStyle(cfg, compatibility, "api.example.com"), "off", compatibility);
  }
});

test("the style can be forced or disabled by configuration", () => {
  assert.equal(
    resolveReasoningStyle(resolveConfig({ RELAY_REASONING_STYLE: "responses" }), "openai", "api.openai.com"),
    "responses",
  );
  assert.equal(resolveReasoningStyle(resolveConfig({ RELAY_REASONING: "false" }), "openai", "api.openai.com"), "off");
});

/* -------------------------------------------------------------------------- *
 * Per-provider request shapes
 * -------------------------------------------------------------------------- */

test("OpenAI chat completions gets the flat reasoning_effort field", () => {
  const { body, mutated } = applyReasoning({ model: "gpt-5", messages: [] }, "high");
  assert.equal(body.reasoning_effort, "high");
  assert.equal(mutated, true);
  assert.equal(applyReasoning({}, "none").body.reasoning_effort, "none");
  assert.equal(applyReasoning({}, "xhigh").body.reasoning_effort, "xhigh");
});

test("a numeric budget becomes the nearest level for flat-field providers", () => {
  assert.equal(applyReasoning({}, "1024").body.reasoning_effort, "minimal");
  assert.equal(applyReasoning({}, "8192").body.reasoning_effort, "medium");
  assert.equal(applyReasoning({}, "24576").body.reasoning_effort, "high");
  assert.equal(levelForBudget(4096, cfg), "low");
});

test("the Responses API gets a nested reasoning.effort and keeps sibling fields", () => {
  const { body } = applyReasoning(
    { model: "o4-mini", reasoning: { summary: "detailed", mode: "pro" } },
    "max",
    { compatibility: "responses" },
  );
  assert.deepEqual(body.reasoning, { summary: "detailed", mode: "pro", effort: "max" });
});

test("OpenRouter gets its unified object, never the flat field", () => {
  const level = applyReasoning({ model: "anthropic/claude", reasoning: { exclude: true } }, "low", {
    compatibility: "openai",
    host: "openrouter.ai",
  });
  assert.deepEqual(level.body.reasoning, { exclude: true, effort: "low" });
  assert.equal(level.body.reasoning_effort, undefined);

  // effort and max_tokens are mutually exclusive: a budget replaces the effort.
  const budget = applyReasoning({ reasoning: { effort: "high" } }, "5000", {
    compatibility: "openai",
    host: "openrouter.ai",
  });
  assert.deepEqual(budget.body.reasoning, { max_tokens: 5000 });
});

test("GLM gets thinking.type plus reasoning_effort", () => {
  const on = applyReasoning({ model: "glm-4.6" }, "high", { compatibility: "openai", host: "api.z.ai" });
  assert.deepEqual(on.body.thinking, { type: "enabled" });
  assert.equal(on.body.reasoning_effort, "high");

  const off = applyReasoning({ model: "glm-4.6" }, "off", { compatibility: "openai", host: "api.z.ai" });
  assert.deepEqual(off.body.thinking, { type: "disabled" });
  assert.equal(off.body.reasoning_effort, undefined);
});

test("Gemini gets generationConfig.thinkingConfig and keeps its siblings", () => {
  const { body } = applyReasoning(
    { generationConfig: { temperature: 0.2, thinkingConfig: { includeThoughts: true } } },
    "high",
    { compatibility: "gemini" },
  );
  assert.equal(body.generationConfig.temperature, 0.2);
  assert.equal(body.generationConfig.thinkingConfig.includeThoughts, true);
  assert.equal(body.generationConfig.thinkingConfig.thinkingBudget, 24576);

  // Documented Gemini mapping: minimal/low -> 1024, medium -> 8192, high -> 24576.
  assert.equal(applyReasoning({}, "minimal", { compatibility: "gemini" }).body.generationConfig.thinkingConfig.thinkingBudget, 1024);
  assert.equal(applyReasoning({}, "medium", { compatibility: "gemini" }).body.generationConfig.thinkingConfig.thinkingBudget, 8192);
  // "off" is budget 0.
  assert.equal(applyReasoning({}, "off", { compatibility: "gemini" }).body.generationConfig.thinkingConfig.thinkingBudget, 0);
  // Explicit budgets pass through.
  assert.equal(applyReasoning({}, "3000", { compatibility: "gemini" }).body.generationConfig.thinkingConfig.thinkingBudget, 3000);
});

test("Gemini can be switched to the newer thinkingLevel field", () => {
  const { body } = applyReasoning({}, "high", {
    compatibility: "gemini",
    env: { RELAY_REASONING_GEMINI_FIELD: "thinkingLevel" },
  });
  assert.equal(body.generationConfig.thinkingConfig.thinkingLevel, "high");
  assert.equal(body.generationConfig.thinkingConfig.thinkingBudget, undefined);
});

/* -------------------------------------------------------------------------- *
 * Anthropic: the numeric rules
 * -------------------------------------------------------------------------- */

test("Claude budgeted thinking derives budget_tokens from max_tokens", () => {
  const { body } = applyReasoning(
    { model: "claude-sonnet-4-5", max_tokens: 16000 },
    "high",
    { compatibility: "anthropic" },
  );
  // high = 0.8 of max_tokens
  assert.deepEqual(body.thinking, { type: "enabled", budget_tokens: 12800 });
  assert.ok(body.thinking.budget_tokens < body.max_tokens, "budget must leave room for the answer");
});

test("Claude budget respects the 1024 floor and the max_tokens ceiling", () => {
  const tiny = applyReasoning({ model: "claude-3-7-sonnet", max_tokens: 2000 }, "minimal", {
    compatibility: "anthropic",
  });
  assert.equal(tiny.body.thinking.budget_tokens, 1024, "never below the documented minimum");

  const squeezed = applyReasoning({ model: "claude-3-7-sonnet", max_tokens: 1500 }, "max", {
    compatibility: "anthropic",
  });
  assert.equal(squeezed.body.thinking.budget_tokens, 1425);
  assert.ok(squeezed.body.thinking.budget_tokens < 1500);

  const impossible = applyReasoning({ model: "claude-3-7-sonnet", max_tokens: 500 }, "high", {
    compatibility: "anthropic",
  });
  assert.equal(impossible.body.thinking, undefined, "an impossible budget is skipped, not sent");
  assert.equal(impossible.state.warnings.length, 1);
});

test("Claude explicit budgets are clamped into the legal window", () => {
  const explicit = applyReasoning({ model: "claude-sonnet-4-5", max_tokens: 32000 }, "6000", {
    compatibility: "anthropic",
  });
  assert.equal(explicit.body.thinking.budget_tokens, 6000);

  const tooSmall = applyReasoning({ model: "claude-sonnet-4-5", max_tokens: 32000 }, "10", {
    compatibility: "anthropic",
  });
  assert.equal(tooSmall.body.thinking.budget_tokens, 1024);
});

test("Claude without max_tokens falls back to the configured budget table", () => {
  const { body } = applyReasoning({ model: "claude-sonnet-4-5" }, "medium", { compatibility: "anthropic" });
  assert.equal(body.thinking.budget_tokens, 8192);
});

test("Claude thinking can be disabled and thinking.display survives", () => {
  const off = applyReasoning({ model: "claude-sonnet-4-5", max_tokens: 8000 }, "off", {
    compatibility: "anthropic",
  });
  assert.deepEqual(off.body.thinking, { type: "disabled" });

  const kept = applyReasoning(
    { model: "claude-sonnet-4-5", max_tokens: 8000, thinking: { display: "omitted" } },
    "low",
    { compatibility: "anthropic" },
  );
  assert.equal(kept.body.thinking.display, "omitted");
  assert.equal(kept.body.thinking.type, "enabled");
});

test("Claude 4.7+ switches to the adaptive shape with output_config.effort", () => {
  assert.equal(anthropicUsesAdaptive("claude-sonnet-4-5", cfg), false);
  assert.equal(anthropicUsesAdaptive("claude-sonnet-4-6", cfg), false);
  assert.equal(anthropicUsesAdaptive("claude-sonnet-4-7", cfg), true);
  assert.equal(anthropicUsesAdaptive("claude-opus-5", cfg), true);
  assert.equal(anthropicUsesAdaptive("claude-3-7-sonnet-20250219", cfg), false);
  assert.equal(anthropicUsesAdaptive(undefined, cfg), false, "unknown models keep the widely supported shape");

  const { body } = applyReasoning({ model: "claude-sonnet-4-7", max_tokens: 16000 }, "xhigh", {
    compatibility: "anthropic",
  });
  assert.deepEqual(body.thinking, { type: "adaptive" });
  assert.deepEqual(body.output_config, { effort: "xhigh" });
  assert.equal(body.thinking.budget_tokens, undefined, "adaptive takes no budget");

  // Claude's adaptive vocabulary has no "minimal".
  const minimal = applyReasoning({ model: "claude-sonnet-5", max_tokens: 16000 }, "minimal", {
    compatibility: "anthropic",
  });
  assert.equal(minimal.body.output_config.effort, "low");
});

test("the anthropic shape can be forced either way", () => {
  const forcedAdaptive = applyReasoning({ model: "claude-3-7-sonnet", max_tokens: 9000 }, "high", {
    compatibility: "anthropic",
    env: { RELAY_REASONING_ANTHROPIC_MODE: "adaptive" },
  });
  assert.equal(forcedAdaptive.body.thinking.type, "adaptive");

  const forcedBudget = applyReasoning({ model: "claude-sonnet-5", max_tokens: 9000 }, "high", {
    compatibility: "anthropic",
    env: { RELAY_REASONING_ANTHROPIC_MODE: "budget" },
  });
  assert.equal(forcedBudget.body.thinking.type, "enabled");
});

/* -------------------------------------------------------------------------- *
 * Safety rails
 * -------------------------------------------------------------------------- */

test("reasoning is never written into APIs that have no such parameter", () => {
  for (const compatibility of ["images", "tts", "stt", "embeddings", "rerank", "videos"]) {
    const { body, state, mutated } = applyReasoning({ prompt: "draw a cat" }, "high", { compatibility });
    assert.deepEqual(body, { prompt: "draw a cat" }, compatibility);
    assert.equal(mutated, false);
    assert.equal(state.warnings.length, 1, compatibility);
  }
});

test("[reasoning=default] writes nothing at all", () => {
  const { body, mutated } = applyReasoning({ model: "gpt-5" }, "default");
  assert.deepEqual(body, { model: "gpt-5" });
  assert.equal(mutated, false);
});

test("a reasoning directive alone still counts as a body mutation", () => {
  const { mutated } = applyReasoning({ model: "gpt-5" }, "low");
  assert.equal(mutated, true);
});
