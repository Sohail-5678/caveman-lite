import type { Metadata, Viewport } from "next";
import { JetBrains_Mono, Mona_Sans } from "next/font/google";
import "./globals.css";

const mona = Mona_Sans({
  subsets: ["latin"],
  axes: ["wdth"],
  variable: "--font-mona",
  display: "swap",
});

const jetbrains = JetBrains_Mono({
  subsets: ["latin"],
  variable: "--font-jetbrains",
  display: "swap",
});

export const metadata: Metadata = {
  title: "Caveman-Lite — Self-optimizing LLM gateway",
  description:
    "OpenAI-compatible LLM gateway with an entity-aware semantic cache, singleflight stampede lock, learned complexity router, circuit-breaker failover and McNemar shadow evals. Runs at $0.",
  authors: [{ name: "Ameer Sohail Shaik", url: "https://ameer-shaik.vercel.app/" }],
};

export const viewport: Viewport = {
  themeColor: "#07080b",
  colorScheme: "dark",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${mona.variable} ${jetbrains.variable}`}>
      <body className="grain">{children}</body>
    </html>
  );
}
