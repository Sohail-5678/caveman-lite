import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}

const int = new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 });

export function fmtInt(n: number): string {
  return int.format(Math.round(n));
}

/** Joins a number to its unit so a line never breaks between them. */
export const NBSP = "\u00a0";

export function fmtMs(ms: number): string {
  if (!Number.isFinite(ms)) return "—";
  return `${fmtMsValue(ms)}${NBSP}ms`;
}

/** Number only, for places where the unit is typeset separately. */
export function fmtMsValue(ms: number): string {
  if (!Number.isFinite(ms)) return "—";
  if (ms < 1) return ms.toFixed(2);
  if (ms < 10) return ms.toFixed(1);
  return int.format(Math.round(ms));
}

export function fmtUs(ms: number): string {
  const us = ms * 1000;
  if (us < 1000) return `${Math.max(1, Math.round(us))}${NBSP}µs`;
  return fmtMs(ms);
}

export function fmtUsd(n: number): string {
  if (n === 0) return "$0";
  if (Math.abs(n) < 0.01) return `$${n.toFixed(4)}`;
  if (Math.abs(n) < 1) return `$${n.toFixed(3)}`;
  if (Math.abs(n) < 1000) return `$${n.toFixed(2)}`;
  return `$${int.format(Math.round(n))}`;
}

export function fmtPct(ratio: number, digits = 1): string {
  if (!Number.isFinite(ratio)) return "—";
  return `${(ratio * 100).toFixed(digits)}%`;
}

export function fmtSigned(ratio: number, digits = 1): string {
  const v = ratio * 100;
  const s = v > 0 ? "+" : v < 0 ? "−" : "±";
  return `${s}${Math.abs(v).toFixed(digits)}%`;
}

export function truncate(text: string, n: number): string {
  const clean = text.replace(/[\u{E0000}-\u{E007F}]/gu, "").replace(/\s+/g, " ").trim();
  return clean.length > n ? `${clean.slice(0, n - 1)}…` : clean;
}

/** Difference of two shares, in percentage points: −0.8 pp. */
export function fmtPp(delta: number, digits = 1): string {
  const v = delta * 100;
  const sign = v > 0.05 ? "+" : v < -0.05 ? "−" : "±";
  return `${sign}${Math.abs(v).toFixed(digits)}\u202fpp`;
}

export function plural(n: number, word: string, many = `${word}s`): string {
  return `${fmtInt(n)}${NBSP}${n === 1 ? word : many}`;
}

/** Whole seconds left on a breaker cooldown, clamped so a stale clock can never print an impossible value. */
export function fmtCountdown(msLeft: number, cooldownMs: number): string {
  const s = Math.min(Math.ceil(cooldownMs / 1000), Math.max(0, Math.ceil(msLeft / 1000)));
  return `${s}${NBSP}s`;
}
