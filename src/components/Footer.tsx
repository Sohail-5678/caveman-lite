import type { ReactNode } from "react";
import { ArrowUpRight } from "lucide-react";
import { GithubMark, LogoMark, Micro } from "./ui";

/** Keeps a compound or a number/unit pair on one line. */
const nw = (text: string) => <span className="whitespace-nowrap">{text}</span>;

const STACK: Array<[string, ReactNode, string]> = [
  ["Gateway hosting", <>{nw("Next.js\u00a015")} App Router on Vercel Hobby, {nw("push-to-deploy")} from GitHub</>, "Free tier, no servers"],
  ["T1\u00a0cache\u00a0· singleflight", <>{nw("In-process")} LRU + promise registry; {nw("redis:7-alpine")} only for local Docker runs</>, "No managed Redis"],
  ["T2 semantic cache", <>{nw("384-d")} {nw("feature-hashed")} embeddings + lexicon projection; entity guard {nw("<\u00a03\u00a0ms")} on CPU</>, "No GPU, no vector DB"],
  ["Router\u00a0· compressor", <>{nw("12-feature")} logistic model and filler pruning, {nw("<\u00a04\u00a0ms")}, deterministic</>, "No model calls to decide"],
  ["Upstream providers", "Groq and Gemini free tiers, BYOK headers, deterministic streaming fallback", "Demo runs without keys"],
];

export function Footer() {
  return (
    <footer className="mx-auto max-w-[1360px] px-4 pb-14 pt-32 md:px-8 md:pt-40">
      <div className="mb-7 flex items-center gap-4">
        <span className="t-data text-[12px] text-ink-2">06</span>
        <span className="h-px flex-1 bg-line-2" />
        <Micro>Operating cost</Micro>
      </div>
      <div className="grid grid-cols-1 gap-10 lg:grid-cols-12">
        <div className="lg:col-span-4">
          <p className="t-figure text-[64px] text-ink-1 md:text-[84px]">$0.00</p>
          <p className="mt-3 max-w-[38ch] text-[15px] leading-relaxed text-ink-2">
            per month to run the whole thing in public. Every subsystem was chosen so the demo stays up on free tiers
            and keeps working when no provider key is set.
          </p>
        </div>
        <div className="lg:col-span-8">
          <dl className="border-t border-line-2">
            {STACK.map(([what, how, why]) => (
              <div key={what} className="grid gap-1 border-b border-line py-4 md:grid-cols-[190px_1fr_170px] md:gap-6">
                <dt className="text-[13.5px] text-ink-1">{what}</dt>
                <dd className="text-[13.5px] leading-snug text-ink-3">{how}</dd>
                <dd className="t-data text-[11.5px] text-ink-2 md:text-right">{why}</dd>
              </div>
            ))}
          </dl>
        </div>
      </div>

      <div className="mt-24 flex flex-col gap-6 border-t border-line pt-8 md:flex-row md:items-center md:justify-between">
        <div className="flex items-center gap-3">
          <LogoMark className="size-5 text-ink-2" />
          <span className="text-[13px] text-ink-3">
            <span className="whitespace-nowrap">Caveman-Lite</span>
            {"\u00a0· built by "}
            <a href="https://ameer-shaik.vercel.app/" target="_blank" rel="noreferrer" className="-my-2.5 inline-block py-2.5 text-ink-1 underline-offset-4 hover:underline">
              Ameer Sohail Shaik
            </a>
          </span>
        </div>
        <div className="flex items-center gap-5 text-[13px] text-ink-3">
          <a href="https://github.com/Sohail-5678/caveman-lite" target="_blank" rel="noreferrer" className="-my-2.5 inline-flex items-center gap-1.5 py-2.5 transition-colors hover:text-ink-1">
            <GithubMark className="size-3.5" /> Source
          </a>
          <a href="https://ameer-shaik.vercel.app/" target="_blank" rel="noreferrer" className="-my-2.5 inline-flex items-center gap-1 py-2.5 transition-colors hover:text-ink-1">
            Portfolio <ArrowUpRight className="size-3.5" />
          </a>
          <span className="t-data whitespace-nowrap text-[11.5px] text-ink-3">MIT · v1.0.0</span>
        </div>
      </div>
    </footer>
  );
}
