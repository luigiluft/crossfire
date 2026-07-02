#!/usr/bin/env node
/**
 * crossfire review — adversarial review by model(s) from a DIFFERENT vendor via OpenRouter.
 *
 * The value isn't "one more reviewer" — it's a training distribution DIFFERENT from the
 * agent that wrote the work, which catches what that agent rationalized past. Use it
 * SELECTIVELY (high risk): prod migrations/SQL, large specs, automation that runs
 * unattended, anything hard to reverse.
 *
 * TWO MODES:
 *   solo  (default) — 1 adversarial model. Cheap (~$0.001-0.004). Safe to automate.
 *   panel          — N models from DIFFERENT vendors answer BLIND in parallel, and a
 *                    JUDGE synthesizes: consensus / disagreement / blind spots /
 *                    to-verify / noise / recommendation. For expensive/architectural calls.
 *
 * Why the panel:
 *   - INDEPENDENCE is the engine: each model answers without seeing the others.
 *   - PROMOTION: 2+ models from different training distributions flagging the same bug
 *     is the strongest cheap signal of a real defect there is.
 *   - DISAGREEMENT is the gold of a decision: the judge SURFACES it instead of averaging.
 *
 * Usage:
 *   node cross-review.mjs <file>                                 # solo
 *   cat plan.md | node cross-review.mjs --type plan             # solo via stdin
 *   node cross-review.mjs plan.md --panel --type plan           # max-diversity panel + judge
 *   node cross-review.mjs diff.txt --panel --safe --context "client PII"
 *   node cross-review.mjs x.md --panel --reviewers z-ai/glm-5.2,moonshotai/kimi-k2.6,openai/gpt-5.5
 *   node cross-review.mjs x.md --panel --json                   # machine-readable output
 *
 * Flags:
 *   --mode solo|panel   (default solo)   ·  --panel  = shortcut for --mode panel
 *   --safe              (panel: Western-vendor set, no region-sensitive models — for client data)
 *   --type plan|diff|code (default code)
 *   --context "..."
 *   --lang <code>       (output language: en|pt|es|fr|de; default env CROSSFIRE_LANG or en)
 *   --model <slug>      (solo reviewer; default openai/gpt-5.4)
 *   --reviewers a,b,c   (panel; default 4 lineages GLM+Kimi+GPT+Grok; --safe = Google+OpenAI+xAI)
 *   --judge <slug>      (panel judge; default gemini-3.5-flash, fallback gpt-5.5)
 *   --json              (JSON output; suppresses formatted text)
 *   --models / --list   (list suggested slugs and exit)
 *   --check             (validate panel slugs against OpenRouter live and exit)
 *
 * Env: OPENROUTER_API_KEY (required).
 * Privacy: the default panel INCLUDES region-sensitive models for max training diversity —
 *          it's a deliberate, manual mode. For client/regulated data use --safe (warns if a
 *          region-sensitive model is in the set). Solo defaults to a Western reviewer.
 * Maintenance: OpenRouter retires slugs silently — validate with --check periodically (the
 *          source is openrouter.ai/api/v1/models, public). Panel skips a dead reviewer and
 *          continues; the judge has a fallback.
 */

import fs from 'node:fs';
import { CHINA_VENDORS, PRICES, callModel, costOf, checkSlugs, readStdin, resolveLang, langDirective } from './lib/openrouter.mjs';

const KEY = process.env.OPENROUTER_API_KEY;

// Default panel = MAX DIVERSITY of training lineage (the engine of the ensemble isn't power,
// it's a distribution different from the one being reviewed). 4 independent vendors. The panel
// is a manual/deliberate mode for an expensive call. It deliberately does NOT include the same
// model family as the one that produced the work — that would reintroduce the monoculture blind
// spot the panel exists to break.
const DEFAULT_REVIEWERS = ['z-ai/glm-5.2', 'moonshotai/kimi-k2.6', 'openai/gpt-5.5', 'x-ai/grok-4.3'];
// --safe: Western-vendor set (no region-sensitive models) for CLIENT/REGULATED data.
const SAFE_REVIEWERS = ['google/gemini-3.5-flash', 'openai/gpt-5.5', 'x-ai/grok-4.3'];
// The judge SYNTHESIZES finished reviews (no new analysis) → doesn't need heavy reasoning.
// A flash-tier model synthesizes just as well and is reliable on the large judge prompt.
const DEFAULT_JUDGE = 'google/gemini-3.5-flash';
const JUDGE_FALLBACK = 'openai/gpt-5.5'; // fallback from a DIFFERENT vendor (resilience to one outage)

