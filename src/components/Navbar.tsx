"use client";

import { useEffect, useRef, useState } from "react";
import { motion, useReducedMotion } from "framer-motion";
import { useGateway } from "@/lib/gateway/use-gateway";
import type { Tone } from "@/lib/gateway/choreography";
import { cn } from "@/lib/format";
import { GithubMark, Glyph, LogoMark } from "./ui";

const LINKS = [
  { id: "corridor", label: "Corridor" },
  { id: "chaos", label: "Chaos" },
  { id: "cache", label: "Cache" },
  { id: "evals", label: "Evals" },
  { id: "playground", label: "Playground" },
];

const PROVIDER_NAMES: Record<string, string> = { groq: "Groq", gemini: "Gemini", claude: "Claude" };

function useActiveSection() {
  const [active, setActive] = useState("corridor");
  useEffect(() => {
    const els = LINKS.map((l) => document.getElementById(l.id)).filter(Boolean) as HTMLElement[];
    const io = new IntersectionObserver(
      (entries) => {
        const visible = entries.filter((e) => e.isIntersecting).sort((a, b) => b.intersectionRatio - a.intersectionRatio);
        if (visible[0]) setActive(visible[0].target.id);
      },
      { rootMargin: "-35% 0px -55% 0px", threshold: [0, 0.2, 0.5] },
    );
    els.forEach((el) => io.observe(el));
    return () => io.disconnect();
  }, []);
  return active;
}

/** Steady when nominal; a fault blinks its own glyph like a panel lamp. Below md it collapses to the glyph alone. */
function SystemStatus() {
  const breakers = useGateway((s) => s.breakers);
  const killed = useGateway((s) => s.primaryKilled);
  const entries = Object.entries(breakers) as Array<[string, { state: string }]>;
  const names = (state: string) => entries.filter(([, b]) => b.state === state).map(([id]) => PROVIDER_NAMES[id] ?? id);
  const open = names("OPEN");
  const half = names("HALF_OPEN");
  const tone: Tone = open.length ? "cinnabar" : half.length || killed ? "amber" : "malachite";
  const text = open.length
    ? `${open.join(", ")} ${open.length > 1 ? "circuits" : "circuit"} open`
    : half.length
      ? `${half.join(", ")} ${half.length > 1 ? "circuits" : "circuit"} half-open`
      : killed
        ? "Groq degraded · 429s"
        : "All circuits closed";

  return (
    // Transitions are announced once, by the page's live region; this pill only shows state.
    <span
      className={cn(
        "flex size-8 items-center justify-center gap-2 rounded-lg border border-line transition-colors duration-300 md:w-auto md:px-3",
        open.length > 0 && "border-[rgb(241_97_89/0.38)]",
      )}
      title={text}
    >
      <Glyph tone={tone} size={8} className={tone !== "malachite" ? "annunciate" : undefined} />
      <span className="sr-only text-[12.5px] text-ink-2 md:not-sr-only md:whitespace-nowrap">{text}</span>
    </span>
  );
}

/**
 * `recede` is the transform the page plane takes while the drawer is open; the bar rides in the same plane,
 * so it scales back with the page instead of printing over it.
 */
