#!/usr/bin/env node
/**
 * crossfire fuse — structure a raw prompt + run cross-vendor Mixture-of-Agents (MoA) to
 * GENERATE the best answer. The generation axis — the opposite of review (which is CRITIQUE).
 *
 * Theory: Wang et al. 2024, "Mixture-of-Agents Enhances LLM Capabilities" (2406.04692).
 * Findings the design uses:
 *   - "Collaborativeness": a model produces a better answer when it sees others' — EVEN if
 *     worse ones. So proposers can be cheap/diverse; diversity > raw power.
 *   - More proposers = better (up to ~6); multi-model > same-model repeated.
 *   - The AGGREGATOR is where quality concentrates → spend a strong model there.
 *   - One aggregation layer already gives the biggest jump (no need to stack; less latency).
 *
 * PIPELINE:
 *   1. STRUCTURE   — rewrite the raw prompt into a clean spec (objective/context/constraints/
 *                    output). Doesn't answer the task, just improves the prompt. (--no-structure off)
 *   2. PROPOSERS   — N DIVERSE models answer the structured prompt, in parallel.
 *   3. AGGREGATOR  — 1 strong model synthesizes everything into a final answer (paper's prompt,
 *                    with an anti-bias instruction: "some responses may be wrong").
 *
 * Usage:
 *   node fusion.mjs "my raw prompt here"
 *   echo "prompt" | node fusion.mjs --no-structure
 *   node fusion.mjs prompt.md --safe                 # Western vendors only (client data)
 *   node fusion.mjs "..." --show-prompt              # show the structured prompt too
 *   node fusion.mjs "..." --json
 *
 * Flags:
 *   --safe            proposers Western-only (no region-sensitive vendors) — for client data
 *   --no-structure    skip step 1 (send the raw prompt straight to proposers)
 *   --show-prompt     print the structured prompt + each proposal (auditable)
 *   --lang <code>     output language: en|pt|es|fr|de (default env CROSSFIRE_LANG or en)
 *   --proposers a,b,c override the proposers
 *   --aggregator slug override the aggregator
 *   --structurer slug override the structurer
 *   --context "..."   extra context injected into the prompt
 *   --json            machine-readable output
 *   --models / --check  list slugs / validate live against OpenRouter
 *
 * Env: OPENROUTER_API_KEY. Privacy: the default INCLUDES region-sensitive vendors for max
 * generation diversity; --safe switches to the Western set. Cost ~$0.10-0.17/run (manual, high value).
 */

import fs from 'node:fs';
import { CHINA_VENDORS, callModel, costOf, liveModelIds, readStdin, resolveLang, langDirective } from './lib/openrouter.mjs';

const KEY = process.env.OPENROUTER_API_KEY;

// Real prices (USD/1M) fetched from openrouter.ai — for estimation only.
const PRICES = {
  'openai/gpt-5.4-mini': { in: 0.75, out: 4.50 },
  'openai/gpt-5.5': { in: 5.00, out: 30.0 },
  'google/gemini-3-flash-preview': { in: 0.50, out: 3.00 },
  'google/gemini-3.5-flash': { in: 1.50, out: 9.00 },
  'x-ai/grok-4.3': { in: 1.25, out: 2.50 },
  'z-ai/glm-5.2': { in: 1.40, out: 4.40 },
  'moonshotai/kimi-k2.6': { in: 0.68, out: 3.41 },
  'deepseek/deepseek-v4-pro': { in: 0.43, out: 0.87 },
  'anthropic/claude-opus-4.8': { in: 5.00, out: 25.0 },
};

// Default proposers: 4 independent training lineages, cheap-capable (the paper says a proposer
// need not be strong — it needs to be DIVERSE). Region-inclusive (deliberate manual mode).
const DEFAULT_PROPOSERS = ['z-ai/glm-5.2', 'deepseek/deepseek-v4-pro', 'moonshotai/kimi-k2.6', 'google/gemini-3-flash-preview'];
// --safe: Western-only proposers (no region-sensitive vendors) for client data.
const SAFE_PROPOSERS = ['google/gemini-3-flash-preview', 'openai/gpt-5.4-mini', 'x-ai/grok-4.3'];
// Aggregator: where quality lives → strong model. A 5th lineage, distinct from default proposers.
const DEFAULT_AGGREGATOR = 'openai/gpt-5.5';
const AGG_FALLBACK = 'anthropic/claude-opus-4.8'; // strong and reliable if the primary aggregator drops
const DEFAULT_STRUCTURER = 'openai/gpt-5.4-mini'; // cheap-capable for rewriting the prompt

