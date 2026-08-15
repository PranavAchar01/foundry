import { describeProviders } from '@/lib/providers';
import { json } from '@/lib/http';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Every capability, every implementation, which one is live, and exactly which
 * env var would switch it. Flipping a flag needs no code edit; this endpoint is
 * how you check that claim from outside the process.
 */
export function GET() {
  return json({ capabilities: describeProviders() });
}
