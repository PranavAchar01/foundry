import { env } from './env';
import { id, one, query } from './db';
import * as decisions from './decisions';
import * as businesses from './businesses';
import { brain, type ToolSpec } from './brain';
import { supportProvider } from './providers';
import * as x from './x';
import * as cohort from './cohort';

/**
 * The sales conversation.
 *
 * Foundry opens with a short DM, then works whatever comes back until the deal
 * closes. Three things keep that from becoming a machine that pesters people:
 *
 *   - `state` has terminal values. Nothing is ever sent into WON or LOST.
 *   - `agent_turns` caps how many times it will reply at all.
 *   - a reply is only ever sent in response to an inbound message, so silence
 *     ends the conversation rather than triggering a follow-up.
 *
 * Closing is not something the agent asserts. WON is set by the Stripe webhook
 * when money actually arrives; the agent can only move a conversation as far as
 * CLOSING.
 */

const MAX_AGENT_TURNS = 6;

export interface Conversation {
  id: string;
  business_id: string | null;
  segment_id: string | null;
  username: string;
  x_user_id: string;
  state: 'OPENED' | 'ENGAGED' | 'OBJECTION' | 'CLOSING' | 'WON' | 'LOST' | 'HANDED_OFF';
  agent_turns: number;
  last_inbound_at: string | null;
  last_outbound_at: string | null;
  close_reason: string;
  support_channel: string;
  meta: Record<string, unknown>;
  created_at: string;
}

export interface Message {
  id: string;
  conversation_id: string;
  direction: 'out' | 'in';
  channel: string;
  text: string;
  model: string;
  created_at: string;
}

const TERMINAL = new Set(['WON', 'LOST', 'HANDED_OFF']);

// ---------------------------------------------------------------------------
// Opening
// ---------------------------------------------------------------------------

export async function open(opts: {
  username: string;
  xUserId: string;
  businessId: string | null;
  segmentId: string | null;
  text: string;
  externalId?: string | null;
}): Promise<Conversation> {
  const rows = await query<Conversation>(
    `INSERT INTO conversations (id, business_id, segment_id, username, x_user_id, state, last_outbound_at)
     VALUES ($1,$2,$3,$4,$5,'OPENED', now())
     ON CONFLICT (username) DO UPDATE SET
       business_id = EXCLUDED.business_id, last_outbound_at = now(), updated_at = now()
     RETURNING *`,
    [id('cnv'), opts.businessId, opts.segmentId, opts.username, opts.xUserId],
  );
  const conversation = rows[0];
  await record(conversation.id, 'out', opts.text, { externalId: opts.externalId ?? null });
  return conversation;
}

export async function record(
  conversationId: string,
  direction: 'out' | 'in',
  text: string,
  opts: { externalId?: string | null; model?: string; channel?: string } = {},
): Promise<void> {
  await query(
    `INSERT INTO conversation_messages (id, conversation_id, direction, channel, external_id, text, model)
     VALUES ($1,$2,$3,$4,$5,$6,$7)
     ON CONFLICT (channel, external_id) DO NOTHING`,
    [
      id('msg'),
      conversationId,
      direction,
      opts.channel ?? 'x',
      opts.externalId ?? null,
      text.slice(0, 4000),
      opts.model ?? '',
    ],
  );
}

export async function forUsername(username: string): Promise<Conversation | null> {
  return one<Conversation>(`SELECT * FROM conversations WHERE username = $1`, [
    username.replace(/^@/, ''),
  ]);
}

export async function forXUserId(xUserId: string): Promise<Conversation | null> {
  return one<Conversation>(`SELECT * FROM conversations WHERE x_user_id = $1`, [xUserId]);
}

export async function list(): Promise<Conversation[]> {
  return query<Conversation>(`SELECT * FROM conversations ORDER BY updated_at DESC LIMIT 50`);
}

export async function transcript(conversationId: string): Promise<Message[]> {
  return query<Message>(
    `SELECT * FROM conversation_messages WHERE conversation_id = $1 ORDER BY created_at ASC`,
    [conversationId],
  );
}

// ---------------------------------------------------------------------------
// Replying
// ---------------------------------------------------------------------------

const REPLY_TOOL: ToolSpec = {
  name: 'reply',
  description: 'Decide how to answer the latest message in a sales conversation.',
  schema: {
    type: 'object',
    properties: {
      state: {
        type: 'string',
        enum: ['ENGAGED', 'OBJECTION', 'CLOSING', 'LOST', 'HANDED_OFF'],
        description:
          'ENGAGED: interested, keep talking. OBJECTION: they raised a concern to answer. ' +
          'CLOSING: they are ready and the link is what they need. LOST: they declined, are not a ' +
          'fit, or asked to stop. HANDED_OFF: they need a human.',
      },
      message: {
        type: 'string',
        description:
          'What to send. Under 320 characters. Empty string when state is LOST and no reply ' +
          'is warranted.',
      },
      reasoning: {
        type: 'string',
        description: 'One or two sentences: what they said and why you answered that way.',
      },
    },
    required: ['state', 'message', 'reasoning'],
  },
};