const SUGGEST = Object.keys(PRICES);

function parseArgs(argv) {
  const o = {
    structure: true, safe: false, showPrompt: false, json: false, context: '', lang: null,
    prompt: null, file: null, proposers: null, aggregator: DEFAULT_AGGREGATOR, structurer: DEFAULT_STRUCTURER,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--no-structure') o.structure = false;
    else if (a === '--safe') o.safe = true;
    else if (a === '--show-prompt') o.showPrompt = true;
    else if (a === '--json') o.json = true;
    else if (a === '--context') o.context = argv[++i];
    else if (a === '--lang') o.lang = argv[++i];
    else if (a === '--proposers') o.proposers = argv[++i].split(',').map((s) => s.trim()).filter(Boolean);
    else if (a === '--aggregator') o.aggregator = argv[++i];
    else if (a === '--structurer') o.structurer = argv[++i];
    else if (a === '--file') o.file = argv[++i];
    else if (a === '--models' || a === '--list') o.listModels = true;
    else if (a === '--check') o.check = true;
    else if (!a.startsWith('--')) o.prompt = (o.prompt ? o.prompt + ' ' : '') + a;
  }
  if (!o.proposers) o.proposers = o.safe ? SAFE_PROPOSERS : DEFAULT_PROPOSERS;
  o.lang = resolveLang(o.lang);
  return o;
}

// ── Prompts ──────────────────────────────────────────────────────────────────

const STRUCTURE_SYSTEM = `You are a prompt engineer. Rewrite the user's RAW request into a CLEAN, well-structured prompt, with these sections when they make sense: OBJECTIVE (what is wanted, in 1 sentence), CONTEXT (what the model needs to know), CONSTRAINTS (what to respect/avoid), OUTPUT FORMAT (how the answer should come). Rules: preserve the ORIGINAL intent; fill obvious gaps conservatively (don't invent strong requirements); do NOT answer the task — produce ONLY the improved prompt, ready to use. Keep the user's language.`;

const PROPOSER_SYSTEM = `Answer the user's request as well as possible: correct, complete, and direct. If there is ambiguity, state your assumption and proceed.`;

// Aggregate-and-Synthesize — adapted from the MoA paper (Table 1), with an anti-bias clause.
const AGGREGATE_SYSTEM = `You have been given a set of responses from several models to the same request. Your task is to SYNTHESIZE them into a single high-quality response. It is crucial to critically evaluate the content — some of it may be biased or INCORRECT. Do not simply replicate the given responses: produce a refined, accurate, comprehensive answer. Where the models diverge, choose the best-grounded path (no lazy averaging). Ensure the answer is well-structured, coherent, and in the language of the request.`;

function buildProposerInput(o, working) {
  return `${o.context ? `Context: ${o.context}\n\n` : ''}${working}`;
}

function buildAggregateInput(working, proposals) {
  const block = proposals
    .map((p, i) => `\n### Response from model ${i + 1} (${p.model})\n${p.content}`)
    .join('\n');
  return `Original request:\n${working}\n\nModel responses (each answered independently):\n${block}\n\nNow synthesize the single best answer, following your rules.`;
}

// ── Pipeline ─────────────────────────────────────────────────────────────────

