import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';

// Transient API-error backoff (529 Overloaded / 500 / 503). Separate block from
// the usage-limit knobs above: those wait in *hours* until a reset, these wait in
// *seconds* on an exponential backoff. See README "Overload backoff".
export const DEFAULT_OVERLOAD = {
  enabled: true,
  // Anchored to Claude Code's actual TERMINAL error render — NOT bare status numbers.
  // A bare "503"/"529" matches ordinary code (res.status(503)), ports, byte counts and
  // quoted logs, which is what caused false "Continue where you left off." injections.
  // Matched as case-insensitive regexes against only the pane tail (see detectOverload).
  //
  // Claude Code (verified against the v2.1.x binary) has TWO render forms:
  //   terminal (retries exhausted):  "API Error: 529 {…}"  / "API Error: 503 no healthy upstream"
  //   transient (still retrying):     "API Error (529 …) · Retrying in 5s · attempt 3/10"
  // We REQUIRE the colon form to skip the parens form, and the retry SUFFIX
  // ("· Retrying in…" / "attempt n/m") is separately suppressed by the working gate
  // in patterns.js — together they ensure we never interrupt Claude's own backoff.
  patterns: [
    // Terminal error line. Covers the full retryable set (429+5xx) in the colon form.
    'API Error:\\s*(429|500|502|503|504|529)\\b',
    // JSON error.type for a sustained overload (survives the collapsed non-JSON render).
    'overloaded_error',
    // API-level 429 uses a dedicated render with no 3-digit code in the generic slot:
    //   "API Error: Server is temporarily limiting requests (not your usage limit) · Rate limited"
    'temporarily limiting requests',
  ],
  backoffSeconds: [30, 60, 120, 240, 300],
  steadyStateSeconds: 300,
  jitterPct: 15,
  maxTotalWaitMinutes: 120,
  // StopFailure event markers older than this are ignored (guards against a recycled
  // tmux pane id replaying a stale failure, or acting on a marker left while down).
  eventMaxAgeSeconds: 120,
  retryMessage: 'Continue where you left off.',
  // Gating: by default we only act when claude is alive at its prompt (the
  // foreground safety check passes). If a 500 ever drops you to the shell, the
  // send-keys is correctly blocked and nothing resumes; flip relaunchOnExit to
  // re-enter via relaunchCommand. Off by default — never type into a shell the
  // user may be using. See README "Gating decision".
  relaunchOnExit: false,
  relaunchCommand: 'claude --continue',
};

// Safeguard / AUP false-positive retry. Distinct from usage limits (hours) and overload
// (5xx, exponential): the model's safeguards flag a message — often a false positive, so
// an immediate re-send usually clears it. Bounded by maxRetries so a *sticky* flag can't
// loop forever. See README "Safeguard retry".
export const DEFAULT_SAFEGUARD = {
  enabled: true,
  // Case-insensitive regexes matched against the pane tail; a match only counts with an
  // `API Error` line nearby (see safeguardMatch) so quoting/discussing these phrases in
  // conversation can't trigger a retry. Match the stable phrases of the render, not the
  // model name (which varies).
  patterns: [
    "safeguards flagged this message",
    "can't respond to this request with",   // "Claude Code can't respond to this request with <model>"
    "legal/aup",                             // the AUP link Anthropic includes
  ],
  maxRetries: 3,          // small — if it keeps flagging, retrying won't help
  retryDelaySeconds: 8,   // brief pause between re-sends (semi-random flag; quick retry helps)
  retryMessage: 'continue',
};

// Context-limit compaction. A fourth failure family, and the only one whose remedy changes
// the conversation rather than just poking it: when the window is full Claude Code parks a
// "Context limit reached · /compact or /clear to continue" row and accepts nothing further,
// so an unattended session stops there for good — including one the usage-wait just woke,
// which is how it was found (the reset fired, the continuation message went in, and the
// session answered with the context row and sat until morning).
//
// The remedy is two-phase and deliberately NOT a bounded re-send like the families above:
// send /compact, let the compaction turn run to completion, and only then re-send the
// continuation. Sending both at once would queue the continuation into a compacting session;
// sending only /compact would leave the session compacted but idle — still stopped.
export const DEFAULT_CONTEXT_LIMIT = {
  enabled: true,
  // What to type to compact. Verified against Claude Code v2.1.263: the slash-command
  // autocomplete opens while this is typed, but Enter still SUBMITS rather than merely
  // completing the highlighted row, so the package's normal two-step send works unchanged
  // and no second Enter is wanted (a spare one would land in the next prompt).
  compactCommand: '/compact',
  // How long to let a compaction turn run before deciding it never started. Only consulted
  // while the pane is IDLE — an in-flight compaction re-arms the deadline every tick, so
  // this bounds "nothing happened", never a slow compaction.
  compactTimeoutSeconds: 180,
  maxRetries: 2,          // small — if /compact hasn't cleared the row twice, it won't
  retryDelaySeconds: 10,  // settle time after the compacted transcript lands, before resuming
  // The message sent AFTER a successful compaction. null (the default) means "reuse
  // usageLimitMessage", which is almost always right: the common path into this state is a
  // usage-limit retry the session could not process, so the instruction to re-send is
  // exactly the one that was just lost. Set a string here to decouple them.
  retryMessage: null,
};

