import * as decisions from '@/lib/decisions';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 300;

/**
 * Server-sent events for the allocation log. Polls the append-only decisions
 * table and pushes anything newer than the last cursor, so the dashboard shows
 * the agent thinking without a page refresh.
 */
export async function GET(req: Request) {
  const encoder = new TextEncoder();
  let cursor = new URL(req.url).searchParams.get('since') ?? new Date(Date.now() - 60 * 60 * 1000).toISOString();

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
          const rows = await decisions.since(cursor, 25);
          for (const row of rows) {
            cursor = row.created_at;
            send('decision', row);
          }
          send('heartbeat', { at: new Date().toISOString() });
        } catch (err) {
          send('error', { message: String(err).slice(0, 200) });
        }
      };

      const timer = setInterval(tick, 3000);
      await tick();

      // Vercel caps a function at maxDuration; end cleanly before it is killed.
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
