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
import { resolveTarget } from './_vercel.mjs';

loadEnv();

const TOKEN = process.env.VERCEL_TOKEN;
const PREBUILT = process.argv.includes('--prebuilt');

if (!TOKEN) {
  console.error(bad('FAIL') + '  VERCEL_TOKEN is required');
  process.exit(1);
}

// Discovers the team, creates the project if it does not exist, and writes
// .vercel/project.json — so a bare token is enough to ship to a fresh account.
const { teamId: TEAM, projectId: PROJECT, projectName: PROJECT_NAME } = await resolveTarget();

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

  // The stable project alias is the app's real origin.
  const canonical =
    aliases.find((a) => a === `${PROJECT_NAME}.vercel.app`) ??
    aliases.slice().sort((a, b) => a.length - b.length)[0];

  if (canonical && `https://${canonical}` !== process.env.FOUNDRY_PUBLIC_URL) {
    console.log('');
    console.log(
      warn('NOTE') +
        `  this deployment serves https://${canonical}, but FOUNDRY_PUBLIC_URL is` +
        ` ${process.env.FOUNDRY_PUBLIC_URL}.`,
    );
    console.log(
      dim(
        '       Spawned pages bake that value into their checkout and beacon calls, and\n' +
          '       the Stripe webhook points at it. Repoint everything with:\n' +
          `         node scripts/retarget.mjs https://${canonical} && pnpm env:push && pnpm deploy`,
      ),
    );
  }
  process.exit(0);
}

console.log('');
console.log(bad('FAIL') + `  deployment finished as ${state}`);
if (final.errorMessage) console.log(dim('       ' + final.errorMessage));

if (state === 'BLOCKED') {
  // BLOCKED carries no errorMessage. The actual cause is on `seatBlock`.
  const block = final.seatBlock ?? {};
  const user = await fetch('https://api.vercel.com/v2/user', {
    headers: { Authorization: `Bearer ${TOKEN}` },
  }).then((r) => r.json());

  console.log(
    warn('NOTE') +
      `  seatBlock.blockCode = ${block.blockCode ?? 'unknown'}, isVerified = ${block.isVerified}` +
      `, account "${user.user?.username}" limited = ${user.user?.limited}.`,
  );
  if (block.blockCode === 'TEAM_ACCESS_REQUIRED') {
    console.log(
      dim(
        '       Vercel is refusing deployments that contain serverless functions until this\n' +
          '       account completes verification. Static deployments are unaffected, which is\n' +
          '       why spawned businesses deploy fine. Fix it at https://vercel.com/account —\n' +
          '       complete account verification, then re-run `pnpm deploy && pnpm smoke`.\n' +
          '       There is no change to this repository that resolves it.',
      ),
    );
  }
}
process.exit(1);

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}