export const DEFAULT_CONFIG = {
  maxRetries: 5,
  pollIntervalSeconds: 5,
  marginSeconds: 60,
  fallbackWaitHours: 5,
  retryMessage: 'Continue where you left off. The previous attempt was rate limited.',
  usageLimitMessage: 'Continue where you left off. The previous attempt was rate limited.',
  customPatterns: [],
  overload: DEFAULT_OVERLOAD,
  safeguard: DEFAULT_SAFEGUARD,
  contextLimit: DEFAULT_CONTEXT_LIMIT,
};

const CONFIG_PATH = join(homedir(), '.claude-auto-retry.json');

function validNumber(val, min, fallback) {
  return typeof val === 'number' && Number.isFinite(val) && val >= min ? val : fallback;
}

function clamp(val, lo, hi, fallback) {
  if (typeof val !== 'number' || !Number.isFinite(val)) return fallback;
  return Math.min(hi, Math.max(lo, val));
}

function validateOverload(raw) {
  // Shallow-merge so a partial user block keeps the documented defaults for the
  // keys it omits (JSON.parse's spread would otherwise replace the whole block).
  const o = { ...DEFAULT_OVERLOAD, ...(raw && typeof raw === 'object' ? raw : {}) };

  o.enabled = typeof o.enabled === 'boolean' ? o.enabled : DEFAULT_OVERLOAD.enabled;

  // Patterns are case-insensitive regexes (see detectOverload). Keep only non-empty
  // strings that actually compile, so a typo'd pattern can't crash the monitor tick.
  const pats = Array.isArray(o.patterns)
    ? o.patterns.filter(p => {
        if (typeof p !== 'string' || p.length === 0) return false;
        try { new RegExp(p); return true; } catch { return false; }
      })
    : [];
  o.patterns = pats.length > 0 ? pats : [...DEFAULT_OVERLOAD.patterns];

  const backoff = Array.isArray(o.backoffSeconds)
    ? o.backoffSeconds.filter(n => typeof n === 'number' && Number.isFinite(n) && n > 0)
    : [];
  o.backoffSeconds = backoff.length > 0 ? backoff : [...DEFAULT_OVERLOAD.backoffSeconds];

  o.steadyStateSeconds = validNumber(o.steadyStateSeconds, 1, DEFAULT_OVERLOAD.steadyStateSeconds);
  o.jitterPct = clamp(o.jitterPct, 0, 100, DEFAULT_OVERLOAD.jitterPct);
  o.maxTotalWaitMinutes = validNumber(o.maxTotalWaitMinutes, 0.1, DEFAULT_OVERLOAD.maxTotalWaitMinutes);
  o.eventMaxAgeSeconds = validNumber(o.eventMaxAgeSeconds, 1, DEFAULT_OVERLOAD.eventMaxAgeSeconds);

  if (typeof o.retryMessage !== 'string' || !o.retryMessage) {
    o.retryMessage = DEFAULT_OVERLOAD.retryMessage;
  }
  o.relaunchOnExit = typeof o.relaunchOnExit === 'boolean' ? o.relaunchOnExit : DEFAULT_OVERLOAD.relaunchOnExit;
  if (typeof o.relaunchCommand !== 'string' || !o.relaunchCommand) {
    o.relaunchCommand = DEFAULT_OVERLOAD.relaunchCommand;
  }
  return o;
}

