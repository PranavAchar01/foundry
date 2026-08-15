import * as machine from '@/lib/machine';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 300;

/**
 * A live view of the actual operating system.
 *
 * Every tick this runs a real command on the business's VM and streams the raw
 * stdout back — `top`, `df`, `ls`. Not a rendered summary of the machine: the
 * machine's own output, verbatim.
 *
 * The command is a fixed constant and nothing from the request reaches the
 * shell. That is deliberate: this endpoint is reachable by anyone who can load
 * the dashboard, so it is a read-only window, never a way to run code on the
 * VM.
 */
const SNAPSHOT = [
  'top -bn1 -w 120 | head -16',
  "echo",
  "echo '── disk ──'",
  'df -h / | tail -1',
  "echo",
  "echo '── workspace ──'",
  'ls -lt --time-style=+%H:%M /root/company 2>/dev/null | head -8',
].join('; ');

const TICK_MS = 3000;
/** Stop well before the platform kills the function, so the client can reconnect cleanly. */
const MAX_MS = 270_000;

export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const encoder = new TextEncoder();

  const stream = new ReadableStream({
    async start(controller) {
      let closed = false;
      const send = (event: string, data: unknown) => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
        } catch {
          closed = true;
        }
      };
      const close = () => {
        if (closed) return;
        closed = true;
        clearInterval(timer);
        clearTimeout(deadline);
        try {
          controller.close();
        } catch {
          /* already closed */
        }
      };

      const box = await machine.forBusiness(id);
      if (!box) {
        send('error', { message: 'this company has no machine' });
        close();
        return;
      }
      send('open', { externalId: box.external_id, provider: box.provider, status: box.status });

      let inFlight = false;
      const tick = async () => {
        if (closed || inFlight) return;
        inFlight = true;
        try {
          const out = await machine.snapshot(id, SNAPSHOT);
          send('frame', { at: new Date().toISOString(), text: out.stdout || out.stderr });
        } catch (err) {
          send('error', { message: String(err).slice(0, 200) });
        } finally {
          inFlight = false;
        }
      };

      const timer = setInterval(tick, TICK_MS);
      const deadline = setTimeout(close, MAX_MS);
      void tick();
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
