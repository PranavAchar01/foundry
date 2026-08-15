import * as conversation from '@/lib/conversation';
import { errorMessage, json } from '@/lib/http';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 300;

/** Every live sales conversation with its transcript. */
export async function GET() {
  try {
    const conversations = await conversation.list();
    const withTranscripts = await Promise.all(
      conversations.map(async (c) => ({
        id: c.id,
        username: c.username,
        state: c.state,
        agentTurns: c.agent_turns,
        businessId: c.business_id,
        supportChannel: c.support_channel,
        closeReason: c.close_reason,
        lastInboundAt: c.last_inbound_at,
        messages: (await conversation.transcript(c.id)).map((m) => ({
          direction: m.direction,
          text: m.text,
          createdAt: m.created_at,
        })),
      })),
    );
    return json({ conversations: withTranscripts });
  } catch (err) {
    return json({ error: errorMessage(err) }, { status: 500 });
  }
}

/**
 * Pull inbound DMs and answer anything still open.
 *
 * Safe to call repeatedly: messages are deduplicated on their X event id, and a
 * reply is only ever generated in response to something inbound — so polling an
 * idle conversation sends nothing.
 */
export async function POST() {
  try {
    const result = await conversation.poll();
    return json(result, { status: result.error ? 502 : 200 });
  } catch (err) {
    return json({ error: errorMessage(err) }, { status: 500 });
  }
}
