import { env } from './env';
import { id, one, query } from './db';
import * as ledger from './ledger';
import * as decisions from './decisions';
import { authorizeSpend } from './guardrails';

/**
 * A machine per business.
 *
 * Every spawned business gets a persistent Firecracker microVM (Superserve)
 * that its operator agent runs the company from. Unlike a scratch sandbox, the
 * machine survives between CEO cycles: files the agent writes on Monday are
 * still there on Tuesday, so a business accumulates real working state —
 * copy drafts, customer notes, generated assets, its own scripts.
 *
 * The machine is metered. Compute is money, so:
 *   - provisioning goes through `authorizeSpend` like any other spend,
 *   - active time is billed by the second and posted as OPEX,
 *   - an idle machine is paused, which stops the meter,
 *   - killing a business kills its machine.
 */

export interface MachineRow {
  id: string;
  business_id: string;
  provider: string;
  external_id: string;
  status: 'active' | 'paused' | 'killed';
  preview_url: string;
  billed_seconds: string | number;
  last_started_at: string | null;
  last_used_at: string;
  killed_at: string | null;
  meta: Record<string, unknown>;
  created_at: string;
}

export interface MachineRun {
  command: string;
  exitCode: number;
  stdout: string;
  stderr: string;
  durationMs: number;
}

/** Superserve's SDK, loaded lazily so the module imports without the key. */
async function sdk() {
  const mod = await import('@superserve/sdk');
  return mod.Sandbox;
}

function requireKey(): string {
  const key = env.superserveApiKey;
  if (!key) throw new Error('SUPERSERVE_API_KEY is not set — no machine provider available');
  return key;
}

export async function forBusiness(businessId: string): Promise<MachineRow | null> {
  return one<MachineRow>(
    `SELECT * FROM machines WHERE business_id = $1 AND status <> 'killed'`,
    [businessId],
  );
}

export async function list(): Promise<MachineRow[]> {
  return query<MachineRow>(
    `SELECT * FROM machines WHERE status <> 'killed' ORDER BY created_at DESC`,
  );
}

// ---------------------------------------------------------------------------
// Provisioning
// ---------------------------------------------------------------------------

export interface ProvisionSpec {
  businessId: string;
  /** Carried onto the machine's own page. */
  disclosureLine?: string;
  name: string;
  niche: string;
  offer: string;
  targetCustomer: string;
  priceCents: number;
  url: string;
  thesis: string;
  cycleId?: string;
}

export interface ProvisionResult {
  ok: boolean;
  machine: MachineRow | null;
  reason: string;
  guardrailCode: string;
}

/**
 * Gives a business its machine and seeds it with everything the operator agent
 * needs to know about the company it is running.
 */
