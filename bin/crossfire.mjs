#!/usr/bin/env node
/**
 * crossfire — dispatcher for the three ensemble commands.
 *   crossfire review <file|->  [flags]   → cross-review.mjs (adversarial catch)
 *   crossfire fuse   "<prompt>" [flags]   → fusion.mjs (mixture-of-agents generate)
 *   crossfire decide "<question>" [flags] → mini-fusion.mjs (lens ensemble, decide)
 *
 * Spawns the target script with stdio inherited, so file args, stdin pipes, and
 * exit codes all pass through unchanged.
 */
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const [cmd, ...rest] = process.argv.slice(2);

const TARGETS = { review: 'cross-review.mjs', fuse: 'fusion.mjs', decide: 'mini-fusion.mjs' };

function help() {
  console.log(`crossfire — cross-vendor LLM ensemble for AI coding agents

Usage:
  crossfire review <file>    [--panel] [--type plan|diff|code] [--safe] [--lang xx]
  crossfire fuse   "<prompt>"   [--safe] [--no-structure] [--lang xx]
  crossfire decide "<question>" [--known "..."] [--context "..."] [--safe] [--lang xx]
  crossfire review --check                 validate model slugs are live on OpenRouter

  review → CRITIQUE an artifact   fuse → GENERATE an answer   decide → DECIDE by lenses

Input: a file argument or stdin. Requires OPENROUTER_API_KEY in the environment.
Docs:  https://github.com/luigiluft/crossfire`);
}

if (!cmd || cmd === '-h' || cmd === '--help') { help(); process.exit(cmd ? 0 : 1); }

const target = TARGETS[cmd];
if (!target) { console.error(`Unknown command: "${cmd}". Try: review | fuse | decide  (or --help)`); process.exit(1); }

const child = spawn(process.execPath, [join(root, target), ...rest], { stdio: 'inherit' });
child.on('exit', (code) => process.exit(code ?? 0));
child.on('error', (e) => { console.error(`failed to launch ${target}: ${e.message}`); process.exit(1); });
