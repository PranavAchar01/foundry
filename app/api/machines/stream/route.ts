import { query } from '@/lib/db';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 300;

interface RunRow {
  id: string;
  business_id: string;
  machine_id: string;
  command: string;
  exit_code: number;
  stdout: string;
  stderr: string;
  duration_ms: number;
  created_at: string;
}

/**
 * Live shell feed from every business machine.
 *
 * Polls the append-only `machine_runs` table and pushes anything new, so the
 * dashboard shows commands landing on each VM as they happen rather than on a
 * refresh. Paired with /api/machines for the initial snapshot.
 */
export async function GET(req: Request) {
  const encoder = new TextEncoder();
  let cursor =
    new URL(req.url).searchParams.get('since') ??
    new Date(Date.now() - 30 * 60 * 1000).toISOString();

  const stream = new ReadableStream({
    async start(controller) {
      let closed = false;
      const send = (event: string, data: unknown) => {
        if (closed) return;
        controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
      };
      const close = () => {
        if (closed) return;
        closed = true;
        clearInterval(timer);
        try {
          controller.close();
        } catch {
          /* already closed */
        }
      };

      req.signal.addEventListener('abort', close);
      send('open', { at: new Date().toISOString(), since: cursor });

      const tick = async () => {
        if (closed) return;
        try {
          const rows = await query<RunRow>(
            `SELECT id, business_id, machine_id, command, exit_code,
                    LEFT(stdout, 4000) AS stdout, LEFT(stderr, 1000) AS stderr,
                    duration_ms, created_at
               FROM machine_runs
              WHERE created_at > $1
              ORDER BY created_at ASC, id ASC
              LIMIT 40`,
            [cursor],
          );
          for (const row of rows) {
            cursor = row.created_at;
            send('run', row);
          }

          // Status transitions are what make a boot visible.
          const states = await query<{ id: string; business_id: string; status: string; preview_url: string }>(
            `SELECT id, business_id, status, preview_url FROM machines WHERE status <> 'killed'`,
          );
          send('machines', states);
        } catch (err) {
          send('error', { message: String(err).slice(0, 200) });
        }
      };

      const timer = setInterval(tick, 2500);
      await tick();
      setTimeout(close, 280_000);
    },
  });

  return new Response(stream, {
    headers: {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    },
  });
}
