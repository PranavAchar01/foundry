/**
 * Terac External API v2 client — human expertise as a priced, budgeted line item.
 *
 * Auth:  Authorization: Bearer <TERAC_API_KEY>   (keys are org-scoped)
 * Rate:  100 req/min per key -> 429 RATE_LIMITED
 * Spec:  https://terac.com/api/external/v2/openapi.json  (v2 beta)
 *
 * The escalation flow Foundry depends on:
 *   quote(question)  -> totalCost, expiresAt        // price the labor BEFORE committing
 *   affordable?      -> check against budget + live balanceDollars
 *   launchFromQuote  -> opportunityId               // buy it
 *   setCap           -> hard limit_seconds ceiling  // guardrail, enforced by Terac
 *   webhook          -> submission.approved         // answer arrives, post COGS to ledger
 */

const BASE = process.env.TERAC_API_BASE ?? 'https://terac.com/api/external/v2';

export class TeracError extends Error {
  constructor(
    readonly code: string,
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = 'TeracError';
  }
  /** 429 and 5xx are worth retrying; 4xx are not. */
  get retryable() {
    return this.status === 429 || this.status >= 500;
  }
}

export interface Quote {
  quoteId: string;
  totalCost: number;
  costPerParticipant: number;
  timelineHours: number;
  submissionCount: number;
  expiresAt: string;
}

export interface QuoteDetail {
  id: string;
  status: string;
  price: string;
  costPerParticipant: string;
  timelineHours: number;
  submissionCount: number;
  taskDescription: string;
  panelDescription: string;
  /** Terac's own reasoning for the price — log this verbatim in the allocation log. */
  reasoning: string;
  taskAnalysis: Record<string, unknown>;
  panelAnalysis: Record<string, unknown>;
  expiresAt: string;
  createdAt: string;
}

export type SubmissionStatus =
  | 'screen_passed' | 'screened_out' | 'in_progress'
  | 'awaiting_review' | 'approved' | 'rejected' | 'abandoned';

export interface Submission {
  id: string;
  opportunity_id: string;
  status: SubmissionStatus;
  participant_id: string;
  created_at: string;
  updated_at: string;
  screening_outcome: 'passed' | 'failed' | 'review' | '';
  screening_answers: { key?: string; question: string; answer: string[]; outcome: string }[];
  dashboard_url?: string;
  tasks?: { sequence: number; task_type: string; status: string }[];
}

export interface OrgContext {
  markdown: string;
  organizationId: string;
  organizationName: string;
  organizationSlug: string;
  /** Live account balance. The circuit breaker reads this, not a local counter. */
  balanceDollars: number;
  dashboard: Record<string, string>;
}

export class TeracClient {
  private readonly key: string;

  constructor(apiKey = process.env.TERAC_API_KEY) {
    if (!apiKey) throw new Error('TERAC_API_KEY is not set');
    this.key = apiKey;
  }

  private async request<T>(
    method: string,
    path: string,
    body?: unknown,
    attempt = 0,
  ): Promise<T> {
    const res = await fetch(`${BASE}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${this.key}`,
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });

    if (!res.ok) {
      const payload = await res.json().catch(() => ({}) as any);
      const code = payload?.error?.code ?? `HTTP_${res.status}`;
      const err = new TeracError(code, res.status, payload?.error?.message ?? res.statusText);

      // 100 req/min ceiling. Back off and retry rather than dropping an escalation.
      if (err.retryable && attempt < 4) {
        const waitMs = Number(res.headers.get('retry-after') ?? 0) * 1000 || 2 ** attempt * 1000;
        await new Promise((r) => setTimeout(r, waitMs));
        return this.request<T>(method, path, body, attempt + 1);
      }
      throw err;
    }