function replySystem(ctx: {
  productName: string;
  offer: string;
  priceUsd: string;
  url: string;
  interval: string;
}): string {
  return `You are FOUNDRY answering a DM about a product it built and sells.

The product:
- ${ctx.productName}
- ${ctx.offer}
- $${ctx.priceUsd} per ${ctx.interval}, cancel any time
- ${ctx.url}

How you talk:
- Short. Under 320 characters. This is a DM, not an email.
- Answer the actual question first. Do not restate the pitch.
- Never invent features, customers, numbers, integrations or results. If you do not know, say so
  and offer to find out.
- One link, and only when it is the useful next step.
- If they say no, are not a fit, or ask you to stop: set LOST, and either say nothing or thank
  them in one line. Never push twice.
- If they need something you cannot answer — refunds, an edge case, anything account-specific —
  set HANDED_OFF.
- You are an AI operating this business. If asked, say so plainly.

You cannot mark a deal won. Money arriving is what closes it, not your judgement.`;
}

export interface ReplyOutcome {
  conversationId: string;
  username: string;
  replied: boolean;
  state: Conversation['state'];
  message: string;
  reasoning: string;
  error: string | null;
}

/** Generates and sends one reply to the latest inbound message. */
export async function respond(conversation: Conversation): Promise<ReplyOutcome> {
  const base = {
    conversationId: conversation.id,
    username: conversation.username,
    state: conversation.state,
  };

  if (TERMINAL.has(conversation.state)) {
    return { ...base, replied: false, message: '', reasoning: 'conversation is closed', error: null };
  }
  if (conversation.agent_turns >= MAX_AGENT_TURNS) {
    await close(conversation.id, 'HANDED_OFF', `reached the ${MAX_AGENT_TURNS}-reply cap`);
    return {
      ...base, replied: false, message: '', state: 'HANDED_OFF',
      reasoning: 'hit the reply cap; handed to a human rather than continuing',
      error: null,
    };
  }

  const business = conversation.business_id ? await businesses.get(conversation.business_id) : null;
  const history = await transcript(conversation.id);
  const lastInbound = [...history].reverse().find((m) => m.direction === 'in');
  if (!lastInbound) {
    return { ...base, replied: false, message: '', reasoning: 'nothing inbound to answer', error: null };
  }

  const thinker = brain();
  let out;
  try {
    out = await thinker.structured<{ state: Conversation['state']; message: string; reasoning: string }>({
      system: replySystem({
        productName: business?.name ?? 'the product',
        offer: business?.tagline ?? '',
        priceUsd: ((business?.price_cents ?? 500) / 100).toFixed(2),
        url: business?.url ?? env.publicUrl,
        interval: business?.billing_interval ?? 'month',
      }),
      prompt: history
        .map((m) => `${m.direction === 'out' ? 'FOUNDRY' : conversation.username}: ${m.text}`)
        .join('\n'),
      tool: REPLY_TOOL,
      maxTokens: 900,
    });
  } catch (err) {
    return {
      ...base, replied: false, message: '',
      reasoning: 'could not generate a reply',
      error: String(err).slice(0, 200),
    };
  }

  const state = out.value.state;
  const message = String(out.value.message ?? '').slice(0, 320).trim();

  // A conversation that ended does not get another message.
  if (!message || state === 'LOST') {
    await close(conversation.id, state === 'LOST' ? 'LOST' : 'ENGAGED', out.value.reasoning);
    await logDecision(conversation, state, '', out.value.reasoning, out.model);
    return { ...base, replied: false, message: '', state, reasoning: out.value.reasoning, error: null };
  }

  // The allowlist still governs every outbound write.
  const allowed = await cohort.isAllowed(conversation.username);
  if (!allowed) {
    return {
      ...base, replied: false, message: '',
      reasoning: 'not on the contact allowlist', error: 'blocked by allowlist',
    };
  }

  const sent = await x.sendDm(conversation.x_user_id, message);
  if (!sent.ok) {
    return { ...base, replied: false, message, reasoning: out.value.reasoning, error: sent.error };
  }

  await record(conversation.id, 'out', message, { externalId: sent.id, model: out.model });
  await query(
    `UPDATE conversations SET state = $2, agent_turns = agent_turns + 1,
            last_outbound_at = now(), updated_at = now() WHERE id = $1`,
    [conversation.id, state === 'HANDED_OFF' ? 'HANDED_OFF' : state],
  );

  if (state === 'HANDED_OFF') await handOff(conversation, out.value.reasoning);
  await logDecision(conversation, state, message, out.value.reasoning, out.model);

  return { ...base, replied: true, message, state, reasoning: out.value.reasoning, error: null };
}

