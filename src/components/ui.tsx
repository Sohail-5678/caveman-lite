"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import { cn } from "@/lib/format";
import type { Tone } from "@/lib/gateway/choreography";

/* ── marks ─────────────────────────────────────────────────────────────── */

/** Knapped-flint mark: a low-poly stone. Caveman, but machined. */
export function LogoMark({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" className={className} aria-hidden>
      <path d="M12 2.2 20.6 8.4 18.2 20.2 6 21.6 3.2 9.6Z" fill="rgb(243 240 233 / 0.06)" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round" />
      <path d="M12 2.2 10.8 12.2 20.6 8.4M10.8 12.2 18.2 20.2M10.8 12.2 6 21.6M10.8 12.2 3.2 9.6" stroke="currentColor" strokeOpacity=".5" strokeWidth="1" strokeLinejoin="round" />
      <circle cx="12" cy="2.2" r="1.35" fill="var(--color-accent)" />
    </svg>
  );
}

export function GithubMark({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 16 16" className={className} aria-hidden fill="currentColor">
      <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0 0 16 8c0-4.42-3.58-8-8-8Z" />
    </svg>
  );
}

/**
 * Status glyph: every signal colour also has its own shape, so state never relies on hue alone.
 * malachite ● · glacier ◆ · amber ▲ · cinnabar ■
 */
export function Glyph({ tone, size = 8, className }: { tone: Tone; size?: number; className?: string }) {
  const fill = `var(--color-${tone === "bone" ? "ink-2" : tone})`;
  const s = size;
  return (
    <svg width={s} height={s} viewBox="0 0 10 10" className={cn("shrink-0", className)} aria-hidden>
      {tone === "malachite" || tone === "bone" ? <circle cx="5" cy="5" r="4" fill={fill} /> : null}
      {tone === "glacier" ? <path d="M5 .6 9.4 5 5 9.4.6 5Z" fill={fill} /> : null}
      {tone === "amber" ? <path d="M5 1 9.4 9H.6Z" fill={fill} /> : null}
      {tone === "cinnabar" ? <rect x="1.2" y="1.2" width="7.6" height="7.6" rx="1" fill={fill} /> : null}
    </svg>
  );
}

/** Solid play triangle for Fire and Play keys: drawn for this system, not borrowed from an icon set. */
export function PlayMark({ className }: { className?: string }) {
  return (
    <svg width="8" height="9" viewBox="0 0 8 9" aria-hidden className={cn("shrink-0", className)}>
      <path d="M0 0 8 4.5 0 9Z" fill="currentColor" />
    </svg>
  );
}

export function Chip({ tone, children, className, glyph = true }: { tone?: Tone; children: ReactNode; className?: string; glyph?: boolean }) {
  return (
    <span className={cn("chip", className)} data-tone={tone && tone !== "bone" ? tone : undefined}>
      {glyph && tone ? <Glyph tone={tone} size={7} /> : null}
      {children}
    </span>
  );
}

export function Micro({ children, className }: { children: ReactNode; className?: string }) {
  return <span className={cn("t-micro", className)}>{children}</span>;
}

/* ── layout ────────────────────────────────────────────────────────────── */

export function useInView<T extends Element>(options: IntersectionObserverInit = { rootMargin: "0px 0px -12% 0px" }) {
  const ref = useRef<T>(null);
  const [inView, setInView] = useState(false);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const io = new IntersectionObserver(([entry]) => {
      if (entry.isIntersecting) {
        setInView(true);
        io.disconnect();
      }
    }, options);
    io.observe(el);
    return () => io.disconnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return { ref, inView };
}

export function Reveal({ children, className, delay = 0 }: { children: ReactNode; className?: string; delay?: number }) {
  const { ref, inView } = useInView<HTMLDivElement>();
  return (
    <div ref={ref} className={cn("reveal", className)} data-in={inView} style={{ transitionDelay: `${delay}ms` }}>
      {children}
    </div>
  );
}

export function SectionHeader({
  index,
  kicker,
  title,
  children,
  aside,
  layout = "stack",
}: {
  index: string;
  kicker: string;
  title: ReactNode;
  children?: ReactNode;
  aside?: ReactNode;
  /** "split" sets the lead in the right-hand column, level with the headline's last line. */
  layout?: "stack" | "split";
}) {
  const split = layout === "split";
  const lead = "max-w-[60ch] text-[15.5px] leading-relaxed text-ink-2 [text-wrap:pretty]";
  return (
    <header className="mb-10 md:mb-12">
      <div className="mb-7 flex items-center gap-4">
        <span className="t-data text-[12px] text-accent">{index}</span>
        <span className="h-px flex-1 bg-line-2" />
        <Micro>{kicker}</Micro>
      </div>
      <div className="grid grid-cols-1 gap-6 md:grid-cols-12 md:items-end">
        <div className={split ? "md:col-span-7" : "md:col-span-9 xl:col-span-8"}>
          <h2 className="t-title max-w-[22ch] text-[30px] text-ink-1 [text-wrap:balance] md:text-[38px]">{title}</h2>
          {children && !split ? <p className={cn("mt-4", lead)}>{children}</p> : null}
        </div>
        {children && split ? <p className={cn("md:col-span-5 md:col-start-8 md:self-end", lead)}>{children}</p> : null}
        {aside ? <div className="md:col-span-3 md:justify-self-end xl:col-span-4">{aside}</div> : null}
      </div>
    </header>
  );
}

/** Sentence-case panel title. */
export function Label({ children, className }: { children: ReactNode; className?: string }) {
  return <span className={cn("t-label", className)}>{children}</span>;
}

/** A labelled readout cell used inside instrument strips. */
export function Readout({
  label,
  value,
  unit,
  sub,
  className,
  tone,
}: {
  label: ReactNode;
  value: ReactNode;
  unit?: string;
  sub?: ReactNode;
  className?: string;
  tone?: Tone;
}) {
  return (
    <div className={cn("flex min-w-0 flex-col gap-2", className)}>
      <span className="flex items-center gap-2">
        {tone ? <Glyph tone={tone} size={7} /> : null}
        <Micro>{label}</Micro>
      </span>
      <span className="flex items-baseline gap-1.5">
        <span className="t-figure text-[28px] tabular-nums text-ink-1">{value}</span>
        {unit ? <span className="t-data text-[12px] text-ink-3">{unit}</span> : null}
      </span>
      {sub ? <span className="text-[12.5px] leading-snug text-ink-3 [text-wrap:pretty]">{sub}</span> : null}
    </div>
  );
}
