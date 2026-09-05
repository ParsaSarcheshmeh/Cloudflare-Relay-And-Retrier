/**
 * Cloudflare Workers AI Relay & Retrier — single-file Worker.
 *
 * Paste this whole file into the Cloudflare dashboard Worker editor (or use it as
 * the entrypoint of a wrangler project) and deploy. No npm packages, no build step,
 * no Node built-ins — only Web Platform APIs that workerd implements.
 *
 * WHAT IT DOES
 *   Clients call this Worker exactly like they would call an OpenAI / Anthropic /
 *   OpenAI-compatible provider. Inside their prompt text (or via query params /
 *   `X-Relay-*` headers) they embed relay directives:
 *
 *       [provider=https://api.example.com/v1]
 *       [model=gpt-5]
 *       [compatibility=responses]
 *       [key=sk-example]
 *
 *   The relay extracts the directives, strips them out of the text the model sees,
 *   rewrites only what it must (model / auth / target URL), forwards everything else
 *   byte-for-byte, retries transient upstream failures, and streams the response
 *   back untouched.
 *
 * DESIGN RULES (in priority order)
 *   1. Protocol transparency. This is a relay, not an API translator. Unknown fields,
 *      media, binary bodies and provider extensions are preserved.
 *   2. First valid occurrence of a directive wins; later duplicates are ignored but
 *      still removed from the text.
 *   3. Unicode safety. Text is handled as JS strings / UTF-8 only; no normalization,
 *      no ASCII folding. Persian, Arabic, CJK, emoji and combining marks survive.
 *   4. Streaming is never buffered, and a response is never retried after its first
 *      byte has been handed to the client.
 *
 * "INFINITE RETRY" IS BEST-EFFORT. Cloudflare Workers enforce runtime, CPU,
 * subrequest and client-connection limits, so no individual HTTP request can be
 * guaranteed to retry forever. See CONFIG.retries and the notes in
 * fetchWithRetries() for the exact behaviour and the platform ceilings.
 */

/* ========================================================================== *
 * 1. CONFIGURATION
 * ========================================================================== */

/**
 * Base configuration. Every value can also be overridden per-deployment with a
 * plain-text Worker variable (Settings → Variables) — see resolveConfig().
 */
const BASE_CONFIG = {
  /** Fallback used when a request contains no [provider=...] directive. */
  defaultProvider: "",
  /** Allow http:// upstreams (local dev only; keep false in production). */
  allowHttpProviders: false,
  /**
   * Empty array  -> any public HTTPS host is allowed (subject to the SSRF checks).
   * Non-empty    -> only these hosts. Entries may be exact ("api.openai.com") or
   *                 wildcard suffixes ("*.openai.azure.com").
   */
  providerAllowlist: [],
  /** Extra debug logging (never logs secrets, bodies or prompts). */
  debug: false,
  /** Strip this prefix off the incoming pathname before forwarding (e.g. "/relay"). */
  stripPathPrefix: "",
  /** Reserved local endpoints: /__relay/health, /__relay/help. "" disables them. */
  reservedNamespace: "/__relay",
  /** Add non-sensitive X-Relay-* diagnostics to responses. */
  exposeDiagnosticHeaders: true,

  directives: {
    /** Also read directives from ?provider=&model=&key=&compatibility= */
    acceptQueryParams: true,
    /** Also read directives from X-Relay-Provider / X-Relay-Model / ... headers. */
    acceptHeaders: true,
    headerPrefix: "x-relay-",
    /**
     * Where directives are looked for, in order. Body text wins over query params,
     * query params win over headers ("first occurrence wins" across sources too).
     */
    sourceOrder: ["body", "query", "header"],
  },

  paths: {
    /**
     * "smart" -> collapse an overlap between the provider base path and the incoming
     *            path (…/v1 + /v1/chat/completions = …/v1/chat/completions) and drop a
     *            leading /v1 when the base already carries a version segment
     *            (…/v1beta/openai + /v1/chat/completions = …/v1beta/openai/chat/completions).
     * "drop"  -> always drop a leading version segment from the incoming path.
     * "keep"  -> pure concatenation (overlap collapsing only).
     */
    versionPrefixMode: "smart",
    /** For requests to "/" use the compatibility's canonical endpoint. */
    useCompatibilityDefaultEndpoint: true,
  },

  body: {
    /** Bodies larger than these limits are forwarded opaquely instead of parsed. */
    maxJsonParseBytes: 24 * 1024 * 1024,
    maxMultipartParseBytes: 24 * 1024 * 1024,
    maxTextParseBytes: 8 * 1024 * 1024,
    /** Opaque bodies up to this size are buffered so that retries stay possible. */
    maxOpaqueBufferBytes: 24 * 1024 * 1024,
    /** Drop content parts whose only text was directives (keeps APIs from erroring). */
    dropEmptyTextParts: true,
  },
  traversal: {
    /** Guard rails for hostile / pathological JSON. */
    maxDepth: 64,
    maxNodes: 250000,
    /** Strings longer than this are not scanned for directives (CPU guard). */
    maxStringLength: 8 * 1024 * 1024,
  },

  retries: {
    /**
     * Effectively unbounded while the invocation is alive. The real ceiling is the
     * Cloudflare subrequest budget (50 on the free plan, 1000 on paid) — the loop
     * detects "Too many subrequests" and stops immediately with a clear error.
     */
    maxAttempts: 10000,
    baseDelayMs: 250,
    maxDelayMs: 30000,
    /** Floor for every wait, so `Retry-After: 0` and full jitter cannot busy-loop. */
    minDelayMs: 50,
    jitter: true,
    honorRetryAfter: true,
    maxRetryAfterMs: 60000,
    /** 0 = no wall-clock budget; otherwise stop starting new attempts after this. */
    totalBudgetMs: 0,
    /** 0 = no per-attempt timeout. Overridable per request with [timeout=ms]. */
    attemptTimeoutMs: 0,
    /** Statuses that are worth another attempt. 409 is opt-in (usually terminal). */
    retryStatuses: [
      408, 425, 429, 500, 502, 503, 504, 507, 509, 520, 521, 522, 523, 524, 525,
      526, 527, 529, 530,
    ],
    retry409: false,
    logAttempts: true,
  },

  cors: {
    origin: "*",
    methods: "GET, POST, PUT, PATCH, DELETE, HEAD, OPTIONS",
    /** "*" mirrors Access-Control-Request-Headers when credentials are not used. */
    headers: "*",
    exposeHeaders:
      "Content-Type, Content-Length, ETag, Retry-After, RateLimit-Limit, RateLimit-Remaining, RateLimit-Reset, X-Request-Id, X-Relay-Attempts, X-Relay-Compatibility, X-Relay-Upstream-Host, X-Relay-Model, X-Relay-Session",
    maxAgeSeconds: 86400,
    allowCredentials: false,
  },

  security: {
    blockPrivateNetworks: true,
    blockUrlCredentials: true,
    /**
     * Redirects are followed by the relay itself so that every hop is re-checked
     * against the SSRF policy (Cloudflare's own redirect following would not be).
     * 0 hands the 3xx back to the caller instead.
     */
    maxRedirects: 3,
    /** Fall back to the caller's own Authorization / x-api-key when no [key=...]. */
    forwardIncomingAuth: true,
    /** Never hand the caller's cookies to an arbitrary third-party provider. */
    stripCookies: true,
  },
  idempotency: {
    /** Always pass a caller-supplied Idempotency-Key through untouched. */
    preserveIncoming: true,
    /**
     * Retrying an expensive image/video/audio job can create duplicate work. Some
     * providers de-duplicate on Idempotency-Key, many ignore it, and a few reject
     * unknown headers — so a key is never invented unless you opt in here.
     */
    generate: false,
    headerName: "Idempotency-Key",
  },

  /**
   * Sticky directive sessions. In-prompt directives are fragile by nature: AI agents
   * spawn subagents whose prompts are written by the parent model (no directives),
   * and long conversations get compacted into summaries that may drop them. The relay
   * therefore issues a signed session token (X-Relay-Session) carrying the resolved
   * directives; clients echo it via header, query param, cookie — or the parent model
   * can paste the token into a subagent prompt, where it is recognized and stripped
   * like any directive. Tokens are stateless: the directives travel inside the token.
   */
  sessions: {
    enabled: true,
    /** Token lifetime in seconds. Renewed (re-emitted) on every request that has directives. */
    ttlSeconds: 7 * 24 * 3600,
    /**
     * HMAC/encryption secret (RELAY_SESSION_SECRET). WITHOUT a secret, tokens are
     * checksum-protected but READABLE — the provider key inside can be decoded by
     * anyone who sees the token. WITH a secret, tokens are AES-GCM encrypted.
     * Treat tokens as secrets either way.
     */
    secret: "",
    /** Include [key=...] in tokens. Without this, session tokens cannot restore auth. */
    includeKey: true,
    headerName: "x-relay-session",
    queryName: "relay_session",
    cookieName: "relay_session",
    /** Also set the token as a cookie so browser clients become sticky automatically. */
    emitCookie: true,
  },

  /**
   * Directives that stick to the caller's IP (see section 6c for semantics and
   * limits). Only cf-connecting-ip is trusted by default.
   */
  ipMemory: {
    enabled: true,
    ttlSeconds: 24 * 3600,
    maxEntries: 10000,
    includeKey: true,
    trustForwardedHeaders: false,
  },

  /**
   * Reasoning / thinking effort. Every provider spells this differently, so the
   * directive carries INTENT ("think harder") and the relay writes it into whichever
   * field the target API actually accepts. Verified against provider docs:
   *   effort     -> reasoning_effort: "high"                  (OpenAI chat, Azure, xAI,
   *                                                            Groq, Gemini OpenAI-compat,
   *                                                            most OpenAI-compatible gateways)
   *   responses  -> reasoning: { effort: "high" }             (OpenAI Responses API)
   *   anthropic  -> thinking: { type:"enabled", budget_tokens } | { type:"adaptive" }
   *                 + output_config: { effort }               (Claude Messages API)
   *   gemini     -> generationConfig.thinkingConfig.thinkingBudget  (native generateContent)
   *   openrouter -> reasoning: { effort } | { max_tokens }    (OpenRouter's unified param;
   *                                                            it does NOT accept reasoning_effort)
   *   glm        -> thinking: { type } + reasoning_effort     (Z.ai / GLM)
   */
  reasoning: {
    enabled: true,
    /** "auto" picks the style from compatibility + upstream host; or force one. */
    style: "auto",
    /**
     * Claude has two mutually exclusive shapes: budgeted ("enabled", rejected by
     * Claude 4.7+) and "adaptive" (rejected by older extended-thinking-only models).
     * "auto" reads the model version and picks; "budget"/"adaptive" force one.
     */
    anthropicMode: "auto",
    /** Token budgets used when a provider wants numbers instead of a level. */
    budgets: { minimal: 1024, low: 4096, medium: 8192, high: 24576, xhigh: 32768, max: 63999 },
    /**
     * Claude derives its budget from the request's own max_tokens (the budget must
     * leave room for the answer). Ratios follow the documented convention.
     */
    ratios: { minimal: 0.1, low: 0.2, medium: 0.5, high: 0.8, xhigh: 0.95, max: 0.95 },
    /** Gemini's own documented reasoning_effort -> thinking budget mapping. */
    geminiBudgets: { minimal: 1024, low: 1024, medium: 8192, high: 24576, xhigh: 32768, max: 32768 },
    /** Gemini field to write: "thinkingBudget" (generateContent) or "thinkingLevel". */
    geminiField: "thinkingBudget",
    minBudgetTokens: 1024,
    maxBudgetTokens: 128000,
  },

  /**
   * Path-based providers (RELAY_NAMED_PROVIDERS="openai=https://api.openai.com/v1,...").
   * Lets a client configure its base URL ONCE (https://relay/…/openai) and reach a
   * provider without any directives at all — the most compaction- and
   * subagent-proof option. The first path segment selects the provider:
   *   /openai/v1/chat/completions -> https://api.openai.com/v1/chat/completions
   * A provider directive may also use the name directly: [provider=openai].
   */
  namedProviders: {},
};

const RELAY_VERSION = "1.0.0";

/* ========================================================================== *
 * 2. CONSTANTS
 * ========================================================================== */

/**
 * Directive registry. Adding a directive is a single entry here:
 *   key      - field name on the parsed state
 *   names    - accepted directive names (case-insensitive, first alias hit wins)
 *   parse    - value -> parsed value (return undefined to reject the value)
 *   multiple - collect every occurrence instead of first-wins
 */
const DIRECTIVE_SPECS = [
  { key: "provider", names: ["provider", "endpoint", "base_url", "baseurl", "base-url"] },
  { key: "model", names: ["model"] },
  {
    key: "compatibility",
    names: ["compatibility", "compatiblity", "compatability", "compat"],
    parse: (value) => normalizeCompatibility(value),
  },
  { key: "apiKey", names: ["key", "apikey", "api_key", "api-key"], secret: true },
  { key: "stream", names: ["stream"], parse: (value) => parseBooleanValue(value) },
  { key: "timeoutMs", names: ["timeout", "timeout_ms"], parse: (value) => parseIntInRange(value, 1, 3600000) },
  {
    key: "maxRetries",
    names: ["max_retries", "maxretries", "retries"],
    // Caller-supplied retry budgets are capped well below the deployment default:
    // a relay that retries a million times against an attacker-chosen host is an
    // amplification tool. Operators raise this by editing the Worker, not per request.
    parse: (value) => parseIntInRange(value, 0, 1000),
  },
  { key: "temperature", names: ["temperature"], parse: (value) => parseFloatValue(value) },
  {
    key: "reasoning",
    names: ["reasoning", "reasoning_effort", "reasoningeffort", "effort", "thinking"],
    parse: (value) => parseReasoningValue(value),
  },
  {
    key: "extraHeaders",
    names: ["header"],
    multiple: true,
    parse: (value) => parseHeaderDirective(value),
  },
];
/** lowercased directive name -> spec */
const DIRECTIVE_BY_NAME = new Map();
for (const spec of DIRECTIVE_SPECS) {
  for (const name of spec.names) DIRECTIVE_BY_NAME.set(name.toLowerCase(), spec);
}

/**
 * Directives are found with a hand-written linear scanner rather than a regex, so the
 * CPU cost is O(n) even on adversarial input (a regex with a bounded value class can
 * be made to backtrack linearly-with-a-huge-constant, which reads as a DoS on Workers).
 * Rules, identical to the old pattern's intent:
 *   - only spaces/tabs may pad the name and the "=" (never a newline)
 *   - the value stops at the first "]", line break, or MAX_DIRECTIVE_VALUE_LENGTH chars
 *   - a directive immediately followed by "(" is treated as a Markdown link and left alone
 */
const MAX_DIRECTIVE_VALUE_LENGTH = 4096;
const MAX_DIRECTIVE_NAME_LENGTH = 32;

function isDirectiveNameChar(char) {
  return (
    (char >= "a" && char <= "z") ||
    (char >= "A" && char <= "Z") ||
    (char >= "0" && char <= "9") ||
    char === "-" ||
    char === "_"
  );
}

/** Sentinel used to remember where a directive was removed (see cleanDirectiveText). */
const REMOVAL_MARK = "\u0000\u001a\u0000";

/* -------------------------------------------------------------------------- *
 * Reasoning / thinking effort
 * -------------------------------------------------------------------------- */

/**
 * Canonical effort levels, ordered weakest -> strongest. This is OpenAI's current
 * reasoning_effort enum, which is also the superset the other providers map onto.
 */
const REASONING_LEVELS = ["none", "minimal", "low", "medium", "high", "xhigh", "max"];

/** Spelling variants accepted for a level (the value the user typed). */
const REASONING_LEVEL_ALIASES = new Map([
  ["off", "none"],
  ["false", "none"],
  ["disable", "none"],
  ["disabled", "none"],
  ["no", "none"],
  ["nothinking", "none"],
  ["min", "minimal"],
  ["lowest", "minimal"],
  ["med", "medium"],
  ["mid", "medium"],
  ["normal", "medium"],
  ["standard", "medium"],
  ["hi", "high"],
  ["xh", "xhigh"],
  ["x-high", "xhigh"],
  ["extra-high", "xhigh"],
  ["veryhigh", "xhigh"],
  ["ultra", "max"],
  ["maximum", "max"],
  ["highest", "max"],
  ["true", "high"],
  ["on", "high"],
  ["enable", "high"],
  ["enabled", "high"],
  ["think", "high"],
  ["deep", "high"],
]);

/** Emitters, i.e. which request field a provider family actually accepts. */
const REASONING_STYLES = new Set([
  "effort",
  "responses",
  "anthropic",
  "gemini",
  "openrouter",
  "glm",
  "off",
]);

/** Style implied by the compatibility mode. */
const REASONING_STYLE_BY_COMPATIBILITY = {
  openai: "effort",
  responses: "responses",
  anthropic: "anthropic",
  gemini: "gemini",
  azure: "effort",
  generic: "effort",
  // Reasoning has no meaning for these APIs and adding fields can break them.
  images: "off",
  videos: "off",
  tts: "off",
  stt: "off",
  embeddings: "off",
  rerank: "off",
};

/**
 * Hosts whose OpenAI-compatible endpoint does NOT take the flat reasoning_effort
 * field. Matched on exact host or ".suffix" so subdomains count.
 */
const REASONING_STYLE_BY_HOST = [
  [".openrouter.ai", "openrouter"],
  ["openrouter.ai", "openrouter"],
  ["api.z.ai", "glm"],
  ["open.bigmodel.cn", "glm"],
  [".bigmodel.cn", "glm"],
];

/** Claude switched shapes at 4.7: below it takes a budget, from it "adaptive". */
const ANTHROPIC_ADAPTIVE_MIN_VERSION = [4, 7];

