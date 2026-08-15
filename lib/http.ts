import { NextResponse } from 'next/server';

/**
 * Spawned businesses are deployed to their own origins, so the two endpoints
 * they call back into Foundry with — checkout and the pageview beacon — need
 * permissive CORS. Nothing sensitive is readable through either one.
 */
const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'POST, OPTIONS',
  'access-control-allow-headers': 'content-type',
  'access-control-max-age': '86400',
};

export function json(body: unknown, init: { status?: number; cors?: boolean } = {}) {
  return NextResponse.json(body, {
    status: init.status ?? 200,
    headers: init.cors ? CORS : undefined,
  });
}

export function preflight() {
  return new NextResponse(null, { status: 204, headers: CORS });
}

export function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}
