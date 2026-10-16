import type { Metadata, Viewport } from "next";
import { Hanken_Grotesk, IBM_Plex_Mono, Newsreader } from "next/font/google";
import "./globals.css";

/* v3 type: an editorial serif for display, a warm grotesk for the interface, Plex Mono for telemetry */
const display = Newsreader({
  subsets: ["latin"],
  axes: ["opsz"],
  style: ["normal", "italic"],
  variable: "--font-display",
  display: "swap",
});

const ui = Hanken_Grotesk({
  subsets: ["latin"],
  variable: "--font-ui",
  display: "swap",
});

const code = IBM_Plex_Mono({
  subsets: ["latin"],
  weight: ["400", "500", "600"],
  variable: "--font-code",
  display: "swap",
});

export const metadata: Metadata = {
  title: "Caveman-Lite — Self-optimizing LLM gateway",
  description:
    "OpenAI-compatible LLM gateway with an entity-aware semantic cache, singleflight stampede lock, learned complexity router, circuit-breaker failover and McNemar shadow evals. Runs at $0.",
  authors: [{ name: "Ameer Sohail Shaik", url: "https://ameer-shaik.vercel.app/" }],
};

export const viewport: Viewport = {
  themeColor: "#2e151b",
  colorScheme: "dark",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${display.variable} ${ui.variable} ${code.variable}`}>
      <body className="grain">{children}</body>
    </html>
  );
}