/** Canonical compatibility modes. */
const COMPATIBILITY_SPECS = {
  openai: {
    authStyle: "bearer",
    defaultEndpoint: "/v1/chat/completions",
    aliases: ["openai", "chat", "chat-completions", "chat_completions", "completions", "openai-chat", "oai"],
  },
  responses: {
    authStyle: "bearer",
    defaultEndpoint: "/v1/responses",
    aliases: ["responses", "response", "openai-responses", "openai_responses"],
  },
  anthropic: {
    authStyle: "anthropic",
    defaultEndpoint: "/v1/messages",
    aliases: ["anthropic", "claude", "messages", "anthropic-messages"],
  },
  images: {
    authStyle: "bearer",
    defaultEndpoint: "/v1/images/generations",
    aliases: ["images", "image", "image-generation", "images-generations", "dalle"],
  },
  videos: {
    authStyle: "bearer",
    defaultEndpoint: "/v1/videos",
    aliases: ["videos", "video", "video-generation"],
  },
  tts: {
    authStyle: "bearer",
    defaultEndpoint: "/v1/audio/speech",
    aliases: ["tts", "speech", "audio-speech", "text-to-speech", "texttospeech"],
  },
  stt: {
    authStyle: "bearer",
    defaultEndpoint: "/v1/audio/transcriptions",
    aliases: ["stt", "transcription", "transcriptions", "asr", "speech-to-text", "whisper", "audio-transcriptions"],
  },
  embeddings: {
    authStyle: "bearer",
    defaultEndpoint: "/v1/embeddings",
    aliases: ["embeddings", "embedding", "embed"],
  },
  rerank: {
    authStyle: "bearer",
    defaultEndpoint: "/v1/rerank",
    aliases: ["rerank", "reranking", "reranker"],
  },
  gemini: {
    authStyle: "google",
    defaultEndpoint: "",
    aliases: ["gemini", "google", "google-ai", "generativelanguage"],
  },
  azure: {
    authStyle: "azure",
    defaultEndpoint: "",
    /** Azure deployment URLs already carry their own path, so drop the client's /v1. */
    versionPrefixMode: "drop",
    aliases: ["azure", "azure-openai", "azureopenai"],
  },
  generic: {
    authStyle: "bearer",
    defaultEndpoint: "",
    aliases: ["generic", "passthrough", "raw", "proxy", "none"],
  },
};

const COMPATIBILITY_BY_ALIAS = new Map();
for (const [canonical, spec] of Object.entries(COMPATIBILITY_SPECS)) {
  COMPATIBILITY_BY_ALIAS.set(canonical, canonical);
  for (const alias of spec.aliases) COMPATIBILITY_BY_ALIAS.set(alias.toLowerCase(), canonical);
}

/** Path suffix -> compatibility, used when no [compatibility=...] was supplied. */
const PATH_COMPATIBILITY_RULES = [
  ["/chat/completions", "openai"],
  ["/completions", "openai"],
  ["/responses", "responses"],
  ["/messages", "anthropic"],
  ["/complete", "anthropic"],
  ["/images/generations", "images"],
  ["/images/edits", "images"],
  ["/images/variations", "images"],
  ["/images", "images"],
  ["/videos/generations", "videos"],
  ["/videos", "videos"],
  ["/audio/speech", "tts"],
  ["/audio/transcriptions", "stt"],
  ["/audio/translations", "stt"],
  ["/embeddings", "embeddings"],
  ["/rerank", "rerank"],
  ["/reranking", "rerank"],
];

/**
 * Field names whose *string* values may carry user text, and are therefore scanned
 * for directives. Everything else is forwarded byte-for-byte.
 */
const TEXT_FIELD_NAMES = new Set([
  "prompt",
  "prompts",
  "text",
  "input",
  "inputs",
  "content",
  "query",
  "instruction",
  "instructions",
  "message",
  "messages",
  "caption",
  "description",
  "system",
  "system_prompt",
  "system_instruction",
  "negative_prompt",
  "question",
]);

/**
 * Never rewritten and never descended into. Media, binary payloads, credentials and
 * schema-ish structures must reach the provider exactly as the client sent them.
 */
const PROTECTED_FIELD_NAMES = new Set([
  "url",
  "urls",
  "image_url",
  "image_urls",
  "video_url",
  "video_urls",
  "audio_url",
  "audio_urls",
  "file_url",
  "file_urls",
  "media_url",
  "media_urls",
  "base64",
  "b64",
  "b64_json",
  "data",
  "bytes",
  "buffer",
  "binary",
  "blob",
  "source",
  "file",
  "files",
  "file_id",
  "file_ids",
  "attachment",
  "attachments",
  "image",
  "images",
  "image_base64",
  "video",
  "videos",
  "input_video",
  "input_audio",
  "audio",
  "media",
  "embedding",
  "embeddings",
  "authorization",
  "api_key",
  "apikey",
  "key",
  "secret",
  "token",
  "access_token",
  "password",
  "credentials",
  "signature",
  "tools",
  "tool_choice",
  "tool_calls",
  "functions",
  "function_call",
  "response_format",
  "json_schema",
  "schema",
]);
/** multipart/form-data + urlencoded string fields that may carry directives. */
const FORM_TEXT_FIELD_NAMES = new Set([
  "prompt",
  "text",
  "input",
  "instruction",
  "instructions",
  "description",
  "caption",
  "query",
  "message",
  "content",
  "system",
  "negative_prompt",
]);

/** Content-part types whose text may be dropped when a directive was its only content. */
const TEXT_PART_TYPES = new Set(["text", "input_text", "output_text"]);

/** Request headers that must never be forwarded verbatim. */
const STRIPPED_REQUEST_HEADERS = new Set([
  "host",
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "proxy-connection",
  "te",
  "trailer",
  "trailers",
  "transfer-encoding",
  "upgrade",
  "content-length",
  "accept-encoding",
  "expect",
  "origin",
  "referer",
  "cookie",
  "x-real-ip",
  "true-client-ip",
  "cdn-loop",
  "forwarded",
  "priority",
]);

/** Request header prefixes that must never be forwarded. */
const STRIPPED_REQUEST_PREFIXES = ["cf-", "x-forwarded-", "sec-fetch-", "sec-ch-", "x-relay-"];
/** Response headers that are hop-by-hop and must not be re-emitted. */
const STRIPPED_RESPONSE_HEADERS = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "trailers",
  "transfer-encoding",
  "upgrade",
]);

/** Relay error code -> default HTTP status. */
const ERROR_STATUS = {
  missing_provider: 400,
  invalid_provider: 400,
  blocked_provider: 403,
  invalid_json: 400,
  invalid_directive: 400,
  unsupported_content_type: 415,
  request_too_large: 413,
  upstream_error: 502,
  retry_exhausted: 504,
  subrequest_limit: 502,
  client_disconnected: 499,
  internal_error: 500,
};

/** Hostnames that always resolve somewhere we must not reach. */
const BLOCKED_HOST_EXACT = new Set([
  "localhost",
  "localhost.localdomain",
  "ip6-localhost",
  "ip6-loopback",
  "metadata",
  "metadata.google.internal",
  "metadata.goog",
  "instance-data",
  "instance-data.ec2.internal",
  "kubernetes",
  "kubernetes.default",
]);

/** Suffixes that denote private / internal namespaces. */
const BLOCKED_HOST_SUFFIXES = [
  ".localhost",
  ".local",
  ".localdomain",
  ".internal",
  ".intranet",
  ".intra",
  ".lan",
  ".home",
  ".home.arpa",
  ".corp",
  ".private",
  ".in-addr.arpa",
  ".ip6.arpa",
  ".ec2.internal",
  ".compute.internal",
  ".svc.cluster.local",
];

/**
 * Blocked IPv4 CIDRs: loopback, RFC1918, link-local (cloud metadata lives at
 * 169.254.169.254), CGNAT, benchmarking, documentation, multicast and reserved.
 */
const BLOCKED_IPV4_CIDRS = [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24],
  ["192.88.99.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 4],
  ["240.0.0.0", 4],
];

/* ========================================================================== *
 * 3. SMALL UTILITIES
 * ========================================================================== */

function isPlainObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function log(cfg, ...args) {
  if (cfg && cfg.debug) console.log("[relay]", ...args);
}

/** Never let a secret reach a log line: not even a prefix/suffix hint. */
function redact(value) {
  if (typeof value !== "string" || value.length === 0) return "";
  return "***";
}
function parseBooleanValue(value) {
  const normalized = String(value).trim().toLowerCase();
  if (["true", "1", "yes", "on", "enable", "enabled"].includes(normalized)) return true;
  if (["false", "0", "no", "off", "disable", "disabled"].includes(normalized)) return false;
  return undefined;
}

function parseIntInRange(value, min, max) {
  const raw = String(value).trim();
  if (!/^\d+$/.test(raw)) return undefined; // rejects "1e3", "0x10", "-5", "1.5"
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed < min || parsed > max) return undefined;
  return parsed;
}

function parseFloatValue(value) {
  const parsed = Number.parseFloat(String(value).trim());
  return Number.isFinite(parsed) ? parsed : undefined;
}

