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
    ['/root/company/.serve_version', SERVE_VERSION],
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

/**
 * Bumped whenever serve.pl changes. `ensureServing` compares this against the
 * copy on disk and reinstalls when they differ, so machines provisioned by an
 * older build get the current view without being rebuilt.
 */
export const SERVE_VERSION = '2';

const SERVE_PL = String.raw`#!/usr/bin/perl
# The machine's own status page. Everything below is read live from this VM on
# each request -- /proc, df, ps -- so the page is evidence the machine is
# running, not a description of it.
use strict; use warnings;
use IO::Socket::INET;
$| = 1;
my $root = $ARGV[0] || '/root/company';
my $port = $ARGV[1] || 8000;
my %TYPES = (html=>'text/html', txt=>'text/plain', md=>'text/plain', json=>'application/json',
             css=>'text/css', js=>'text/javascript', svg=>'image/svg+xml', log=>'text/plain');

sub slurp { my ($f) = @_; open(my $h, '<', $f) or return ''; local $/; my $d = <$h>; close $h; return $d // ''; }
sub esc { my $t = shift // ''; $t =~ s/&/&amp;/g; $t =~ s/</&lt;/g; $t =~ s/>/&gt;/g; return $t; }
sub human { my $b = shift || 0; return sprintf('%.1f GB', $b/1073741824) if $b >= 1073741824;
            return sprintf('%.0f MB', $b/1048576) if $b >= 1048576;
            return sprintf('%.0f KB', $b/1024) if $b >= 1024; return $b . ' B'; }
sub dur { my $s = int(shift || 0); my $d = int($s/86400); my $h = int(($s%86400)/3600);
          my $m = int(($s%3600)/60);
          return $d . 'd ' . $h . 'h' if $d; return $h . 'h ' . $m . 'm' if $h; return $m . 'm'; }

sub stats {
  my %s;
  my $up = slurp('/proc/uptime'); $s{uptime} = (split /\s+/, $up)[0] || 0;
  my $load = slurp('/proc/loadavg'); my @l = split /\s+/, $load;
  $s{load} = join(' ', @l[0..2]) if @l >= 3; $s{load} ||= 'n/a';
  my $mi = slurp('/proc/meminfo');
  my ($tot) = $mi =~ /MemTotal:\s+(\d+)/;  my ($av) = $mi =~ /MemAvailable:\s+(\d+)/;
  $s{mem_total} = ($tot || 0) * 1024; $s{mem_used} = (($tot || 0) - ($av || 0)) * 1024;
  $s{procs} = qx{ps -e --no-headers 2>/dev/null | wc -l}; chomp $s{procs}; $s{procs} =~ s/\s//g;
  my $df = qx{df -Pk / 2>/dev/null | tail -1}; my @d = split /\s+/, ($df || '');
  $s{disk_used} = (@d > 2 ? $d[2] : 0) * 1024; $s{disk_total} = (@d > 1 ? $d[1] : 0) * 1024;
  $s{host} = qx{hostname 2>/dev/null}; chomp $s{host}; $s{host} ||= 'sandbox';
  $s{kernel} = qx{uname -sr 2>/dev/null}; chomp $s{kernel};
  return \%s;
}

sub bar {
  my ($used, $total) = @_;
  my $pct = $total > 0 ? int(100 * $used / $total) : 0;
  $pct = 100 if $pct > 100;
  return '<div class="bar"><i style="width:' . $pct . '%"></i></div><div class="cap">'
       . human($used) . ' of ' . human($total) . ' &middot; ' . $pct . '%</div>';
}

sub workspace {
  my $out = ''; my $n = 0;
  opendir(my $dh, $root) or return '<tr><td>unreadable</td></tr>';
  my @files = sort grep { $_ ne '.' && $_ ne '..' } readdir($dh);
  closedir $dh;
  for my $f (@files) {
    my $path = $root . '/' . $f;
    my @st = stat($path); next unless @st;
    my $isdir = -d $path;
    my $age = time() - $st[9];
    $out .= '<tr><td><a href="/' . esc($f) . ($isdir ? '/' : '') . '">' . esc($f)
          . ($isdir ? '/' : '') . '</a></td><td class="r">' . ($isdir ? '&mdash;' : human($st[7]))
          . '</td><td class="r dim">' . dur($age) . ' ago</td></tr>';
    $n++;
  }
  return $out || '<tr><td class="dim">empty</td><td></td><td></td></tr>';
}

sub procs {
  my $ps = qx{ps -eo pid,etime,comm --no-headers 2>/dev/null | head -8};
  my $out = '';
  for my $line (split /\n/, ($ps || '')) {
    $line =~ s/^\s+//;
    my ($pid, $et, $cmd) = split /\s+/, $line, 3;
    next unless defined $cmd;
    $out .= '<tr><td class="dim">' . esc($pid) . '</td><td>' . esc($cmd)
          . '</td><td class="r dim">' . esc($et) . '</td></tr>';
  }
  return $out || '<tr><td class="dim">none</td><td></td><td></td></tr>';
}

sub machine_page {
  my $s = stats();
  my $cj = slurp($root . '/company.json');
  my ($company) = $cj =~ /"name"\s*:\s*"([^"]*)"/;
  my ($niche)   = $cj =~ /"niche"\s*:\s*"([^"]*)"/;
  $company ||= 'company'; $niche ||= '';
  my $notes = slurp($root . '/NOTES.md'); $notes = substr($notes, -1200);
  my $css = '
 :root{--bg:#fff;--grey:#f5f5f7;--line:#d2d2d7;--fg:#1d1d1f;--muted:#6e6e73;--dim:#86868b}
 *{box-sizing:border-box;margin:0;padding:0}
 body{background:var(--bg);color:var(--fg);letter-spacing:-.01em;line-height:1.5;padding:48px 28px 72px;
  max-width:900px;margin:0 auto;-webkit-font-smoothing:antialiased;
  font-family:-apple-system,BlinkMacSystemFont,"SF Pro Display","SF Pro Text","Helvetica Neue",Helvetica,Arial,sans-serif}
 h1{font-size:32px;font-weight:600;letter-spacing:-.03em}
 .sub{color:var(--muted);font-size:14px;margin:4px 0 30px}
 .dot{display:inline-block;width:7px;height:7px;border-radius:50%;background:var(--fg);margin-right:7px;
  animation:p 1.8s ease-in-out infinite}
 @keyframes p{0%,100%{opacity:1}50%{opacity:.25}}
 .grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(190px,1fr));gap:12px;margin-bottom:28px}
 .card{background:var(--grey);border:1px solid var(--line);border-radius:16px;padding:16px 18px}
 .k{font-size:11px;font-weight:600;letter-spacing:.04em;text-transform:uppercase;color:var(--dim)}
 .v{font-size:24px;font-weight:600;letter-spacing:-.02em;margin-top:5px;
  font-variant-numeric:tabular-nums}
 .cap{font-size:11.5px;color:var(--dim);margin-top:6px;font-variant-numeric:tabular-nums}
 .bar{height:4px;background:#e3e3e6;border-radius:99px;overflow:hidden;margin-top:10px}
 .bar i{display:block;height:100%;background:var(--fg)}
 h2{font-size:11px;font-weight:600;letter-spacing:.04em;text-transform:uppercase;color:var(--dim);
  margin:0 0 10px}
 section{margin-bottom:26px}
 table{width:100%;border-collapse:collapse;font-size:14px}
 td{padding:9px 0;border-bottom:1px solid var(--line)}
 td.r{text-align:right;font-variant-numeric:tabular-nums}
 .dim{color:var(--dim)}
 a{color:var(--fg);text-decoration:none;font-weight:500}
 a:hover{text-decoration:underline}
 pre{background:var(--grey);border:1px solid var(--line);border-radius:14px;padding:16px;
  font:12.5px/1.6 ui-monospace,"SF Mono",Menlo,monospace;white-space:pre-wrap;word-break:break-word;
  color:var(--muted);max-height:220px;overflow:auto}
 footer{margin-top:34px;padding-top:18px;border-top:1px solid var(--line);font-size:12px;color:var(--dim)}
';
  my $html = '<!doctype html><html><head><meta charset="utf-8">'
    . '<meta name="viewport" content="width=device-width,initial-scale=1">'
    . '<meta http-equiv="refresh" content="5">'
    . '<title>' . esc($s->{host}) . ' &middot; machine</title><style>' . $css . '</style></head><body>'
    . '<h1>' . esc($company) . '</h1>'
    . '<div class="sub"><span class="dot"></span>live virtual machine &middot; '
    . esc($s->{host}) . ' &middot; ' . esc($s->{kernel})
    . ($niche ? ' &middot; ' . esc($niche) : '') . ' &middot; refreshes every 5s</div>'
    . '<div class="grid">'
    . '<div class="card"><div class="k">uptime</div><div class="v">' . dur($s->{uptime}) . '</div>'
    . '<div class="cap">load ' . esc($s->{load}) . '</div></div>'
    . '<div class="card"><div class="k">memory</div><div class="v">'
    . human($s->{mem_used}) . '</div>' . bar($s->{mem_used}, $s->{mem_total}) . '</div>'
    . '<div class="card"><div class="k">disk</div><div class="v">'
    . human($s->{disk_used}) . '</div>' . bar($s->{disk_used}, $s->{disk_total}) . '</div>'
    . '<div class="card"><div class="k">processes</div><div class="v">' . esc($s->{procs}) . '</div>'
    . '<div class="cap">running now</div></div>'
    . '</div>'
    . '<section><h2>Processes</h2><table>' . procs() . '</table></section>'
    . '<section><h2>Operator workspace</h2><table>' . workspace() . '</table></section>';
  if ($notes) {
    $html .= '<section><h2>NOTES.md (tail)</h2><pre>' . esc($notes) . '</pre></section>';
  }
  $html .= '<footer>Served by this machine from its own /proc. '
        . 'This business is operated end-to-end by an AI agent. No human wrote this.</footer>'
        . '</body></html>';
  return $html;
}

my $sock = IO::Socket::INET->new(LocalAddr=>'0.0.0.0', LocalPort=>$port, Listen=>16,
                                 ReuseAddr=>1, Proto=>'tcp') or die "bind: $!";
sub send_res {
  my ($c, $code, $type, $body) = @_;
  my $len = length($body);
  print $c "HTTP/1.1 " . $code . "\r\nContent-Type: " . $type . "\r\nContent-Length: " . $len . "\r\n"
         . "Access-Control-Allow-Origin: *\r\nCache-Control: no-store\r\nConnection: close\r\n\r\n" . $body;
}
sub listing {
  my ($dir, $rel) = @_;
  opendir(my $dh, $dir) or return '<tr><td>cannot read</td></tr>';
  my @e = sort grep { $_ ne '.' && $_ ne '..' } readdir($dh);
  closedir $dh;
  my $out = '';
  for my $f (@e) {
    my $isdir = -d ($dir . '/' . $f);
    my $size = $isdir ? '&mdash;' : human(-s ($dir . '/' . $f));
    $out .= '<tr><td><a href="' . $rel . esc($f) . ($isdir ? '/' : '') . '">' . esc($f)
          . ($isdir ? '/' : '') . '</a></td><td class="r dim">' . $size . '</td></tr>';
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
  $path =~ s{\.\./}{}g;
  if ($path eq '/') {
    send_res($c, '200 OK', 'text/html', machine_page());
  } else {
    my $target = $root . $path;
    if (-d $target) {
      my $rel = $path; $rel .= '/' unless $rel =~ m{/$};
      send_res($c, '200 OK', 'text/html',
        '<!doctype html><meta charset=utf-8><title>' . esc($path) . '</title>'
        . '<style>body{background:#fff;color:#1d1d1f;padding:40px;max-width:720px;margin:0 auto;'
        . 'font:15px/1.5 -apple-system,BlinkMacSystemFont,"SF Pro Text","Helvetica Neue",Helvetica,Arial,sans-serif;'
        . 'letter-spacing:-.01em}a{color:#1d1d1f;text-decoration:none;font-weight:500}'
        . 'a:hover{text-decoration:underline}table{width:100%;border-collapse:collapse}'
        . 'td{padding:10px 0;border-bottom:1px solid #d2d2d7}td.r{text-align:right}'
        . '.dim{color:#86868b}h1{font-size:12px;font-weight:600;letter-spacing:.04em;'
        . 'text-transform:uppercase;color:#86868b;margin-bottom:14px}</style>'
        . '<h1>' . esc($path) . '</h1><table>' . listing($target, $rel) . '</table>'
        . '<p style="margin-top:20px"><a href="/">&larr; machine status</a></p>');
    } elsif (-f $target) {
      my ($ext) = $target =~ /\.(\w+)$/;
      my $type = ($ext && $TYPES{lc $ext}) ? $TYPES{lc $ext} : 'text/plain';
      send_res($c, '200 OK', $type, slurp($target));
    } else {
      send_res($c, '404 Not Found', 'text/plain', 'not found: ' . $path);
    }
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
- **Price**: $${(spec.priceCents / 100).toFixed(2)} per ${env.billingInterval}, recurring
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
  box: {
    commands: { run: (c: string, o?: { timeoutMs?: number }) => Promise<{ stdout?: string }> };
    files: { write: (path: string, content: string) => Promise<unknown> };
  },
  machineRow: MachineRow,
): Promise<boolean> {
  const shell = async (cmd: string) =>
    ((await box.commands.run(cmd).catch(() => ({ stdout: '' }))).stdout ?? '').trim();

  const health = () =>
    shell(`curl -s -o /dev/null -w '%{http_code}' --max-time 3 http://127.0.0.1:8000/ || true`);

  // A machine provisioned by an older build is serving an older page. Compare
  // the installed version and reinstall in place rather than rebuilding the VM.
  const installed = await shell('cat /root/company/.serve_version 2>/dev/null || echo 0');
  const stale = installed !== SERVE_VERSION;

  if (!stale && (await health()) === '200') return true;

  if (stale) {
    await box.files.write('/root/company/serve.pl', SERVE_PL).catch(() => {});
    await box.files.write('/root/company/.serve_version', SERVE_VERSION).catch(() => {});
    await shell('pkill -f serve.pl || true');
    await shell('rm -f /root/company/index.html');
  }

  await shell('chmod +x /root/company/serve.pl');
  await box.commands.run(LAUNCH_SERVER).catch(() => {});
  await new Promise((r) => setTimeout(r, 1400));

  const healthy = (await health()) === '200';

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