export async function provision(spec: ProvisionSpec): Promise<ProvisionResult> {
  const existing = await forBusiness(spec.businessId);
  if (existing) return { ok: true, machine: existing, reason: 'already provisioned', guardrailCode: '' };

  // An hour of machine time, authorised up front like any other spend.
  const auth = await authorizeSpend({
    businessId: spec.businessId,
    amountUsd: env.machineCostPerHour,
    category: 'infra',
  });
  if (!auth.allowed) {
    await decisions.record({
      cycleId: spec.cycleId ?? `machine_${Date.now().toString(36)}`,
      businessId: spec.businessId,
      action: 'MACHINE_DECLINED',
      reasoning:
        `Did not provision a machine for ${spec.name}: ${auth.reason}. The business runs ` +
        'without one; its storefront is unaffected.',
      confidence: 1,
      model: 'guardrail',
      outputs: { guardrailCode: auth.code, limits: auth.limits },
    });
    return { ok: false, machine: null, reason: auth.reason, guardrailCode: auth.code };
  }

  const Sandbox = await sdk();
  const box = await Sandbox.create({
    apiKey: requireKey(),
    name: `foundry-${spec.businessId}`.slice(0, 64),
    metadata: { businessId: spec.businessId, niche: spec.niche },
  });

  // Seed the machine with the company's own operating context.
  const seed: [string, string][] = [
    ['/root/company/COMPANY.md', companyBrief(spec)],
    [
      '/root/company/company.json',
      JSON.stringify(
        {
          businessId: spec.businessId,
          name: spec.name,
          niche: spec.niche,
          offer: spec.offer,
          targetCustomer: spec.targetCustomer,
          priceCents: spec.priceCents,
          storefront: spec.url,
          foundry: env.publicUrl,
          disclosure: env.disclosureLine,
        },
        null,
        2,
      ),
    ],
    ['/root/company/NOTES.md', '# Working notes\n\nAppend findings here.\n'],
    ['/root/company/serve.pl', SERVE_PL],
    ['/root/company/index.html', bootPage(spec)],
  ];
  for (const [path, content] of seed) {
    await box.files.write(path, content);
  }

  // Boot the machine's own web view and expose it. Every command here is
  // recorded, so the boot sequence is watchable rather than implied.
  const machineId = id('mch');
  let previewUrl = '';
  const bootLog: string[] = [];
  try {
    await box.commands.run('chmod +x /root/company/serve.pl');
    await box.commands.run(LAUNCH_SERVER);
    await new Promise((r) => setTimeout(r, 1200));
    await box.publishPreviewPort(8000, { access: 'public' });
    previewUrl = box.getPreviewUrl(8000);

    // Only claim a preview URL that actually answers.
    const probe = await fetch(previewUrl, { signal: AbortSignal.timeout(8000) }).catch(() => null);
    bootLog.push(`serve.pl on :8000 -> ${probe?.status ?? 'no response'}`);
    if (!probe?.ok) previewUrl = '';
  } catch (err) {
    bootLog.push(`preview unavailable: ${String(err).slice(0, 160)}`);
  }

  // A concurrent cycle may have provisioned this business between the check at
  // the top and here — the partial unique index is the real arbiter. Losing
  // that race must not kill the machine we just built, so surrender it.
  const rows = await query<MachineRow>(
    `INSERT INTO machines (id, business_id, provider, external_id, status, preview_url, last_started_at, meta)
     VALUES ($1,$2,'superserve',$3,'active',$4, now(), $5)
     ON CONFLICT DO NOTHING
     RETURNING *`,
    [
      machineId,
      spec.businessId,
      box.id,
      previewUrl,
      JSON.stringify({ name: spec.name, seeded: true, bootLog }),
    ],
  );

  if (!rows.length) {
    await box.kill().catch(() => {});
    const winner = await forBusiness(spec.businessId);
    return {
      ok: Boolean(winner),
      machine: winner,
      reason: 'another cycle provisioned this business first; released the duplicate machine',
      guardrailCode: '',
    };
  }

  await decisions.record({
    cycleId: spec.cycleId ?? `machine_${Date.now().toString(36)}`,
    businessId: spec.businessId,
    action: 'MACHINE_PROVISIONED',
    reasoning:
      `Gave ${spec.name} its own machine (${box.id}). It is seeded with the company brief, ` +
      'so the operator agent can keep working state between cycles instead of starting cold ' +
      `each time. Metered at $${env.machineCostPerHour}/hour and paused when idle.` +
      (previewUrl ? ` Its working directory is live at ${previewUrl}.` : ''),
    confidence: 1,
    model: 'guardrail',
    outputs: { machineId, externalId: box.id, provider: 'superserve', previewUrl, bootLog },
  });

  return { ok: true, machine: rows[0], reason: 'provisioned', guardrailCode: '' };
}

/**
 * A dependency-free static server for the machine's own working directory.
 *
 * The base image has no node and no python — only perl and curl — so this is
 * written against perl's core IO::Socket::INET. It is what makes each VM
 * visible: publish port 8000 and the company's working directory becomes a
 * live web page that changes as its operator agent works.
 */
/**
 * `commands.spawn` binds a process to the SDK connection — the docs are explicit
 * that aborting it "kills the process and closes the connection" — so a server
 * started that way dies the moment provisioning disconnects. That is why
 * machines booted fine and then served 502s minutes later.
 *
 * `setsid` detaches from the session, `nohup` survives the hangup, and the
 * redirects free the shell so `run()` returns immediately.
 */
const LAUNCH_SERVER =
  'setsid nohup perl /root/company/serve.pl /root/company 8000 ' +
  '</dev/null >/root/company/serve.log 2>&1 & echo launched';