/** `[header=X-Custom: abc]` -> { name: "X-Custom", value: "abc" } */
function parseHeaderDirective(value) {
  const raw = String(value);
  const separator = raw.indexOf(":");
  if (separator <= 0) return undefined;
  const name = raw.slice(0, separator).trim();
  const headerValue = raw.slice(separator + 1).trim();
  if (!/^[A-Za-z0-9!#$%&'*+.^_`|~-]+$/.test(name)) return undefined;
  // Header values must be valid ByteStrings; anything outside this set (e.g. U+2028,
  // NUL) would make Headers.set() throw and turn a bad directive into a 500.
  if (!/^[ \t\x21-\x7E\x80-\xFF]*$/.test(headerValue)) return undefined;
  const lower = name.toLowerCase();
  // Directive-supplied headers may not be used to smuggle transport or CF headers.
  if (STRIPPED_REQUEST_HEADERS.has(lower)) return undefined;
  if (STRIPPED_REQUEST_PREFIXES.some((prefix) => lower.startsWith(prefix))) return undefined;
  return { name, value: headerValue };
}

function normalizeCompatibility(value) {
  const normalized = String(value).trim().toLowerCase().replace(/\s+/g, "-");
  return COMPATIBILITY_BY_ALIAS.get(normalized);
}

/**
 * Parse a [reasoning=...] value into intent:
 *   { level: "high" }        a named effort level (or "none" to switch thinking off)
 *   { budget: 8192 }         an explicit thinking-token budget
 *   { auto: true }           "default"/"auto": let the provider decide
 */
function parseReasoningValue(value) {
  const raw = String(value).trim().toLowerCase();
  if (raw === "") return undefined;
  if (raw === "default" || raw === "auto" || raw === "dynamic") return { auto: true };

  if (/^\d+$/.test(raw)) {
    const budget = Number.parseInt(raw, 10);
    if (!Number.isFinite(budget) || budget < 0 || budget > 1000000) return undefined;
    return budget === 0 ? { level: "none" } : { budget };
  }

  const normalized = raw.replace(/[\s_]+/g, "-");
  if (REASONING_LEVELS.includes(normalized)) return { level: normalized };
  const alias = REASONING_LEVEL_ALIASES.get(normalized) || REASONING_LEVEL_ALIASES.get(raw.replace(/[\s_-]+/g, ""));
  if (alias) return { level: alias };
  return undefined;
}

/**
 * Routing flags embedded IN the model name, for clients that can only set a model
 * string (no prompt access, no headers). Syntax:
 *   <model>@<flag>[@<flag>…]   e.g. glm-5.3-flash@https://api.b.ai/v1@key=sk-x
 * Each flag must be one of:
 *   - an absolute http(s) URL            -> provider
 *   - a bare host ("api.b.ai/v1")        -> provider (https:// prepended)
 *   - a RELAY_NAMED_PROVIDERS name       -> provider
 *   - key=… / apikey=… / k=…             -> API key
 *   - compatibility=… / compat=… / c=…   -> compatibility mode
 * If ANY segment is unrecognized the whole string is left untouched, so ordinary
 * model names containing "@" never get mangled.
 */
function extractModelFlags(modelString, cfg) {
  if (typeof modelString !== "string") return null;
  const at = modelString.indexOf("@");
  if (at <= 0 || at === modelString.length - 1) return null;

  const model = modelString.slice(0, at).trim();
  const flags = {
    model: model === "" ? null : model,
    provider: undefined,
    apiKey: undefined,
    compatibility: undefined,
    reasoning: undefined,
  };
  let matchedAny = false;

  for (const rawSegment of modelString.slice(at + 1).split("@")) {
    const segment = rawSegment.trim();
    if (segment === "") return null;
    const lower = segment.toLowerCase();

    if (/^https?:\/\//i.test(segment)) {
      flags.provider ??= segment;
      matchedAny = true;
      continue;
    }
    // A bare host with a public TLD, same convenience rule as provider validation.
    if (/^[a-z0-9._~%-]+\.[a-z]{2,}(:\d+)?([/?#]|$)/i.test(segment)) {
      flags.provider ??= `https://${segment}`;
      matchedAny = true;
      continue;
    }
    if (cfg.namedProviders.size > 0 && cfg.namedProviders.has(lower)) {
      flags.provider ??= cfg.namedProviders.get(lower);
      matchedAny = true;
      continue;
    }
    const keyMatch = segment.match(/^(?:key|apikey|api_key|k)=(.+)$/i);
    if (keyMatch && keyMatch[1].trim() !== "") {
      flags.apiKey ??= keyMatch[1].trim();
      matchedAny = true;
      continue;
    }
    const compatMatch = segment.match(/^(?:compatibility|compat|c)=(.+)$/i);
    if (compatMatch) {
      const compatibility = normalizeCompatibility(compatMatch[1]);
      if (!compatibility) return null;
      flags.compatibility ??= compatibility;
      matchedAny = true;
      continue;
    }
    const reasoningMatch = segment.match(/^(?:reasoning|reasoning_effort|reasoningeffort|effort|thinking)=(.+)$/i);
    if (reasoningMatch) {
      const reasoning = parseReasoningValue(reasoningMatch[1]);
      if (!reasoning) return null;
      flags.reasoning ??= reasoning;
      matchedAny = true;
      continue;
    }
    return null; // Unrecognized segment: not model flags after all.
  }

  return matchedAny ? flags : null;
}

function boolFromEnv(value, fallback) {
  if (value === undefined || value === null || value === "") return fallback;
  const parsed = parseBooleanValue(value);
  return parsed === undefined ? fallback : parsed;
}

function numFromEnv(value, fallback, min = 0) {
  if (value === undefined || value === null || value === "") return fallback;
  const parsed = Number(String(value).trim());
  if (!Number.isFinite(parsed) || parsed < min) return fallback;
  return parsed;
}
function listFromEnv(value, fallback) {
  if (value === undefined || value === null || String(value).trim() === "") return fallback;
  return String(value)
    .split(/[,\s]+/)
    .map((entry) => entry.trim().toLowerCase())
    .filter(Boolean);
}

/** RELAY_NAMED_PROVIDERS="openai=https://api.openai.com/v1, anthropic=https://…" */
function parseNamedProviders(value) {
  const map = new Map();
  if (value === undefined || value === null || String(value).trim() === "") return map;
  for (const entry of String(value).split(/[,\n]+/)) {
    const equals = entry.indexOf("=");
    if (equals <= 0) continue;
    const name = entry
      .slice(0, equals)
      .trim()
      .toLowerCase()
      .replace(/^\/+|\/+$/g, "");
    const url = entry.slice(equals + 1).trim();
    if (name && url && /^[a-z0-9-]{1,64}$/.test(name)) map.set(name, url);
  }
  return map;
}

/**
 * Per-request configuration: BASE_CONFIG plus optional plain-text Worker variables.
 * Returning a fresh object keeps module state immutable across requests.
 */
function resolveConfig(env) {
  const e = env || {};
  const base = BASE_CONFIG;
  return {
    defaultProvider: (e.RELAY_DEFAULT_PROVIDER || base.defaultProvider || "").trim(),
    allowHttpProviders: boolFromEnv(e.RELAY_ALLOW_HTTP, base.allowHttpProviders),
    providerAllowlist: listFromEnv(e.RELAY_PROVIDER_ALLOWLIST, base.providerAllowlist),
    debug: boolFromEnv(e.RELAY_DEBUG, base.debug),
    stripPathPrefix: (e.RELAY_STRIP_PATH_PREFIX ?? base.stripPathPrefix) || "",
    reservedNamespace: e.RELAY_RESERVED_NAMESPACE ?? base.reservedNamespace,
    exposeDiagnosticHeaders: boolFromEnv(e.RELAY_DIAGNOSTIC_HEADERS, base.exposeDiagnosticHeaders),
    directives: {
      acceptQueryParams: boolFromEnv(e.RELAY_ACCEPT_QUERY_DIRECTIVES, base.directives.acceptQueryParams),
      acceptHeaders: boolFromEnv(e.RELAY_ACCEPT_HEADER_DIRECTIVES, base.directives.acceptHeaders),
      headerPrefix: base.directives.headerPrefix,
      sourceOrder: base.directives.sourceOrder,
    },
    paths: {
      versionPrefixMode: ["smart", "drop", "keep"].includes(String(e.RELAY_VERSION_PREFIX_MODE))
        ? String(e.RELAY_VERSION_PREFIX_MODE)
        : base.paths.versionPrefixMode,
      useCompatibilityDefaultEndpoint: boolFromEnv(
        e.RELAY_DEFAULT_ENDPOINT,
        base.paths.useCompatibilityDefaultEndpoint,
      ),
    },
    body: {
      maxJsonParseBytes: numFromEnv(e.RELAY_MAX_JSON_BYTES, base.body.maxJsonParseBytes, 1),
      maxMultipartParseBytes: numFromEnv(e.RELAY_MAX_MULTIPART_BYTES, base.body.maxMultipartParseBytes, 1),
      maxTextParseBytes: numFromEnv(e.RELAY_MAX_TEXT_BYTES, base.body.maxTextParseBytes, 1),
      maxOpaqueBufferBytes: numFromEnv(e.RELAY_MAX_BUFFER_BYTES, base.body.maxOpaqueBufferBytes, 0),
      dropEmptyTextParts: boolFromEnv(e.RELAY_DROP_EMPTY_TEXT_PARTS, base.body.dropEmptyTextParts),
    },
    traversal: { ...base.traversal },
    retries: {
      maxAttempts: numFromEnv(e.RELAY_MAX_ATTEMPTS, base.retries.maxAttempts, 1),
      baseDelayMs: numFromEnv(e.RELAY_BASE_DELAY_MS, base.retries.baseDelayMs, 0),
      maxDelayMs: numFromEnv(e.RELAY_MAX_DELAY_MS, base.retries.maxDelayMs, 0),
      minDelayMs: numFromEnv(e.RELAY_MIN_DELAY_MS, base.retries.minDelayMs, 0),
      jitter: boolFromEnv(e.RELAY_JITTER, base.retries.jitter),
      honorRetryAfter: boolFromEnv(e.RELAY_HONOR_RETRY_AFTER, base.retries.honorRetryAfter),
      maxRetryAfterMs: numFromEnv(e.RELAY_MAX_RETRY_AFTER_MS, base.retries.maxRetryAfterMs, 0),
      totalBudgetMs: numFromEnv(e.RELAY_RETRY_BUDGET_MS, base.retries.totalBudgetMs, 0),
      attemptTimeoutMs: numFromEnv(e.RELAY_ATTEMPT_TIMEOUT_MS, base.retries.attemptTimeoutMs, 0),
      retryStatuses: new Set(base.retries.retryStatuses),
      retry409: boolFromEnv(e.RELAY_RETRY_409, base.retries.retry409),
      logAttempts: boolFromEnv(e.RELAY_LOG_ATTEMPTS, base.retries.logAttempts),
    },
    cors: {
      origin: e.RELAY_CORS_ORIGIN || base.cors.origin,
      methods: base.cors.methods,
      headers: e.RELAY_CORS_HEADERS || base.cors.headers,
      exposeHeaders: base.cors.exposeHeaders,
      maxAgeSeconds: numFromEnv(e.RELAY_CORS_MAX_AGE, base.cors.maxAgeSeconds, 0),
      // Credentialed responses require a specific origin: "*" + credentials is an
      // invalid (and unsafe) combination, so credentials are dropped instead.
      allowCredentials:
        boolFromEnv(e.RELAY_CORS_CREDENTIALS, base.cors.allowCredentials) &&
        Boolean(e.RELAY_CORS_ORIGIN) &&
        e.RELAY_CORS_ORIGIN !== "*",
    },
    security: {
      blockPrivateNetworks: !boolFromEnv(
        e.RELAY_ALLOW_PRIVATE_NETWORKS,
        !base.security.blockPrivateNetworks,
      ),
      blockUrlCredentials: boolFromEnv(e.RELAY_BLOCK_URL_CREDENTIALS, base.security.blockUrlCredentials),
      maxRedirects: numFromEnv(e.RELAY_MAX_REDIRECTS, base.security.maxRedirects, 0),
      forwardIncomingAuth: boolFromEnv(e.RELAY_FORWARD_INCOMING_AUTH, base.security.forwardIncomingAuth),
      stripCookies: boolFromEnv(e.RELAY_STRIP_COOKIES, base.security.stripCookies),
    },
    idempotency: {
      preserveIncoming: base.idempotency.preserveIncoming,
      generate: boolFromEnv(e.RELAY_GENERATE_IDEMPOTENCY_KEY, base.idempotency.generate),
      headerName: base.idempotency.headerName,
    },
    sessions: {
      enabled: boolFromEnv(e.RELAY_SESSIONS, base.sessions.enabled),
      ttlSeconds: numFromEnv(e.RELAY_SESSION_TTL_SECONDS, base.sessions.ttlSeconds, 60),
      secret: (e.RELAY_SESSION_SECRET || "").trim(),
      includeKey: boolFromEnv(e.RELAY_SESSION_INCLUDE_KEY, base.sessions.includeKey),
      headerName: base.sessions.headerName,
      queryName: base.sessions.queryName,
      cookieName: base.sessions.cookieName,
      emitCookie: boolFromEnv(e.RELAY_SESSION_COOKIE, base.sessions.emitCookie),
    },
    ipMemory: resolveConfiguredIpMemory(e),
    namedProviders: parseNamedProviders(e.RELAY_NAMED_PROVIDERS),
    reasoning: {
      enabled: boolFromEnv(e.RELAY_REASONING, base.reasoning.enabled),
      style: REASONING_STYLES.has(String(e.RELAY_REASONING_STYLE))
        ? String(e.RELAY_REASONING_STYLE)
        : base.reasoning.style,
      anthropicMode: ["auto", "budget", "adaptive"].includes(String(e.RELAY_REASONING_ANTHROPIC_MODE))
        ? String(e.RELAY_REASONING_ANTHROPIC_MODE)
        : base.reasoning.anthropicMode,
      budgets: { ...base.reasoning.budgets },
      ratios: { ...base.reasoning.ratios },
      geminiBudgets: { ...base.reasoning.geminiBudgets },
      geminiField: ["thinkingBudget", "thinkingLevel"].includes(String(e.RELAY_REASONING_GEMINI_FIELD))
        ? String(e.RELAY_REASONING_GEMINI_FIELD)
        : base.reasoning.geminiField,
      minBudgetTokens: numFromEnv(e.RELAY_REASONING_MIN_BUDGET, base.reasoning.minBudgetTokens, 1),
      maxBudgetTokens: numFromEnv(e.RELAY_REASONING_MAX_BUDGET, base.reasoning.maxBudgetTokens, 1024),
    },
  };
}

/* ========================================================================== *
 * 4. CORS
 * ========================================================================== */

function resolveAllowedOrigin(cfg, request) {
  const configured = cfg.cors.origin || "*";
  const requestOrigin = request.headers.get("Origin");
  if (configured === "*") {
    // Credentialed requests cannot use "*", so mirror the caller's origin instead.
    return cfg.cors.allowCredentials && requestOrigin ? requestOrigin : "*";
  }
  const allowed = configured.split(",").map((entry) => entry.trim()).filter(Boolean);
  if (requestOrigin && allowed.includes(requestOrigin)) return requestOrigin;
  return allowed[0] || "*";
}

/** Adds the relay's CORS headers to an existing Headers object (mutates + returns). */
function applyCorsHeaders(headers, cfg, request) {
  const origin = resolveAllowedOrigin(cfg, request);
  headers.set("Access-Control-Allow-Origin", origin);
  if (origin !== "*") headers.append("Vary", "Origin");
  if (cfg.cors.allowCredentials) headers.set("Access-Control-Allow-Credentials", "true");
  headers.set("Access-Control-Expose-Headers", cfg.cors.exposeHeaders);
  return headers;
}

function handlePreflight(request, cfg) {
  const headers = new Headers();
  applyCorsHeaders(headers, cfg, request);
  headers.set("Access-Control-Allow-Methods", cfg.cors.methods);
  const requested = request.headers.get("Access-Control-Request-Headers");
  headers.set(
    "Access-Control-Allow-Headers",
    cfg.cors.headers === "*" ? requested || "*" : cfg.cors.headers,
  );
  if (requested) headers.append("Vary", "Access-Control-Request-Headers");
  headers.set("Access-Control-Max-Age", String(cfg.cors.maxAgeSeconds));
  headers.set("Content-Length", "0");
  return new Response(null, { status: 204, headers });
}

/* ========================================================================== *
 * 5. ERROR HELPERS
 * ========================================================================== */

/**
 * Structured relay error. Only relay-owned text is included — never the request
 * body, never a prompt, never an API key.
 */
function relayError(code, message, options = {}) {
  const { cfg, request, status, details, headers: extraHeaders } = options;
  const payload = {
    error: {
      type: "relay_error",
      code,
      message,
      ...(details && Object.keys(details).length ? { details } : {}),
    },
  };
  const headers = new Headers({ "Content-Type": "application/json; charset=utf-8" });
  if (extraHeaders) {
    for (const [name, value] of Object.entries(extraHeaders)) headers.set(name, value);
  }
  if (cfg && request) applyCorsHeaders(headers, cfg, request);
  return new Response(JSON.stringify(payload, null, 2), {
    status: status || ERROR_STATUS[code] || 500,
    headers,
  });
}

/* ========================================================================== *
 * 6. DIRECTIVE PARSING
 * ========================================================================== */

function createDirectiveState() {
  return {
    /** First-wins values, keyed by DIRECTIVE_SPECS[].key */
    values: Object.create(null),
    /** Where each value came from ("body" | "query" | "header"), for diagnostics. */
    sources: Object.create(null),
    /** Repeatable directives. */
    extraHeaders: [],
    /** Non-fatal problems (empty value, unknown compatibility, bad header, ...). */
    warnings: [],
    /** True once any recognized directive has been seen anywhere. */
    found: false,
  };
}

function recordWarning(state, code, message) {
  if (state.warnings.length < 20) state.warnings.push({ code, message });
}

/**
 * Store a directive value, honouring first-occurrence-wins.
 * Returns true when the value was accepted (stored), false otherwise.
 */
function storeDirectiveValue(state, spec, rawValue, source) {
  const trimmed = String(rawValue).trim();
  state.found = true;

  if (trimmed === "") {
    recordWarning(state, "invalid_directive", `Directive "${spec.names[0]}" had an empty value and was ignored.`);
    return false;
  }

  const parsed = spec.parse ? spec.parse(trimmed) : trimmed;
  if (parsed === undefined || parsed === null) {
    recordWarning(
      state,
      "invalid_directive",
      `Directive "${spec.names[0]}" had an unsupported value and was ignored.`,
    );
    return false;
  }
  if (spec.multiple) {
    if (spec.key === "extraHeaders") {
      // Only the first value for a given header name wins, matching the general rule.
      const exists = state.extraHeaders.some(
        (entry) => entry.name.toLowerCase() === parsed.name.toLowerCase(),
      );
      if (!exists && state.extraHeaders.length < 32) {
        state.extraHeaders.push(parsed);
        state.sources[`header:${parsed.name.toLowerCase()}`] = source;
      }
    }
    return true;
  }

  if (state.values[spec.key] === undefined) {
    state.values[spec.key] = parsed;
    state.sources[spec.key] = source;
    return true;
  }
  return false; // Later duplicate: ignored on purpose (first match wins).
}

/**
 * Scan one string for directives with a single left-to-right pass (no backtracking).
 * A pre-check keeps pathological inputs (millions of "[" with no directive) cheap:
 * if the string holds no "=" at all, no directive can exist inside it.
 *
 * Returns the text with every recognized directive removed. Directive-only lines
 * disappear completely, and (only when something was actually removed) the result is
 * trimmed at both ends — the surrounding user text is otherwise untouched, including
 * whitespace, Markdown, code fences, emoji and combining marks.
 */
function extractDirectivesFromText(text, state, source = "body") {
  if (typeof text !== "string" || text.length === 0) {
    return { text, changed: false };
  }
  if (text.indexOf("[") === -1 || text.indexOf("=") === -1) {
    return { text, changed: false };
  }

  // Line tidying uses a sentinel; if the caller's text already contains it, skip tidying.
  const canTidy = text.indexOf(REMOVAL_MARK) === -1;

  let result = "";
  let copiedUpTo = 0;
  let changed = false;
  let searchFrom = 0;
  // Hard bound on total scanning so adversarial input stays around one pass.
  const budgetRef = { used: 0, limit: text.length + 16384 };

  for (;;) {
    const open = text.indexOf("[", searchFrom);
    if (open === -1) break;
    if (budgetRef.used > budgetRef.limit) break;

    const parsed = parseDirectiveAt(text, open, budgetRef);
    if (!parsed) {
      searchFrom = open + 1;
      continue;
    }

    // A "[key=value](…)" is a Markdown link, not a directive.
    if (text.charAt(parsed.end) === "(") {
      searchFrom = parsed.end;
      continue;
    }

    const spec = DIRECTIVE_BY_NAME.get(parsed.name.toLowerCase());
    storeDirectiveValue(state, spec, parsed.value, source);

    result += text.slice(copiedUpTo, open);
    result += canTidy ? REMOVAL_MARK : "";
    copiedUpTo = parsed.end;
    searchFrom = parsed.end;
    changed = true;
  }

  if (!changed) return { text, changed: false };
  result += text.slice(copiedUpTo);
  return { text: canTidy ? tidyRemovedText(result) : result, changed: true };
}

/**
 * Try to read one directive starting at text[start] === "[".
 * Returns { end, name, value } (end = index just past the closing "]"), or null.
 *
 * `budget` caps how many characters this window may inspect; the caller keeps a total
 * per-string budget so adversarial input (many "[name =" windows that never close)
 * cannot drive scan cost far beyond one pass over the string. Legitimate documents
 * never come near the budget: each successful window is linear in its own length and
 * the scan resumes after it.
 */
function parseDirectiveAt(text, start, budgetRef) {
  let index = start + 1;
  let char = text.charAt(index);

  const step = () => {
    index += 1;
    char = text.charAt(index);
    budgetRef.used += 1;
    if (budgetRef.used > budgetRef.limit) return false;
    return true;
  };

  while (char === " " || char === "\t") {
    if (!step()) return null;
  }

  const nameStart = index;
  while (isDirectiveNameChar(char)) {
    if (!step()) return null;
  }
  const name = text.slice(nameStart, index);
  if (name === "" || name.length > MAX_DIRECTIVE_NAME_LENGTH) return null;

  // Skip padding, then require "=" (a directive without one does not exist).
  while (char === " " || char === "\t") {
    if (!step()) return null;
  }
  if (char !== "=") return null;
  if (!step()) return null;

  while (char === " " || char === "\t") {
    if (!step()) return null;
  }

  const valueStart = index;
  while (char !== "" && char !== "]" && char !== "\r" && char !== "\n") {
    if (index - valueStart >= MAX_DIRECTIVE_VALUE_LENGTH) return null;
    if (!step()) return null;
  }
  if (char !== "]") return null;

  const value = text.slice(valueStart, index);
  if (!DIRECTIVE_BY_NAME.has(name.toLowerCase())) return null;

  return { end: index + 1, name, value };
}

/**
 * Collapse the holes left behind by removed directives:
 *   - a line that contained nothing but directives/whitespace is dropped entirely
 *   - other lines simply lose the directive text (inner spacing is preserved)
 *   - the final string is trimmed at both ends
 */
function tidyRemovedText(marked) {
  const lines = marked.split("\n");
  const kept = [];
  for (const line of lines) {
    if (line.indexOf(REMOVAL_MARK) === -1) {
      kept.push(line);
      continue;
    }
    const stripped = line.split(REMOVAL_MARK).join("");
    if (stripped.trim() === "") continue;
    kept.push(stripped);
  }
  return kept.join("\n").trim();
}

/** Directives supplied as query parameters (?provider=…&model=…). */
function extractDirectivesFromQuery(searchParams, state) {
  const consumed = [];
  for (const [name, value] of searchParams.entries()) {
    const spec = DIRECTIVE_BY_NAME.get(name.toLowerCase());
    if (!spec) continue;
    storeDirectiveValue(state, spec, value, "query");
    consumed.push(name);
  }
  return consumed;
}

/** Directives supplied as X-Relay-* headers. */
function extractDirectivesFromHeaders(headers, state, prefix) {
  for (const [rawName, value] of headers.entries()) {
    const name = rawName.toLowerCase();
    if (!name.startsWith(prefix)) continue;
    const spec = DIRECTIVE_BY_NAME.get(name.slice(prefix.length));
    if (!spec) continue;
    storeDirectiveValue(state, spec, value, "header");
  }
}

/* ========================================================================== *
 * 6b. SESSION TOKENS — sticky directives for subagents and compaction
 * ========================================================================== *
 *
 * Problem this solves: in-prompt directives only exist in the message the USER wrote.
 *   - When an AI agent spawns a subagent, the SUBAGENT'S PROMPT is written by the
 *     parent model, which does not copy the directives; the subagent's API calls hit
 *     the relay with no provider/model/key at all.
 *   - When a conversation is compacted, the history (including the directive text)
 *     is replaced by a model-written summary that may drop them.
 *
 * Fix: every response carries `X-Relay-Session: rls1_<payload>.<tag>` — a stateless,
 * signed (and optionally AES-GCM encrypted) token containing the resolved provider,
 * model, compatibility and key. Clients echo it on ANY later request via the
 * X-Relay-Session header, ?relay_session=, the relay_session cookie — or the parent
 * model can simply include the token in a subagent's prompt, where the relay
 * recognizes and strips it like any other directive. No server-side storage needed.
 *
 * Priority stays first-occurrence-wins: body > query > header > session token.
 */

const SESSION_TOKEN_PREFIX = "rls1_";
/** Bounded and linear: payload ≤ 24 KB (a long provider URL + key), tag ≤ 128 chars. */
const SESSION_TOKEN_PATTERN_SOURCE = `${SESSION_TOKEN_PREFIX}[A-Za-z0-9_-]{10,24000}\\.[A-Za-z0-9_-]{8,128}`;
const MAX_SESSION_TOKEN_CANDIDATES = 8;

function base64UrlEncodeBytes(bytes) {
  let binary = "";
  for (let index = 0; index < bytes.length; index += 1) {
    binary += String.fromCharCode(bytes[index]);
  }
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function base64UrlDecodeToBytes(text) {
  const padded = text.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (text.length % 4)) % 4);
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

async function sha256Bytes(data) {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", data));
}

async function hmacSha256(secret, message) {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(message)));
}

async function aesGcmKey(secret, usage) {
  const raw = await sha256Bytes(new TextEncoder().encode(secret));
  return crypto.subtle.importKey("raw", raw, "AES-GCM", false, [usage]);
}

/** Length-safe comparison; avoids leaking where a tag mismatched. */
function timingSafeEqualText(a, b) {
  if (a.length !== b.length) return false;
  let difference = 0;
  for (let index = 0; index < a.length; index += 1) {
    difference |= a.charCodeAt(index) ^ b.charCodeAt(index);
  }
  return difference === 0;
}

/** Build the token for everything resolved in this request (provider/model/compat/key). */
async function encodeSessionToken(state, cfg, now = Date.now()) {
  const values = state.values;
  const payload = { v: 1, e: Math.floor(now / 1000) + cfg.sessions.ttlSeconds };
  if (values.provider) payload.p = values.provider;
  if (values.model) payload.m = values.model;
  if (values.compatibility) payload.c = values.compatibility;
  if (values.reasoning) payload.r = values.reasoning;
  if (values.apiKey && cfg.sessions.includeKey) payload.k = values.apiKey;

  const jsonBytes = new TextEncoder().encode(JSON.stringify(payload));
  const secret = cfg.sessions.secret;

  if (secret) {
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const key = await aesGcmKey(secret, "encrypt");
    const ciphertext = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, jsonBytes));
    const sealed = new Uint8Array(iv.length + ciphertext.length);
    sealed.set(iv);
    sealed.set(ciphertext, iv.length);
    const payloadPart = base64UrlEncodeBytes(sealed);
    const tag = await hmacSha256(secret, payloadPart);
    return `${SESSION_TOKEN_PREFIX}${payloadPart}.${base64UrlEncodeBytes(tag.slice(0, 16))}`;
  }

  const payloadPart = base64UrlEncodeBytes(jsonBytes);
  const checksum = (await sha256Bytes(new TextEncoder().encode(`rls1|${payloadPart}`))).slice(0, 8);
  return `${SESSION_TOKEN_PREFIX}${payloadPart}.${base64UrlEncodeBytes(checksum)}`;
}