export function Navbar({ onOpenBench, recede }: { onOpenBench: () => void; recede: string | null }) {
  const active = useActiveSection();
  const reduce = useReducedMotion();
  const [scrolled, setScrolled] = useState(false);
  const railRef = useRef<HTMLUListElement>(null);

  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > 8);
    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);

  // Centre the active link in the compact rail. Scrolling the rail itself (rather than scrollIntoView)
  // leaves the page's own smooth anchor scroll untouched.
  useEffect(() => {
    const rail = railRef.current;
    const item = rail?.querySelector<HTMLElement>(`[data-section="${active}"]`);
    if (!rail || !item || rail.scrollWidth <= rail.clientWidth) return;
    rail.scrollTo({ left: item.offsetLeft - (rail.clientWidth - item.offsetWidth) / 2, behavior: reduce ? "auto" : "smooth" });
  }, [active, reduce]);

  const underline = reduce ? { duration: 0 } : { type: "spring" as const, duration: 0.45, bounce: 0.15 };

  return (
    <div
      inert={recede !== null}
      className="fixed inset-x-0 top-0 z-40 transition-transform duration-500 ease-[var(--ease-drawer)]"
      style={{ transformOrigin: "50% 50vh", transform: recede ?? "none" }}
    >
      <nav
        aria-label="Primary"
        className={cn(
          "border-b transition-[background-color,border-color,backdrop-filter] duration-300",
          scrolled ? "border-line bg-[rgb(46_21_27/0.72)] backdrop-blur-xl" : "border-transparent",
        )}
      >
        <div className="mx-auto flex h-14 max-w-[1360px] items-center justify-between gap-4 px-4 md:px-8">
          <a href="#top" className="group -my-2.5 flex items-center gap-2.5 py-2.5" aria-label="Caveman-Lite home">
            <LogoMark className="size-[22px] text-ink-1 transition-transform duration-300 ease-[var(--ease-out)] group-hover:-rotate-6" />
            <span className="text-[15px] font-[600] tracking-[-0.02em] text-ink-1">caveman-lite</span>
          </a>

          <ul className="hidden h-full items-stretch gap-1 lg:flex">
            {LINKS.map((link) => (
              <li key={link.id} className="relative">
                <a
                  href={`#${link.id}`}
                  aria-current={active === link.id ? "location" : undefined}
                  className={cn(
                    "relative flex h-full items-center px-3 text-[13px] transition-colors duration-150",
                    active === link.id ? "text-ink-1" : "text-ink-3 hover:text-ink-1",
                  )}
                >
                  {link.label}
                  {active === link.id ? (
                    <motion.span layoutId="nav-active" className="absolute inset-x-3 -bottom-px h-px bg-accent" transition={underline} />
                  ) : null}
                </a>
              </li>
            ))}
          </ul>

          <div className="flex items-center gap-2">
            <SystemStatus />
            <button type="button" className="btn btn-secondary btn-sm gap-2" onClick={onOpenBench} aria-label="Verify: run the 30-check suite">
              Verify
              <span className="t-data text-[11px] text-ink-3-raised">30</span>
            </button>
            <a
              href="https://github.com/Sohail-5678/caveman-lite"
              target="_blank"
              rel="noreferrer"
              className="btn btn-ghost btn-sm px-2 [@media(pointer:coarse)]:min-w-11"
              aria-label="Source on GitHub"
            >
              <GithubMark className="size-4" />
            </a>
          </div>
        </div>

        {/* Below lg the section links move to a second, horizontally scrolling row. */}
        <div className={cn("border-t transition-colors duration-300 lg:hidden", scrolled ? "border-line" : "border-transparent")}>
          <ul
            ref={railRef}
            className="relative mx-auto flex h-10 max-w-[1360px] items-stretch gap-1 overflow-x-auto px-1 [scrollbar-width:none] md:px-5 [&::-webkit-scrollbar]:hidden"
          >
            {LINKS.map((link) => (
              <li key={link.id} data-section={link.id} className="relative shrink-0">
                <a
                  href={`#${link.id}`}
                  aria-current={active === link.id ? "location" : undefined}
                  className={cn(
                    "relative flex h-full items-center px-3 text-[13px] transition-colors duration-150 focus-visible:outline-offset-[-3px]",
                    active === link.id ? "text-ink-1" : "text-ink-3 hover:text-ink-1",
                  )}
                >
                  {link.label}
                  {active === link.id ? (
                    <motion.span layoutId="nav-active-rail" className="absolute inset-x-3 bottom-0 h-px bg-accent" transition={underline} />
                  ) : null}
                </a>
              </li>
            ))}
          </ul>
        </div>
      </nav>
    </div>
  );
}