async function logDecision(
  conversation: Conversation,
  state: string,
  message: string,
  reasoning: string,
  model: string,
) {
  await decisions.record({
    cycleId: `conv_${conversation.id}`,
    businessId: conversation.business_id,
    action: `CONVERSATION_${state}`,
    reasoning: `@${conversation.username}: ${reasoning}${message ? ` Replied: "${message}"` : ''}`,
    confidence: 0.7,
    model,
    inputs: { username: conversation.username, turns: conversation.agent_turns },
    outputs: { state, message },
  });
}

// ---------------------------------------------------------------------------
// Closing and handing off
// ---------------------------------------------------------------------------

export async function close(
  conversationId: string,
  state: Conversation['state'],
  reason: string,
): Promise<void> {
  const terminal = TERMINAL.has(state);
  await query(
    `UPDATE conversations SET state = $2, close_reason = $3,
            closed_at = CASE WHEN $4 THEN now() ELSE closed_at END, updated_at = now()
      WHERE id = $1`,
    [conversationId, state, reason.slice(0, 500), terminal],
  );
}

/**
 * Money arrived. Only the Stripe webhook calls this — the agent can talk a
 * conversation to CLOSING but cannot declare it won.
 */
export async function markWon(businessId: string, note: string): Promise<Conversation | null> {
  const row = await one<Conversation>(
    `UPDATE conversations SET state = 'WON', close_reason = $2, closed_at = now(), updated_at = now()
      WHERE business_id = $1 AND state NOT IN ('WON','LOST')
      RETURNING *`,
    [businessId, note.slice(0, 500)],
  );
  if (row) await handOff(row, 'deal closed — moving to support');
  return row;
}

/**
 * Support handoff. Once someone is a customer the relationship stops being a
 * sale, so it moves to the support channel — Linq when it is configured, which
 * is what that product is for.
 */
async function handOff(conversation: Conversation, why: string): Promise<void> {
  const provider = supportProvider();
  let channel = 'none';
  try {
    if (provider.info.configured) {
      const contact = (conversation.meta?.phone as string) ?? '';
      if (contact) {
        await provider.send({
          to: contact,
          subject: 'Foundry support',
          body:
            `Thanks — you're set up. This number is your support line from here; ` +
            `reply any time and a person or the operating agent will pick it up.`,
        });
        channel = provider.info.name;
      } else {
        // No phone number yet: record the intent so the handoff is visible
        // rather than silently skipped.
        channel = `${provider.info.name}:awaiting-contact`;
      }
    }
  } catch {
    channel = `${provider.info.name}:failed`;
  }

  await query(
    `UPDATE conversations SET support_channel = $2, updated_at = now() WHERE id = $1`,
    [conversation.id, channel],
  );
  await decisions.record({
    cycleId: `conv_${conversation.id}`,
    businessId: conversation.business_id,
    action: 'SUPPORT_HANDOFF',
    reasoning: `@${conversation.username} handed to support via ${channel}: ${why}`,
    confidence: 1,
    model: 'guardrail',
    outputs: { channel },
  });
}

// ---------------------------------------------------------------------------
// Polling for inbound
// ---------------------------------------------------------------------------

export interface PollResult {
  fetched: number;
  matched: number;
  replies: ReplyOutcome[];
  error: string | null;
}

/**
 * Reads recent DM events, files anything new against its conversation, and
 * answers the ones that are still open.
 */
export async function poll(): Promise<PollResult> {
  const events = await x.dmEvents(50);
  if (events.error) return { fetched: 0, matched: 0, replies: [], error: events.error };

  const account = await x.account();
  const selfId = account?.x_user_id ?? '';
  let matched = 0;
  const touched = new Set<string>();

  for (const e of events.events) {
    if (!e.senderId || e.senderId === selfId) continue; // our own echoes
    const conversation = await forXUserId(e.senderId);
    if (!conversation) continue;
    matched++;
    await record(conversation.id, 'in', e.text, { externalId: e.id });
    await query(
      `UPDATE conversations SET last_inbound_at = now(), updated_at = now(),
              state = CASE WHEN state = 'OPENED' THEN 'ENGAGED' ELSE state END
        WHERE id = $1`,
      [conversation.id],
    );
    touched.add(conversation.id);
  }

  const replies: ReplyOutcome[] = [];
  for (const conversationId of touched) {
    const fresh = await one<Conversation>(`SELECT * FROM conversations WHERE id = $1`, [conversationId]);
    if (fresh) replies.push(await respond(fresh));
  }

  return { fetched: events.events.length, matched, replies, error: null };
}
