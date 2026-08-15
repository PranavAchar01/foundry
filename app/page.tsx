import Dashboard from './dashboard';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

/**
 * The dashboard hydrates itself from /api/portfolio, so this shell renders
 * instantly and never fails a build on a cold database.
 */
export default function Home() {
  return <Dashboard initial={null} />;
}
