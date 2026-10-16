import type { Metadata, Viewport } from "next";
import { Hanken_Grotesk, IBM_Plex_Mono, Literata, Newsreader, Noto_Sans, Source_Code_Pro } from "next/font/google";
import "./globals.css";

/* v3 type: an editorial serif for display, a warm grotesk for the interface, Plex Mono for telemetry */
const display = Newsreader({
  subsets: ["latin"],
  axes: ["opsz"],
  style: ["normal", "italic"],
  variable: "--font-display",
  display: "swap",
  adjustFontFallback: false,
});

const ui = Hanken_Grotesk({
  subsets: ["latin"],
  variable: "--font-ui",
  display: "swap",
  adjustFontFallback: false,
});

const code = IBM_Plex_Mono({
  subsets: ["latin"],
  weight: ["400", "500", "600"],
  variable: "--font-code",
  display: "swap",
  adjustFontFallback: false,
});

/* The v3 faces carry no Greek. These sit next in each stack, so only τ, χ, Δ, σ ever fall through to them. */
const greekMono = Source_Code_Pro({ subsets: ["greek"], variable: "--font-greek-mono", display: "swap", preload: false });
const greekSans = Noto_Sans({ subsets: ["greek"], variable: "--font-greek-sans", display: "swap", preload: false });
const greekSerif = Literata({ subsets: ["greek"], variable: "--font-greek-serif", display: "swap", preload: false });

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
    <html lang="en" className={`${display.variable} ${ui.variable} ${code.variable} ${greekMono.variable} ${greekSans.variable} ${greekSerif.variable}`}>
      <body className="grain">{children}</body>
    </html>
  );
}