function validateSafeguard(raw) {
  const s = { ...DEFAULT_SAFEGUARD, ...(raw && typeof raw === 'object' ? raw : {}) };
  s.enabled = typeof s.enabled === 'boolean' ? s.enabled : DEFAULT_SAFEGUARD.enabled;
  const pats = Array.isArray(s.patterns)
    ? s.patterns.filter(p => {
        if (typeof p !== 'string' || p.length === 0) return false;
        try { new RegExp(p); return true; } catch { return false; }
      })
    : [];
  s.patterns = pats.length > 0 ? pats : [...DEFAULT_SAFEGUARD.patterns];
  s.maxRetries = validNumber(s.maxRetries, 1, DEFAULT_SAFEGUARD.maxRetries);
  s.retryDelaySeconds = validNumber(s.retryDelaySeconds, 1, DEFAULT_SAFEGUARD.retryDelaySeconds);
  if (typeof s.retryMessage !== 'string' || !s.retryMessage) {
    s.retryMessage = DEFAULT_SAFEGUARD.retryMessage;
  }
  return s;
}

// Shallow-merge + field-by-field fallback, same shape as validateSafeguard. The one twist is
// retryMessage: null is a MEANINGFUL default ("reuse usageLimitMessage"), so it resolves
// against the already-validated usage message rather than falling back to a literal.
function validateContextLimit(raw, usageLimitMessage) {
  const c = { ...DEFAULT_CONTEXT_LIMIT, ...(raw && typeof raw === 'object' ? raw : {}) };
  c.enabled = typeof c.enabled === 'boolean' ? c.enabled : DEFAULT_CONTEXT_LIMIT.enabled;
  if (typeof c.compactCommand !== 'string' || !c.compactCommand) {
    c.compactCommand = DEFAULT_CONTEXT_LIMIT.compactCommand;
  }
  c.compactTimeoutSeconds = validNumber(c.compactTimeoutSeconds, 1, DEFAULT_CONTEXT_LIMIT.compactTimeoutSeconds);
  c.maxRetries = validNumber(c.maxRetries, 1, DEFAULT_CONTEXT_LIMIT.maxRetries);
  c.retryDelaySeconds = validNumber(c.retryDelaySeconds, 0, DEFAULT_CONTEXT_LIMIT.retryDelaySeconds);
  if (typeof c.retryMessage !== 'string' || !c.retryMessage) c.retryMessage = usageLimitMessage;
  return c;
}

function validate(cfg) {
  cfg.maxRetries = validNumber(cfg.maxRetries, 1, DEFAULT_CONFIG.maxRetries);
  cfg.pollIntervalSeconds = validNumber(cfg.pollIntervalSeconds, 1, DEFAULT_CONFIG.pollIntervalSeconds);
  cfg.marginSeconds = validNumber(cfg.marginSeconds, 0, DEFAULT_CONFIG.marginSeconds);
  cfg.fallbackWaitHours = validNumber(cfg.fallbackWaitHours, 0.1, DEFAULT_CONFIG.fallbackWaitHours);
  if (typeof cfg.retryMessage !== 'string' || !cfg.retryMessage) {
    cfg.retryMessage = DEFAULT_CONFIG.retryMessage;
  }
  if (typeof cfg.usageLimitMessage !== 'string' || !cfg.usageLimitMessage) {
    cfg.usageLimitMessage = DEFAULT_CONFIG.usageLimitMessage;
  }
  if (!Array.isArray(cfg.customPatterns)) {
    cfg.customPatterns = DEFAULT_CONFIG.customPatterns;
  } else {
    cfg.customPatterns = cfg.customPatterns.filter(p => {
      if (typeof p !== 'string') return false;
      try { new RegExp(p); return true; } catch { return false; }
    });
  }
  if (cfg.foregroundCommands !== undefined) {
    if (!Array.isArray(cfg.foregroundCommands) || cfg.foregroundCommands.length === 0) {
      delete cfg.foregroundCommands;
    }
  }
  cfg.overload = validateOverload(cfg.overload);
  cfg.safeguard = validateSafeguard(cfg.safeguard);
  // AFTER usageLimitMessage above: the null default resolves to it (see DEFAULT_CONTEXT_LIMIT).
  cfg.contextLimit = validateContextLimit(cfg.contextLimit, cfg.usageLimitMessage);
  return cfg;
}

export async function loadConfig(path = CONFIG_PATH) {
  try {
    const raw = await readFile(path, 'utf-8');
    return validate({ ...DEFAULT_CONFIG, ...JSON.parse(raw) });
  } catch {
    // The no-config path runs validate() too. It used to return the raw defaults, which was
    // harmless only while every default was already its own final value; contextLimit's
    // retryMessage default is null ("reuse usageLimitMessage") and RESOLVES in validate, so
    // skipping it here handed the monitor a null message to type into the pane.
    return validate({ ...DEFAULT_CONFIG });
  }
}
