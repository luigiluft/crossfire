# crossfire

> Your AI coding agent reviews its own work with the same blind spots it used to write it.
> **crossfire makes a model from a _different lab_ attack the work before you ship it.**

A zero-dependency CLI that runs a **cross-vendor LLM ensemble** over your plans, diffs, and code.
Two axes, one idea — borrow a brain trained on a different distribution than yours:

- **`crossfire review`** — *catch*. An adversarial reviewer (or a blind panel + judge) from a different vendor tears your plan/diff apart **before** you execute it.
- **`crossfire fuse`** — *generate*. Mixture-of-Agents: several diverse models answer in parallel, a strong aggregator synthesizes the best single answer.

No SDKs. No accounts beyond one OpenRouter key. ~330 lines of Node, `fetch` only.

```bash
crossfire review plan.md --type plan
crossfire review migration.sql --panel        # blind panel + judge
echo "$DIFF" | crossfire review --type diff
crossfire fuse "design the retry strategy for this queue"
```

---

## Why this exists

When an AI agent writes a plan and then "reviews" it, you're asking the same training
distribution to catch its own rationalizations. It can't — the blind spot that produced the
bug is the blind spot reviewing for it. That's **model monoculture**.

The fix isn't a smarter prompt. It's a **different lab**. A model from another vendor has a
different training distribution, so it flags the thing yours talked itself past. When two
models from *different* vendors independently flag the same defect, that agreement is the
strongest signal of a real bug you can get cheaply.

crossfire is the smallest possible tool that turns that idea into a command.

---

## 30-second demo

```
$ crossfire review examples/plan-with-bug.md --type plan --panel

════ CROSSFIRE · review · PANEL (4 blind reviewers + judge) ════

┌─ reviewer 1: openai/gpt-5.5  ·  FIX-BEFORE-SHIP
│ CRITICAL — the webhook endpoint is public and the payload is trusted with
│ no signature check. Anyone can POST a fake checkout.session.completed and
│ credit any account. Triggered by: curl to /api/webhook. confidence: 5
│ CRITICAL — no idempotency. Stripe retries webhooks; the same purchase
│ credits the balance multiple times. ...

┌─ reviewer 2: x-ai/grok-4.3  ·  FIX-BEFORE-SHIP
│ CRITICAL — missing webhook signature verification → forged credit grants.
│ HIGH — duplicate delivery double-credits (no idempotency key). ...

════════════════════════════════════════════════════════════
★★★ JUDGE SYNTHESIS · google/gemini-3.5-flash ★★★

CONSENSUS (≥2 reviewers — fix this):
- forged credit: public webhook trusts an unsigned payload — flagged by
  reviewer 1 AND reviewer 2 (independent → strong signal)
- double-credit: no idempotency on webhook retries — flagged by both

VERDICT: FIX-BEFORE-SHIP
```

Two models from different labs caught the same billing-bypass. That's not noise — that's a bug.
(See [`examples/`](examples/) for the input and full output.)

---

## Quickstart

```bash
# 1. Get an OpenRouter key → https://openrouter.ai/keys
export OPENROUTER_API_KEY=sk-or-...

# 2. Run straight from GitHub — no install
npx github:luigiluft/crossfire review path/to/plan.md --type plan

# or clone and link the `crossfire` command
git clone https://github.com/luigiluft/crossfire
cd crossfire && npm link
crossfire review diff.txt --type diff
```

Input comes from a file argument **or** stdin (so it pipes from `git diff`, your editor, an agent hook, anything).

---

## `crossfire review` — adversarial catch

| Mode | What | Cost | Use for |
|------|------|------|---------|
| `--solo` (default) | one reviewer from another vendor | ~$0.001–0.004 | the daily gate; safe to automate |
| `--panel` | N blind reviewers (different vendors) + a judge that synthesizes consensus / disagreement / blind-spots / noise | ~$0.05–0.20 | expensive, hard-to-reverse, architectural calls |

The judge does **not** average the reviews. It surfaces:
- **Consensus** — what ≥2 independent models flagged (promote: strong signal)
- **Disagreement** — where they conflict (this is where *you* decide; it never decides for you)
- **To verify** — schema/contract/data-binding claims it can't confirm from the input alone (never silently dropped as "noise")
- **Discarded noise** — generic best-practice with no concrete trigger

Every reviewer must end on a hard verdict: `SHIP` / `FIX-BEFORE-SHIP` / `RECONSIDER-APPROACH`. No hedging.

## `crossfire fuse` — Mixture-of-Agents generate

For open, hard problems where diversity wins. Pipeline:

1. **Structure** — rewrite your raw prompt into a clean spec (objective / context / constraints / output). `--no-structure` to skip.
2. **Propose** — N diverse models answer in parallel (the [MoA paper](https://arxiv.org/abs/2406.04692) shows diversity beats raw power here).
3. **Aggregate** — one strong model synthesizes the best single answer, told explicitly that some inputs may be wrong.

```bash
crossfire fuse "what's the cleanest schema for multi-tenant soft-delete?"
crossfire fuse prompt.md --show-prompt        # show the structured prompt + each proposal
```

---

## Privacy: `--safe`

The default panels include models from multiple regions (max training diversity). For
**client or regulated data**, pass `--safe` to restrict to a vetted Western-vendor set, and
crossfire warns you if any region-sensitive model is in the active set.

```bash
crossfire review prod-migration.sql --panel --safe --context "client PII"
```

## Output language

Defaults to English. Set `--lang pt|es|fr|de` (or `CROSSFIRE_LANG` in your env) to get
reviews and answers in your language — the analysis is identical, only the prose changes.

---

## Plugging into your agent

crossfire is stdin-friendly on purpose. Wire it as a pre-execution gate:

```bash
# Claude Code / Cursor / any agent: red-team a plan before executing it
git diff main...HEAD | crossfire review --type diff --solo
```

Drop it in a pre-commit hook, a CI step, or your agent's "before high-risk action" path.
The solo mode is cheap and deterministic enough to run on every risky change; escalate to
`--panel` for the calls you can't easily undo.

---

## Design notes (why it won't lie to you)

- **Never throws on a network blip** — a connection hiccup can't make the gate report "no issues found". Network errors retry; HTTP errors don't (they're deterministic).
- **Panel degrades gracefully** — dead model slug? It's skipped and the panel continues. Judge dies? Falls back to a different vendor. One reviewer left? It says so instead of faking a consensus.
- **Raw reviews printed before the judge's synthesis** — you can always audit the judge against the source. Never accept a synthesis blind.
- **Confidence-capped findings** — a reviewer that can't name the exact input that triggers a failure is capped at low confidence, so you can discard hallucinated "bugs".
- **Slugs rot** — `crossfire review --check` validates every model slug against OpenRouter's live catalog before you trust an automated run. A weekly CI job ([`.github/workflows/slug-check.yml`](.github/workflows/slug-check.yml)) does it for you.

---

## Configuration

Default model slugs live at the top of `cross-review.mjs` and `fusion.mjs`. Override per-run
with `--reviewers`, `--judge`, `--model` (review) or `--proposers`, `--aggregator` (fuse).
OpenRouter retires slugs over time — run `crossfire review --check` to see which are still live
and swap as needed.

## Cost

Live-estimated per run from OpenRouter pricing and printed to stderr after each call.
Ballpark: solo review ≈ $0.002, panel ≈ $0.05–0.20 (scales with artifact size and how much the reviewers write), fuse ≈ $0.10–0.17. You bring your own key; crossfire takes no cut.

## License

MIT.