const SUGGEST = Object.keys(PRICES);

function parseArgs(argv) {
  const o = {
    mode: 'solo', model: 'openai/gpt-5.4', type: 'code', context: '',
    file: null, reviewers: null, judge: DEFAULT_JUDGE, json: false, safe: false, lang: null,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--model') o.model = argv[++i];
    else if (a === '--mode') o.mode = argv[++i];
    else if (a === '--panel') o.mode = 'panel';
    else if (a === '--safe') o.safe = true;
    else if (a === '--type') o.type = argv[++i];
    else if (a === '--context') o.context = argv[++i];
    else if (a === '--lang') o.lang = argv[++i];
    else if (a === '--reviewers') o.reviewers = argv[++i].split(',').map((s) => s.trim()).filter(Boolean);
    else if (a === '--judge') o.judge = argv[++i];
    else if (a === '--json') o.json = true;
    else if (a === '--stdin') o.stdin = true;
    else if (a === '--models' || a === '--list') o.listModels = true;
    else if (a === '--check') o.check = true;
    else if (!a.startsWith('--')) o.file = a;
  }
  if (!o.reviewers) o.reviewers = o.safe ? SAFE_REVIEWERS : DEFAULT_REVIEWERS;
  o.lang = resolveLang(o.lang);
  return o;
}

// ── Prompts ──────────────────────────────────────────────────────────────────

const REVIEWER_SYSTEM = `You are a skeptical principal engineer doing an ADVERSARIAL review. Your only job is to find where this BREAKS: bugs, race conditions, edge cases, silent failures, wrong assumptions, security holes, broken error handling, duplication that will drift, and anything that looks "green but secretly broken". Rules:
- Be specific: cite the exact line/section and name the failure mode and the input that triggers it.
- Do NOT praise. Do NOT summarize what the code does. Do NOT suggest style nits unless they cause real bugs.
- Prioritize each finding as CRITICAL / HIGH / MEDIUM.
- For EACH finding, append confidence 1-5 that it is a REAL defect (not a stylistic guess or a maybe). HARD RULE: if you cannot name the exact input/condition that triggers the failure, cap confidence at 2. This lets the reader discard low-confidence noise — single-shot reviewers hallucinate plausible-but-fake issues, and an un-triggerable "bug" is usually one.
- If something is genuinely fine, stay silent on it. If you find nothing serious, say exactly "No serious issues found." — never invent problems to seem useful.
- End with the single highest-leverage thing to fix first, and state your confidence it is real.
- VERDICT (mandatory final line, on its own): close with exactly ONE discrete verdict — \`VERDICT: SHIP\` (no real blocker), \`VERDICT: FIX-BEFORE-SHIP\` (a CRITICAL/HIGH defect must be fixed first), or \`VERDICT: RECONSIDER-APPROACH\` (the design is wrong, not patchable line-by-line). Use exactly one. Commit to a stance whenever the evidence warrants it; reserve the middle verdict only for a genuinely balanced call — never hedge to seem safe.`;

const TYPE_HINT = {
  plan: 'This is a PLAN/spec, not code yet. Attack the plan: what will fail when implemented, what is underspecified, what edge case is ignored, what assumption is wrong.',
  diff: 'This is a DIFF. Focus on what the change introduces or breaks, not pre-existing code.',
  code: 'This is source code. Review for correctness and failure modes.',
};