const SERVE_PL = String.raw`#!/usr/bin/perl
use strict; use warnings;
use IO::Socket::INET;
$| = 1;
my $root = $ARGV[0] || '/root/company';
my $port = $ARGV[1] || 8000;
my %TYPES = (html=>'text/html', txt=>'text/plain', md=>'text/plain', json=>'application/json',
             css=>'text/css', js=>'text/javascript', svg=>'image/svg+xml');
my $sock = IO::Socket::INET->new(LocalAddr=>'0.0.0.0', LocalPort=>$port, Listen=>16,
                                 ReuseAddr=>1, Proto=>'tcp') or die "bind: $!";
sub send_res {
  my ($c, $code, $type, $body) = @_;
  my $len = length($body);
  print $c "HTTP/1.1 $code\r\nContent-Type: $type\r\nContent-Length: $len\r\n"
         . "Access-Control-Allow-Origin: *\r\nCache-Control: no-store\r\nConnection: close\r\n\r\n$body";
}
sub listing {
  my ($dir, $rel) = @_;
  opendir(my $dh, $dir) or return "<p>cannot read</p>";
  my @e = sort grep { $_ ne '.' && $_ ne '..' } readdir($dh);
  closedir $dh;
  my $out = '';
  for my $f (@e) {
    my $path = "$rel$f";
    my $isdir = -d "$dir/$f";
    my $size = $isdir ? '' : (-s "$dir/$f") . ' B';
    $out .= "<li><a href=\"$path" . ($isdir ? '/' : '') . "\">$f" . ($isdir ? '/' : '') . "</a> <span>$size</span></li>";
  }
  return $out;
}
while (my $c = $sock->accept) {
  my $req = <$c>;
  next unless defined $req;
  my ($path) = $req =~ m{^\w+\s+(\S+)};
  while (defined(my $h = <$c>)) { last if $h =~ /^\r?$/; }
  $path = '/' unless defined $path;
  $path =~ s/\?.*//;
  $path =~ s/%2e/./gi;
  $path =~ s{\.\./}{}g;                       # no traversal above the root
  my $target = $path eq '/' ? $root : "$root$path";
  if (-d $target) {
    if (-f "$target/index.html") {
      open(my $fh, '<', "$target/index.html"); local $/; my $b = <$fh>; close $fh;
      send_res($c, '200 OK', 'text/html', $b);
    } else {
      my $rel = $path eq '/' ? '/' : "$path/"; $rel =~ s{//$}{/};
      my $items = listing($target, $rel);
      send_res($c, '200 OK', 'text/html',
        "<!doctype html><meta charset=utf-8><title>machine</title>"
        . "<style>body{background:#fff;color:#1d1d1f;padding:40px;max-width:720px;margin:0 auto;"
        . "font:15px/1.5 -apple-system,BlinkMacSystemFont,'SF Pro Text','Helvetica Neue',Helvetica,Arial,sans-serif;"
        . "letter-spacing:-.01em;-webkit-font-smoothing:antialiased}"
        . "a{color:#1d1d1f;text-decoration:none;font-weight:500}a:hover{text-decoration:underline}"
        . "li{padding:11px 0;border-bottom:1px solid #d2d2d7;list-style:none}"
        . "span{color:#86868b;margin-left:8px;font-size:13px}"
        . "h1{font-size:12px;font-weight:600;letter-spacing:.04em;text-transform:uppercase;color:#86868b;margin-bottom:14px}</style>"
        . "<h1>$path</h1><ul>$items</ul>");
    }
  } elsif (-f $target) {
    my ($ext) = $target =~ /\.(\w+)$/;
    my $type = ($ext && $TYPES{lc $ext}) ? $TYPES{lc $ext} : 'text/plain';
    open(my $fh, '<', $target); local $/; my $b = <$fh>; close $fh;
    send_res($c, '200 OK', $type, $b);
  } else {
    send_res($c, '404 Not Found', 'text/plain', "not found: $path");
  }
  close $c;
}
`;

function companyBrief(spec: ProvisionSpec): string {
  return `# ${spec.name}

You are the operator agent for this company. This machine is yours; anything you
write here persists between cycles.

- **Niche**: ${spec.niche}
- **Customer**: ${spec.targetCustomer}
- **Offer**: ${spec.offer}
- **Price**: $${(spec.priceCents / 100).toFixed(2)} one-time
- **Storefront**: ${spec.url}
- **Thesis**: ${spec.thesis}

## Rules

1. Every public artefact must carry this line verbatim:
   ${env.disclosureLine}
2. No medical, legal, or financial claims. No guarantees. Nothing aimed at minors.
3. You cannot spend money from here. Budget decisions belong to the CEO loop.
4. Keep durable findings in NOTES.md — it is the only thing that survives you.
`;
}

