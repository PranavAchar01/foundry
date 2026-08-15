#!/usr/bin/env node
/**
 * Mints a Band agent identity for Foundry and stores its key.
 *
 *   pnpm band:register
 *
 * Why this exists: Band's Human API (`/me/*`) is gated behind an Enterprise
 * plan, but the Agent API (`/agent/*`) is not. So the bus authenticates as a
 * registered agent rather than as the account owner. The human key
 * (BAND_API_KEY) is used exactly once — here — to mint the agent key, which
 * Band shows only at creation time.
 *
 * Auth is `X-API-Key`, not a bearer token.
 */
import { bad, dim, loadEnv, ok, warn } from './_env.mjs';
import { setEnvLocal } from './_vercel.mjs';

loadEnv();

const HUMAN = process.env.BAND_API_KEY;
if (!HUMAN) {
  console.error(bad('FAIL') + '  BAND_API_KEY is not set');
  process.exit(1);
}

const BASE = 'https://app.band.ai/api/v1';
const H = { 'X-API-Key': HUMAN, 'content-type': 'application/json' };
const AGENT_NAME = process.env.BAND_AGENT_NAME || 'Foundry CEO';

const jsonOf = async (res) => {
  const text = await res.text();
  try {
    return JSON.parse(text);
  } catch {
    return { raw: text.slice(0, 200) };
  }
};

// Already have a working agent key? Then this is a no-op.
if (process.env.BAND_AGENT_API_KEY) {
  const me = await fetch(`${BASE}/agent/me`, {
    headers: { 'X-API-Key': process.env.BAND_AGENT_API_KEY },
  });
  if (me.ok) {
    const j = await jsonOf(me);
    console.log(ok('PASS') + `  existing agent key is valid — ${j.data?.handle}`);
    process.exit(0);
  }
  console.log(warn('NOTE') + '  BAND_AGENT_API_KEY is set but rejected; minting a new one');
}

const res = await fetch(`${BASE}/me/agents/register`, {
  method: 'POST',
  headers: H,
  body: JSON.stringify({
    agent: {
      name: AGENT_NAME,
      description:
        'Autonomous holding company operator. Publishes CEO cycle events and coordinates ' +
        'per-business operator agents.',
    },
  }),
});

const out = await jsonOf(res);
if (!res.ok) {
  console.error(bad('FAIL') + `  register -> ${res.status}`);
  console.error(dim('       ' + JSON.stringify(out.error ?? out).slice(0, 300)));
  process.exit(1);
}

const agentId = out.data?.agent?.id;
const apiKey = out.data?.credentials?.api_key;
if (!apiKey) {
  console.error(bad('FAIL') + '  Band returned no api_key');
  process.exit(1);
}

// Prove the new key works before persisting it.
const me = await fetch(`${BASE}/agent/me`, { headers: { 'X-API-Key': apiKey } });
const meJson = await jsonOf(me);
if (!me.ok) {
  console.error(bad('FAIL') + `  minted key rejected by /agent/me -> ${me.status}`);
  process.exit(1);
}

setEnvLocal('BAND_AGENT_API_KEY', apiKey);
setEnvLocal('BAND_AGENT_ID', agentId);

console.log(ok('PASS') + `  registered "${AGENT_NAME}" — handle ${meJson.data?.handle}`);
console.log(dim(`       agent id ${agentId}`));
console.log(ok('PASS') + '  BAND_AGENT_API_KEY and BAND_AGENT_ID written to .env.local');
console.log(dim('       run `pnpm env:push` to send them to production'));
