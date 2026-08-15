#!/usr/bin/env node
/**
 * One command, cold start to verified production.
 *
 *   pnpm go-live
 *
 * Runs, in order and stopping at the first failure:
 *   1. preflight   — every external dependency, live
 *   2. migrate     — schema, and proof the append-only trigger is active
 *   3. env push    — secrets into the Vercel project
 *   4. deploy      — prebuilt, polled to a real terminal state
 *   5. smoke       — real content asserted on the live URL
 *
 * Step 4 is the one that can fail for a reason outside this repository; it
 * prints the exact Vercel block code when it does.
 */
import { spawn } from 'node:child_process';
import { bad, dim, loadEnv, ok } from './_env.mjs';

loadEnv();

const STEPS = [
  ['preflight', 'scripts/verify-all.mjs', []],
  ['migrate', 'scripts/migrate.mjs', []],
  ['env push', 'scripts/push-env-vercel.mjs', []],
  ['deploy', 'scripts/deploy-vercel.mjs', ['--prebuilt']],
  ['smoke', 'scripts/smoke.mjs', []],
];

function run(script, args) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [script, ...args], { stdio: 'inherit' });
    child.on('close', (code) => resolve(code ?? 1));
  });
}

for (const [name, script, args] of STEPS) {
  console.log(dim(`\n${'─'.repeat(64)}\n▸ ${name}\n${'─'.repeat(64)}`));
  const code = await run(script, args);
  if (code !== 0) {
    console.log('');
    console.log(bad(`go-live: stopped at "${name}"`));
    process.exit(code);
  }
}

console.log('');
console.log(ok('go-live: FOUNDRY IS LIVE AND VERIFIED'));
console.log(dim(`       ${process.env.FOUNDRY_PUBLIC_URL ?? 'https://foundry-biz.vercel.app'}`));