/** Verify + decode a session token. Returns the directive values, or null. */
async function decodeSessionToken(token, cfg, now = Date.now()) {
  if (typeof token !== "string" || !token.startsWith(SESSION_TOKEN_PREFIX)) return null;
  const body = token.slice(SESSION_TOKEN_PREFIX.length);
  if (body.length > 24200) return null;
  const dot = body.lastIndexOf(".");
  if (dot < 8) return null;
  const payloadPart = body.slice(0, dot);
  const tagPart = body.slice(dot + 1);
  if (payloadPart.length < 10 || tagPart.length < 8) return null;

  const secret = cfg.sessions.secret;
  let payloadBytes;

  if (secret) {
    const expectedTag = base64UrlEncodeBytes((await hmacSha256(secret, payloadPart)).slice(0, 16));
    if (!timingSafeEqualText(tagPart, expectedTag)) return null;
    const sealed = base64UrlDecodeToBytes(payloadPart);
    if (sealed.length <= 12) return null;
    try {
      const key = await aesGcmKey(secret, "decrypt");
      payloadBytes = new Uint8Array(
        await crypto.subtle.decrypt({ name: "AES-GCM", iv: sealed.slice(0, 12) }, key, sealed.slice(12)),
      );
    } catch {
      return null;
    }
  } else {
    const expectedTag = base64UrlEncodeBytes(
      (await sha256Bytes(new TextEncoder().encode(`rls1|${payloadPart}`))).slice(0, 8),
    );
    if (!timingSafeEqualText(tagPart, expectedTag)) return null;
    payloadBytes = base64UrlDecodeToBytes(payloadPart);
  }

  let payload;
  try {
    payload = JSON.parse(new TextDecoder().decode(payloadBytes));
  } catch {
    return null;
  }
  if (!isPlainObject(payload) || payload.v !== 1) return null;
  if (typeof payload.e !== "number" || payload.e * 1000 < now) return null;

  const values = {};
  if (typeof payload.p === "string" && payload.p) values.provider = payload.p;
  if (typeof payload.m === "string" && payload.m) values.model = payload.m;
  if (typeof payload.c === "string" && payload.c) {
    const compatibility = normalizeCompatibility(payload.c);
    if (compatibility) values.compatibility = compatibility;
  }
  if (typeof payload.k === "string" && payload.k) values.apiKey = payload.k;
  if (isPlainObject(payload.r)) {
    // Re-validate rather than trusting the token's shape.
    const reasoning = {};
    if (typeof payload.r.level === "string" && REASONING_LEVELS.includes(payload.r.level)) {
      reasoning.level = payload.r.level;
    }
    if (Number.isFinite(payload.r.budget) && payload.r.budget > 0) reasoning.budget = payload.r.budget;
    if (payload.r.auto === true) reasoning.auto = true;
    if (Object.keys(reasoning).length > 0) values.reasoning = reasoning;
  }
  return values;
}

/**
 * Find session tokens embedded in TEXT (e.g. a parent model pasting one into a
 * subagent's prompt). Valid tokens are recorded into `sessionState` and REMOVED from
 * the text — they carry the caller's key and must not reach the provider. Invalid
 * lookalikes are left untouched.
 */
async function stripSessionTokensFromText(text, sessionState, cfg) {
  if (typeof text !== "string" || text.length === 0 || !text.includes(SESSION_TOKEN_PREFIX)) {
    return { text, changed: false, applied: false };
  }

  const pattern = new RegExp(SESSION_TOKEN_PATTERN_SOURCE, "g");
  let result = "";
  let copiedUpTo = 0;
  let changed = false;
  let applied = false;
  let verified = 0;
  let match;

  while ((match = pattern.exec(text)) !== null) {
    const token = match[0];
    const values = await decodeSessionToken(token, cfg);
    if (!values) continue; // Not a real token: keep the text as the user wrote it.

    verified += 1;
    for (const spec of DIRECTIVE_SPECS) {
      if (spec.multiple) continue;
      const value = values[spec.key];
      if (value !== undefined && sessionState.values[spec.key] === undefined) {
        sessionState.values[spec.key] = value;
        sessionState.sources[spec.key] = "session";
      }
    }
    sessionState.found = true;
    applied = true;

    result += text.slice(copiedUpTo, match.index);
    copiedUpTo = match.index + token.length;
    changed = true;
    if (verified >= MAX_SESSION_TOKEN_CANDIDATES) break;
  }

  if (!changed) return { text, changed: false, applied: false };
  result += text.slice(copiedUpTo);
  return { text: result, changed: true, applied };
}

/** Session token from the X-Relay-Session header, ?relay_session=, or the cookie. */
async function resolveExplicitSessionToken(request, searchParams, cfg, consumedQueryParams) {
  if (!cfg.sessions.enabled) return null;

  let token = request.headers.get(cfg.sessions.headerName);
  if (!token && searchParams.has(cfg.sessions.queryName)) {
    token = searchParams.get(cfg.sessions.queryName);
    if (consumedQueryParams) consumedQueryParams.push(cfg.sessions.queryName);
  }
  if (!token && cfg.sessions.emitCookie) {
    const cookieHeader = request.headers.get("cookie");
    if (cookieHeader) {
      for (const part of cookieHeader.split(";")) {
        const equals = part.indexOf("=");
        if (equals > 0 && part.slice(0, equals).trim() === cfg.sessions.cookieName) {
          token = part.slice(equals + 1).trim();
          break;
        }
      }
    }
  }
  if (!token) return null;

  const values = await decodeSessionToken(token.trim(), cfg);
  if (!values) return null;

  const state = createDirectiveState();
  for (const spec of DIRECTIVE_SPECS) {
    if (spec.multiple) continue;
    const value = values[spec.key];
    if (value !== undefined) {
      state.values[spec.key] = value;
      state.sources[spec.key] = "session";
    }
  }
  state.found = true;
  return state;
}

/* ========================================================================== *
 * 6c. IP MEMORY — directives that stick to the caller's IP
 * ========================================================================== *
 *
 * The same problem session tokens solve, but with zero client cooperation: once an
 * IP has sent a request with directives, later requests from that IP that lack them
 * inherit the remembered provider/model/compatibility/reasoning/key. This covers
 * AI-agent subagents (fresh conversations with model-chosen prompts) and post-
 * compaction turns without any token echo.
 *
 * Precedence stays first-occurrence-wins:
 *   body > model-name flags > query > header > session token > IP memory
 *
 * SCOPE AND LIMITS, stated honestly:
 *   - Storage is this isolate's memory. On a single process (the bundled dev server)
 *     it is authoritative; on Cloudflare it is best-effort — requests may land on a
 *     different isolate in the same colo and miss the memory. When you need a hard
 *     guarantee, echo the X-Relay-Session token, which is stateless and always works.
 *   - The client IP is taken ONLY from `cf-connecting-ip`, which Cloudflare's edge
 *     sets and clients cannot spoof. X-Forwarded-For / X-Real-IP are client-supplied
 *     and would let an attacker steal another IP's remembered key, so they are
 *     ignored unless RELAY_IP_TRUST_FORWARDED is explicitly enabled (local proxies).
 *   - Everyone behind the same public IP (office NAT, VPN) shares one memory slot.
 */

const IP_MEMORY = new Map(); // ip -> { values, expiresAt }

function resolveConfiguredIpMemory(env) {
  const base = BASE_CONFIG.ipMemory;
  return {
    enabled: boolFromEnv(env.RELAY_IP_MEMORY, base.enabled),
    ttlSeconds: numFromEnv(env.RELAY_IP_MEMORY_TTL_SECONDS, base.ttlSeconds, 10),
    maxEntries: numFromEnv(env.RELAY_IP_MEMORY_MAX_ENTRIES, base.maxEntries, 1),
    includeKey: boolFromEnv(env.RELAY_IP_MEMORY_INCLUDE_KEY, base.includeKey),
    trustForwarded: boolFromEnv(env.RELAY_IP_TRUST_FORWARDED, base.trustForwardedHeaders),
  };
}

/** The caller's IP. Only edge-set headers by default; forwarded headers are opt-in. */
function resolveClientIp(request, cfg) {
  const direct = request.headers.get("cf-connecting-ip");
  if (direct && direct.trim() !== "") return direct.trim();
  if (cfg.ipMemory.trustForwarded) {
    const real = request.headers.get("x-real-ip");
    if (real && real.trim() !== "") return real.trim();
    const forwarded = request.headers.get("x-forwarded-for");
    if (forwarded) {
      const first = forwarded.split(",")[0].trim();
      if (first !== "") return first;
    }
  }
  return null;
}

/** Which resolved directive values are worth remembering for this IP. */
function ipMemoryValuesFromState(state, cfg) {
  const values = {};
  for (const key of ["provider", "model", "compatibility", "reasoning"]) {
    if (state.values[key] !== undefined) values[key] = state.values[key];
  }
  if (cfg.ipMemory.includeKey && state.values.apiKey !== undefined) {
    values.apiKey = state.values.apiKey;
  }
  return values;
}

function rememberDirectivesForIp(ip, state, cfg, now = Date.now()) {
  if (!cfg.ipMemory.enabled || !ip || !state.found) return;
  const values = ipMemoryValuesFromState(state, cfg);
  if (Object.keys(values).length === 0) return;

  if (!IP_MEMORY.has(ip) && IP_MEMORY.size >= cfg.ipMemory.maxEntries) {
    // Evict the oldest entry (Map iterates in insertion order).
    const oldest = IP_MEMORY.keys().next().value;
    IP_MEMORY.delete(oldest);
  }
  IP_MEMORY.set(ip, {
    values,
    expiresAt: now + cfg.ipMemory.ttlSeconds * 1000,
    updated: now,
  });
}

/** Recall this IP's remembered directives, refreshing the sliding TTL on a hit. */
function recallDirectivesForIp(ip, cfg, now = Date.now()) {
  if (!cfg.ipMemory.enabled || !ip) return null;
  const entry = IP_MEMORY.get(ip);
  if (!entry) return null;
  if (entry.expiresAt <= now) {
    IP_MEMORY.delete(ip);
    return null;
  }
  entry.expiresAt = now + cfg.ipMemory.ttlSeconds * 1000;

  const state = createDirectiveState();
  for (const spec of DIRECTIVE_SPECS) {
    if (spec.multiple) continue;
    const value = entry.values[spec.key];
    if (value !== undefined) {
      state.values[spec.key] = value;
      state.sources[spec.key] = "ip";
    }
  }
  state.found = true;
  return state;
}

/** Test/diagnostics helper: forget everything. */
function clearIpMemory() {
  IP_MEMORY.clear();
}

/** Test/diagnostics helper: a plain-object copy of the current memory table. */
function ipMemorySnapshot() {
  const snapshot = {};
  for (const [ip, entry] of IP_MEMORY) snapshot[ip] = entry.values;
  return snapshot;
}

/* ========================================================================== *
 * 7. JSON TRAVERSAL
 * ========================================================================== */

/** Content parts registered here lost all of their text to directive removal. */
function createTraversalContext(state, cfg) {
  return { state, cfg, mutated: false, nodes: 0, truncated: false, droppable: new WeakSet() };
}

/**
 * Recursively process a parsed JSON body.
 *
 * Only string values whose field name is a known text field are scanned/rewritten;
 * media, credential and schema fields are never touched or even descended into.
 * Traversal order is document order (object keys in insertion order, arrays by index),
 * which is what makes "first directive wins" deterministic across messages.
 */
function traverseJson(node, ctx, parentKey = null, depth = 0) {
  if (ctx.nodes++ > ctx.cfg.traversal.maxNodes || depth > ctx.cfg.traversal.maxDepth) {
    ctx.truncated = true;
    return node;
  }

  if (Array.isArray(node)) {
    const output = new Array(node.length);
    const droppable = [];
    let changedHere = false;
    for (let index = 0; index < node.length; index += 1) {
      const item = node[index];
      if (typeof item === "string") {
        // parentKey carries through nested arrays: "content": [["text [model=x]"]]
        // must be scanned just like "content": ["text [model=x]"].
        const processed =
          parentKey && TEXT_FIELD_NAMES.has(parentKey) ? processTextValue(item, ctx) : item;
        output[index] = processed;
        if (processed !== item) changedHere = true;
      } else if (item !== null && typeof item === "object") {
        const processed = traverseJson(item, ctx, parentKey, depth + 1);
        output[index] = processed;
        if (processed !== item) changedHere = true;
        if (ctx.droppable.has(processed)) droppable.push(index);
      } else {
        output[index] = item;
      }
    }
    // Parts whose only content was a directive are removed — but never every part,
    // because an empty content array is rejected by most providers.
    if (droppable.length > 0 && droppable.length < output.length) {
      return output.filter((_, index) => !droppable.includes(index));
    }
    // Copy-on-write: an untouched array is returned as-is, so protected subtrees keep
    // their exact original structure.
    return changedHere ? output : node;
  }

  if (isPlainObject(node)) {
    // A null-prototype object cannot be reached by a "__proto__" key: JSON.parse
    // creates real own properties for that key, and assigning it onto a plain {}
    // would silently mutate the prototype instead of copying the client's data.
    const output = Object.create(null);
    let changedHere = false;
    let emptiedText = false;
    for (const key of Object.keys(node)) {
      const lower = key.toLowerCase();
      const value = node[key];

      if (PROTECTED_FIELD_NAMES.has(lower)) {
        output[key] = value;
        continue;
      }

      if (typeof value === "string") {
        if (TEXT_FIELD_NAMES.has(lower)) {
          const processed = processTextValue(value, ctx);
          output[key] = processed;
          if (processed !== value) {
            changedHere = true;
            if (lower === "text" && processed === "") emptiedText = true;
          }
        } else {
          output[key] = value;
        }
        continue;
      }

      if (value !== null && typeof value === "object") {
        const processed = traverseJson(value, ctx, lower, depth + 1);
        output[key] = processed;
        if (processed !== value) changedHere = true;
        continue;
      }

      output[key] = value;
    }

    if (
      emptiedText &&
      ctx.cfg.body.dropEmptyTextParts &&
      typeof output.type === "string" &&
      TEXT_PART_TYPES.has(output.type.toLowerCase())
    ) {
      ctx.droppable.add(output);
    }
    return changedHere ? output : node;
  }
  return node;
}

function processTextValue(value, ctx) {
  if (value.length > ctx.cfg.traversal.maxStringLength) {
    ctx.truncated = true;
    return value;
  }
  const { text, changed } = extractDirectivesFromText(value, ctx.state, "body");
  if (changed) ctx.mutated = true;
  return text;
}

/**
 * Apply directive-driven changes to a parsed JSON body.
 * Only fields the user explicitly asked for are written; everything else is left as is.
 */
function applyDirectivesToJsonBody(body, state, ctx, target = {}) {
  if (!isPlainObject(body)) return body;
  const { model, stream, temperature, reasoning } = state.values;
  if (model !== undefined && body.model !== model) {
    body.model = model;
    ctx.mutated = true;
  }
  if (stream !== undefined && body.stream !== stream) {
    body.stream = stream;
    ctx.mutated = true;
  }
  if (temperature !== undefined && body.temperature !== temperature) {
    body.temperature = temperature;
    ctx.mutated = true;
  }
  if (reasoning !== undefined) {
    applyReasoningToJsonBody(body, reasoning, {
      cfg: ctx.cfg,
      state,
      compatibility: target.compatibility,
      host: target.host,
      ctx,
    });
  }
  return body;
}

/* -------------------------------------------------------------------------- *
 * Reasoning effort -> provider-specific request field
 * -------------------------------------------------------------------------- */

/** Which request shape this upstream expects for reasoning. */
function resolveReasoningStyle(cfg, compatibility, host) {
  if (!cfg.reasoning.enabled) return "off";
  if (cfg.reasoning.style !== "auto") return cfg.reasoning.style;

  const lowerHost = (host || "").toLowerCase();
  for (const [pattern, style] of REASONING_STYLE_BY_HOST) {
    if (pattern.startsWith(".") ? lowerHost.endsWith(pattern) : lowerHost === pattern) return style;
  }
  return REASONING_STYLE_BY_COMPATIBILITY[compatibility] || "effort";
}

function clampBudget(value, cfg) {
  return Math.max(cfg.reasoning.minBudgetTokens, Math.min(cfg.reasoning.maxBudgetTokens, Math.round(value)));
}

