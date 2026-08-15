#!/usr/bin/env node
/**
 * Deploys to the EXISTING foundry-biz project and waits for it to be serving.
 *
 *   node scripts/deploy-vercel.mjs [--prebuilt]
 *
 * Uses the Vercel CLI for the upload (it handles the file manifest), then polls
 * the REST API for the real terminal state rather than trusting the CLI's exit
 * code. A BLOCKED deployment is reported as such, with the account flag that
 * explains it, instead of being reported as a success.
 */
import { spawn } from 'node:child_process';
import { bad, dim, loadEnv, ok, warn } from './_env.mjs';

loadEnv();

const TOKEN = process.env.VERCEL_TOKEN;
const TEAM = process.env.VERCEL_TEAM_ID;
const PROJECT = process.env.VERCEL_PROJECT_ID;
const PREBUILT = process.argv.includes('--prebuilt');

if (!TOKEN || !PROJECT) {
  console.error(bad('FAIL') + '  VERCEL_TOKEN and VERCEL_PROJECT_ID are required');
  process.exit(1);
}

const api = async (path) => {
  const res = await fetch(
    `https://api.vercel.com${path}${path.includes('?') ? '&' : '?'}teamId=${TEAM}`,
    { headers: { Authorization: `Bearer ${TOKEN}` } },
  );
  return res.json();
};

// The project must know it is a Next.js app, or the build produces a static
// directory listing instead of an application.
{
  const res = await fetch(
    `https://api.vercel.com/v9/projects/${PROJECT}?teamId=${TEAM}`,
    {
      method: 'PATCH',
      headers: { Authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
      body: JSON.stringify({ framework: 'nextjs' }),
    },
  );
  const json = await res.json();
  console.log(
    res.ok
      ? ok('PASS') + `  project framework = ${json.framework}`
      : bad('FAIL') + `  could not set framework: ${JSON.stringify(json.error ?? json)}`,
  );
}

// The CLI reads VERCEL_PROJECT_ID from the environment and then insists on
// VERCEL_ORG_ID alongside it. Ours lives under VERCEL_TEAM_ID.
const CHILD_ENV = { ...process.env, VERCEL_ORG_ID: TEAM };

function run(cmd, args) {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'], shell: false, env: CHILD_ENV });
    let out = '';
    child.stdout.on('data', (d) => {
      out += d;
      process.stdout.write(dim(String(d)));
    });
    child.stderr.on('data', (d) => {
      out += d;
      process.stdout.write(dim(String(d)));
    });
    child.on('close', (code) => resolve({ code, out }));
  });
}

const before = new Set(
  ((await api(`/v6/deployments?projectId=${PROJECT}&limit=20`)).deployments ?? []).map((d) => d.uid),
);

const args = ['vercel@latest', 'deploy', '--prod', '--yes', '--token', TOKEN];
if (PREBUILT) {
  console.log(dim('\nbuilding locally (vercel build)…'));
  const built = await run('pnpm', ['dlx', 'vercel@latest', 'build', '--prod', '--yes', '--token', TOKEN]);
  if (built.code !== 0) {
    console.log(bad('FAIL') + '  vercel build failed');
    process.exit(1);
  }
  args.push('--prebuilt');
}

console.log(dim('\nuploading…'));
// The CLI blocks waiting for the build; we only need it to submit. Poll after.
const cli = run('pnpm', ['dlx', ...args]);
const submitted = await Promise.race([cli, sleep(90_000).then(() => null)]);
if (submitted && submitted.code !== 0 && !/Queued|Building/i.test(submitted.out)) {
  // Surface the CLI's own refusal (plan limits, bad vercel.json, …) verbatim.
  console.log(bad('\nFAIL') + '  vercel CLI refused the deployment');
  process.exit(1);
}

// Find the deployment this run created.
let deployment = null;
for (let i = 0; i < 30 && !deployment; i++) {
  const list = (await api(`/v6/deployments?projectId=${PROJECT}&limit=20`)).deployments ?? [];
  deployment = list.find((d) => !before.has(d.uid)) ?? null;
  if (!deployment) await sleep(3000);
}

if (!deployment) {
  console.log(bad('FAIL') + '  no new deployment appeared');
  process.exit(1);
}

console.log(dim(`\ndeployment ${deployment.uid} — polling for a terminal state…`));

const TERMINAL = new Set(['READY', 'ERROR', 'CANCELED', 'BLOCKED']);
let state = deployment.readyState ?? deployment.state;
const started = Date.now();
while (!TERMINAL.has(state) && Date.now() - started < 600_000) {
  await sleep(5000);
  const d = await api(`/v13/deployments/${deployment.uid}`);
  state = d.readyState ?? state;
  process.stdout.write(dim(`  ${state}\n`));
}

const final = await api(`/v13/deployments/${deployment.uid}`);

if (state === 'READY') {
  const aliases = (final.alias ?? []).filter(Boolean);
  console.log('');
  console.log(ok('PASS') + `  deployment READY in ${Math.round((Date.now() - started) / 1000)}s`);
  for (const a of aliases) console.log(dim(`       https://${a}`));
  process.exit(0);
}

console.log('');
console.log(bad('FAIL') + `  deployment finished as ${state}`);
if (final.errorMessage) console.log(dim('       ' + final.errorMessage));

if (state === 'BLOCKED') {
  const user = await fetch('https://api.vercel.com/v2/user', {
    headers: { Authorization: `Bearer ${TOKEN}` },
  }).then((r) => r.json());
  console.log(
    warn('NOTE') +
      `  account "${user.user?.username}" has limited=${user.user?.limited}. Vercel puts a` +
      ' deployment in BLOCKED when the account is over its plan limits; the fix is on the' +
      ' Vercel dashboard, not in this repository.',
  );
}
process.exit(1);

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}