const JUDGE_SYSTEM = `You are the judge of an adversarial panel. Several reviewers (models from DIFFERENT vendors, with different training distributions) reviewed the SAME artifact, each BLIND to the others' output. Your job is NOT to repeat the reviews or average them — it's to distill the signal.

Judging rules:
- PROMOTION (the most important signal): if 2+ INDEPENDENT reviewers flag the SAME defect, that is the strongest signal there is that the bug is REAL — agreement across different training distributions is not coincidence. Treat it as CONSENSUS and prioritize it.
- Judge by STRENGTH OF EVIDENCE (a concrete input/condition that triggers the failure), NEVER by which model said it. Favor no vendor.
- DISAGREEMENT is information, not a problem: where reviewers conflict, do NOT decide for them — expose the trade-off clearly, because that is where the owner decides.
- Anti-hallucination: a finding that no reviewer can anchor to a concrete trigger, or that is generic best-practice, goes to DISCARDED NOISE with a one-line why.
- HARD RULE — never discard as noise a finding about SCHEMA, data-binding, an API contract, or logic you cannot confirm from the given input alone. That kind goes to TO VERIFY (check against the real DB/runtime before accepting OR discarding). "Filtering noise" is not "discarding what's annoying to confirm".

Answer DIRECTLY, in exactly these sections (omit a section only if it would be empty, writing "—"):

CONSENSUS (≥2 reviewers, strong signal — fix it). Prefix EACH item with [N/M]: N = how many of the M reviewers independently flagged THIS specific defect (count honestly from the reviews above), M = panel size. This per-finding count is how the reader triages — the highest N is the surest bug:
- [N/M] <defect> — <file/section:line> — triggered by <input/condition> — flagged by <which reviewers>

DISAGREEMENTS (reviewers conflict — YOU DECIDE HERE):
- <point> — Reviewer X says A / Reviewer Y says B — real trade-off: <...>

BLIND SPOTS (only 1 reviewer saw it but it looks real WITH a concrete trigger; or something ALL may have missed):
- <...>

TO VERIFY (can't confirm from the input alone — check against real DB/runtime/schema BEFORE accepting or discarding):
- <...>

DISCARDED NOISE (hallucination / generic best-practice / no trigger):
- <finding> — discarded because <...>

RECOMMENDATION (the single highest-leverage thing to do first):
- <...>

VERDICT: <SHIP | FIX-BEFORE-SHIP | RECONSIDER-APPROACH>  (pick ONE, based on the consensus; do not sit on the fence)`;

function buildReviewerPrompt(o, content) {
  return `${TYPE_HINT[o.type] || TYPE_HINT.code}\n${o.context ? `\nContext: ${o.context}\n` : ''}\n--- BEGIN ${o.type.toUpperCase()} ---\n${content}\n--- END ---`;
}

// The judge sees reviewers as "REVIEWER N" WITHOUT the model slug: judging by
// strength of evidence (and the PROMOTION signal) must not be colored by which
// vendor said it — brand bias contaminates "2+ vendors agree", and a same-family
// judge/reviewer pair invites self-enhancement bias. The N↔model map is preserved
// in the raw-reviews display above the synthesis, so the reader de-anonymizes there.
function buildJudgePrompt(o, content, reviews) {
  const reviewsBlock = reviews
    .map((r, i) => `\n══ REVIEWER ${i + 1} — VERDICT: ${extractVerdict(r.content) || '?'} ══\n${r.content}`)
    .join('\n');
  return `Reviewed artifact (${o.type.toUpperCase()})${o.context ? ` — context: ${o.context}` : ''}:\n--- BEGIN ---\n${content}\n--- END ---\n\nIndependent reviews from ${reviews.length} reviewers (panel size M = ${reviews.length}; each was blind to the others, and is shown to you anonymized — judge by evidence, not by source; the [N/M] per-finding counts you emit use this M):\n${reviewsBlock}\n\nNow synthesize per your rules.`;
}

