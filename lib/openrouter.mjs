/**
 * openrouter.mjs — shared OpenRouter HTTP layer for crossfire (review + fuse).
 *
 * Why a shared lib: review and fuse both need the exact same chat call, cost
 * estimate, live-slug check, stdin reader, and language directive. Keeping one
 * copy means a fix lands in both. No external dependencies — native fetch only.
 */

export const ENDPOINT = 'https://openrouter.ai/api/v1/chat/completions';
export const MODELS_ENDPOINT = 'https://openrouter.ai/api/v1/models';
export const KEY = process.env.OPENROUTER_API_KEY;

// Region-sensitive vendor prefixes. `--safe` excludes these for client/regulated data.
export const CHINA_VENDORS = ['deepseek', 'qwen', 'thudm', '01-ai', 'zhipu', 'z-ai', 'moonshotai', 'minimax'];

// Approx prices (USD per 1M tokens) for cost ESTIMATION only — fetched live from
// openrouter.ai. Shared by review + fuse so the table can't DRIFT between them (it
// already had: each tool listed only the slugs it used). The superset is harmless —
// costOf() looks up by slug and returns null for any model not present.
export const PRICES = {
  'openai/gpt-5.4-mini': { in: 0.75, out: 4.50 },
  'openai/gpt-5.5': { in: 5.00, out: 30.0 },
  'google/gemini-3-flash-preview': { in: 0.50, out: 3.00 },
  'google/gemini-3.5-flash': { in: 1.50, out: 9.00 },
  'google/gemini-3.1-pro-preview': { in: 2.00, out: 12.0 },
  'openai/gpt-5.4': { in: 2.50, out: 15.0 },
  'qwen/qwen3.7-max': { in: 1.25, out: 3.75 },
  'x-ai/grok-4.3': { in: 1.25, out: 2.50 },
  'z-ai/glm-5.2': { in: 0.93, out: 3.00 },
  'moonshotai/kimi-k2.6': { in: 0.55, out: 3.20 },
  'deepseek/deepseek-v4-pro': { in: 0.43, out: 0.87 },
  'anthropic/claude-opus-4.8': { in: 5.00, out: 25.0 },
};

// Per-model reasoning effort applied WHEREVER the model is called (review + fuse), unless a
// call passes an explicit override. OpenRouter effort ladder: xhigh/max=0.95 · high=0.8 ·
// medium=0.5 · low=0.2 · minimal=0.1 (fraction of the reasoning-token budget). 'xhigh' only
// "sticks" on models that support it (gpt-5.1-codex-max, Claude Opus 4.7+); elsewhere
// OpenRouter maps it DOWN to the nearest supported level (high) — harmless, never an error.
export const DEFAULT_EFFORT = {
  'z-ai/glm-5.2': 'high',                // GLM-5.2 "max" everywhere it's used (review + fuse)
  'anthropic/claude-opus-4.8': 'xhigh',  // native xhigh; only surfaces as the fusion --max fallback aggregator
};
// NOTE: gpt-5.5's max effort is scoped to the GENERATOR only — fusion --max forces effort
// explicitly per call, so it is deliberately NOT in this global map. That keeps the
// cross-review panel's gpt-5.5 at its default effort (no forced xhigh on the review axis).

export function readStdin() {
  return new Promise((res) => {
    let d = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (c) => (d += c));
    process.stdin.on('end', () => res(d));
  });
}

/** Estimated USD cost of one call, or null if the model isn't in the price table. */
export function costOf(model, usage, prices) {
  const p = prices[model];
  if (!p || !usage?.prompt_tokens) return null;
  return (usage.prompt_tokens * p.in + (usage.completion_tokens || 0) * p.out) / 1e6;
}

/** One chat call. NEVER throws: returns {ok, model, content, usage, error, ms}.
 *  retries only on NETWORK errors (not HTTP 4xx/5xx, which are deterministic) —
 *  a connection blip must not make an automated gate report "no issues found". */
export async function callModel(model, system, user, temperature, retries = 1, title = 'crossfire', effort) {
  const t0 = Date.now();
  // Reasoning effort: explicit arg wins; else the per-model default (DEFAULT_EFFORT); else none.
  const reasoningEffort = effort || DEFAULT_EFFORT[model];
  const body = { model, messages: [{ role: 'system', content: system }, { role: 'user', content: user }], temperature };
  if (reasoningEffort) body.reasoning = { effort: reasoningEffort };
  try {
    const res = await fetch(ENDPOINT, {
      method: 'POST',
      headers: { Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json', 'X-Title': title },
      body: JSON.stringify(body),
    });
    const ms = Date.now() - t0;
    if (!res.ok) return { ok: false, model, error: `HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`, ms };
    const data = await res.json();
    const content = data.choices?.[0]?.message?.content;
    if (!content) return { ok: false, model, error: 'empty response (no choices)', ms };
    return { ok: true, model, content, usage: data.usage || {}, ms };
  } catch (e) {
    if (retries > 0) return callModel(model, system, user, temperature, retries - 1, title);
    return { ok: false, model, error: `network: ${e.message}`, ms: Date.now() - t0 };
  }
}

/** Live set of model ids served by OpenRouter (for --check). */
export async function liveModelIds() {
  const res = await fetch(MODELS_ENDPOINT, { headers: { Authorization: `Bearer ${KEY}` } });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const data = await res.json();
  return new Set((data.data || []).map((m) => m.id));
}

/** Validate a list of slugs against OpenRouter's live model set; prints ✓ live / ✗ DEAD.
 *  Shared by both tools' --check so the fetch and the print format live in one place.
 *  De-dupes the input, so callers can pass overlapping sets freely. */
export async function checkSlugs(slugs) {
  let live;
  try { live = await liveModelIds(); } catch (e) { console.error(`ERROR fetching models: ${e.message}`); process.exit(1); }
  console.log('Slug validation against openrouter.ai/api/v1/models:\n');
  for (const m of [...new Set(slugs)]) console.log(`  ${live.has(m) ? '✓ live' : '✗ DEAD'}  ${m}`);
  console.log('\n(dead slug = OpenRouter retired it — swap before relying on an automated run)');
}

const LANG_NAMES = { en: 'English', pt: 'Portuguese (pt-BR)', es: 'Spanish', fr: 'French', de: 'German' };

/** Resolve output language: explicit --lang > CROSSFIRE_LANG env > 'en'. */
export function resolveLang(explicit) {
  return (explicit || process.env.CROSSFIRE_LANG || 'en').toLowerCase();
}

/** A directive appended to a system prompt to force output language.
 *  Returns '' for English (prompts are authored in English). */
export function langDirective(lang) {
  if (!lang || lang === 'en') return '';
  return `\n\nIMPORTANT: Write your entire response in ${LANG_NAMES[lang] || lang}.`;
}
