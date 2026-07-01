#!/usr/bin/env node
/**
 * crossfire decide — intra-model lens ensemble. N advisors answer the SAME question,
 * each through a DIFFERENT lens and BLIND to the others, then one judge distills the
 * signal (consensus / divergence / blind spots / recommendation).
 *
 * The DECISION axis — the third of the trio:
 *   review  → CRITIQUE a finished artifact (adversarial, cross-vendor).
 *   fuse    → GENERATE the best answer (mixture-of-agents, cross-VENDOR diversity).
 *   decide  → DECIDE an open question (single model, LENS diversity, no artifact).
 *
 * Why single-model + lenses (not cross-vendor like fuse): for an open strategic call
 * ("which stack? expand or not? how to structure this?") the diversity that matters is
 * the ANGLE, not the vendor. Same model in separate contexts, each forced onto one lens,
 * produces genuinely different takes; the judge then exposes where they diverge — which
 * is exactly where a human should make the call, not the model.
 *
 * PIPELINE:
 *   1. FAN-OUT   — the chosen model answers N times in parallel, one lens each (blind).
 *   2. JUDGE     — one strong model synthesizes: promotes points ≥2 advisors share,
 *                  surfaces divergences (does NOT resolve them), names blind spots.
 *
 * Usage:
 *   node mini-fusion.mjs "should I migrate to Shopify Plus?"
 *   node mini-fusion.mjs decision.md --known "leaning yes, worried about migration cost"
 *   echo "..." | node mini-fusion.mjs --json
 *
 * Flags:
 *   --known "..."     what you ALREADY concluded — makes lenses go BEYOND, not re-derive.
 *   --context "..."   extra data/context injected into the question.
 *   --lens "..."      replace the default lenses (repeatable; pass once per lens).
 *   --model slug      the model used for ALL lenses (default a strong reasoner).
 *   --judge slug      the synthesizer (quality concentrates here → strong model).
 *   --safe            forbid region-sensitive vendors (client/regulated data).
 *   --show-lenses     print each advisor's raw answer (auditable).
 *   --lang <code>     output language: en|pt|es|fr|de (default env CROSSFIRE_LANG or en).
 *   --json            machine-readable output.
 *   --models / --check  list slugs / validate live against OpenRouter.
 *
 * Env: OPENROUTER_API_KEY. Cost ~$0.10-0.25/run (manual, high-value strategic calls).
 */

import fs from 'node:fs';
import { CHINA_VENDORS, PRICES, callModel, costOf, checkSlugs, readStdin, resolveLang, langDirective } from './lib/openrouter.mjs';

const KEY = process.env.OPENROUTER_API_KEY;

// Lenses model: one strong reasoner, run once per lens. Lenses need depth, so this is
// not a place for a cheap model (unlike fuse's proposers, whose job is only diversity).
const DEFAULT_MODEL = 'google/gemini-3.1-pro-preview';
const SAFE_MODEL = 'openai/gpt-5.5'; // Western strong model for client data
// Judge: where the decision quality concentrates (mirrors fuse's aggregator) → strong.
const DEFAULT_JUDGE = 'openai/gpt-5.5';

// Default lenses — calibrated for a strategic/architectural decision. The '—' separates
// the lens NAME (shown to the judge) from its brief (its marching orders). Override with --lens.
const DEFAULT_LENSES = [
  'execution architect — focus on HOW to implement: dependencies, order of steps, what breaks in execution, the real effort',
  'product & user — focus on VALUE to whoever uses it: the job-to-be-done, what actually moves the needle, what is vanity',
  'risk, scale & cost — focus on failure modes, maintenance cost, what cracks under scale, the long-term trade-off',
  "contrarian / devil's advocate — assume the obvious option is WRONG: find the angle nobody saw and the case for doing NOTHING",
];

const SUGGEST = Object.keys(PRICES);