/**
 * A read-only snapshot of the machine, for the live console.
 *
 * Deliberately separate from `run()`: it does not write to `machine_runs` and
 * does not touch `last_used_at`, because a human watching the console is not
 * the operator agent doing work — recording it would pollute the transcript and
 * keep an idle machine awake forever.
 */
export async function snapshot(
  businessId: string,
  command: string,
): Promise<{ stdout: string; stderr: string }> {
  const row = await forBusiness(businessId);
  if (!row) throw new Error(`${businessId} has no machine`);

  const box = await (await sdk()).connect(row.external_id, { apiKey: requireKey() });

  // A parked machine has to be woken before it can answer. `resume()` conflicts
  // if a wake is already in flight — from another viewer, or from the CEO cycle
  // — so treat that as "someone else is already doing it" and wait for the
  // machine to come up rather than failing the view.
  if (row.status === 'paused') {
    await box.resume().catch((err: unknown) => {
      if (!/conflict/i.test(String(err))) throw err;
    });
    for (let i = 0; i < 12; i++) {
      const info = await box.getInfo().catch(() => null);
      if (info?.status === 'active') break;
      await new Promise((r) => setTimeout(r, 1000));
    }
    await query(`UPDATE machines SET status = 'active', last_started_at = now() WHERE id = $1`, [row.id]);
  }

  const res = await box.commands.run(command, { timeoutMs: 15_000 });
  return { stdout: res.stdout ?? '', stderr: res.stderr ?? '' };
}