/** The page a machine serves before its operator has written anything. */
function bootPage(spec: ProvisionSpec): string {
  const esc = (s: string) =>
    s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  return `<!doctype html><meta charset="utf-8"><title>${esc(spec.name)} — machine</title>
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>
 :root{--bg:#fff;--grey:#f5f5f7;--line:#d2d2d7;--fg:#1d1d1f;--muted:#6e6e73;--dim:#86868b}
 *{box-sizing:border-box;margin:0;padding:0}
 body{background:var(--bg);color:var(--fg);letter-spacing:-.01em;line-height:1.5;
   font-family:-apple-system,BlinkMacSystemFont,"SF Pro Display","SF Pro Text","Helvetica Neue",Helvetica,Arial,sans-serif;
   -webkit-font-smoothing:antialiased;padding:56px 28px;max-width:760px;margin:0 auto}
 h1{font-size:34px;font-weight:600;letter-spacing:-.03em;margin-bottom:6px}
 .sub{color:var(--muted);font-size:15px;margin-bottom:34px}
 .dot{display:inline-block;width:7px;height:7px;border-radius:50%;background:var(--fg);margin-right:7px}
 .box{background:var(--grey);border:1px solid var(--line);border-radius:16px;padding:24px}
 h2{font-size:12px;font-weight:600;letter-spacing:.04em;text-transform:uppercase;color:var(--dim);margin-bottom:14px}
 ul{list-style:none}
 li{padding:12px 0;border-bottom:1px solid var(--line);font-size:15px}
 li:last-child{border-bottom:0}
 a{color:var(--fg);text-decoration:none;font-weight:500}
 a:hover{text-decoration:underline}
 .note{margin-top:16px;color:var(--muted);font-size:13.5px;line-height:1.6}
 .disclosure{margin-top:26px;font-size:12.5px;color:var(--dim)}
</style>
<h1>${esc(spec.name)}</h1>
<div class="sub"><span class="dot"></span>${esc(spec.niche)} · machine online</div>
<div class="box">
  <h2>Operator workspace</h2>
  <ul>
    <li><a href="/COMPANY.md">COMPANY.md</a> — the brief</li>
    <li><a href="/NOTES.md">NOTES.md</a> — durable findings</li>
    <li><a href="/company.json">company.json</a></li>
  </ul>
  <p class="note">This page is served by the machine itself. The operator agent may
  replace it as it works — what you see here is whatever it has built so far.</p>
</div>
<p class="disclosure">${esc(spec.disclosureLine ?? env.disclosureLine)}</p>
`;
}

// ---------------------------------------------------------------------------
// Running work on the machine
// ---------------------------------------------------------------------------

/**
 * The machine's own web view is a long-running process, and a process does not
 * reliably survive a pause/resume cycle. This checks the port from inside the
 * machine and restarts the server if it has gone away, so a paused-then-woken
 * machine does not silently start serving 502s.
 */
export async function ensureServing(
  box: { commands: { run: (c: string, o?: { timeoutMs?: number }) => Promise<{ stdout?: string }> } },
  machineRow: MachineRow,
): Promise<boolean> {
  const probe = await box.commands
    .run(`curl -s -o /dev/null -w '%{http_code}' --max-time 3 http://127.0.0.1:8000/ || true`)
    .catch(() => ({ stdout: '' }));

  if ((probe.stdout ?? '').trim() === '200') return true;

  await box.commands.run(LAUNCH_SERVER).catch(() => {});
  await new Promise((r) => setTimeout(r, 1200));

  const again = await box.commands
    .run(`curl -s -o /dev/null -w '%{http_code}' --max-time 3 http://127.0.0.1:8000/ || true`)
    .catch(() => ({ stdout: '' }));
  const healthy = (again.stdout ?? '').trim() === '200';

  if (healthy && !machineRow.preview_url) {
    // The port was published at boot; only the URL was withheld because nothing
    // answered. Now that it does, record it.
    const url = `https://8000-${machineRow.external_id}.sandbox.superserve.ai`;
    await query(`UPDATE machines SET preview_url = $2 WHERE id = $1`, [machineRow.id, url]);
  }
  return healthy;
}

/** Connects, resuming a paused machine first. Updates the billing clock. */
async function connect(machine: MachineRow) {
  const Sandbox = await sdk();
  const box = await Sandbox.connect(machine.external_id, { apiKey: requireKey() });

  if (machine.status === 'paused') {
    await box.resume();
    await query(
      `UPDATE machines SET status = 'active', last_started_at = now() WHERE id = $1`,
      [machine.id],
    );
  }

  // Keep the machine's public view alive across pause/resume.
  await ensureServing(box, machine).catch(() => false);
  return box;
}