/** Nearest named level for a raw token budget (providers that only take levels). */
function levelForBudget(budget, cfg) {
  const table = cfg.reasoning.budgets;
  let best = "medium";
  let bestDistance = Infinity;
  for (const level of REASONING_LEVELS) {
    if (level === "none") continue;
    const distance = Math.abs((table[level] || 0) - budget);
    if (distance < bestDistance) {
      bestDistance = distance;
      best = level;
    }
  }
  return best;
}

/** Claude 4.7+ requires the "adaptive" shape; earlier models require a budget. */
function anthropicUsesAdaptive(model, cfg) {
  if (cfg.reasoning.anthropicMode === "adaptive") return true;
  if (cfg.reasoning.anthropicMode === "budget") return false;
  if (typeof model !== "string" || model === "") return false;

  const match = model.toLowerCase().match(/(?:^|[^0-9])(\d+)(?:[.-](\d+))?(?:[^0-9]|$)/);
  if (!match) return false;
  const major = Number.parseInt(match[1], 10);
  const minor = match[2] === undefined ? 0 : Number.parseInt(match[2], 10);
  if (!Number.isFinite(major)) return false;
  const [minMajor, minMinor] = ANTHROPIC_ADAPTIVE_MIN_VERSION;
  return major > minMajor || (major === minMajor && minor >= minMinor);
}

/**
 * Write the reasoning intent into the field the target API accepts.
 * Nested objects are merged, never replaced, so a client's own
 * `reasoning.summary` / `thinking.display` / `thinkingConfig.includeThoughts`
 * settings survive.
 */
function applyReasoningToJsonBody(body, reasoning, { cfg, state, compatibility, host, ctx }) {
  const style = resolveReasoningStyle(cfg, compatibility, host);
  if (style === "off") {
    recordWarning(
      state,
      "invalid_directive",
      `The reasoning directive was ignored: this endpoint (${compatibility}) has no reasoning parameter.`,
    );
    return;
  }
  // "default"/"auto" means "provider default", i.e. write nothing at all.
  if (reasoning.auto) return;

  const level = reasoning.level;
  const budget = reasoning.budget;
  const disable = level === "none";

  if (style === "effort") {
    // Flat string field: a numeric budget is expressed as the nearest level.
    body.reasoning_effort = level || levelForBudget(budget, cfg);
    ctx.mutated = true;
    return;
  }

  if (style === "responses") {
    const existing = isPlainObject(body.reasoning) ? body.reasoning : {};
    body.reasoning = { ...existing, effort: level || levelForBudget(budget, cfg) };
    ctx.mutated = true;
    return;
  }

  if (style === "openrouter") {
    const existing = isPlainObject(body.reasoning) ? body.reasoning : {};
    const next = { ...existing };
    // effort and max_tokens are mutually exclusive in OpenRouter's unified parameter.
    delete next.effort;
    delete next.max_tokens;
    if (budget !== undefined) next.max_tokens = clampBudget(budget, cfg);
    else next.effort = level;
    body.reasoning = next;
    ctx.mutated = true;
    return;
  }

  if (style === "glm") {
    const existing = isPlainObject(body.thinking) ? body.thinking : {};
    body.thinking = { ...existing, type: disable ? "disabled" : "enabled" };
    if (!disable) body.reasoning_effort = level || levelForBudget(budget, cfg);
    ctx.mutated = true;
    return;
  }

  if (style === "gemini") {
    const generationConfig = isPlainObject(body.generationConfig) ? body.generationConfig : {};
    const thinkingConfig = isPlainObject(generationConfig.thinkingConfig)
      ? { ...generationConfig.thinkingConfig }
      : {};
    if (cfg.reasoning.geminiField === "thinkingLevel" && !disable) {
      // Newer Gemini generations take a named level instead of a token budget.
      thinkingConfig.thinkingLevel = level === "max" || level === "xhigh" ? "high" : level || "medium";
      delete thinkingConfig.thinkingBudget;
    } else {
      thinkingConfig.thinkingBudget = disable
        ? 0
        : budget !== undefined
          ? clampBudget(budget, cfg)
          : cfg.reasoning.geminiBudgets[level] ?? cfg.reasoning.geminiBudgets.medium;
      delete thinkingConfig.thinkingLevel;
    }
    body.generationConfig = { ...generationConfig, thinkingConfig };
    ctx.mutated = true;
    return;
  }

  if (style === "anthropic") {
    applyAnthropicThinking(body, { level, budget, disable, cfg, state, ctx });
  }
}

/**
 * Claude has three shapes and hard numeric rules:
 *   { type:"disabled" }
 *   { type:"enabled", budget_tokens }  — budget ≥ 1024 AND < max_tokens
 *   { type:"adaptive" } + output_config.effort  — required from Claude 4.7 on
 */
function applyAnthropicThinking(body, { level, budget, disable, cfg, state, ctx }) {
  const existing = isPlainObject(body.thinking) ? body.thinking : {};
  const keepDisplay = typeof existing.display === "string" ? { display: existing.display } : {};

  if (disable) {
    body.thinking = { type: "disabled" };
    ctx.mutated = true;
    return;
  }

  if (anthropicUsesAdaptive(body.model, cfg)) {
    body.thinking = { type: "adaptive", ...keepDisplay };
    const outputConfig = isPlainObject(body.output_config) ? { ...body.output_config } : {};
    // Claude's adaptive vocabulary has no "minimal"; it starts at "low".
    const effort = level || levelForBudget(budget, cfg);
    outputConfig.effort = effort === "minimal" ? "low" : effort;
    body.output_config = outputConfig;
    ctx.mutated = true;
    return;
  }

  const maxTokens = Number.isFinite(body.max_tokens) ? body.max_tokens : null;
  let resolved;
  if (budget !== undefined) {
    resolved = clampBudget(budget, cfg);
  } else if (maxTokens !== null) {
    const ratio = cfg.reasoning.ratios[level] ?? cfg.reasoning.ratios.medium;
    resolved = clampBudget(maxTokens * ratio, cfg);
  } else {
    resolved = clampBudget(cfg.reasoning.budgets[level] ?? cfg.reasoning.budgets.medium, cfg);
  }

  if (maxTokens !== null) {
    // Thinking tokens count against max_tokens, so the answer needs room.
    if (maxTokens <= cfg.reasoning.minBudgetTokens) {
      recordWarning(
        state,
        "invalid_directive",
        "The reasoning directive was ignored: max_tokens is too small to fit a thinking budget.",
      );
      return;
    }
    resolved = Math.min(resolved, maxTokens - 1);
  }

  body.thinking = { type: "enabled", budget_tokens: resolved, ...keepDisplay };
  ctx.mutated = true;
}

/* ========================================================================== *
 * 8. REQUEST BODY PREPARATION
 * ========================================================================== */

function parseContentType(headerValue) {
  const raw = (headerValue || "").trim();
  if (!raw) return { mediaType: "", parameters: "" };
  const semicolon = raw.indexOf(";");
  const mediaType = (semicolon === -1 ? raw : raw.slice(0, semicolon)).trim().toLowerCase();
  return { mediaType, parameters: semicolon === -1 ? "" : raw.slice(semicolon + 1) };
}

