import type { Metadata } from "next";
import { Archivo, IBM_Plex_Mono } from "next/font/google";
import "./globals.css";
import Providers from "./providers";

const archivo = Archivo({ subsets: ["latin"], variable: "--font-display", weight: ["400", "500", "700", "800", "900"] });
const plexMono = IBM_Plex_Mono({ subsets: ["latin"], variable: "--font-num", weight: ["400", "500", "600", "700"] });

export const metadata: Metadata = {
  title: "RobinHook — never overpay for stocks",
  description:
    "A Uniswap v4 hook on Robinhood Chain that checks every stock-token swap against its Chainlink fair price and blocks the trade if you would overpay. Stake $WIF to tighten your guard.",
  icons: { icon: "/favicon.svg" },
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${archivo.variable} ${plexMono.variable}`}>
      <body>
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