function extractVerdict(text) {
  // tolerate markdown around the verdict (e.g. "VERDICT: **FIX-BEFORE-SHIP**") — models
  // format in bold/italic and that broke extraction (judge showed up as "null").
  // Take the LAST match, not the first: the verdict is the mandatory FINAL line, and reviewers
  // routinely quote example verdicts ("VERDICT: SHIP") earlier in their prose. First-match-wins
  // mis-parsed those reviewers — a real panel run reported 2/4 SPLIT when it was 4/4 unanimous.
  const re = /VERDICT[:\s*_`-]*\b(SHIP|FIX-BEFORE-SHIP|RECONSIDER-APPROACH)\b/gi;
  let m, last = null;
  while ((m = re.exec(text || '')) !== null) last = m[1];
  return last ? last.toUpperCase() : null;
}

// Mechanical agreement — counts how many independent reviewers reached the SAME verdict.
// Deliberately NOT a model-emitted "confidence %": a raw count across DIFFERENT training
// distributions is the only honest cheap signal. Named "agreement", not "confidence", on
// purpose — N/N reviewers can share a blind spot and all be wrong; "confidence" would
// overclaim. A split (no majority) is information: the call is genuinely open, not noise.
function agreementOf(verdicts, totalReviewers) {
  if (!totalReviewers) return null;
  const counts = {};
  for (const v of verdicts) counts[v] = (counts[v] || 0) + 1;
  const entries = Object.entries(counts).sort((a, b) => b[1] - a[1]);
  const top = entries.length ? entries[0][1] : 0;
  const leaders = entries.filter(([, c]) => c === top).map(([v]) => v); // tied max verdict(s)
  // SPLIT = a tie among leaders OR the leader isn't a strict majority of the FULL panel.
  // Denominator is the reviewers that RAN (totalReviewers), never just the parseable ones —
  // otherwise one unparseable verdict silently fabricates "1/1 unanimous".
  const split = leaders.length !== 1 || top * 2 <= totalReviewers;
  return {
    verdict: split ? null : leaders[0],   // null in a split — never expose an arbitrary "winner" to JSON
    leaders, count: top, total: totalReviewers, parseable: verdicts.length,
    unparseable: totalReviewers - verdicts.length, label: `${top}/${totalReviewers}`,
    unanimous: top === totalReviewers, split, distribution: counts,
  };
}

// Best-effort extraction of the judge's per-finding promotion counts (the [N/M] tags on CONSENSUS
// items). Purely additive to --json — if the judge doesn't tag, returns [] and nothing breaks.
// This is the finding-level agreement: which SPECIFIC defect the most independent labs flagged.
function parseConsensusFindings(judgeText) {
  const t = judgeText || '';
  // Scope to the CONSENSUS section ONLY — [N/M] also shows up in DISAGREEMENTS/examples, and those
  // are not consensus findings (a real run leaked a [1/3] disagreement into the array otherwise).
  const start = t.search(/^[\s#*_>-]*CONSENSUS/im);
  if (start === -1) return [];
  const after = t.slice(start).replace(/^[^\n]*\n/, ''); // drop the CONSENSUS header line itself
  const endRel = after.search(/^[\s#*_>-]*(DISAGREEMENT|BLIND|TO VERIFY|DISCARD|RECOMMEND|VERDICT)/im);
  const section = endRel === -1 ? after : after.slice(0, endRel);
  const out = [];
  // tolerate any mix of list markers + markdown emphasis before the [N/M] tag (judges wrap in bold).
  const re = /^[\s>*_`-]*\[(\d+)\/(\d+)\]\s*(.+)$/gm;
  let m;
  while ((m = re.exec(section)) !== null) {
    out.push({ count: +m[1], total: +m[2], finding: m[3].replace(/\*\*/g, '').replace(/[\s*_]+$/, '').trim() });
  }
  return out.sort((a, b) => b.count - a.count);
}

// ── Modes ────────────────────────────────────────────────────────────────────