async function runFusion(o, rawPrompt) {
  const chinaInSet = o.proposers.filter((m) => CHINA_VENDORS.some((v) => m.startsWith(v)));
  if (chinaInSet.length && !o.json) console.error(`[privacy] proposers include ${chinaInSet.join(', ')} (region-sensitive) — if this is CLIENT data, run with --safe.`);

  // STEP 1 — structure the prompt
  let working = rawPrompt;
  let structured = null;
  if (o.structure) {
    const s = await callModel(o.structurer, STRUCTURE_SYSTEM, rawPrompt, 0.3, 1, 'crossfire-fuse');
    if (s.ok) { structured = s; working = s.content; }
    else if (!o.json) console.error(`[fuse] structurer failed (${s.error}) → using raw prompt.`);
  }

  // STEP 2 — proposers in parallel (independence is the engine of the ensemble)
  const proposerInput = buildProposerInput(o, working);
  const proposerSystem = PROPOSER_SYSTEM + langDirective(o.lang);
  const settled = await Promise.all(o.proposers.map((m) => callModel(m, proposerSystem, proposerInput, 0.7, 1, 'crossfire-fuse')));
  const ok = settled.filter((r) => r.ok);
  const failed = settled.filter((r) => !r.ok);
  for (const f of failed) if (!o.json) console.error(`[fuse] proposer skipped — ${f.model}: ${f.error}`);
  if (ok.length === 0) { console.error('ERROR: no proposer responded. Check --check and OPENROUTER_API_KEY.'); process.exit(1); }

  // STEP 3 — aggregator synthesizes (with a different-vendor fallback)
  const aggSystem = AGGREGATE_SYSTEM + langDirective(o.lang);
  const aggInput = buildAggregateInput(working, ok);
  let agg = await callModel(o.aggregator, aggSystem, aggInput, 0.4, 1, 'crossfire-fuse');
  if (!agg.ok && o.aggregator !== AGG_FALLBACK) {
    if (!o.json) console.error(`[fuse] aggregator ${o.aggregator} failed (${agg.error}) → fallback ${AGG_FALLBACK}`);
    agg = await callModel(AGG_FALLBACK, aggSystem, aggInput, 0.4, 1, 'crossfire-fuse');
  }
  if (!agg.ok) { console.error(`ERROR: aggregator failed (${agg.error}). Raw proposals were not synthesized.`); process.exit(1); }

  const structCost = structured ? (costOf(structured.model, structured.usage, PRICES) || 0) : 0;
  const propCost = ok.reduce((s, r) => s + (costOf(r.model, r.usage, PRICES) || 0), 0);
  const aggCost = costOf(agg.model, agg.usage, PRICES) || 0;
  const total = structCost + propCost + aggCost;

  if (o.json) {
    console.log(JSON.stringify({
      structuredPrompt: structured?.content || null,
      proposals: ok.map((r) => ({ model: r.model, content: r.content, cost: costOf(r.model, r.usage, PRICES) })),
      failed: failed.map((f) => ({ model: f.model, error: f.error })),
      answer: agg.content, aggregator: agg.model, totalCost: total,
    }, null, 2));
    return;
  }

  if (o.showPrompt && structured) {
    console.log(`\n════ STRUCTURED PROMPT (${structured.model}) ════\n`);
    console.log(structured.content);
  }
  if (o.showPrompt) {
    for (let i = 0; i < ok.length; i++) {
      console.log(`\n┌─ proposal ${i + 1}: ${ok[i].model}`);
      console.log(ok[i].content.split('\n').map((l) => `│ ${l}`).join('\n'));
    }
    console.log(`\n${'═'.repeat(60)}`);
  }
  console.log(`\n★★★ SYNTHESIZED ANSWER · ${agg.model} (${ok.length} proposers${o.structure ? ' + structuring' : ''}) ★★★\n`);
  console.log(agg.content);
  console.log(`\n${'─'.repeat(60)}`);
  console.error(`[fuse: ${ok.length} proposers${failed.length ? `, ${failed.length} failed` : ''} · agg ${agg.model} · ~$${total.toFixed(4)}]`);
}

async function runCheck(o) {
  let live;
  try { live = await liveModelIds(); } catch (e) { console.error(`ERROR fetching models: ${e.message}`); process.exit(1); }
  const all = [...new Set([...o.proposers, ...SAFE_PROPOSERS, o.aggregator, AGG_FALLBACK, o.structurer, ...SUGGEST])];
  console.log('Slug validation against openrouter.ai/api/v1/models:\n');
  for (const m of all) console.log(`  ${live.has(m) ? '✓ live' : '✗ DEAD'}  ${m}`);
}

// ── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  const o = parseArgs(process.argv.slice(2));
  if (o.listModels) {
    console.log('Suggested models (slugs):\n' + SUGGEST.map((m) => `  ${m}  (~$${PRICES[m].in}/$${PRICES[m].out} per 1M)`).join('\n')
      + `\n\nDefault proposers: ${DEFAULT_PROPOSERS.join(', ')}\n--safe proposers: ${SAFE_PROPOSERS.join(', ')}\nAggregator: ${DEFAULT_AGGREGATOR} (fallback ${AGG_FALLBACK})\nStructurer: ${DEFAULT_STRUCTURER}`);
    return;
  }
  if (!KEY) { console.error('ERROR: OPENROUTER_API_KEY missing from env.'); process.exit(1); }
  if (o.check) { await runCheck(o); return; }

  let raw = o.prompt || '';
  if (o.file) raw = fs.readFileSync(o.file, 'utf8');
  else if (!raw) raw = await readStdin();
  if (!raw.trim()) { console.error('ERROR: nothing to process (pass the prompt as arg, --file, or pipe via stdin).'); process.exit(1); }

  await runFusion(o, raw.trim());
}

main();