function parseArgs(argv) {
  const o = {
    known: '', context: '', lenses: [], model: null, judge: DEFAULT_JUDGE,
    safe: false, showLenses: false, json: false, lang: null, prompt: null, file: null,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--known') o.known = argv[++i];
    else if (a === '--context') o.context = argv[++i];
    else if (a === '--lens') o.lenses.push(argv[++i]);
    else if (a === '--model') o.model = argv[++i];
    else if (a === '--judge') o.judge = argv[++i];
    else if (a === '--safe') o.safe = true;
    else if (a === '--show-lenses') o.showLenses = true;
    else if (a === '--json') o.json = true;
    else if (a === '--lang') o.lang = argv[++i];
    else if (a === '--file') o.file = argv[++i];
    else if (a === '--models' || a === '--list') o.listModels = true;
    else if (a === '--check') o.check = true;
    else if (!a.startsWith('--')) o.prompt = (o.prompt ? o.prompt + ' ' : '') + a;
  }
  if (!o.lenses.length) o.lenses = DEFAULT_LENSES;
  if (!o.model) o.model = o.safe ? SAFE_MODEL : DEFAULT_MODEL;
  o.lang = resolveLang(o.lang);
  return o;
}

// ── Prompts ──────────────────────────────────────────────────────────────────

function advisorSystem(lens, hasKnown) {
  return `You are an advisor answering STRICTLY through one lens:\n"${lens}"\n\n` +
    `Do not try to cover everything — bring the UNIQUE angle of your lens, with depth. ` +
    (hasKnown
      ? `The material states a conclusion the user already reached — do NOT restate it; deliver only what is missing, what is wrong, or a different frame. `
      : '') +
    `End with: a concrete recommendation + why + the trade-off you consciously accept.`;
}

function buildAdvisorInput(o, question) {
  const ctx = o.context ? `\n\nContext/data:\n${o.context}` : '';
  const known = o.known ? `\n\nThe user ALREADY concluded this — do NOT restate, go beyond:\n${o.known}` : '';
  return `QUESTION:\n${question}${ctx}${known}`;
}

// Judge prompt — ported from the mini-fusion workflow. Promotes shared points, refuses
// to resolve divergences (that's the human's call), leads with [NEW] when `known` is set.
function buildJudgeInput(o, question, answers) {
  const ctx = o.context ? `\n\nContext/data:\n${o.context}` : '';
  const known = o.known ? `\n\nThe user ALREADY concluded this:\n${o.known}` : '';
  const knownRule = o.known
    ? `- INCREMENTAL VALUE: the user already holds the conclusion in the block above. Mark each point [NEW] (goes beyond what they had) or [CONFIRMS] (corroborates). LEAD with the [NEW] points — that is what the advisors were for; [CONFIRMS] comes after, brief.\n`
    : '';
  const block = answers.map((a, i) => `\n══ Advisor ${i + 1} — lens: ${a.lens} ══\n${a.text}`).join('\n');
  return `You are the judge of an advisory council. ${answers.length} advisors answered the SAME question, ` +
    `each through a different lens and BLIND to the others. Distill the signal — do NOT repeat the advice or average it.\n\n` +
    `Rules:\n` +
    `- PROMOTION: a point raised by 2+ independent advisors = strong signal, prioritize it.\n` +
    `- DIVERGENCE is the gold of the decision: where they disagree, do NOT decide for the user — expose the trade-off clearly, because that is where the user decides.\n` +
    `- Judge by the strength of the argument, not by which lens said it.\n` +
    knownRule +
    `\nAnswer directly, in these sections (use "—" if empty):\n` +
    `CONSENSUS (≥2 advisors converge):\n` +
    `DIVERGENCES (they disagree — THIS IS WHERE THE USER DECIDES):\n` +
    `BLIND SPOTS (only 1 saw it and it seems right; or something ALL missed):\n` +
    `RECOMMENDATION (the highest-leverage thing to do first):\n\n` +
    `QUESTION:\n${question}${ctx}${known}\n\n` +
    `ADVISORS' ANSWERS:\n${block}`;
}

// ── Pipeline ─────────────────────────────────────────────────────────────────