    return res.status === 204 ? (undefined as T) : ((await res.json()) as T);
  }

  // ---- org / balance -------------------------------------------------------
  getOrganizationContext() {
    return this.request<OrgContext>('GET', '/organizations/current/context');
  }

  // ---- pricing -------------------------------------------------------------
  /** Price a unit of human labor. Does not commit funds. */
  createQuote(input: {
    taskDescription: string;
    panelDescription: string;
    timelineHours: number;
    submissionCount: number;
  }) {
    return this.request<Quote>('POST', '/quotes', input);
  }

  getQuote(quoteId: string) {
    return this.request<QuoteDetail>('GET', `/quotes/${quoteId}`);
  }

  /** Commit the quote — creates and launches the opportunity. This spends money. */
  launchFromQuote(quoteId: string, opts?: { name?: string; projectId?: string }) {
    return this.request<{ opportunityId: string; status: string }>(
      'POST', `/quotes/${quoteId}/launch`, opts ?? {},
    );
  }

  // ---- projects / opportunities -------------------------------------------
  createProject(name: string) {
    return this.request<{ id: string; name: string; slug: string; dashboard_url: string | null }>(
      'POST', '/projects', { name },
    );
  }

  stopOpportunity(opportunityId: string, reason?: string) {
    return this.request<unknown>('POST', `/opportunities/${opportunityId}/stop`, { reason });
  }

  // ---- results -------------------------------------------------------------
  listSubmissions(opportunityId: string, params: { limit?: number; cursor?: string } = {}) {
    const q = new URLSearchParams(
      Object.entries(params).filter(([, v]) => v != null).map(([k, v]) => [k, String(v)]),
    ).toString();
    return this.request<{
      data: Submission[];
      pagination: { next_cursor: string | null; has_more: boolean };
      dashboard_url: string;
    }>('GET', `/opportunities/${opportunityId}/submissions${q ? `?${q}` : ''}`);
  }

  getSubmission(submissionId: string) {
    return this.request<Submission>('GET', `/submissions/${submissionId}`);
  }

  approveSubmission(submissionId: string) {
    return this.request<unknown>('POST', `/submissions/${submissionId}/approve`);
  }

  rejectSubmission(
    submissionId: string,
    rejection_category: 'low_quality' | 'failed_instructions' | 'incomplete' | 'suspicious_patterns' | 'other',
    rejection_reason?: string,
  ) {
    return this.request<unknown>('POST', `/submissions/${submissionId}/reject`, {
      rejection_category,
      rejection_reason,
    });
  }

  // ---- guardrails ----------------------------------------------------------
  /** Terac-enforced hard ceiling. Belt to the local budget check's braces. */
  setCap(scope: 'PER_TASK' | 'PER_USER_TOTAL', target_ref: string, limit_seconds: number) {
    return this.request<unknown>('POST', '/time-tracking/caps', { scope, target_ref, limit_seconds });
  }

  // ---- webhooks ------------------------------------------------------------
  createWebhookSubscription(
    target_url: string,
    event_types: ('submission.status.change' | 'submission.approved')[] = ['submission.approved'],
  ) {
    return this.request<{ id: string }>('POST', '/hooks/subscriptions', { target_url, event_types });
  }

  getWebhookSubscriptionSecret(subscriptionId: string) {
    return this.request<{ secret: string }>('GET', `/hooks/subscriptions/${subscriptionId}/secret`);
  }
}

// ---------------------------------------------------------------------------
// Escalation primitive — the CEO agent's only entry point into human labor.
// ---------------------------------------------------------------------------

export interface EscalationRequest {
  businessId: string;
  /** What the agent could not decide on its own. */
  question: string;
  /** Who should answer it, in Terac panel terms. */
  expertProfile: string;
  /** The agent's own confidence, 0–1. Below threshold is why we're here. */
  confidence: number;
  timelineHours?: number;
  submissionCount?: number;
}

export type EscalationOutcome =
  | { decision: 'purchased'; quote: Quote; opportunityId: string }
  | { decision: 'declined'; quote: Quote; reason: string };

/**
 * Price human expertise, check it against every budget ceiling, and buy it only
 * if it clears. The declined branch is not a failure path — a CEO that refuses
 * an overpriced consult is the guardrail working.
 */
export async function escalate(
  req: EscalationRequest,
  ctx: {
    client?: TeracClient;
    /** Spend already booked against this business, in dollars. */
    spentOnBusiness: number;
    /** Spend already booked across the portfolio, in dollars. */
    spentTotal: number;
  },
): Promise<EscalationOutcome> {
  const client = ctx.client ?? new TeracClient();

  const maxEscalation = Number(process.env.TERAC_MAX_SPEND_USD ?? 40);
  const perBusiness = Number(process.env.FOUNDRY_PER_BUSINESS_BUDGET_USD ?? 25);
  const total = Number(process.env.FOUNDRY_TOTAL_BUDGET_USD ?? 150);

  const quote = await client.createQuote({
    taskDescription: req.question,
    panelDescription: req.expertProfile,
    timelineHours: req.timelineHours ?? 2,
    submissionCount: req.submissionCount ?? 1,
  });

  const decline = (reason: string): EscalationOutcome => ({ decision: 'declined', quote, reason });

  if (quote.totalCost > maxEscalation)
    return decline(`quote $${quote.totalCost} exceeds per-escalation cap $${maxEscalation}`);
  if (ctx.spentOnBusiness + quote.totalCost > perBusiness)
    return decline(`would breach ${req.businessId} budget $${perBusiness}`);
  if (ctx.spentTotal + quote.totalCost > total)
    return decline(`would breach portfolio budget $${total}`);

  // Live balance beats a local counter — another process may have spent since.
  const org = await client.getOrganizationContext();
  if (org.balanceDollars < quote.totalCost)
    return decline(`Terac balance $${org.balanceDollars} < quote $${quote.totalCost}`);

  const { opportunityId } = await client.launchFromQuote(quote.quoteId, {
    name: `foundry-${req.businessId}-escalation`,
  });

  return { decision: 'purchased', quote, opportunityId };
}