/**
 * Reinstalls the current serve.pl on every live machine and reports what each
 * one ended up serving. Used by /api/machines/upgrade.
 */
export async function upgradeAll(): Promise<
  { businessId: string; externalId: string; ok: boolean; detail: string }[]
> {
  const machines = await list();
  const out: { businessId: string; externalId: string; ok: boolean; detail: string }[] = [];

  for (const m of machines) {
    try {
      const box = await (await sdk()).connect(m.external_id, { apiKey: requireKey() });
      if (m.status === 'paused') await box.resume().catch(() => {});
      const ok = await ensureServing(box, m);
      const version = await box.commands
        .run('cat /root/company/.serve_version 2>/dev/null || echo 0')
        .catch(() => ({ stdout: '' }));
      out.push({
        businessId: m.business_id,
        externalId: m.external_id,
        ok,
        detail: `serving=${ok} version=${(version.stdout ?? '').trim() || 'unknown'}`,
      });
      if (m.status === 'paused') {
        await query(`UPDATE machines SET status = 'active', last_started_at = now() WHERE id = $1`, [m.id]);
      }
    } catch (err) {
      out.push({
        businessId: m.business_id,
        externalId: m.external_id,
        ok: false,
        detail: String(err).slice(0, 200),
      });
    }
  }
  return out;
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