function isJsonMediaType(mediaType) {
  return (
    mediaType === "application/json" ||
    mediaType === "text/json" ||
    mediaType.endsWith("+json")
  );
}
function contentLengthOf(request) {
  const raw = request.headers.get("Content-Length");
  if (!raw) return null;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

/**
 * Read the request body with a hard byte cap that is enforced DURING the read, not
 * after it: a client that lies about Content-Length (or sends no length at all) can
 * otherwise make the Worker buffer an unbounded stream. Returns
 *   { bytes }                  - body is at most `limit` bytes
 *   { stream, bufferedBytes }  - the cap was exceeded; `bufferedBytes` were consumed
 *                                and must be prepended to the remaining stream
 */
async function readBodyWithCap(request, limit) {
  const reader = request.body.getReader();
  const chunks = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    total += value.byteLength;
    if (total > limit) {
      return {
        stream: new ReadableStream({
          start(controller) {
            for (const chunk of chunks) controller.enqueue(chunk);
          },
          async pull(controller) {
            try {
              const { done: innerDone, value: innerValue } = await reader.read();
              if (innerDone) controller.close();
              else controller.enqueue(innerValue);
            } catch (error) {
              controller.error(error);
            }
          },
          cancel(reason) {
            return reader.cancel(reason);
          },
        }),
        bufferedBytes: total,
      };
    }
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { bytes };
}

/**
 * Turn the incoming request body into something we can (a) inspect for directives and
 * (b) hand to fetch() as many times as a retry loop needs.
 *
 * Returns { body, contentTypeOverride, retryable, kind, error }.
 *   body                - string | ArrayBuffer | FormData | ReadableStream | null
 *   contentTypeOverride - null (keep client value) | undefined (delete it, FormData)
 *   retryable           - false for one-shot streams: those cannot be replayed
 */
async function prepareRequestBody(request, state, cfg) {
  const method = request.method.toUpperCase();
  if (method === "GET" || method === "HEAD" || request.body === null) {
    return { body: null, retryable: true, kind: "none", mutated: false };
  }

  const { mediaType } = parseContentType(request.headers.get("Content-Type"));
  const declaredLength = contentLengthOf(request);

  // ---- JSON ------------------------------------------------------------------
  if (isJsonMediaType(mediaType)) {
    // Read with a hard cap enforced during the read (Content-Length can lie or be
    // absent). Oversized JSON is forwarded opaquely in a single attempt.
    if (declaredLength === null || declaredLength <= cfg.body.maxJsonParseBytes) {
      const read = await readBodyWithCap(request, cfg.body.maxJsonParseBytes);
      if (read.stream) {
        return {
          body: read.stream,
          retryable: false,
          kind: "json-oversize-stream",
          mutated: false,
        };
      }
      let raw = new TextDecoder().decode(read.bytes);
      if (raw.trim() === "") {
        return { body: raw, retryable: true, kind: "json-empty", mutated: false };
      }

      // Session tokens pasted into the prompt text are pulled out before parsing.
      const textSessionState = createDirectiveState();
      if (cfg.sessions.enabled) {
        const stripped = await stripSessionTokensFromText(raw, textSessionState, cfg);
        if (stripped.changed) raw = stripped.text;
      }

      let parsed;
      try {
        parsed = JSON.parse(raw);
      } catch {
        return {
          error: { code: "invalid_json", message: "The request body could not be parsed as JSON." },
        };
      }

      const ctx = createTraversalContext(state, cfg);
      const processed = traverseJson(parsed, ctx);
      // Directive-driven field writes happen later, once query/header fallbacks are known.
      // The raw body may have had session tokens removed, so "untouched" still means
      // forwarding the cleaned raw text, not the original bytes.
      return {
        json: processed,
        raw,
        retryable: true,
        kind: "json",
        mutated: ctx.mutated,
        textSessionState,
        bodyModel: isPlainObject(parsed) && typeof parsed.model === "string" ? parsed.model : undefined,
      };
    }
    return await bufferOpaqueBody(request, cfg, "json-oversize");
  }
  // ---- multipart/form-data (speech-to-text, file uploads, image edits) --------
  if (mediaType === "multipart/form-data") {
    if (declaredLength !== null && declaredLength > cfg.body.maxMultipartParseBytes) {
      return await bufferOpaqueBody(request, cfg, "multipart-oversize");
    }
    let formData;
    try {
      formData = await request.formData();
    } catch {
      // Unparseable multipart: stay transparent instead of failing the request.
      return await bufferOpaqueBody(request, cfg, "multipart-unparsed");
    }

    const rebuilt = new FormData();
    let mutated = false;
    const textSessionState = createDirectiveState();
    for (const [name, value] of formData.entries()) {
      if (typeof value === "string") {
        let fieldValue = value;
        if (cfg.sessions.enabled) {
          const stripped = await stripSessionTokensFromText(fieldValue, textSessionState, cfg);
          if (stripped.changed) {
            fieldValue = stripped.text;
            mutated = true;
          }
        }
        if (FORM_TEXT_FIELD_NAMES.has(name.toLowerCase())) {
          const { text, changed } = extractDirectivesFromText(fieldValue, state, "body");
          if (changed) mutated = true;
          rebuilt.append(name, text);
        } else {
          rebuilt.append(name, fieldValue);
        }
      } else {
        // File / Blob parts are appended untouched, filename included.
        rebuilt.append(name, value, value.name);
      }
    }

    // The old boundary no longer matches the rebuilt body: let fetch() regenerate it.
    return {
      formData: rebuilt,
      dropContentType: true,
      retryable: true,
      kind: "multipart",
      mutated,
      textSessionState,
    };
  }
  // ---- application/x-www-form-urlencoded --------------------------------------
  if (mediaType === "application/x-www-form-urlencoded") {
    if (declaredLength === null || declaredLength <= cfg.body.maxTextParseBytes) {
      const read = await readBodyWithCap(request, cfg.body.maxTextParseBytes);
      if (read.stream) {
        return { body: read.stream, retryable: false, kind: "urlencoded-oversize-stream", mutated: false };
      }
      const raw = new TextDecoder().decode(read.bytes);
      const textSessionState = createDirectiveState();
      let cleanedRaw = raw;
      if (cfg.sessions.enabled) {
        const stripped = await stripSessionTokensFromText(cleanedRaw, textSessionState, cfg);
        if (stripped.changed) cleanedRaw = stripped.text;
      }
      const params = new URLSearchParams(cleanedRaw);
      const rebuilt = new URLSearchParams();
      let mutated = cleanedRaw !== raw;
      for (const [name, value] of params.entries()) {
        if (FORM_TEXT_FIELD_NAMES.has(name.toLowerCase())) {
          const { text, changed } = extractDirectivesFromText(value, state, "body");
          if (changed) mutated = true;
          rebuilt.append(name, text);
        } else {
          rebuilt.append(name, value);
        }
      }
      return { params: rebuilt, raw: cleanedRaw, retryable: true, kind: "urlencoded", mutated, textSessionState };
    }
    return await bufferOpaqueBody(request, cfg, "urlencoded-oversize");
  }

  // ---- text/* ------------------------------------------------------------------
  if (mediaType.startsWith("text/")) {
    if (declaredLength === null || declaredLength <= cfg.body.maxTextParseBytes) {
      const read = await readBodyWithCap(request, cfg.body.maxTextParseBytes);
      if (read.stream) {
        return { body: read.stream, retryable: false, kind: "text-oversize-stream", mutated: false };
      }
      const raw = new TextDecoder().decode(read.bytes);
      const textSessionState = createDirectiveState();
      let working = raw;
      if (cfg.sessions.enabled) {
        const stripped = await stripSessionTokensFromText(working, textSessionState, cfg);
        if (stripped.changed) working = stripped.text;
      }
      const { text, changed } = extractDirectivesFromText(working, state, "body");
      const sessionChanged = working !== raw;
      return {
        body: changed || sessionChanged ? text : raw,
        retryable: true,
        kind: "text",
        mutated: changed || sessionChanged,
        textSessionState,
      };
    }
    return await bufferOpaqueBody(request, cfg, "text-oversize");
  }

  // ---- anything else: binary / unknown / streaming -----------------------------
  return await bufferOpaqueBody(request, cfg, "opaque");
}

/**
 * Bodies we do not understand are never decoded. They are buffered when they fit the
 * cap (so retries remain possible) and streamed straight through once they do not —
 * in which case the request becomes single-attempt, because a ReadableStream cannot
 * be replayed. The cap is enforced on the bytes actually read: a forged or missing
 * Content-Length can never make the Worker buffer more than the configured maximum.
 */
async function bufferOpaqueBody(request, cfg, kind) {
  const limit = cfg.body.maxOpaqueBufferBytes;
  if (limit > 0 && request.body !== null) {
    const read = await readBodyWithCap(request, limit);
    if (!read.stream) {
      return { body: read.bytes.buffer, retryable: true, kind, mutated: false };
    }
    return {
      body: read.stream,
      retryable: false,
      kind: `${kind}-oversize-stream`,
      mutated: false,
    };
  }
  return { body: request.body, retryable: false, kind: `${kind}-stream`, mutated: false };
}
/* ========================================================================== *
 * 9. COMPATIBILITY DETECTION
 * ========================================================================== */

/** Guess the compatibility mode from the incoming path when no directive was given. */
function detectCompatibilityFromPath(pathname) {
  const path = (pathname || "").toLowerCase().replace(/\/+$/, "");
  if (!path) return null;
  for (const [suffix, compatibility] of PATH_COMPATIBILITY_RULES) {
    if (path.endsWith(suffix)) return compatibility;
  }
  return null;
}

function resolveCompatibility(state, pathname) {
  if (state.values.compatibility) {
    return { compatibility: state.values.compatibility, source: "directive" };
  }
  const detected = detectCompatibilityFromPath(pathname);
  if (detected) return { compatibility: detected, source: "path" };
  return { compatibility: "generic", source: "default" };
}

/* ========================================================================== *
 * 10. PROVIDER URL VALIDATION + SSRF PROTECTION
 * ========================================================================== */

/** Parse dotted, decimal, octal and hex IPv4 notations into 32-bit numbers. */
function parseIPv4(host) {
  const parts = host.split(".");
  if (parts.length === 0 || parts.length > 4) return null;

  const values = [];
  for (const part of parts) {
    if (part === "") return null;
    let value;
    if (/^0[xX][0-9a-fA-F]+$/.test(part)) value = Number.parseInt(part.slice(2), 16);
    else if (/^0[0-7]+$/.test(part)) value = Number.parseInt(part.slice(1), 8);
    else if (/^[0-9]+$/.test(part)) value = Number.parseInt(part, 10);
    else return null;
    if (!Number.isFinite(value) || value < 0) return null;
    values.push(value);
  }

  // 1.2.3.4 | 1.2.3 (last part = 16 bits) | 1.2 (last = 24 bits) | 1 (32 bits)
  const last = values.pop();
  const shift = 8 * (4 - values.length);
  if (last >= 2 ** shift) return null;
  let result = last;
  for (let index = 0; index < values.length; index += 1) {
    if (values[index] > 255) return null;
    result += values[index] * 2 ** (8 * (3 - index));
  }
  return result >>> 0;
}
function ipv4InCidr(ip, network, prefix) {
  const base = parseIPv4(network);
  if (base === null) return false;
  if (prefix === 0) return true;
  const mask = (0xffffffff << (32 - prefix)) >>> 0;
  return (ip & mask) >>> 0 === (base & mask) >>> 0;
}

function isBlockedIPv4(ip) {
  return BLOCKED_IPV4_CIDRS.some(([network, prefix]) => ipv4InCidr(ip, network, prefix));
}

/** Expand an IPv6 literal (with optional ::, optional trailing IPv4) into 8 groups. */
function parseIPv6(host) {
  let text = host;
  if (text.startsWith("[") && text.endsWith("]")) text = text.slice(1, -1);
  if (text.includes("%")) text = text.slice(0, text.indexOf("%"));
  if (!text.includes(":")) return null;
  if (text.indexOf("::") !== text.lastIndexOf("::")) return null;

  const toGroups = (side) => {
    const groups = [];
    if (side === "") return groups;
    for (const token of side.split(":")) {
      if (token === "") return null;
      if (token.includes(".")) {
        const ipv4 = parseIPv4(token);
        if (ipv4 === null) return null;
        groups.push((ipv4 >>> 16) & 0xffff, ipv4 & 0xffff);
        continue;
      }
      if (!/^[0-9a-fA-F]{1,4}$/.test(token)) return null;
      groups.push(Number.parseInt(token, 16));
    }
    return groups;
  };

  const doubleColon = text.indexOf("::");
  const head = toGroups(doubleColon === -1 ? text : text.slice(0, doubleColon));
  const tail = doubleColon === -1 ? [] : toGroups(text.slice(doubleColon + 2));
  if (head === null || tail === null) return null;

  const missing = 8 - head.length - tail.length;
  if (doubleColon === -1) return missing === 0 ? head : null;
  if (missing < 0) return null;
  return [...head, ...new Array(missing).fill(0), ...tail];
}
function isBlockedIPv6(groups) {
  const [g0, g1] = groups;
  const isZeroPrefix = groups.slice(0, 5).every((group) => group === 0);

  // ::  and  ::1
  if (groups.every((group) => group === 0)) return true;
  if (isZeroPrefix && groups[5] === 0 && groups[6] === 0 && groups[7] === 1) return true;
  // ::ffff:a.b.c.d  (IPv4-mapped)  and  ::a.b.c.d  (deprecated IPv4-compatible)
  if (isZeroPrefix && (groups[5] === 0xffff || groups[5] === 0)) {
    const ipv4 = ((groups[6] << 16) | groups[7]) >>> 0;
    if (isBlockedIPv4(ipv4)) return true;
  }
  // 64:ff9b::/96 NAT64 and 2002::/16 6to4 both embed an IPv4 address.
  if (g0 === 0x0064 && g1 === 0xff9b) {
    const ipv4 = ((groups[6] << 16) | groups[7]) >>> 0;
    if (isBlockedIPv4(ipv4)) return true;
  }
  if (g0 === 0x2002) {
    const ipv4 = ((g1 << 16) | groups[2]) >>> 0;
    if (isBlockedIPv4(ipv4)) return true;
  }
  if ((g0 & 0xfe00) === 0xfc00) return true; // fc00::/7 unique-local
  if ((g0 & 0xffc0) === 0xfe80) return true; // fe80::/10 link-local
  if ((g0 & 0xffc0) === 0xfec0) return true; // fec0::/10 site-local (deprecated)
  if (g0 === 0x0100 && g1 === 0) return true; // 100::/64 discard-only
  return false;
}

/**
 * Hostname-level SSRF filter. Returns a human-readable reason when the host must not
 * be contacted, or null when it looks acceptable.
 *
 * LIMITATION: this inspects the literal host only. A public DNS name that resolves to
 * a private address (DNS rebinding) cannot be detected from inside a Worker, because
 * Workers cannot resolve names or pin a connection to an address. Use
 * CONFIG.providerAllowlist when you need a hard guarantee.
 */
function findBlockedHostReason(hostname, cfg) {
  // Strip ALL trailing dots: "127.0.0.1.." and "localhost.." are the same host and
  // must not slip past an exact/suffix check that only trims one dot.
  let host = hostname.toLowerCase().replace(/\.+$/, "");
  if (host === "") return "empty hostname";

  const isIPv6Literal = hostname.startsWith("[") || host.includes(":");
  if (isIPv6Literal) {
    const groups = parseIPv6(host);
    if (!groups) return "malformed IPv6 literal";
    if (cfg.security.blockPrivateNetworks && isBlockedIPv6(groups)) {
      return "IPv6 loopback/link-local/private address";
    }
    return null;
  }

  const ipv4 = parseIPv4(host);
  if (ipv4 !== null) {
    if (cfg.security.blockPrivateNetworks && isBlockedIPv4(ipv4)) {
      return "loopback/private/link-local IPv4 address";
    }
    return null;
  }

  if (!cfg.security.blockPrivateNetworks) return null;

  if (BLOCKED_HOST_EXACT.has(host)) return "internal hostname";
  if (BLOCKED_HOST_SUFFIXES.some((suffix) => host.endsWith(suffix))) return "internal domain suffix";
  // A single-label name can only be an intranet host (there is no public TLD-only host).
  if (!host.includes(".")) return "single-label (intranet) hostname";
  return null;
}

function matchesAllowlist(hostname, allowlist) {
  const host = hostname.toLowerCase().replace(/\.$/, "");
  return allowlist.some((entry) => {
    if (entry.startsWith("*.")) {
      const suffix = entry.slice(1); // ".example.com"
      return host.endsWith(suffix) || host === entry.slice(2);
    }
    return host === entry;
  });
}

/**
 * Validate a [provider=...] value.
 * Returns { url } on success or { error: { code, message } } on rejection.
 */
function validateProviderUrl(rawValue, cfg) {
  const raw = String(rawValue).trim();
  if (!raw) {
    return { error: { code: "missing_provider", message: "The provider directive was empty." } };
  }

  let candidate = raw;
  if (!/^[a-z][a-z0-9+.-]*:/i.test(candidate)) {
    // Accept "api.example.com/v1" as a convenience, but only when it really looks
    // like a host: anything else (e.g. "hello") stays an invalid provider.
    if (/^[a-z0-9._~%-]+\.[a-z]{2,}(:\d+)?([/?#]|$)/i.test(candidate)) {
      candidate = `https://${candidate}`;
    } else {
      return {
        error: {
          code: "invalid_provider",
          message: "The provider directive is not a valid absolute URL.",
        },
      };
    }
  }
  let url;
  try {
    url = new URL(candidate);
  } catch {
    return {
      error: { code: "invalid_provider", message: "The provider directive is not a valid URL." },
    };
  }

  const allowedProtocols = cfg.allowHttpProviders ? ["https:", "http:"] : ["https:"];
  if (!allowedProtocols.includes(url.protocol)) {
    return {
      error: {
        code: "invalid_provider",
        message: `Unsupported provider protocol "${url.protocol}". Only ${allowedProtocols.join(", ")} are allowed.`,
      },
    };
  }

  if (cfg.security.blockUrlCredentials && (url.username || url.password)) {
    return {
      error: {
        code: "invalid_provider",
        message: "Provider URLs must not embed credentials (user:password@host).",
      },
    };
  }

  // The private/internal-host policy applies in every mode: being on the allowlist
  // must not re-open loopback, RFC1918 or metadata addresses.
  const blockedReason = findBlockedHostReason(url.hostname, cfg);
  if (blockedReason) {
    return {
      error: {
        code: "blocked_provider",
        message: `The provider host is not reachable through this relay (${blockedReason}).`,
      },
    };
  }

  if (cfg.providerAllowlist.length > 0) {
    if (!matchesAllowlist(url.hostname, cfg.providerAllowlist)) {
      return {
        error: {
          code: "blocked_provider",
          message: "This relay is configured with a provider allowlist and that host is not on it.",
        },
      };
    }
    return { url };
  }

  return { url };
}
/* ========================================================================== *
 * 11. PATH JOINING
 * ========================================================================== */

const VERSION_SEGMENT = /^v\d+(?:[a-z]+\d*)?$/i;

function splitPath(pathname) {
  return (pathname || "").split("/").filter((segment) => segment !== "");
}

/**
 * Join the provider base path with the incoming Worker path.
 *
 *   base …/v1        + /v1/chat/completions  -> …/v1/chat/completions      (overlap)
 *   base …/api/v1    + /v1/messages          -> …/api/v1/messages          (overlap)
 *   base …/v1beta/openai + /v1/chat/completions -> …/v1beta/openai/chat/completions
 *   base (no path)   + /v1/chat/completions  -> /v1/chat/completions
 *
 * `mode` is "smart" (default), "drop" (always drop a leading version segment) or
 * "keep" (overlap collapsing only).
 */
function joinProviderPath(basePathname, incomingPathname, mode = "smart") {
  const baseSegments = splitPath(basePathname);
  let incomingSegments = splitPath(incomingPathname);

  // 1. Collapse the longest overlap between the tail of the base and the head of the path.
  let overlap = 0;
  const maxOverlap = Math.min(baseSegments.length, incomingSegments.length);
  for (let size = maxOverlap; size >= 1; size -= 1) {
    const baseTail = baseSegments.slice(baseSegments.length - size);
    const incomingHead = incomingSegments.slice(0, size);
    if (baseTail.every((segment, index) => segment.toLowerCase() === incomingHead[index].toLowerCase())) {
      overlap = size;
      break;
    }
  }
  if (overlap > 0) {
    incomingSegments = incomingSegments.slice(overlap);
  } else if (
    incomingSegments.length > 0 &&
    VERSION_SEGMENT.test(incomingSegments[0]) &&
    (mode === "drop" ||
      (mode === "smart" && baseSegments.some((segment) => VERSION_SEGMENT.test(segment))))
  ) {
    // 2. The base already carries its own API version, so the client's /v1 is noise.
    incomingSegments = incomingSegments.slice(1);
  }

  const segments = [...baseSegments, ...incomingSegments];
  if (segments.length === 0) return "/";
  const trailingSlash = incomingPathname.length > 1 && incomingPathname.endsWith("/");
  return `/${segments.join("/")}${trailingSlash ? "/" : ""}`;
}
/** Compose the final upstream URL: path join + query merge. */
function buildTargetUrl({ providerUrl, incomingUrl, cfg, compatibility, consumedQueryParams }) {
  let incomingPath = incomingUrl.pathname;
  if (cfg.stripPathPrefix) {
    // Only strip on a path boundary: with prefix "/relay", "/relay/x" becomes "/x"
    // but "/relayhouse/x" must keep its first segment.
    const withSlash = cfg.stripPathPrefix.endsWith("/") ? cfg.stripPathPrefix : `${cfg.stripPathPrefix}/`;
    if (incomingPath === cfg.stripPathPrefix) {
      incomingPath = "/";
    } else if (incomingPath.startsWith(withSlash)) {
      incomingPath = incomingPath.slice(withSlash.length - 1);
    }
  }

  const compatSpec = COMPATIBILITY_SPECS[compatibility] || COMPATIBILITY_SPECS.generic;
  if (
    splitPath(incomingPath).length === 0 &&
    cfg.paths.useCompatibilityDefaultEndpoint &&
    compatSpec.defaultEndpoint
  ) {
    incomingPath = compatSpec.defaultEndpoint;
  }

  const mode = compatSpec.versionPrefixMode || cfg.paths.versionPrefixMode;
  const target = new URL(providerUrl.toString());
  target.pathname = joinProviderPath(providerUrl.pathname, incomingPath, mode);
  target.hash = "";

  // Query: provider-base params are kept (e.g. Azure api-version) but the caller's
  // own params win for any name they both use. Consumed relay params are dropped.
  const consumed = new Set(consumedQueryParams || []);
  const params = new URLSearchParams(providerUrl.search);
  const incomingNames = new Set();
  for (const name of incomingUrl.searchParams.keys()) {
    if (!consumed.has(name)) incomingNames.add(name);
  }
  for (const name of incomingNames) params.delete(name);
  for (const [name, value] of incomingUrl.searchParams.entries()) {
    if (!consumed.has(name)) params.append(name, value);
  }
  const search = params.toString();
  target.search = search ? `?${search}` : "";
  return target;
}

/* ========================================================================== *
 * 12. AUTHENTICATION HEADERS
 * ========================================================================== */

/**
 * Precedence: [key=...] directive > caller's own Authorization / x-api-key > nothing.
 * A missing key never produces "Bearer undefined" or an empty header — free providers
 * must be reachable with no authentication at all.
 */
function applyAuthHeaders(headers, { apiKey, compatibility, cfg }) {
  const compatSpec = COMPATIBILITY_SPECS[compatibility] || COMPATIBILITY_SPECS.generic;
  const style = compatSpec.authStyle || "bearer";
  if (apiKey) {
    // The directive replaces whatever the client sent, in every style.
    headers.delete("Authorization");
    headers.delete("x-api-key");
    headers.delete("x-goog-api-key");
    headers.delete("api-key");
    if (style === "anthropic") headers.set("x-api-key", apiKey);
    else if (style === "google") headers.set("x-goog-api-key", apiKey);
    else if (style === "azure") headers.set("api-key", apiKey);
    else headers.set("Authorization", `Bearer ${apiKey}`);
  } else if (!cfg.security.forwardIncomingAuth) {
    headers.delete("Authorization");
    headers.delete("x-api-key");
    headers.delete("x-goog-api-key");
    headers.delete("api-key");
  }

  // Anthropic rejects requests without a version header; only add it if absent.
  if (style === "anthropic" && !headers.has("anthropic-version")) {
    headers.set("anthropic-version", "2023-06-01");
  }
  return headers;
}

/* ========================================================================== *
 * 13. HEADER SANITIZATION
 * ========================================================================== */

function isStrippedRequestHeader(name, cfg) {
  if (STRIPPED_REQUEST_HEADERS.has(name)) {
    // Cookies are only stripped when the policy says so; the rest is transport noise.
    if (name === "cookie") return cfg.security.stripCookies;
    return true;
  }
  return STRIPPED_REQUEST_PREFIXES.some((prefix) => name.startsWith(prefix));
}

/**
 * Build the upstream request headers: keep everything meaningful (Accept, Content-Type,
 * User-Agent, OpenAI-*, Anthropic-*, Idempotency-Key, …), drop hop-by-hop and
 * Cloudflare-internal headers, then apply directive headers and auth.
 */
function buildUpstreamHeaders(request, { cfg, state, compatibility, dropContentType, isWebSocket }) {
  const headers = new Headers();
  for (const [rawName, value] of request.headers.entries()) {
    const name = rawName.toLowerCase();
    if (isStrippedRequestHeader(name, cfg)) {
      // WebSocket upgrades are the one case where the transport headers must survive.
      if (!(isWebSocket && (name === "connection" || name === "upgrade"))) continue;
    }
    headers.set(rawName, value);
  }
  if (dropContentType) {
    // FormData was rebuilt: fetch() must pick the new multipart boundary itself.
    headers.delete("Content-Type");
  }

  for (const entry of state.extraHeaders) headers.set(entry.name, entry.value);

  applyAuthHeaders(headers, { apiKey: state.values.apiKey, compatibility, cfg });

  if (cfg.idempotency.generate && !headers.has(cfg.idempotency.headerName)) {
    headers.set(cfg.idempotency.headerName, crypto.randomUUID());
  }
  return headers;
}

/**
 * Copy upstream response headers, minus hop-by-hop ones.
 *
 * `Content-Length` and `Content-Encoding` are dropped on purpose: the runtime may
 * transparently decompress the upstream body, and forwarding a stale length or
 * encoding alongside a stream would corrupt the response for clients that honor them.
 */
function sanitizeResponseHeaders(upstreamHeaders) {
  const headers = new Headers();
  const setCookie =
    typeof upstreamHeaders.getSetCookie === "function" ? upstreamHeaders.getSetCookie() : null;
  for (const [rawName, value] of upstreamHeaders.entries()) {
    const name = rawName.toLowerCase();
    if (STRIPPED_RESPONSE_HEADERS.has(name)) continue;
    if (name === "content-length" || name === "content-encoding") continue;
    if (name === "set-cookie") continue; // handled below, one header per cookie
    headers.append(rawName, value);
  }
  if (setCookie) {
    for (const cookie of setCookie) headers.append("Set-Cookie", cookie);
  }
  return headers;
}

/* ========================================================================== *
 * 14. RETRY CALCULATIONS
 * ========================================================================== */

function isRetryableStatus(status, cfg) {
  if (status === 409) return cfg.retries.retry409;
  return cfg.retries.retryStatuses.has(status);
}

/**
 * Fetch-level failures worth another attempt (connection resets, TLS flakiness,
 * upstream hangups). Client aborts and the Cloudflare subrequest ceiling are
 * explicitly *not* retryable.
 *
 * ENOTFOUND is also not retried: a hostname that authoritatively does not exist is a
 * configuration mistake, and looping on it turns a typo into an endless retry storm.
 * Transient resolver outages surface as EAI_AGAIN and stay retryable.
 */
function classifyFetchError(error) {
  const name = error && error.name ? String(error.name) : "";
  const message = error && error.message ? String(error.message) : String(error);
  const lower = message.toLowerCase();
  const cause = error && error.cause;
  const causeCode = cause && cause.code ? String(cause.code).toUpperCase() : "";
  const causeText = cause && cause.message ? String(cause.message).toLowerCase() : "";

  if (name === "AbortError" || lower.includes("aborted")) return "aborted";
  if (lower.includes("relay attempt timeout")) return "timeout";
  if (causeCode === "ENOTFOUND" || causeText.includes("enotfound") || lower.includes("enotfound")) {
    return "dns_not_found";
  }
  if (lower.includes("too many subrequests")) return "subrequest_limit";
  if (lower.includes("daily request limit") || lower.includes("exceeded cpu")) return "fatal";
  return "retryable";
}

function computeBackoffDelay(attempt, cfg) {
  const exponential = cfg.retries.baseDelayMs * 2 ** Math.max(0, attempt - 1);
  const capped = Math.min(cfg.retries.maxDelayMs, exponential);
  // Full jitter: uniform in [0, capped]. Prevents synchronized retry storms.
  const delay = cfg.retries.jitter ? Math.floor(Math.random() * capped) : capped;
  return Math.max(delay, Math.min(cfg.retries.minDelayMs, cfg.retries.maxDelayMs));
}

/** Redirects the relay follows itself so that every hop is SSRF-checked. */
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

function applyDelayFloor(ms, cfg) {
  return Math.max(ms, Math.min(cfg.retries.minDelayMs, cfg.retries.maxDelayMs));
}

/**
 * Resolve a Location header and re-run the provider policy on it. Cloudflare's own
 * redirect following would skip those checks, which would turn any public provider
 * into an SSRF bounce to a private address.
 */
function resolveRedirectTarget(location, baseUrl, cfg) {
  let resolved;
  try {
    resolved = new URL(location, baseUrl);
  } catch {
    return null;
  }
  const validated = validateProviderUrl(resolved.toString(), cfg);
  return validated.error ? null : validated.url;
}

/**
 * Produce the RequestInit for the next hop, or null when the redirect cannot be
 * followed (a one-shot stream body cannot be replayed for a 307/308).
 * On a cross-origin hop the auth and cookie headers are dropped, matching what
 * standard fetch does — otherwise an open redirect on the provider would leak the
 * caller's API key to a third-party host.
 */
function rewriteInitForRedirect(init, status, retryableBody, crossOrigin) {
  const method = (init.method || "GET").toUpperCase();
  const switchToGet = status === 303 || ((status === 301 || status === 302) && method === "POST");

  if (switchToGet) {
    const headers = new Headers(init.headers);
    if (crossOrigin) stripAuthHeaders(headers);
    headers.delete("Content-Type");
    const next = { ...init, method: method === "HEAD" ? "HEAD" : "GET", headers };
    delete next.body;
    delete next.duplex;
    return next;
  }

  const headers = new Headers(init.headers);
  if (crossOrigin) stripAuthHeaders(headers);
  const hasBody = init.body !== undefined && init.body !== null;
  if (hasBody && !retryableBody) return null;
  return { ...init, headers };
}

/** Credentials must never follow a redirect to a different origin. */
function stripAuthHeaders(headers) {
  headers.delete("Authorization");
  headers.delete("x-api-key");
  headers.delete("x-goog-api-key");
  headers.delete("api-key");
  headers.delete("Cookie");
}

/* ========================================================================== *
 * 15. RETRY-AFTER PARSER
 * ========================================================================== */

/** Supports both `Retry-After: 12` and `Retry-After: <HTTP-date>`. */
function parseRetryAfter(headerValue, cfg, now = Date.now()) {
  if (!cfg.retries.honorRetryAfter || !headerValue) return null;
  const raw = String(headerValue).trim();
  if (raw === "") return null;

  if (/^\d+(\.\d+)?$/.test(raw)) {
    const seconds = Number.parseFloat(raw);
    if (!Number.isFinite(seconds) || seconds < 0) return null;
    return Math.min(seconds * 1000, cfg.retries.maxRetryAfterMs);
  }

  const timestamp = Date.parse(raw);
  if (!Number.isFinite(timestamp)) return null;
  const delta = timestamp - now;
  if (delta <= 0) return 0;
  return Math.min(delta, cfg.retries.maxRetryAfterMs);
}

/* ========================================================================== *
 * 16. UPSTREAM FETCH + RETRY LOOP
 * ========================================================================== */

class AbortedError extends Error {
  constructor() {
    super("client aborted");
    this.name = "RelayAbortedError";
  }
}

/** Sleep that wakes up early (and throws) when the client disconnects. */
function sleepWithAbort(ms, signal) {
  if (ms <= 0) {
    if (signal && signal.aborted) return Promise.reject(new AbortedError());
    return Promise.resolve();
  }
  return new Promise((resolve, reject) => {
    if (signal && signal.aborted) {
      reject(new AbortedError());
      return;
    }
    const timer = setTimeout(() => {
      if (signal) signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    function onAbort() {
      clearTimeout(timer);
      reject(new AbortedError());
    }
    if (signal) signal.addEventListener("abort", onAbort, { once: true });
  });
}

/**
 * Combine the client's abort signal with an optional per-attempt timeout.
 * Returns { signal, dispose } — dispose() must be called to release the listener.
 */
function createAttemptSignal(clientSignal, timeoutMs) {
  if (!clientSignal && !timeoutMs) return { signal: undefined, dispose() {} };

  const controller = new AbortController();
  let timer = null;
  const onClientAbort = () => controller.abort(clientSignal ? clientSignal.reason : undefined);

  if (clientSignal) {
    if (clientSignal.aborted) controller.abort(clientSignal.reason);
    else clientSignal.addEventListener("abort", onClientAbort, { once: true });
  }
  if (timeoutMs > 0) {
    timer = setTimeout(() => controller.abort(new Error("relay attempt timeout")), timeoutMs);
  }
  return {
    signal: controller.signal,
    dispose() {
      if (timer !== null) clearTimeout(timer);
      if (clientSignal) clientSignal.removeEventListener("abort", onClientAbort);
    },
  };
}

/** Discard an upstream body we are not going to use, so the connection is released. */
async function discardBody(response) {
  try {
    if (response && response.body && !response.bodyUsed) await response.body.cancel();
  } catch {
    /* the upstream may already be gone; nothing to do */
  }
}

/**
 * The retry loop.
 *
 * "Infinite retry" is best-effort by design: this keeps trying while the invocation is
 * alive, but Cloudflare enforces hard ceilings that no user-space loop can escape —
 *   - the subrequest budget (50 per invocation on the free plan, 1000 on paid); the
 *     loop detects "Too many subrequests" and stops with subrequest_limit
 *   - CPU time and the overall invocation lifetime
 *   - the client connection: once the caller goes away, retrying is pointless
 *   - single-shot request bodies (a streamed upload cannot be replayed)
 *
 * Nothing is retried once a successful response has been handed back, because the body
 * is streamed straight to the client and two SSE streams can never be stitched together.
 */
async function fetchWithRetries(targetUrl, init, options) {
  const { cfg, clientSignal, maxAttempts, attemptTimeoutMs, retryableBody, host } = options;
  const startedAt = Date.now();
  const effectiveMaxAttempts = retryableBody ? Math.max(1, maxAttempts) : 1;

  let currentUrl = targetUrl;
  let currentInit = init;
  let redirectsLeft = cfg.security.maxRedirects;
  let attempt = 0;
  let lastStatus = null;
  let lastRetryAfter = null;
  let lastErrorKind = null;

  while (attempt < effectiveMaxAttempts) {
    attempt += 1;

    if (clientSignal && clientSignal.aborted) {
      return { error: { code: "client_disconnected", message: "The client closed the connection." }, attempt };
    }

    const attemptSignal = createAttemptSignal(clientSignal, attemptTimeoutMs);
    let response = null;
    try {
      response = await fetch(currentUrl, { ...currentInit, signal: attemptSignal.signal });
    } catch (error) {
      const kind = classifyFetchError(error);
      lastErrorKind = kind;
      attemptSignal.dispose();

      if (kind === "aborted") {
        if (clientSignal && clientSignal.aborted) {
          return {
            error: { code: "client_disconnected", message: "The client closed the connection." },
            attempt,
          };
        }
        // Our own per-attempt timeout fired: that is a transient upstream problem.
        lastErrorKind = "timeout";
      } else if (kind === "subrequest_limit") {
        return {
          error: {
            code: "subrequest_limit",
            message:
              "Cloudflare's subrequest limit for this invocation was reached, so the relay cannot retry again.",
          },
          attempt,
        };
      } else if (kind === "dns_not_found") {
        return {
          error: {
            code: "upstream_error",
            reason: "dns_not_found",
            message:
              "The provider hostname could not be resolved (DNS). Check the [provider=...] value for typos.",
          },
          attempt,
        };
      } else if (kind === "fatal") {
        return {
          error: { code: "upstream_error", message: "The relay could not reach the provider." },
          attempt,
        };
      }

      if (attempt >= effectiveMaxAttempts) break;
      const delay = computeBackoffDelay(attempt, cfg);
      if (cfg.retries.logAttempts) {
        log(cfg, `attempt ${attempt} failed (${lastErrorKind}) host=${host} retry in ${delay}ms`);
      }
      if (cfg.retries.totalBudgetMs > 0 && Date.now() - startedAt + delay > cfg.retries.totalBudgetMs) {
        break;
      }
      try {
        await sleepWithAbort(delay, clientSignal);
      } catch {
        return {
          error: { code: "client_disconnected", message: "The client closed the connection." },
          attempt,
        };
      }
      continue;
    }

    attemptSignal.dispose();

    // Redirects are followed here (never by fetch) so the SSRF policy applies to
    // every hop. A hop is not a retry, so it does not consume the retry budget.
    if (REDIRECT_STATUSES.has(response.status) && redirectsLeft > 0) {
      const location = response.headers.get("Location");
      if (location) {
        const next = resolveRedirectTarget(location, currentUrl, cfg);
        if (!next) {
          await discardBody(response);
          return {
            error: {
              code: "blocked_provider",
              message: "The provider redirected to a URL this relay refuses to follow.",
            },
            attempt,
          };
        }
        const crossOrigin = next.origin !== new URL(currentUrl).origin;
        const rewritten = rewriteInitForRedirect(currentInit, response.status, retryableBody, crossOrigin);
        if (rewritten) {
          await discardBody(response);
          redirectsLeft -= 1;
          currentUrl = next.toString();
          currentInit = rewritten;
          attempt -= 1;
          log(cfg, `following redirect ${response.status} -> ${next.hostname}${crossOrigin ? " (credentials dropped)" : ""}`);
          continue;
        }
      }
    }

    // A redirect we did not follow is handed back to the caller. Rewriting a relative
    // Location to the absolute upstream URL: the client must bounce to the provider,
    // not to the relay itself (which would lose the provider directive). Following it
    // from the client's own network is then the caller's decision.
    if (REDIRECT_STATUSES.has(response.status)) {
      const location = response.headers.get("Location");
      let absolute = null;
      if (location) {
        try {
          const resolved = new URL(location, currentUrl);
          if (resolved.href !== currentUrl) absolute = resolved.toString();
        } catch {
          absolute = null;
        }
      }
      if (absolute) {
        const headers = sanitizeResponseHeaders(response.headers);
        headers.set("Location", absolute);
        return {
          response: new Response(response.body, {
            status: response.status,
            statusText: response.statusText,
            headers,
          }),
          attempt,
        };
      }
    }

    // Success (and any non-retryable provider error) is returned verbatim: from here on
    // the body belongs to the client and must never be replayed.
    if (!isRetryableStatus(response.status, cfg)) {
      if (cfg.retries.logAttempts && attempt > 1) {
        log(cfg, `attempt ${attempt} status=${response.status} host=${host} (returning)`);
      }
      return { response, attempt };
    }

    lastRetryAfter = response.headers.get("Retry-After");
    // Only a retryable status is remembered: a stale redirect/success status must never
    // become the HTTP status of a retry_exhausted error.
    lastStatus = response.status;
    const retryAfterMs = parseRetryAfter(lastRetryAfter, cfg);
    await discardBody(response);

    if (attempt >= effectiveMaxAttempts) break;

    const backoff = computeBackoffDelay(attempt, cfg);
    const delay = retryAfterMs === null ? backoff : applyDelayFloor(retryAfterMs, cfg);
    if (cfg.retries.logAttempts) {
      log(cfg, `attempt ${attempt} status=${response.status} host=${host} retry in ${delay}ms`);
    }
    if (cfg.retries.totalBudgetMs > 0 && Date.now() - startedAt + delay > cfg.retries.totalBudgetMs) {
      break;
    }
    try {
      await sleepWithAbort(delay, clientSignal);
    } catch {
      return {
        error: { code: "client_disconnected", message: "The client closed the connection." },
        attempt,
      };
    }
  }

  return {
    error: {
      code: "retry_exhausted",
      message:
        "The upstream provider did not return a successful response before the relay retry budget was exhausted.",
      status: lastStatus,
      retryAfter: lastRetryAfter,
      reason: lastErrorKind,
      singleAttempt: !retryableBody,
    },
    attempt,
  };
}

/* ========================================================================== *
 * 17. RESPONSE CONSTRUCTION
 * ========================================================================== */

const BODYLESS_STATUSES = new Set([101, 204, 205, 304]);

/**
 * Attach the session token (and optional cookie) to a response so clients can pin
 * these directives to future requests — subagents, post-compaction turns, retries.
 */
function attachSessionHeaders(headers, cfg, sessionToken) {
  if (!sessionToken) return;
  headers.set("X-Relay-Session", sessionToken);
  if (cfg.sessions.emitCookie) {
    headers.append(
      "Set-Cookie",
      `${cfg.sessions.cookieName}=${sessionToken}; Path=/; Max-Age=${cfg.sessions.ttlSeconds}; HttpOnly; Secure; SameSite=None`,
    );
  }
}

function buildClientResponse(upstream, { cfg, request, diagnostics }) {
  const headers = sanitizeResponseHeaders(upstream.headers);
  applyCorsHeaders(headers, cfg, request);

  if (cfg.exposeDiagnosticHeaders && diagnostics) {
    if (diagnostics.attempts) headers.set("X-Relay-Attempts", String(diagnostics.attempts));
    if (diagnostics.compatibility) headers.set("X-Relay-Compatibility", diagnostics.compatibility);
    if (diagnostics.host) headers.set("X-Relay-Upstream-Host", diagnostics.host);
    if (diagnostics.model) headers.set("X-Relay-Model", diagnostics.model);
  }

  attachSessionHeaders(headers, cfg, diagnostics && diagnostics.sessionToken);

  // A 1xx status cannot be re-emitted from a Worker (101 is handled as a WebSocket
  // upgrade earlier), so surface it as a relay error instead of throwing.
  if (upstream.status < 200) {
    return relayError("upstream_error", `The provider returned an unsupported ${upstream.status} response.`, {
      cfg,
      request,
    });
  }

  const bodyless = BODYLESS_STATUSES.has(upstream.status) || request.method.toUpperCase() === "HEAD";
  // The body is passed through as a stream: nothing is buffered, so SSE and audio
  // start reaching the client as soon as the provider emits their first bytes.
  return new Response(bodyless ? null : upstream.body, {
    status: upstream.status,
    statusText: upstream.statusText,
    headers,
  });
}
/* ========================================================================== *
 * 18. REQUEST HANDLER
 * ========================================================================== */

/**
 * Directives found in the body always win; query parameters fill the gaps, and
 * X-Relay-* headers are the last resort. (A streamed audio upload has no text at all,
 * so those two sources are what make binary endpoints usable.)
 */
function mergeFallbackDirectives(state, fallback) {
  for (const spec of DIRECTIVE_SPECS) {
    if (spec.multiple) continue;
    if (state.values[spec.key] === undefined && fallback.values[spec.key] !== undefined) {
      state.values[spec.key] = fallback.values[spec.key];
      state.sources[spec.key] = fallback.sources[spec.key];
    }
  }
  for (const entry of fallback.extraHeaders) {
    const exists = state.extraHeaders.some(
      (existing) => existing.name.toLowerCase() === entry.name.toLowerCase(),
    );
    if (!exists && state.extraHeaders.length < 32) state.extraHeaders.push(entry);
  }
  for (const warning of fallback.warnings) recordWarning(state, warning.code, warning.message);
  if (fallback.found) state.found = true;
}

/**
 * Apply the fully merged directives to the prepared body and produce the value handed
 * to fetch(). JSON is re-serialized only when something actually changed, so untouched
 * requests reach the provider byte-for-byte.
 */
function finalizeRequestBody(prepared, state, cfg, target = {}) {
  if (prepared.kind === "json") {
    const ctx = createTraversalContext(state, cfg);
    ctx.mutated = prepared.mutated;
    applyDirectivesToJsonBody(prepared.json, state, ctx, target);
    return { body: ctx.mutated ? JSON.stringify(prepared.json) : prepared.raw, mutated: ctx.mutated };
  }

  if (prepared.kind === "multipart") {
    let mutated = prepared.mutated;
    const existingModel = prepared.formData.get("model");
    if (
      state.values.model !== undefined &&
      (existingModel === null || typeof existingModel === "string") &&
      existingModel !== state.values.model
    ) {
      prepared.formData.set("model", state.values.model);
      mutated = true;
    } else if (state.values.model !== undefined && typeof existingModel === "object") {
      // A file part occupies "model": forcing a string there would silently delete
      // the client's upload, so the directive wins only over text fields.
      recordWarning(state, "invalid_directive", "The multipart field \"model\" is a file and could not be replaced by the model directive.");
    }
    return { body: prepared.formData, mutated };
  }
  if (prepared.kind === "urlencoded") {
    let mutated = prepared.mutated;
    if (state.values.model !== undefined && prepared.params.get("model") !== state.values.model) {
      prepared.params.set("model", state.values.model);
      mutated = true;
    }
    return { body: mutated ? prepared.params.toString() : prepared.raw, mutated };
  }

  return { body: prepared.body === undefined ? null : prepared.body, mutated: !!prepared.mutated };
}

/** GET /__relay/health and GET /__relay/help. */
function handleReservedEndpoint(url, request, cfg) {
  const suffix = url.pathname.slice(cfg.reservedNamespace.length).replace(/^\/+/, "").toLowerCase();
  if (suffix === "health" || suffix === "healthz") {
    const headers = new Headers({ "Content-Type": "application/json; charset=utf-8" });
    applyCorsHeaders(headers, cfg, request);
    return new Response(JSON.stringify({ ok: true, relay: "cloudflare-ai-relay", version: RELAY_VERSION }), {
      status: 200,
      headers,
    });
  }
  if (suffix === "" || suffix === "help") return helpResponse(cfg, request);
  return relayError("invalid_directive", `Unknown relay endpoint "${url.pathname}".`, {
    cfg,
    request,
    status: 404,
  });
}

/** Human-friendly usage document, also returned for a bare GET / with no provider. */
function helpResponse(cfg, request) {
  const payload = {
    relay: "cloudflare-ai-relay",
    version: RELAY_VERSION,
    usage:
      "Call this Worker like the provider you want to reach and embed directives in your prompt text.",
    directives: {
      "[provider=https://api.example.com/v1]": "Upstream base URL (aliases: endpoint, base_url).",
      "[model=gpt-5]": "Force the outgoing model.",
      "[compatibility=openai]": `One of: ${Object.keys(COMPATIBILITY_SPECS).join(", ")}. Aliases accepted; "compatiblity" typo accepted.`,
      "[key=sk-…]": "Provider API key (aliases: apikey, api_key). Omit it for free providers.",
      "[stream=true]": "Force the stream flag on JSON bodies.",
      "[timeout=60000]": "Per-attempt timeout in milliseconds.",
      "[max_retries=100]": "Override the retry budget for this request.",
      "[temperature=0.7]": "Force the temperature field on JSON bodies.",
      "[reasoning=high]":
        "Reasoning/thinking effort: none|minimal|low|medium|high|xhigh|max, an explicit token budget ([reasoning=8192]), or default. Written into whichever field the target API accepts (reasoning_effort, reasoning.effort, thinking.budget_tokens, thinkingConfig.thinkingBudget, …). Aliases: reasoning_effort, effort, thinking.",
      "[header=X-Custom: value]": "Add an arbitrary upstream header (repeatable).",
    },
    rules: [
      "The first valid occurrence of each directive wins; later duplicates are ignored but still removed.",
      "Recognized directives are stripped from the text the model sees. Unknown [bracket] text and Markdown links are left alone.",
      "Directives may also be sent as query parameters (?provider=…), X-Relay-* headers, or flags inside the model name (model@provider@key=…).",
      "Sticky routing: directives are remembered per client IP (CF-Connecting-IP) and every response also returns an X-Relay-Session token. Later requests with no directives — AI-agent subagents, post-compaction turns — inherit both. Priority: body > model flags > query > header > token > IP.",
    ],
    stickySessions: {
      why: "Subagent prompts are written by the parent model and compaction rewrites history, so in-prompt directives do not survive either. The session token travels outside the prompt, and IP memory needs no client cooperation at all.",
      how: "Send the token back as header X-Relay-Session: <token>, query ?relay_session=<token>, cookie relay_session=<token>, or anywhere in the prompt text. Alternatively just call again from the same IP with no directives and the last resolved routing is reused.",
      encrypted: cfg.sessions.secret
        ? "tokens are AES-GCM encrypted (RELAY_SESSION_SECRET is set)"
        : "tokens are readable base64 (set RELAY_SESSION_SECRET to encrypt them) — treat them like API keys",
      tokenPrefix: SESSION_TOKEN_PREFIX,
    },
    ipMemory: {
      enabled: cfg.ipMemory.enabled,
      ttlSeconds: cfg.ipMemory.ttlSeconds,
      scope: cfg.ipMemory.trustForwardedHeaders
        ? "CF-Connecting-IP plus forwarded headers (trusted mode)"
        : "CF-Connecting-IP only (spoof-proof); storage is per-isolate, best-effort on Cloudflare",
      caveat: "everyone behind the same public IP shares one routing slot",
    },
    modelFlags: {
      syntax: "<model>@<flag>[@<flag>…]",
      flags: ["https://provider/v1 (or a bare host)", "a RELAY_NAMED_PROVIDERS name", "key=… / apikey=… / k=…", "compatibility=… / compat=… / c=…"],
      example: "glm-5.3-flash@https://api.b.ai/v1@key=sk-x",
      note: "any unrecognized segment leaves the model name untouched",
    },
    namedProviders:
      cfg.namedProviders.size > 0
        ? Object.fromEntries([...cfg.namedProviders.entries()].map(([name, url]) => [`/${name}/…`, url]))
        : "configure RELAY_NAMED_PROVIDERS=\"name=https://provider/v1,...\" to route by first path segment",
    reasoning: {
      levels: REASONING_LEVELS,
      style: cfg.reasoning.style,
      mapping: {
        openai: "reasoning_effort: <level>",
        responses: "reasoning: { effort: <level> }",
        anthropic: "thinking: { type:'enabled', budget_tokens } or { type:'adaptive' } + output_config.effort",
        gemini: `generationConfig.thinkingConfig.${cfg.reasoning.geminiField}`,
        openrouter: "reasoning: { effort } | { max_tokens }  (auto-detected by host)",
        glm: "thinking: { type } + reasoning_effort  (auto-detected by host)",
        "images/tts/stt/embeddings": "ignored — those APIs have no reasoning parameter",
      },
    },
    example: {
      endpoint: "POST /v1/chat/completions",
      body: {
        messages: [
          {
            role: "user",
            content:
              "سلام! این تصویر را توضیح بده 😄\n\n[provider=https://api.example.com/v1]\n[model=gpt-5]\n[key=YOUR_KEY]",
          },
        ],
      },
    },
    limits: {
      retries: `up to ${cfg.retries.maxAttempts} attempts, capped in practice by Cloudflare's subrequest budget (50 free / 1000 paid)`,
      streaming: "responses are streamed; a request is never retried after its first byte reaches the client",
      http: cfg.allowHttpProviders ? "http:// and https:// providers allowed" : "https:// providers only",
    },
  };
  const headers = new Headers({ "Content-Type": "application/json; charset=utf-8" });
  applyCorsHeaders(headers, cfg, request);
  return new Response(JSON.stringify(payload, null, 2), { status: 200, headers });
}

/** True for a client-initiated WebSocket upgrade (best-effort passthrough support). */
function isWebSocketUpgrade(request) {
  return (request.headers.get("Upgrade") || "").toLowerCase() === "websocket";
}

async function handleRelay(request, env) {
  const cfg = resolveConfig(env);
  const method = request.method.toUpperCase();

  if (method === "OPTIONS") return handlePreflight(request, cfg);

  const incomingUrl = new URL(request.url);
  if (
    cfg.reservedNamespace &&
    (incomingUrl.pathname === cfg.reservedNamespace ||
      incomingUrl.pathname.startsWith(`${cfg.reservedNamespace}/`))
  ) {
    return handleReservedEndpoint(incomingUrl, request, cfg);
  }

  // ---- 1. directives from the body (document order, first occurrence wins) ----
  const state = createDirectiveState();
  let prepared;
  try {
    prepared = await prepareRequestBody(request, state, cfg);
  } catch (error) {
    log(cfg, "body read failed:", error && error.message);
    return relayError("invalid_json", "The request body could not be read.", {
      cfg,
      request,
      status: 400,
    });
  }
  if (prepared.error) {
    return relayError(prepared.error.code, prepared.error.message, { cfg, request });
  }

  // ---- 1b. routing flags embedded in the model name ----------------------------
  // Clients that can only set a model string get full routing:
  //   "glm-5.3-flash@https://api.b.ai/v1@key=sk-x" -> model + provider + key.
  // Flags are looked for in the directive model first, then the body's own model
  // field (so a body model can still supply the provider for a text-chosen model).
  // Text directives keep first-wins priority for the model itself; flag values only
  // fill the gaps. The provider always sees a cleaned model name.
  {
    const candidates = [];
    if (typeof state.values.model === "string") candidates.push(state.values.model);
    if (
      typeof prepared.bodyModel === "string" &&
      prepared.bodyModel !== state.values.model &&
      prepared.bodyModel.includes("@")
    ) {
      candidates.push(prepared.bodyModel);
    }

    for (const candidate of candidates) {
      const flags = extractModelFlags(candidate, cfg);
      if (!flags) continue;

      state.found = true;
      if (flags.provider !== undefined && state.values.provider === undefined) {
        state.values.provider = flags.provider;
        state.sources.provider = "model-flag";
      }
      if (flags.apiKey !== undefined && state.values.apiKey === undefined) {
        state.values.apiKey = flags.apiKey;
        state.sources.apiKey = "model-flag";
      }
      if (flags.compatibility !== undefined && state.values.compatibility === undefined) {
        state.values.compatibility = flags.compatibility;
        state.sources.compatibility = "model-flag";
      }
      if (flags.reasoning !== undefined && state.values.reasoning === undefined) {
        state.values.reasoning = flags.reasoning;
        state.sources.reasoning = "model-flag";
      }
      // The cleaned name replaces the operative model string only — never a
      // directive-chosen model from a different source.
      if (flags.model !== null && (state.values.model === undefined || candidate === state.values.model)) {
        state.values.model = flags.model;
      }
      break; // The first model string with valid flags wins.
    }
  }

  // ---- 2. directives from query params, then X-Relay-* headers -----------------
  const fallback = createDirectiveState();
  let consumedQueryParams = [];
  if (cfg.directives.acceptQueryParams) {
    consumedQueryParams = extractDirectivesFromQuery(incomingUrl.searchParams, fallback);
  }
  if (cfg.directives.acceptHeaders) {
    extractDirectivesFromHeaders(request.headers, fallback, cfg.directives.headerPrefix);
  }
  mergeFallbackDirectives(state, fallback);

  // Session tokens (explicit header/query/cookie first, then tokens pasted into the
  // prompt text during body parsing) fill whatever is still missing. Priority:
  // body > query > header > session.
  const explicitSession = await resolveExplicitSessionToken(
    request,
    incomingUrl.searchParams,
    cfg,
    consumedQueryParams,
  );
  if (explicitSession) mergeFallbackDirectives(state, explicitSession);
  if (prepared.textSessionState) mergeFallbackDirectives(state, prepared.textSessionState);

  // IP memory is the lowest-priority source: it fills whatever is still missing for
  // requests from an IP that configured routing earlier (subagents, compaction).
  const clientIp = resolveClientIp(request, cfg);
  const ipState = recallDirectivesForIp(clientIp, cfg);
  if (ipState) mergeFallbackDirectives(state, ipState);

  // ---- 2b. named provider from the path or as a directive value ----------------
  let effectiveUrl = incomingUrl;
  let namedProviderUrl = null;
  if (cfg.namedProviders.size > 0) {
    const segments = splitPath(incomingUrl.pathname);
    const firstName = segments[0] ? segments[0].toLowerCase() : "";
    if (firstName && cfg.namedProviders.has(firstName)) {
      effectiveUrl = new URL(incomingUrl.toString());
      effectiveUrl.pathname = `/${segments.slice(1).join("/")}`;
      namedProviderUrl = cfg.namedProviders.get(firstName);
    }
    if (state.values.provider && cfg.namedProviders.has(state.values.provider.toLowerCase())) {
      state.values.provider = cfg.namedProviders.get(state.values.provider.toLowerCase());
    }
  }

  // ---- 3. provider selection + SSRF validation --------------------------------
  // Priority: directive > named path segment > deployment default.
  const providerValue = state.values.provider || namedProviderUrl || cfg.defaultProvider;
  if (!providerValue) {
    if ((method === "GET" || method === "HEAD") && splitPath(incomingUrl.pathname).length === 0) {
      return helpResponse(cfg, request);
    }
    return relayError(
      "missing_provider",
      "No provider was supplied. Add [provider=https://api.example.com/v1] to your prompt, send ?provider=…, set the X-Relay-Provider header, or echo an X-Relay-Session token from an earlier request.",
      {
        cfg,
        request,
        details: state.warnings.length ? { warnings: state.warnings } : undefined,
      },
    );
  }

  const validated = validateProviderUrl(providerValue, cfg);
  if (validated.error) {
    return relayError(validated.error.code, validated.error.message, { cfg, request });
  }
  const providerUrl = validated.url;

  // ---- 3b. remember + token ------------------------------------------------------
  // Directives resolved from any source are remembered for this IP and encoded into
  // a session token, so future requests (subagents, compaction) can reroute without
  // repeating any of it.
  rememberDirectivesForIp(clientIp, state, cfg);
  const sessionToken = cfg.sessions.enabled && state.found ? await encodeSessionToken(state, cfg) : null;

  // ---- 4. compatibility + target URL ------------------------------------------
  const { compatibility } = resolveCompatibility(state, effectiveUrl.pathname);
  const targetUrl = buildTargetUrl({
    providerUrl,
    incomingUrl: effectiveUrl,
    cfg,
    compatibility,
    consumedQueryParams,
  });
  // ---- 5. body + headers -------------------------------------------------------
  const finalized = finalizeRequestBody(prepared, state, cfg, {
    compatibility,
    host: targetUrl.hostname,
  });
  const webSocket = isWebSocketUpgrade(request);
  const headers = buildUpstreamHeaders(request, {
    cfg,
    state,
    compatibility,
    dropContentType: prepared.dropContentType === true,
    isWebSocket: webSocket,
  });

  const init = {
    method,
    headers,
    // Redirects are handled in fetchWithRetries so every hop is SSRF-checked.
    redirect: "manual",
  };
  if (finalized.body !== null && method !== "GET" && method !== "HEAD") {
    init.body = finalized.body;
    // A ReadableStream body needs half-duplex mode and can only be sent once.
    if (typeof ReadableStream !== "undefined" && finalized.body instanceof ReadableStream) {
      init.duplex = "half";
    }
  }

  // ---- 6. upstream fetch with retries ------------------------------------------
  log(
    cfg,
    `${method} ${incomingUrl.pathname} -> ${targetUrl.hostname} compat=${compatibility}` +
      ` model=${state.values.model || "-"} body=${prepared.kind}` +
      ` key=${state.values.apiKey ? redact(state.values.apiKey) : "none"}`,
  );
  const requestedRetries = state.values.maxRetries;
  const maxAttempts =
    requestedRetries === undefined ? cfg.retries.maxAttempts : Math.max(1, requestedRetries + 1);
  const attemptTimeoutMs =
    state.values.timeoutMs === undefined ? cfg.retries.attemptTimeoutMs : state.values.timeoutMs;

  const result = await fetchWithRetries(targetUrl.toString(), init, {
    cfg,
    clientSignal: request.signal,
    // WebSocket upgrades and one-shot streamed uploads cannot be replayed.
    maxAttempts: webSocket ? 1 : maxAttempts,
    attemptTimeoutMs,
    retryableBody: prepared.retryable !== false && !webSocket,
    host: targetUrl.hostname,
  });

  const diagnostics = {
    attempts: result.attempt,
    compatibility,
    host: targetUrl.hostname,
    model: state.values.model,
    sessionToken,
  };

  if (result.error) {
    const { code, message, status, retryAfter } = result.error;
    log(
      cfg,
      `giving up: code=${code} host=${targetUrl.hostname} attempts=${result.attempt} upstream=${status || "-"}`,
    );
    const extraHeaders = {};
    if (retryAfter) extraHeaders["Retry-After"] = retryAfter;
    if (cfg.exposeDiagnosticHeaders) {
      extraHeaders["X-Relay-Attempts"] = String(result.attempt);
      extraHeaders["X-Relay-Upstream-Host"] = targetUrl.hostname;
      extraHeaders["X-Relay-Compatibility"] = compatibility;
    }
    if (sessionToken) extraHeaders["X-Relay-Session"] = sessionToken;
    return relayError(code, message, {
      cfg,
      request,
      // Surface the provider's own status so clients keep their 429/503 semantics.
      status: code === "retry_exhausted" && status >= 400 ? status : undefined,
      headers: extraHeaders,
      details: {
        attempts: result.attempt,
        ...(status ? { upstream_status: status } : {}),
        ...(result.error.reason ? { reason: result.error.reason } : {}),
        ...(result.error.singleAttempt
          ? { note: "The request body was a one-shot stream, so it could not be retried." }
          : {}),
        ...(state.warnings.length ? { warnings: state.warnings } : {}),
      },
    });
  }

  // ---- 7. WebSocket upgrade (best-effort passthrough) ---------------------------
  if (webSocket && result.response.webSocket) {
    return new Response(null, {
      status: 101,
      statusText: "Switching Protocols",
      webSocket: result.response.webSocket,
    });
  }

  // ---- 8. stream the provider response straight back ---------------------------
  return buildClientResponse(result.response, { cfg, request, diagnostics });
}

/* ========================================================================== *
 * 19. EXPORT
 * ========================================================================== */

export default {
  async fetch(request, env, ctx) {
    try {
      return await handleRelay(request, env, ctx);
    } catch (error) {
      const cfg = resolveConfig(env);
      log(cfg, "unhandled relay error:", error && error.stack ? error.stack : error);
      // Never echo request content back: the prompt may contain the caller's secrets.
      return relayError("internal_error", "The relay failed to process this request.", {
        cfg,
        request,
        details: cfg.debug && error ? { debug: String(error.message || error) } : undefined,
      });
    }
  },
};
/**
 * Test-only surface. Cloudflare uses `default` alone, so exporting these internals is
 * inert in production but lets the unit tests exercise the real implementations.
 */
export const __internals = {
  BASE_CONFIG,
  COMPATIBILITY_SPECS,
  DIRECTIVE_SPECS,
  REASONING_LEVELS,
  RELAY_VERSION,
  anthropicUsesAdaptive,
  applyAuthHeaders,
  applyDirectivesToJsonBody,
  applyReasoningToJsonBody,
  buildTargetUrl,
  clearIpMemory,
  computeBackoffDelay,
  createDirectiveState,
  createTraversalContext,
  decodeSessionToken,
  detectCompatibilityFromPath,
  encodeSessionToken,
  extractDirectivesFromText,
  extractModelFlags,
  findBlockedHostReason,
  ipMemorySnapshot,
  isRetryableStatus,
  joinProviderPath,
  levelForBudget,
  normalizeCompatibility,
  parseDirectiveAt,
  parseIPv4,
  parseIPv6,
  parseNamedProviders,
  parseReasoningValue,
  parseRetryAfter,
  readBodyWithCap,
  recallDirectivesForIp,
  redact,
  rememberDirectivesForIp,
  resolveClientIp,
  resolveConfig,
  resolveReasoningStyle,
  stripSessionTokensFromText,
  traverseJson,
  validateProviderUrl,
};
