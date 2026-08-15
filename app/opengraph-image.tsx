import { ImageResponse } from 'next/og';

/**
 * The unfurl card. Same greyscale system as the dashboard: ink on Apple grey,
 * the numbers carried by weight rather than colour.
 */

export const runtime = 'edge';
export const alt = 'FOUNDRY — autonomous holding company';
export const size = { width: 1200, height: 630 };
export const contentType = 'image/png';

export default function OgImage() {
  return new ImageResponse(
    (
      <div
        style={{
          width: '100%',
          height: '100%',
          display: 'flex',
          flexDirection: 'column',
          justifyContent: 'space-between',
          background: '#f5f5f7',
          color: '#1d1d1f',
          padding: 72,
          fontFamily: 'Helvetica, Arial, sans-serif',
        }}
      >
        <div style={{ display: 'flex', flexDirection: 'column' }}>
          <div style={{ fontSize: 96, fontWeight: 700, letterSpacing: '-0.03em', display: 'flex' }}>
            FOUNDRY.
          </div>
          <div style={{ fontSize: 34, color: '#6e6e73', marginTop: 20, maxWidth: 900, display: 'flex' }}>
            An autonomous holding company. It spawns businesses, funds them, reads the P&L, and
            kills the losers.
          </div>
        </div>
        <div
          style={{
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'flex-end',
            borderTop: '2px solid #d2d2d7',
            paddingTop: 32,
          }}
        >
          <div style={{ fontSize: 26, color: '#86868b', display: 'flex' }}>
            No human in the loop.
          </div>
          <div style={{ fontSize: 26, color: '#1d1d1f', fontWeight: 600, display: 'flex' }}>
            hypothesis → spawn → deploy → measure → allocate or kill
          </div>
        </div>
      </div>
    ),
    size,
  );
}
