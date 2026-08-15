/**
 * Shared Vercel resolution. Lets the whole toolchain run against a fresh
 * account with nothing but a token: the team is discovered, the project is
 * created if it does not exist, and both are written back to .env.local.
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { ROOT, dim, ok } from './_env.mjs';

const API = 'https://api.vercel.com';

export function token() {
  const t = process.env.VERCEL_TOKEN;
  if (!t) throw new Error('VERCEL_TOKEN is not set');
  return t;
}

export async function api(method, p, body, { teamId } = {}) {
  const team = teamId ?? process.env.VERCEL_TEAM_ID;
  const url = `${API}${p}${p.includes('?') ? '&' : '?'}${team ? `teamId=${team}` : ''}`;
  const res = await fetch(url, {
    method,
    headers: {
      Authorization: `Bearer ${token()}`,
      ...(body ? { 'content-type': 'application/json' } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const text = await res.text();
  let json = {};
  try {
    json = text ? JSON.parse(text) : {};
  } catch {
    json = { raw: text };
  }
  return { ok: res.ok, status: res.status, json };
}

/** Rewrites a single KEY=value line in .env.local, appending it if absent. */
export function setEnvLocal(key, value) {
  const file = path.join(ROOT, '.env.local');
  let text = '';
  try {
    text = readFileSync(file, 'utf8');
  } catch {
    text = '';
  }
  const line = `${key}=${value}`;
  const re = new RegExp(`^${key}=.*$`, 'm');
  text = re.test(text) ? text.replace(re, line) : `${text.replace(/\n*$/, '\n')}${line}\n`;
  writeFileSync(file, text);
  process.env[key] = value;
}

/** Exactly one team → use it. Otherwise the caller must be explicit. */
export async function resolveTeam() {
  if (process.env.VERCEL_TEAM_ID) return process.env.VERCEL_TEAM_ID;

  const res = await api('GET', '/v2/teams?limit=20', undefined, { teamId: '' });
  const teams = res.json.teams ?? [];
  if (teams.length === 1) {
    console.log(ok('PASS') + `  discovered team ${teams[0].slug} (${teams[0].id})`);
    setEnvLocal('VERCEL_TEAM_ID', teams[0].id);
    return teams[0].id;
  }
  if (teams.length === 0) throw new Error('this token can see no teams — check that it is a team token');
  throw new Error(
    `this token can see ${teams.length} teams (${teams.map((t) => t.slug).join(', ')}). ` +
      'Set VERCEL_TEAM_ID in .env.local to pick one.',
  );
}

/** Finds the project by name, creating it if needed. Idempotent. */
export async function resolveProject(teamId) {
  const name = process.env.VERCEL_PROJECT_NAME || 'foundry-biz';

  if (process.env.VERCEL_PROJECT_ID) {
    const existing = await api('GET', `/v9/projects/${process.env.VERCEL_PROJECT_ID}`, undefined, { teamId });
    if (existing.ok) return { id: existing.json.id, name: existing.json.name };
    console.log(dim(`       VERCEL_PROJECT_ID is set but not reachable on this team; re-resolving by name`));
  }

  const found = await api('GET', `/v9/projects/${name}`, undefined, { teamId });
  if (found.ok) {
    console.log(ok('PASS') + `  found project ${found.json.name} (${found.json.id})`);
    setEnvLocal('VERCEL_PROJECT_ID', found.json.id);
    return { id: found.json.id, name: found.json.name };
  }

  const created = await api('POST', '/v11/projects', { name, framework: 'nextjs' }, { teamId });
  if (!created.ok) {
    throw new Error(`could not create project ${name}: ${JSON.stringify(created.json.error ?? created.json)}`);
  }
  console.log(ok('PASS') + `  created project ${created.json.name} (${created.json.id})`);
  setEnvLocal('VERCEL_PROJECT_ID', created.json.id);
  setEnvLocal('VERCEL_PROJECT_NAME', created.json.name);
  return { id: created.json.id, name: created.json.name };
}

/** Writes .vercel/project.json so the CLI targets the resolved project. */
export function writeProjectLink(projectId, orgId, projectName) {
  const dir = path.join(ROOT, '.vercel');
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    path.join(dir, 'project.json'),
    JSON.stringify({ projectId, orgId, projectName }) + '\n',
  );
}

/** Everything the deploy needs, resolved and persisted. */
export async function resolveTarget() {
  const teamId = await resolveTeam();
  const project = await resolveProject(teamId);
  writeProjectLink(project.id, teamId, project.name);
  return { teamId, projectId: project.id, projectName: project.name };
}