async function runDecide(o, question) {
  const regionSensitive = [o.model, o.judge].filter((m) => CHINA_VENDORS.some((v) => m.startsWith(v)));
  if (regionSensitive.length && !o.json) console.error(`[privacy] using ${regionSensitive.join(', ')} (region-sensitive) — if this is CLIENT data, run with --safe.`);

  // STEP 1 — fan-out: same model, one lens each, in parallel. Blindness = the ensemble's engine.
  const advisorInput = buildAdvisorInput(o, question);
  const settled = await Promise.all(o.lenses.map((lens) =>
    callModel(o.model, advisorSystem(lens, !!o.known) + langDirective(o.lang), advisorInput, 0.7, 1, 'crossfire-decide')
      .then((r) => ({ ...r, lens: lens.split('—')[0].trim() }))
  ));
  const ok = settled.filter((r) => r.ok);
  const failed = settled.filter((r) => !r.ok);
  for (const f of failed) if (!o.json) console.error(`[decide] lens skipped — ${f.lens} (${f.model}): ${f.error}`);
  if (ok.length < 2) {
    console.error('ERROR: fewer than 2 advisors responded — no basis to synthesize. Check --check and OPENROUTER_API_KEY.');
    process.exit(1);
  }

  // STEP 2 — judge synthesizes (lenses are labeled, but no vendor is leaked → no brand bias).
  const answers = ok.map((r) => ({ lens: r.lens, text: r.content }));
  const judgeInput = buildJudgeInput(o, question, answers);
  const judge = await callModel(o.judge, `You are a rigorous decision synthesizer.${langDirective(o.lang)}`, judgeInput, 0.4, 1, 'crossfire-decide');
  if (!judge.ok) { console.error(`ERROR: judge failed (${judge.error}). Raw advisor answers were not synthesized.`); process.exit(1); }

  const lensCost = ok.reduce((s, r) => s + (costOf(r.model, r.usage, PRICES) || 0), 0);
  const judgeCost = costOf(judge.model, judge.usage, PRICES) || 0;
  const total = lensCost + judgeCost;

  if (o.json) {
    console.log(JSON.stringify({
      question,
      lensesUsed: answers.map((a) => a.lens),
      answers: ok.map((r) => ({ lens: r.lens, model: r.model, content: r.content, cost: costOf(r.model, r.usage, PRICES) })),
      failed: failed.map((f) => ({ lens: f.lens, model: f.model, error: f.error })),
      synthesis: judge.content, judge: judge.model, totalCost: total,
    }, null, 2));
    return;
  }

  if (o.showLenses) {
    for (let i = 0; i < ok.length; i++) {
      console.log(`\n┌─ advisor ${i + 1} · lens: ${ok[i].lens} (${ok[i].model})`);
      console.log(ok[i].content.split('\n').map((l) => `│ ${l}`).join('\n'));
    }
    console.log(`\n${'═'.repeat(60)}`);
  }
  console.log(`\n★★★ COUNCIL SYNTHESIS · ${judge.model} (${ok.length} lenses${failed.length ? `, ${failed.length} failed` : ''}) ★★★\n`);
  console.log(judge.content);
  console.log(`\n${'─'.repeat(60)}`);
  console.error(`[decide: ${ok.length} lenses via ${o.model} · judge ${judge.model} · ~$${total.toFixed(4)}]`);
}

async function runCheck(o) {
  await checkSlugs([o.model, SAFE_MODEL, o.judge, ...SUGGEST]);
}

// ── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  const o = parseArgs(process.argv.slice(2));
  if (o.listModels) {
    console.log('Suggested models (slugs):\n' + SUGGEST.map((m) => `  ${m}  (~$${PRICES[m].in}/$${PRICES[m].out} per 1M)`).join('\n')
      + `\n\nDefault lenses model: ${DEFAULT_MODEL} (--safe: ${SAFE_MODEL})\nJudge: ${DEFAULT_JUDGE}\n\nDefault lenses:\n`
      + DEFAULT_LENSES.map((l) => `  • ${l}`).join('\n'));
    return;
  }
  if (!KEY) { console.error('ERROR: OPENROUTER_API_KEY missing from env.'); process.exit(1); }
  if (o.check) { await runCheck(o); return; }

  let raw = o.prompt || '';
  if (o.file) raw = fs.readFileSync(o.file, 'utf8');
  else if (!raw) raw = await readStdin();
  if (!raw.trim()) { console.error('ERROR: nothing to decide (pass the question as arg, --file, or pipe via stdin).'); process.exit(1); }

  await runDecide(o, raw.trim());
}

main();
