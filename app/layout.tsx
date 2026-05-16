import type { Metadata } from 'next'
import { IBM_Plex_Mono, Barlow_Condensed } from 'next/font/google'
import './globals.css'

const ibmPlexMono = IBM_Plex_Mono({
  subsets: ['latin'],
  weight: ['400', '500', '600'],
  variable: '--font-mono',
})

const barlowCondensed = Barlow_Condensed({
  subsets: ['latin'],
  weight: ['400', '500', '600', '700'],
  variable: '--font-display',
})

export const metadata: Metadata = {
  title: 'SteelEagle — Iron Condor Scanner',
  description: 'Personal iron condor scanning dashboard for SPY, TLT, and GLD.',
}

export default function RootLayout({
  children,
}: {
  children: React.ReactNode
}) {
  return (
    <html lang="en" className={`${ibmPlexMono.variable} ${barlowCondensed.variable}`}>
      <body className="antialiased">{children}</body>
    </html>
  )
}
