import type { Metadata } from "next";
import { Archivo, IBM_Plex_Mono } from "next/font/google";
import "./globals.css";
import Providers from "./providers";

const archivo = Archivo({ subsets: ["latin"], variable: "--font-display", weight: ["400", "500", "700", "800", "900"] });
const plexMono = IBM_Plex_Mono({ subsets: ["latin"], variable: "--font-num", weight: ["400", "500", "600", "700"] });

export const metadata: Metadata = {
  title: "SlipNope — overpay? nope.",
  description:
    "A Uniswap v4 fair-price hook on Base that checks every tokenized-stock swap against Chainlink fair value and blocks the trade if you would overpay. SlipNope.",
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
