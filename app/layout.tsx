import type { Metadata } from 'next';
import { Hedvig_Letters_Serif, Inter } from 'next/font/google';
import './globals.css';

const inter = Inter({ subsets: ['latin'], variable: '--font-inter' });
const hedvig = Hedvig_Letters_Serif({
  subsets: ['latin'],
  weight: '400',
  variable: '--font-hedvig',
});

export const metadata: Metadata = {
  metadataBase: new URL(process.env.FOUNDRY_PUBLIC_URL || 'https://foundry-biz-eight.vercel.app'),
  title: 'FOUNDRY — autonomous holding company',
  description:
    'It spawns businesses, funds them, reads the P&L, and kills the losers. No human in the loop.',
  openGraph: {
    title: 'FOUNDRY — autonomous holding company',
    description:
      'It spawns businesses, funds them, reads the P&L, and kills the losers. No human in the loop.',
    siteName: 'FOUNDRY',
    type: 'website',
  },
  twitter: {
    card: 'summary_large_image',
    title: 'FOUNDRY — autonomous holding company',
    description:
      'It spawns businesses, funds them, reads the P&L, and kills the losers. No human in the loop.',
  },
  icons: {
    icon: "data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'><text y='.9em' font-size='90'>🏭</text></svg>",
  },
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${inter.variable} ${hedvig.variable}`}>
      <body className="grain min-h-screen">{children}</body>
    </html>
  );
}