async function runSolo(o, content) {
  const system = REVIEWER_SYSTEM + langDirective(o.lang);
  const r = await callModel(o.model, system, buildReviewerPrompt(o, content), 0.2, 1, 'crossfire-review');
  if (!r.ok) { console.error(`ERROR (${o.model}): ${r.error}`); process.exit(1); }
  const cost = costOf(o.model, r.usage, PRICES);
  if (o.json) { console.log(JSON.stringify({ mode: 'solo', reviewer: { model: o.model, verdict: extractVerdict(r.content), review: r.content, cost } }, null, 2)); return; }
  console.log(`\n════ CROSSFIRE · review · solo · ${o.model} ════\n`);
  console.log(r.content);
  console.log(`\n${'─'.repeat(50)}`);
  console.error(`[tokens: ${r.usage.total_tokens || '?'} · ${(r.ms / 1000).toFixed(1)}s${cost !== null ? ` · ~$${cost.toFixed(4)}` : ''}]`);
}

async function runPanel(o, content) {
  const chinaInSet = o.reviewers.filter((m) => CHINA_VENDORS.some((v) => m.startsWith(v)));
  if (chinaInSet.length && !o.json) console.error(`[privacy] panel includes ${chinaInSet.join(', ')} (region-sensitive) — if this is CLIENT/REGULATED data, run with --safe (Western-vendor set).`);

  // BLIND PARALLEL FAN-OUT: independence is the engine of the ensemble.
  const userPrompt = buildReviewerPrompt(o, content);
  const system = REVIEWER_SYSTEM + langDirective(o.lang);
  const settled = await Promise.all(o.reviewers.map((m) => callModel(m, system, userPrompt, 0.2, 1, 'crossfire-review')));
  const ok = settled.filter((r) => r.ok);
  const failed = settled.filter((r) => !r.ok);

  for (const f of failed) console.error(`[panel] reviewer skipped — ${f.model}: ${f.error}`);

  if (ok.length === 0) { console.error('ERROR: no reviewer responded. Check slugs with --check and OPENROUTER_API_KEY.'); process.exit(1); }
  if (ok.length === 1) {
    console.error('[panel] only 1 reviewer survived → no basis for consensus; falling back to solo output (no judge).');
    const r = ok[0];
    const cost = costOf(r.model, r.usage, PRICES);
    if (o.json) { console.log(JSON.stringify({ mode: 'panel-degraded', reviewers: ok, failed }, null, 2)); return; }
    console.log(`\n════ CROSSFIRE · review · degraded panel · ${r.model} ════\n`);
    console.log(r.content);
    console.error(`\n[1 reviewer · ${cost !== null ? `~$${cost.toFixed(4)}` : ''}]`);
    return;
  }

  // JUDGE synthesizes. Fallback if the judge slug died (critical path).
  const judgeSystem = JUDGE_SYSTEM + langDirective(o.lang);
  const judgePrompt = buildJudgePrompt(o, content, ok);
  let judge = await callModel(o.judge, judgeSystem, judgePrompt, 0.1, 1, 'crossfire-review');
  if (!judge.ok && o.judge !== JUDGE_FALLBACK) {
    console.error(`[panel] judge ${o.judge} failed (${judge.error}) → fallback ${JUDGE_FALLBACK}`);
    judge = await callModel(JUDGE_FALLBACK, judgeSystem, judgePrompt, 0.1, 1, 'crossfire-review');
  }

  const reviewerCost = ok.reduce((s, r) => s + (costOf(r.model, r.usage, PRICES) || 0), 0);
  const judgeCost = judge.ok ? (costOf(judge.model, judge.usage, PRICES) || 0) : 0;
  const total = reviewerCost + judgeCost;

  // Agreement = how many independent reviewers landed on the same verdict (mechanical count).
  // Denominator = ok.length (reviewers that ran), so an unparseable verdict can't fake unanimity.
  const verdicts = ok.map((r) => extractVerdict(r.content)).filter(Boolean);
  const agreement = agreementOf(verdicts, ok.length);

  if (o.json) {
    console.log(JSON.stringify({
      mode: 'panel',
      agreement,
      consensusFindings: judge.ok ? parseConsensusFindings(judge.content) : [],
      reviewers: ok.map((r) => ({ model: r.model, verdict: extractVerdict(r.content), review: r.content, cost: costOf(r.model, r.usage, PRICES) })),
      failed: failed.map((f) => ({ model: f.model, error: f.error })),
      judge: judge.ok ? { model: judge.model, verdict: extractVerdict(judge.content), synthesis: judge.content, cost: judgeCost } : { error: judge.error },
      totalCost: total,
    }, null, 2));
    return;
  }

  // RAW REVIEWS first (never accept blind: you can audit the judge's synthesis against the source).
  console.log(`\n════ CROSSFIRE · review · PANEL (${ok.length} blind reviewers + judge) ════`);
  for (let i = 0; i < ok.length; i++) {
    console.log(`\n┌─ reviewer ${i + 1}: ${ok[i].model}  ·  ${extractVerdict(ok[i].content) || '?'}`);
    console.log(ok[i].content.split('\n').map((l) => `│ ${l}`).join('\n'));
  }
  console.log(`\n${'═'.repeat(60)}`);
  if (judge.ok) {
    console.log(`\n★★★ JUDGE SYNTHESIS · ${judge.model} ★★★\n`);
    console.log(judge.content);
  } else {
    console.error(`\nERROR: judge failed (${judge.error}). Raw reviews above — synthesize by hand.`);
  }
  if (agreement) {
    let line;
    if (agreement.parseable === 0) line = `0/${agreement.total} reviewers emitted a parseable verdict — agreement signal unavailable`;
    else if (agreement.unanimous) line = `${agreement.label} on ${agreement.verdict} (unanimous)`;
    else if (agreement.split && agreement.leaders.length > 1) line = `${agreement.label} — SPLIT (${agreement.leaders.join(' vs ')}), no majority: treat the call as genuinely open`;
    else if (agreement.split) line = `${agreement.label} on ${agreement.leaders[0]} — plurality, no majority of the panel`;
    else line = `${agreement.label} on ${agreement.verdict}`;
    if (agreement.unparseable && agreement.parseable !== 0) line += ` · ${agreement.unparseable} unparseable`;
    console.log(`\n  ⊢ reviewer agreement: ${line}`);
  }
  console.log(`\n${'─'.repeat(60)}`);
  const agStr = agreement ? `${agreement.label} ${agreement.verdict ? 'on ' + agreement.verdict : (agreement.parseable ? 'SPLIT' : 'no parseable verdict')}` : '?';
  console.error(`[panel: ${ok.length} ok${failed.length ? `, ${failed.length} failed` : ''} · reviewer verdicts: ${verdicts.join(', ') || '?'} · agreement: ${agStr} · judge: ${judge.ok ? extractVerdict(judge.content) : 'FAILED'} · ~$${total.toFixed(4)}]`);
}

async function runCheck(o) {
  await checkSlugs([...o.reviewers, o.judge, DEFAULT_JUDGE, JUDGE_FALLBACK, ...SUGGEST]);
}

// ── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  const o = parseArgs(process.argv.slice(2));
  if (o.listModels) { console.log('Suggested models (OpenRouter slugs):\n' + SUGGEST.map((m) => `  ${m}  (~$${PRICES[m].in}/$${PRICES[m].out} per 1M in/out)`).join('\n') + `\n\nDefault panel: ${DEFAULT_REVIEWERS.join(', ')}\nDefault judge: ${DEFAULT_JUDGE} (fallback ${JUDGE_FALLBACK})`); return; }
  if (!KEY) { console.error('ERROR: OPENROUTER_API_KEY missing from env.'); process.exit(1); }
  if (o.check) { await runCheck(o); return; }

  let content = '';
  if (o.file) content = fs.readFileSync(o.file, 'utf8');
  else content = await readStdin();
  if (!content.trim()) { console.error('ERROR: nothing to review (pass <file> or pipe via stdin).'); process.exit(1); }

  if (o.mode === 'panel') await runPanel(o, content);
  else await runSolo(o, content);
}

main();