/**
 * Runs one command on a business's machine and records it. The recording is
 * append-only, so the transcript of what the agent did cannot be rewritten.
 */
export async function run(
  businessId: string,
  command: string,
  opts: { cycleId?: string; timeoutMs?: number } = {},
): Promise<MachineRun> {
  const machine = await forBusiness(businessId);
  if (!machine) throw new Error(`${businessId} has no machine`);

  const box = await connect(machine);
  const startedAt = Date.now();
  const result = await box.commands.run(command, { timeoutMs: opts.timeoutMs ?? 120_000 });
  const durationMs = Date.now() - startedAt;

  const stdout = truncate(result.stdout ?? '');
  const stderr = truncate(result.stderr ?? '');

  await query(
    `INSERT INTO machine_runs
       (id, machine_id, business_id, cycle_id, command, exit_code, stdout, stderr, duration_ms)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
    [id('run'), machine.id, businessId, opts.cycleId ?? '', command, result.exitCode, stdout, stderr, durationMs],
  );
  await query(`UPDATE machines SET last_used_at = now() WHERE id = $1`, [machine.id]);

  return { command, exitCode: result.exitCode, stdout, stderr, durationMs };
}

function truncate(s: string, max = 8000): string {
  return s.length > max ? `${s.slice(0, max)}\n…[${s.length - max} more characters]` : s;
}

// ---------------------------------------------------------------------------
// Metering and lifecycle
// ---------------------------------------------------------------------------

/**
 * Bills elapsed active time as OPEX and pauses machines that have gone idle.
 * Called once per CEO cycle, so an unused machine costs at most one idle window.
 */
export async function meterAndPark(): Promise<{ billed: number; paused: number; healed: number }> {
  const machines = await query<MachineRow>(`SELECT * FROM machines WHERE status = 'active'`);
  let billed = 0;
  let paused = 0;
  let healed = 0;

  for (const machine of machines) {
    const startedAt = machine.last_started_at ? new Date(machine.last_started_at).getTime() : null;
    if (startedAt) {
      const seconds = Math.max(0, Math.floor((Date.now() - startedAt) / 1000));
      const cost = (seconds / 3600) * env.machineCostPerHour;

      // Only post once a period is worth at least a cent, so the ledger does
      // not fill with zero-value rows.
      if (cost >= 0.01) {
        await ledger.post({
          businessId: machine.business_id,
          kind: 'OPEX',
          amountCents: ledger.cents(cost),
          description: `Machine time for ${machine.business_id} (${seconds}s @ $${env.machineCostPerHour}/hr)`,
          source: `machine:${machine.provider}`,
          externalId: `machine:${machine.id}:${Math.floor(Date.now() / 1000)}`,
          meta: { machineId: machine.id, seconds },
        });
        await query(
          `UPDATE machines SET billed_seconds = billed_seconds + $2, last_started_at = now() WHERE id = $1`,
          [machine.id, seconds],
        );
        billed++;
      }
    }

    const idleMs = Date.now() - new Date(machine.last_used_at).getTime();
    if (idleMs > env.machineIdleMinutes * 60_000) {
      try {
        const box = await (await sdk()).connect(machine.external_id, { apiKey: requireKey() });
        await box.pause();
        await query(`UPDATE machines SET status = 'paused' WHERE id = $1`, [machine.id]);
        paused++;
      } catch {
        /* a machine that cannot be paused is retried next cycle */
      }
      continue;
    }

    // Still active: make sure its public view is actually answering. A machine
    // showing 502 in the machine room is indistinguishable from a dead one.
    try {
      const box = await (await sdk()).connect(machine.external_id, { apiKey: requireKey() });
      if (await ensureServing(box, machine)) healed++;
    } catch {
      /* retried next cycle */
    }
  }

  return { billed, paused, healed };
}

/** Kills a business's machine. Called when the business itself is killed. */
export async function kill(businessId: string, reason: string): Promise<boolean> {
  const machine = await forBusiness(businessId);
  if (!machine) return false;

  try {
    const box = await (await sdk()).connect(machine.external_id, { apiKey: requireKey() });
    await box.kill();
  } catch {
    /* already gone upstream; the row still needs closing */
  }

  await query(
    `UPDATE machines SET status = 'killed', killed_at = now(),
            meta = meta || jsonb_build_object('killReason', $2::text)
      WHERE id = $1`,
    [machine.id, reason],
  );
  return true;
}
