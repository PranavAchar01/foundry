import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'FOUNDRY — autonomous holding company',
  description:
    'It spawns businesses, funds them, reads the P&L, and kills the losers. No human in the loop.',
  icons: {
    icon: "data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'><text y='.9em' font-size='90'>🏭</text></svg>",
  },
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className="min-h-screen">{children}</body>
    </html>
  );
}
