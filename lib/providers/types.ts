/**
 * Every sponsor-swappable capability in Foundry is declared here as an
 * interface. Each capability has a no-key default implementation and at least
 * one sponsor implementation; the active one is chosen at runtime from a
 * FOUNDRY_*_PROVIDER environment flag by `lib/providers/index.ts`.
 *
 * The contract that matters: flipping a flag must never require a code edit.
 * `tests/providers.test.ts` instantiates every implementation of every
 * capability to keep that true.
 */

export interface ProviderInfo {
  /** Capability family, e.g. 'labor'. */
  capability: string;
  /** Implementation name, matching the env flag value, e.g. 'terac'. */
  name: string;
  /** False when the implementation needs a key that is not currently set. */
  configured: boolean;
  /** Env var that would need filling to make this implementation live. */
  requires: string[];
}

export interface Capability {
  readonly info: ProviderInfo;
}

// ---------------------------------------------------------------------------
// labor — human expertise, priced and bought as a line item
// ---------------------------------------------------------------------------

export interface LaborQuote {
  quoteId: string;
  /** Dollars. */
  totalCost: number;
  /** Dollars. */
  costPerParticipant: number;
  expiresAt: string;
  /** The provider's own justification for the price. Logged verbatim. */
  reasoning: string;
  timelineHours: number;
  submissionCount: number;
  provider: string;
}

export interface LaborPurchase {
  opportunityId: string;
  status: string;
  provider: string;
}

export interface LaborAnswer {
  opportunityId: string;
  status: 'pending' | 'in_progress' | 'answered' | 'failed';
  answer: string | null;
  provider: string;
}

export interface LaborQuoteOptions {
  timelineHours?: number;
  submissionCount?: number;
  businessId?: string;
}

export interface LaborProvider extends Capability {
  quote(
    question: string,
    expertProfile: string,
    opts?: LaborQuoteOptions,
  ): Promise<LaborQuote>;
  purchase(quoteId: string, opts?: { name?: string }): Promise<LaborPurchase>;
  poll(opportunityId: string): Promise<LaborAnswer>;
}

// ---------------------------------------------------------------------------
// pagegen — turns a hypothesis into a landing page
// ---------------------------------------------------------------------------

export interface PageSpec {
  businessId: string;
  slug: string;
  name: string;
  tagline: string;
  niche: string;
  offer: string;
  targetCustomer: string;
  priceCents: number;
  bullets: string[];
  /** Absolute URL the checkout button posts to. */
  checkoutEndpoint: string;
  /** Absolute URL the pageview beacon posts to. */
  beaconEndpoint: string;
  disclosure: string;
  /**
   * The buyer's own description of their work, when the business was spawned
   * for one named person rather than a whole segment. Unset on the segment
   * path, where there is no single buyer to write to.
   */
  prospectBio?: string;
  /** The specific repeating chore in that person's week the product removes. */
  prospectChore?: string;
}

export interface GeneratedPage {
  /**
   * The page markup, when the provider produces a deployable artefact.
   * Empty when the provider hosts the site itself and never hands back source
   * (Lovable builds and serves a full app rather than returning a file).
   */
  html: string;
  provider: string;
  /**
   * Set when the provider has already published the site. `spawn` then uses
   * this as the business URL and skips the HostProvider entirely — deploying a
   * copy would give the business a second, divergent storefront.
   */
  hostedUrl?: string;
  /** The provider's own id for the built project, for later edits. */
  projectId?: string;
}

export interface PagegenProvider extends Capability {
  generate(spec: PageSpec): Promise<GeneratedPage>;
}

// ---------------------------------------------------------------------------
// checkout — takes money
// ---------------------------------------------------------------------------

export interface CheckoutRequest {
  businessId: string;
  /** 'subscription' switches Stripe to recurring billing. */
  billing?: 'one_time' | 'subscription';
  interval?: 'day' | 'week' | 'month' | 'year';
  productName: string;
  description: string;
  amountCents: number;
  currency: string;
  successUrl: string;
  cancelUrl: string;
}

export interface CheckoutSession {
  sessionId: string;
  url: string;
  provider: string;
  amountCents: number;
}

export interface CheckoutProvider extends Capability {
  createSession(req: CheckoutRequest): Promise<CheckoutSession>;
}

// ---------------------------------------------------------------------------
// host — puts a spawned business on the public internet
// ---------------------------------------------------------------------------

export interface DeployRequest {
  slug: string;
  files: { path: string; content: string }[];
}

export interface DeployResult {
  url: string;
  deploymentId: string;
  provider: string;
  /** True when the host confirmed the deployment is serving. */
  ready: boolean;
}

export interface HostProvider extends Capability {
  deploy(req: DeployRequest): Promise<DeployResult>;
}

// ---------------------------------------------------------------------------
// sandbox — isolated execution for agent-written code
// ---------------------------------------------------------------------------

export interface SandboxRun {
  id: string;
  exitCode: number;
  stdout: string;
  stderr: string;
  provider: string;
}

export interface SandboxProvider extends Capability {
  run(cmd: string, args: string[], opts?: { timeoutMs?: number }): Promise<SandboxRun>;
}

// ---------------------------------------------------------------------------
// bus — coordination between agent steps
// ---------------------------------------------------------------------------

export interface BusMessage {
  id: string;
  topic: string;
  payload: Record<string, unknown>;
}

export interface BusProvider extends Capability {
  publish(topic: string, payload: Record<string, unknown>): Promise<{ id: string }>;
  consume(topic: string, limit?: number): Promise<BusMessage[]>;
  ack(id: string): Promise<void>;
}

// ---------------------------------------------------------------------------
// support — talks to customers
// ---------------------------------------------------------------------------

export interface SupportMessage {
  to: string;
  subject: string;
  body: string;
}

export interface SupportProvider extends Capability {
  send(msg: SupportMessage): Promise<{ id: string; provider: string; delivered: boolean }>;
}

// ---------------------------------------------------------------------------
// qa — checks a spawned site actually works before the agent trusts it
// ---------------------------------------------------------------------------

export interface QaCheck {
  url: string;
  /** Substrings that must appear in the served HTML. */
  expect: string[];
}

export interface QaResult {
  passed: boolean;
  provider: string;
  checks: { name: string; passed: boolean; detail: string }[];
}

export interface QaProvider extends Capability {
  verify(check: QaCheck): Promise<QaResult>;
}
