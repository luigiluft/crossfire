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
export async function callModel(model, system, user, temperature, retries = 1, title = 'crossfire') {
  const t0 = Date.now();
  try {
    const res = await fetch(ENDPOINT, {
      method: 'POST',
      headers: { Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json', 'X-Title': title },
      body: JSON.stringify({ model, messages: [{ role: 'system', content: system }, { role: 'user', content: user }], temperature }),
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
