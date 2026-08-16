/**
 * Single source of truth for configuration.
 *
 * Every knob the CEO agent obeys is read through here so that guardrails,
 * providers and the dashboard can never disagree about a limit.
 */

function str(name: string, fallback = ''): string {
  const v = process.env[name];
  return v === undefined || v === '' ? fallback : v;
}

function num(name: string, fallback: number): number {
  const v = process.env[name];
  if (v === undefined || v === '') return fallback;
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function bool(name: string, fallback: boolean): boolean {
  const v = str(name).toLowerCase();
  if (v === '') return fallback;
  return v === 'on' || v === 'true' || v === '1' || v === 'yes';
}

export const env = {
  // ---- brain ----
  get anthropicApiKey() {
    return str('ANTHROPIC_API_KEY');
  },
  get model() {
    return str('FOUNDRY_MODEL', 'claude-opus-5');
  },
  get openaiApiKey() {
    return str('OPENAI_API_KEY');
  },
  get openaiModel() {
    return str('FOUNDRY_OPENAI_MODEL', 'gpt-5.5');
  },
  /**
   * Which vendor does the thinking. Explicit flag wins; otherwise Anthropic
   * when it has a key, else OpenAI. Keeps the portfolio from being hostage to
   * one account's credit balance.
   */
  get brainProvider(): 'anthropic' | 'openai' {
    const explicit = str('FOUNDRY_BRAIN_PROVIDER').toLowerCase();
    if (explicit === 'anthropic' || explicit === 'openai') return explicit;
    return this.anthropicApiKey ? 'anthropic' : 'openai';
  },
  /** The model string of whichever brain is active. */
  get activeModel() {
    return this.brainProvider === 'openai' ? this.openaiModel : this.model;
  },

  // ---- audience intelligence (X) ----
  get xClientId() {
    return str('X_CLIENT_ID');
  },
  get xClientSecret() {
    return str('X_CLIENT_SECRET');
  },
  /**
   * Consumer API Key / Secret from "Keys and tokens". Distinct from the
   * OAuth 2.0 client id/secret: the Account Activity API signs its CRC and its
   * webhook deliveries with the consumer secret.
   */
  get xApiKey() {
    return str('X_API_KEY');
  },
  get xApiKeySecret() {
    return str('X_API_KEY_SECRET');
  },
  /**
   * Whose network to read. The Foundry account does the following and the
   * DMing, but it is not the account with the network — so the audience is
   * read from this handle instead of from whoever authorized.
   */
  get xAudienceHandle() {
    return str('X_AUDIENCE_HANDLE');
  },
  get xCallbackUrl() {
    return str('X_CALLBACK_URL') || `${this.publicUrl}/api/x/callback`;
  },
  /** Hard ceiling on a product's recurring price, in cents. */
  get maxPriceCents() {
    return num('FOUNDRY_MAX_PRICE_CENTS', 500);
  },
  /** Subscribers a one-off expert cost is amortised across. */
  get subscriberTarget() {
    return num('FOUNDRY_SUBSCRIBER_TARGET', 100);
  },
  get billingInterval() {
    return str('FOUNDRY_BILLING_INTERVAL', 'month');
  },
  /** Share of the product price a hired human keeps. */
  get laborPayoutShare() {
    return num('FOUNDRY_LABOR_PAYOUT_SHARE', 0.75);
  },

  // ---- money ----
  get stripeSecretKey() {
    return str('STRIPE_SECRET_KEY');
  },
  get stripePublishableKey() {
    return str('NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY');
  },
  get stripeWebhookSecret() {
    return str('STRIPE_WEBHOOK_SECRET');
  },
  /**
   * This account has card_payments INACTIVE / charges_enabled=false. Automatic
   * payment methods resolve to an empty set and the API 400s, so the type list
   * is always passed explicitly.
   */
  get stripePaymentMethodTypes(): string[] {
    return str('STRIPE_PAYMENT_METHOD_TYPES', 'card')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
  },

  // ---- deploy ----
  get publicUrl() {
    const explicit = str('FOUNDRY_PUBLIC_URL');
    if (explicit) return explicit.replace(/\/$/, '');
    const vercel = str('VERCEL_PROJECT_PRODUCTION_URL') || str('VERCEL_URL');
    return vercel ? `https://${vercel}` : 'http://localhost:3000';
  },
  /**
   * Vercel reserves the `VERCEL_` prefix for env vars it injects itself, so
   * these cannot always be stored under their local names in the project.
   * `scripts/push-env-vercel.mjs` writes a FOUNDRY_-prefixed alias for each,
   * and the local name still wins when it is present.
   */
  get vercelToken() {
    return str('VERCEL_TOKEN') || str('FOUNDRY_VERCEL_TOKEN');
  },
  get vercelTeamId() {
    return str('VERCEL_TEAM_ID') || str('FOUNDRY_VERCEL_TEAM_ID');
  },
  get vercelProjectId() {
    return str('VERCEL_PROJECT_ID') || str('FOUNDRY_VERCEL_PROJECT_ID');
  },
  get vercelProjectPrefix() {
    return str('VERCEL_PROJECT_PREFIX') || str('FOUNDRY_VERCEL_PROJECT_PREFIX', 'foundry-biz');
  },

  // ---- database ----
  get postgresUrl() {
    return str('POSTGRES_URL') || str('DATABASE_URL');
  },
  get postgresUrlNonPooling() {
    return str('POSTGRES_URL_NON_POOLING') || this.postgresUrl;
  },

  // ---- labor ----
  get teracApiKey() {
    return str('TERAC_API_KEY');
  },
  get teracApiBase() {
    return str('TERAC_API_BASE', 'https://terac.com/api/external/v2');
  },
  get escalationThreshold() {
    return num('TERAC_ESCALATION_THRESHOLD', 0.65);
  },
  /** Hard ceiling for a single escalation, in dollars. */
  get maxEscalationSpend() {
    return num('TERAC_MAX_SPEND_USD', 40);
  },
  /**
   * Explicit override wins; otherwise stub whenever there is no Terac key.
   * This is what keeps the whole build unblocked on a day-of API key.
   */
  get laborProvider(): 'terac' | 'stub' {
    const explicit = str('LABOR_PROVIDER').toLowerCase();
    if (explicit === 'terac' || explicit === 'stub') return explicit;
    return this.teracApiKey ? 'terac' : 'stub';
  },

  // ---- guardrails ----
  get totalBudget() {
    return num('FOUNDRY_TOTAL_BUDGET_USD', 150);
  },
  get perBusinessBudget() {
    return num('FOUNDRY_PER_BUSINESS_BUDGET_USD', 25);
  },
  get killThresholdVisitors() {
    return num('FOUNDRY_KILL_THRESHOLD_VISITORS', 40);
  },
  get killThresholdConversions() {
    return num('FOUNDRY_KILL_THRESHOLD_CONVERSIONS', 0);
  },
  get maxBusinesses() {
    return num('FOUNDRY_MAX_BUSINESSES', 8);
  },
  get circuitBreaker() {
    return bool('FOUNDRY_CIRCUIT_BREAKER', true);
  },
  get coldStartAt() {
    return str('FOUNDRY_COLD_START_AT');
  },

  // ---- sponsor capability flags ----
  get pagegenProvider() {
    return str('FOUNDRY_PAGEGEN_PROVIDER', 'internal').toLowerCase();
  },
  get checkoutProvider() {
    return str('FOUNDRY_CHECKOUT_PROVIDER', 'stripe').toLowerCase();
  },
  get sandboxProvider() {
    return str('FOUNDRY_SANDBOX_PROVIDER', 'vercel').toLowerCase();
  },
  get busProvider() {
    return str('FOUNDRY_BUS_PROVIDER', 'postgres').toLowerCase();
  },
  get supportProvider() {
    return str('FOUNDRY_SUPPORT_PROVIDER', 'resend').toLowerCase();
  },
  get qaProvider() {
    return str('FOUNDRY_QA_PROVIDER', 'playwright').toLowerCase();
  },
  get hostProvider() {
    return str('FOUNDRY_HOST_PROVIDER', 'vercel').toLowerCase();
  },

  // ---- sponsor keys ----
  get lovableApiKey() {
    return str('LOVABLE_API_KEY');
  },
  /**
   * Lovable's programmatic surface is an MCP endpoint speaking JSON-RPC 2.0.
   * The tool names and argument shapes in lib/providers/pagegen.ts were read
   * off the live server, so only this URL and the key are configuration.
   */
  get lovableMcpUrl() {
    return str('LOVABLE_MCP_URL', 'https://mcp.lovable.dev/mcp');
  },
  /** Optional: Lovable picks the sole eligible workspace when this is unset. */
  get lovableWorkspaceId() {
    return str('LOVABLE_WORKSPACE_ID');
  },
  /** Seconds Lovable's agent may spend building one site before spawn moves on. */
  get lovableBuildTimeout() {
    return num('LOVABLE_BUILD_TIMEOUT_SECONDS', 420);
  },
  get renderApiKey() {
    return str('RENDER_API_KEY');
  },
  get whopApiKey() {
    return str('WHOP_API_KEY');
  },
  get whopCompanyId() {
    return str('WHOP_COMPANY_ID');
  },
  get dodoApiKey() {
    return str('DODO_PAYMENTS_API_KEY');
  },
  get sandbox0ApiKey() {
    return str('SANDBOX0_API_KEY');
  },
  get superserveApiKey() {
    return str('SUPERSERVE_API_KEY');
  },
  /** Dollars per machine-hour, booked as OPEX for every business VM. */
  get machineCostPerHour() {
    return num('FOUNDRY_MACHINE_USD_PER_HOUR', 0.05);
  },
  /** Idle minutes before a business VM is paused to stop the meter. */
  get machineIdleMinutes() {
    return num('FOUNDRY_MACHINE_IDLE_MINUTES', 15);
  },
  /** Human key. Band's Human API is Enterprise-gated; this mints agent keys. */
  get bandApiKey() {
    return str('BAND_API_KEY');
  },
  /** Agent key from `pnpm band:register`. This is what the bus actually uses. */
  get bandAgentApiKey() {
    return str('BAND_AGENT_API_KEY');
  },
  get bandAgentId() {
    return str('BAND_AGENT_ID');
  },
  /** Band chat room the CEO publishes its cycle events into. */
  get bandChatId() {
    return str('BAND_CHAT_ID');
  },
  get linqApiKey() {
    return str('LINQ_API_KEY');
  },
  get linqPhoneNumber() {
    return str('LINQ_PHONE_NUMBER');
  },
  get replayApiKey() {
    return str('REPLAY_API_KEY');
  },
  get resendApiKey() {
    return str('RESEND_API_KEY');
  },

  // ---- disclosure ----
  get disclosureLine() {
    return str(
      'FOUNDRY_DISCLOSURE_LINE',
      'This business is operated end-to-end by an AI agent. No human wrote this.',
    );
  },

  /** Shared secret for manually poking the CEO cron outside Vercel's scheduler. */
  /**
   * Unlocks the deployment's own X account for one browser session.
   *
   * Sessions arrived after the owner had already authorized, so without this
   * the owner would be signed out by their own multi-tenancy change. Holding
   * the key binds the existing account to a session; it never mints tokens and
   * never touches an account a visitor authorized.
   */
  /**
   * Whether each visitor must connect their own X account.
   *
   * Off, every visitor's run acts as the deployment's own account: one shared
   * identity, one shared rate limit, messages from the owner's handle. That is
   * the right shape for a demo the owner drives and the wrong shape for a site
   * strangers can press buttons on.
   *
   * Defaults to on. The unsafe direction should require someone to have written
   * it down, so losing the environment fails closed rather than quietly handing
   * the next visitor the owner's account.
   */
  get xMultiTenant() {
    return bool('FOUNDRY_X_MULTI_TENANT', true);
  },

  get ownerKey() {
    return str('FOUNDRY_OWNER_KEY');
  },

  get cronSecret() {
    return str('CRON_SECRET');
  },
};

export type Env = typeof env;
