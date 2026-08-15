import * as cohort from '@/lib/cohort';
import * as conversation from '@/lib/conversation';
import * as decisions from '@/lib/decisions';
import * as personal from '@/lib/personal';
import * as prospects from '@/lib/prospects';
import * as x from '@/lib/x';
import * as session from '@/lib/session';
import { errorMessage, json } from '@/lib/http';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 300;

/**
 * Stage three: follow one person and send them the opener for the thing that
 * was just built for them.
 *
 * The allowlist is the whole safety story. It is read before the opener is
 * written — no point spending a model call on someone who cannot be messaged —
 * and read again immediately before the follow and the DM, so a handle removed
 * mid-run is not written to by a request that started before the removal.
 *
 * The message goes out as the visitor's own X account, never the deployment's.
 * A request with no connected session is refused rather than falling back,
 * because the fallback would be a stranger messaging from the owner's handle.
 */
export async function POST(req: Request) {
  const body = (await req.json().catch(() => ({}))) as { runId?: string; username?: string };
  const runId = String(body.runId ?? '').trim();
  const username = String(body.username ?? '').replace(/^@/, '').trim();

  const fail = (error: string, status: number, message: string | null = null) =>
    json({ username, followed: false, dmSent: false, message, error }, { status });

  if (!runId || !username) return fail('runId and username are required', 400);

  const sessionId = await session.currentId();
  if (!sessionId) return fail('connect your own X account before sending', 401);
  const actor: x.XActor = { sessionId };
  if (!(await x.account(actor))) {
    return fail('connect your own X account before sending', 401);
  }

  try {
    const member = await cohort.isAllowed(username);
    if (!member) return fail('not on the allowlist', 403);
    if (!member.x_user_id) return fail('no resolved X id', 409);

    const prepared = await personal.draftFor(runId, username);
    if (!prepared) return fail('this run has not built anything for this person yet', 409);
    const { draft, model, business } = prepared;

    // Belt and braces: re-check the allowlist immediately before writing.
    const gate = await cohort.isAllowed(username);
    if (!gate || !gate.x_user_id) {
      return fail(gate ? 'no resolved X id' : 'not on the allowlist', 403, draft.message);
    }

    let followed = gate.followed;
    if (!followed) {
      const f = await x.follow(actor, gate.x_user_id);
      followed = f.ok;
      if (f.ok) await cohort.markFollowed(username);
    }

    const sent = await x.sendDm(actor, gate.x_user_id, draft.message);
    if (sent.ok) {
      await cohort.markDmSent(username);
      await prospects.markSent(draft.id);
      // Opening a conversation is what puts this person under the reply agent:
      // from here it answers what comes back until it closes.
      await conversation.open({
        username: gate.username,
        xUserId: gate.x_user_id,
        businessId: business.id,
        segmentId: null,
        text: draft.message,
        externalId: sent.id,
      });
    }

    await decisions.record({
      cycleId: runId,
      businessId: business.id,
      action: 'PERSON_REACHED',
      reasoning:
        `${sent.ok ? 'Sent' : 'Failed to send'} @${username} the opener for "${business.name}", ` +
        `the business this run built for them at $${(business.price_cents / 100).toFixed(2)}/mo` +
        `${followed ? ', and followed them' : ''}. ` +
        (sent.ok
          ? 'They are now under the reply agent, which answers what comes back.'
          : `X rejected the message: ${sent.error}.`) +
        ' The allowlist was checked immediately before the write, which is what makes this ' +
        'solicited rather than cold.',
      confidence: 0.8,
      model,
      inputs: { username, runId },
      outputs: { followed, dmSent: sent.ok, draftId: draft.id, error: sent.error },
    });

    return json({
      username,
      followed,
      dmSent: sent.ok,
      message: draft.message,
      error: sent.error,
    });
  } catch (err) {
    return fail(errorMessage(err), 500);
  }
}
