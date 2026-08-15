import { ImageResponse } from 'next/og';

/**
 * The unfurl card. Dusk palette: plum ground, pale-peach serif display,
 * mauve secondary, one pink ember on the final words. Hedvig can't be
 * loaded in the edge ImageResponse without bundling the font file, so
 * Georgia stands in for the serif.
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
          background: '#0b0614',
          color: '#f7e3d3',
          padding: 72,
          fontFamily: 'Helvetica, Arial, sans-serif',
        }}
      >
        <div style={{ display: 'flex', flexDirection: 'column' }}>
          <div
            style={{
              fontSize: 96,
              fontWeight: 400,
              letterSpacing: '-0.03em',
              fontFamily: 'Georgia, Cambria, serif',
              color: '#f7e3d3',
              display: 'flex',
            }}
          >
            FOUNDRY.
          </div>
          <div style={{ fontSize: 34, color: '#c3b0dd', marginTop: 20, maxWidth: 900, display: 'flex' }}>
            An autonomous holding company. It spawns businesses, funds them, reads the P&L, and
            kills the losers.
          </div>
        </div>
        <div
          style={{
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'flex-end',
            borderTop: '2px solid rgba(247,227,211,0.2)',
            paddingTop: 32,
          }}
        >
          <div style={{ fontSize: 26, color: '#9680bb', display: 'flex' }}>
            No human in the loop.
          </div>
          <div style={{ fontSize: 26, color: '#f7e3d3', display: 'flex' }}>
            hypothesis → spawn → deploy → measure →{' '}
            <span style={{ color: '#ff5fa2', marginLeft: 8 }}>allocate or kill</span>
          </div>
        </div>
      </div>
    ),
    size,
  );
}
