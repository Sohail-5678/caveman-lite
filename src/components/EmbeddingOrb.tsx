"use client";

import { useEffect, useRef } from "react";
import { mulberry32 } from "@/lib/utils/prng";
import { EMBEDDING_DIM } from "@/lib/cache/semantic-cache";
import type { Tone } from "@/lib/gateway/choreography";
import { TONE_RGB } from "./corridor/renderer";
import { getTheme, onThemeChange } from "@/lib/theme";

type V3 = [number, number, number];
type P2 = { x: number; y: number; z: number };

const REF = (() => {
  const r = mulberry32(384);
  const v = new Float32Array(EMBEDDING_DIM);
  for (let i = 0; i < v.length; i++) v[i] = r() - 0.5;
  return v;
})();

function dot(a: Float32Array, b: Float32Array) {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i] * b[i];
  return s;
}
function norm(v: Float32Array) {
  const n = Math.sqrt(dot(v, v)) || 1;
  const out = new Float32Array(v.length);
  for (let i = 0; i < v.length; i++) out[i] = v[i] / n;
  return out;
}
function reject(v: Float32Array, ...basis: Float32Array[]) {
  const out = new Float32Array(v);
  for (const e of basis) {
    const k = dot(out, e);
    for (let i = 0; i < out.length; i++) out[i] -= k * e[i];
  }
  return out;
}

/**
 * Angle-preserving view of 384-dim space around the cached key A:
 * A sits at the pole, so every latitude ring is a cosine-similarity contour and the τ cap is the
 * acceptance region. B is placed at its true angle from A; background entries keep their true
 * similarity to A and take their azimuth from a fixed projection.
 */
function layout(a: Float32Array, b: Float32Array, background: Float32Array[]) {
  const e1 = norm(a);
  let r2 = reject(b, e1);
  if (Math.sqrt(dot(r2, r2)) < 1e-6) r2 = reject(REF, e1);
  const e2 = norm(r2);
  const e3 = norm(reject(REF, e1, e2));
  const place = (p: Float32Array): V3 => {
    const x = Math.max(-1, Math.min(1, dot(p, e1)));
    const th = Math.acos(x);
    const ph = Math.atan2(dot(p, e3), dot(p, e2));
    return [Math.sin(th) * Math.cos(ph), Math.cos(th), Math.sin(th) * Math.sin(ph)];
  };
  return { b: place(norm(b)), background: background.map((v) => place(norm(v))) };
}

/** About 1 rad: the cap reads nearly round and the latitudes read as concentric contours around A. */
const PITCH = 1.0;
const CONTOURS = [0.8, 0.6, 0.4, 0.2, 0, -0.4];
const LABELLED_CONTOURS = [0.8, 0.6, 0.4, 0.2];
/** Contour labels sit this far round from the meridian facing the viewer, on the side away from B. */
const LABEL_TURN = 0.45;
const INKS = { dark: "243,240,233", light: "23,24,27" } as const;
const HALOS = { dark: "rgba(13,15,18,0.92)", light: "rgba(254,252,249,0.92)" } as const;

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));
const sphere = (polar: number, az: number): V3 => [Math.sin(polar) * Math.cos(az), Math.cos(polar), Math.sin(polar) * Math.sin(az)];
const wrapPi = (a: number) => a - 2 * Math.PI * Math.round(a / (2 * Math.PI));

export interface OrbProps {
  a: Float32Array | null;
  b: Float32Array | null;
  background: Float32Array[];
  tau: number;
  naiveTau: number;
  tone: Tone;
  similarity: number;
}

export function EmbeddingOrb(props: OrbProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const propsRef = useRef(props);
  const invalidateRef = useRef<() => void>(() => {});

  useEffect(() => {
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext("2d");
    if (!canvas || !ctx) return;
    const motion = window.matchMedia("(prefers-reduced-motion: reduce)");
    let reduced = motion.matches;
    let size = 0;
    let dpr = 1;
    let yaw = 0;
    let goalYaw = 0;
    let pitch = PITCH;
    let goalPitch = PITCH;
    let shownTheta = 0;
    let drag: { x: number; y: number; id: number; mouse: boolean } | null = null;
    let raf = 0;
    let last = 0;
    let visible = true;
    let cache: { a: Float32Array; b: Float32Array; bg: Float32Array[]; out: ReturnType<typeof layout> } | null = null;
    const mono =
      getComputedStyle(document.documentElement).getPropertyValue("--font-jetbrains").trim() || "ui-monospace, monospace";

    const signal = (tone: Tone, a: number) => {
      const [r, g, b] = TONE_RGB[tone];
      return `rgba(${r},${g},${b},${clamp(a, 0, 1)})`;
    };
    let theme = getTheme();
    const ink = (a: number) => `rgba(${INKS[theme]},${a})`;

    /** The yaw that turns B's azimuth to screen-right, so the A→B arc is drawn at its true length. */
    const facingB = () => {
      if (!cache) return goalYaw;
      const [bx, , bz] = cache.out.b;
      return Math.hypot(bx, bz) < 1e-6 ? goalYaw : goalYaw + wrapPi(Math.atan2(bz, bx) - goalYaw);
    };

    const draw = () => {
      const p = propsRef.current;
      const W = size;
      const R = W * 0.42;
      const cx = W / 2;
      const cy = W * 0.56;
      const cyaw = Math.cos(yaw);
      const syaw = Math.sin(yaw);
      const cp = Math.cos(pitch);
      const sp = Math.sin(pitch);
      const proj = (v: V3): P2 => {
        const x = v[0] * cyaw + v[2] * syaw;
        const z = -v[0] * syaw + v[2] * cyaw;
        const y = v[1] * cp - z * sp;
        const z2 = v[1] * sp + z * cp;
        const s = 1 / (1 - z2 * 0.12);
        return { x: cx + x * R * s, y: cy - y * R * s, z: z2 };
      };

      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, W, W);
      ctx.lineCap = "round";
      ctx.lineJoin = "round";

      // silhouette: flat, hairline
      ctx.beginPath();
      ctx.arc(cx, cy, R, 0, Math.PI * 2);
      ctx.fillStyle = ink(0.02);
      ctx.fill();
      ctx.strokeStyle = ink(0.16);
      ctx.lineWidth = 1;
      ctx.stroke();

      // similarity contours and meridians, batched into one front and one back path each
      const contourFront = new Path2D();
      const contourBack = new Path2D();
      const meridianFront = new Path2D();
      const meridianBack = new Path2D();
      const trace = (pts: P2[], front: Path2D, back: Path2D) => {
        for (let i = 1; i < pts.length; i++) {
          const path = pts[i].z > -0.05 ? front : back;
          path.moveTo(pts[i - 1].x, pts[i - 1].y);
          path.lineTo(pts[i].x, pts[i].y);
        }
      };
      const ring = (polar: number, n = 72) => Array.from({ length: n + 1 }, (_, i) => proj(sphere(polar, (i / n) * Math.PI * 2)));
      for (const c of CONTOURS) trace(ring(Math.acos(c)), contourFront, contourBack);
      for (let m = 0; m < 12; m++) {
        const az = (m / 12) * Math.PI * 2;
        trace(
          Array.from({ length: 41 }, (_, i) => proj(sphere((i / 40) * Math.PI, az))),
          meridianFront,
          meridianBack,
        );
      }
      ctx.lineWidth = 1;
      ctx.strokeStyle = ink(0.025);
      ctx.stroke(meridianBack);
      ctx.strokeStyle = ink(0.04);
      ctx.stroke(contourBack);

      const capAngle = Math.acos(clamp(p.tau, -1, 1));
      const cap = new Path2D();
      const outsideCap = new Path2D();
      outsideCap.rect(0, 0, W, W);
      ring(capAngle, 64).forEach((q, i) => {
        if (i) {
          cap.lineTo(q.x, q.y);
          outsideCap.lineTo(q.x, q.y);
        } else {
          cap.moveTo(q.x, q.y);
          outsideCap.moveTo(q.x, q.y);
        }
      });
      cap.closePath();
      outsideCap.closePath();

      // far-side entries sit behind the globe, so none may appear inside the cap they are nowhere near
      if (cache) {
        ctx.save();
        ctx.clip(outsideCap, "evenodd");
        ctx.fillStyle = ink(0.14);
        for (const v of cache.out.background) {
          const q = proj(v);
          if (q.z >= 0) continue;
          ctx.beginPath();
          ctx.arc(q.x, q.y, 1.6, 0, Math.PI * 2);
          ctx.fill();
        }
        ctx.restore();
      }

      ctx.strokeStyle = ink(0.06);
      ctx.stroke(meridianFront);
      ctx.strokeStyle = ink(0.11);
      ctx.stroke(contourFront);

      if (!cache) return;
      const placed = cache.out;
      const azB = Math.atan2(placed.b[2], placed.b[0]);
      const shownB = sphere(shownTheta, azB);

      // acceptance cap: cos >= τ. A definition, not an outcome, so it looks the same for every verdict
      const tone = p.tone;
      ctx.fillStyle = ink(0.035);
      ctx.fill(cap);
      ctx.strokeStyle = ink(0.5);
      ctx.lineWidth = 1;
      ctx.stroke(cap);
      if (Math.abs(p.naiveTau - p.tau) > 1e-6) {
        const naive = ring(Math.acos(p.naiveTau), 64);
        ctx.setLineDash([2, 3]);
        ctx.lineWidth = 1;
        ctx.strokeStyle = ink(0.32);
        ctx.beginPath();
        naive.forEach((q, i) => (i ? ctx.lineTo(q.x, q.y) : ctx.moveTo(q.x, q.y)));
        ctx.stroke();
        ctx.setLineDash([]);
      }

      // near-side background entries
      ctx.fillStyle = ink(0.55);
      for (const v of placed.background) {
        const q = proj(v);
        if (q.z < 0) continue;
        ctx.beginPath();
        ctx.arc(q.x, q.y, 2.2, 0, Math.PI * 2);
        ctx.fill();
      }

      // vectors from the origin: the angle between them is the readout's "Angle"
      const o = proj([0, 0, 0]);
      const A = proj([0, 1, 0]);
      const B = proj(shownB);
      ctx.lineWidth = 1;
      for (const [to, alpha] of [
        [A, 0.6],
        [B, 0.4],
      ] as const) {
        ctx.strokeStyle = ink(alpha);
        ctx.beginPath();
        ctx.moveTo(o.x, o.y);
        ctx.lineTo(to.x, to.y);
        ctx.stroke();
      }

      // great-circle arc A → B on the surface, the only coloured line
      ctx.strokeStyle = tone === "bone" ? ink(0.75) : signal(tone, 0.9);
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      for (let i = 0; i <= 24; i++) {
        const q = proj(sphere((i / 24) * shownTheta, azB));
        if (i) ctx.lineTo(q.x, q.y);
        else ctx.moveTo(q.x, q.y);
      }
      ctx.stroke();

      // endpoints: A is a bone dot, B carries its decision's glyph shape
      const knock = (q: P2, r: number) => {
        ctx.fillStyle = HALOS[theme];
        ctx.beginPath();
        ctx.arc(q.x, q.y, r + 2.2, 0, Math.PI * 2);
        ctx.fill();
      };
      knock(A, 3.5);
      ctx.fillStyle = ink(1);
      ctx.beginPath();
      ctx.arc(A.x, A.y, 3.5, 0, Math.PI * 2);
      ctx.fill();
      knock(B, 4);
      ctx.fillStyle = tone === "bone" ? ink(1) : signal(tone, 1);
      ctx.beginPath();
      if (tone === "cinnabar") ctx.rect(B.x - 3.4, B.y - 3.4, 6.8, 6.8);
      else if (tone === "glacier") {
        ctx.moveTo(B.x, B.y - 4.4);
        ctx.lineTo(B.x + 4.4, B.y);
        ctx.lineTo(B.x, B.y + 4.4);
        ctx.lineTo(B.x - 4.4, B.y);
      } else if (tone === "amber") {
        ctx.moveTo(B.x, B.y - 4.2);
        ctx.lineTo(B.x + 4.4, B.y + 3.6);
        ctx.lineTo(B.x - 4.4, B.y + 3.6);
      } else ctx.arc(B.x, B.y, 4, 0, Math.PI * 2);
      ctx.fill();

      // labels, each with a knock-out halo so hairlines never strike through them
      const text = (s: string, x: number, y: number, fill: string, align: CanvasTextAlign) => {
        // kept inside the canvas: B can sit on the limb when the pair is far apart
        const w = ctx.measureText(s).width;
        const lo = align === "left" ? 4 : align === "right" ? 4 + w : 4 + w / 2;
        const hi = align === "left" ? W - 4 - w : align === "right" ? W - 4 : W - 4 - w / 2;
        const tx = clamp(x, lo, hi);
        const ty = clamp(y, 8, W - 8);
        ctx.textAlign = align;
        ctx.strokeStyle = HALOS[theme];
        ctx.lineWidth = 3;
        ctx.strokeText(s, tx, ty);
        ctx.fillStyle = fill;
        ctx.fillText(s, tx, ty);
      };
      ctx.textBaseline = "middle";

      // A and B labels sit on the A→B line: A's behind A, B's beyond B
      let dx = B.x - A.x;
      let dy = B.y - A.y;
      const len = Math.hypot(dx, dy);
      if (len < 2) {
        dx = 1;
        dy = 0;
      } else {
        dx /= len;
        dy /= len;
      }
      ctx.font = `500 10.5px ${mono}`;
      text("A", A.x - dx * 14, A.y - dy * 14, ink(0.92), "center");
      text("B", B.x + dx * 14, B.y + dy * 14, ink(0.92), "center");

      // τ on the cap rim, on the side away from B
      ctx.font = `10.5px ${mono}`;
      const rim = proj(sphere(capAngle, azB + Math.PI));
      if (rim.z > -0.05) text(`τ ${p.tau.toFixed(2)}`, rim.x - 8, rim.y, ink(0.85), "right");

      // contour values down a meridian turned away from B, and never beside the vertex where they
      // would read as the angle
      const clear = (x: number, y: number, p0: P2, p1: P2) => {
        const vx = p1.x - p0.x;
        const vy = p1.y - p0.y;
        const t = clamp(((x - p0.x) * vx + (y - p0.y) * vy) / (vx * vx + vy * vy || 1), 0, 1);
        return Math.hypot(x - p0.x - t * vx, y - p0.y - t * vy);
      };
      for (const c of LABELLED_CONTOURS) {
        const q = proj(sphere(Math.acos(c), yaw + Math.PI / 2 + LABEL_TURN));
        if (q.z < 0) continue;
        const label = c.toFixed(1);
        const mid = q.x - 6 - ctx.measureText(label).width / 2;
        if (Math.hypot(mid - o.x, q.y - o.y) < 22 || clear(mid, q.y, o, A) < 12 || clear(mid, q.y, o, B) < 12) continue;
        text(label, q.x - 6, q.y, ink(0.5), "right");
      }
    };

    const frame = (now: number) => {
      raf = 0;
      if (!visible || size === 0) return;
      const dt = clamp((now - last) / 1000, 0, 0.05);
      last = now;
      const p = propsRef.current;
      if (p.a && p.b && (!cache || cache.a !== p.a || cache.b !== p.b || cache.bg !== p.background)) {
        cache = { a: p.a, b: p.b, bg: p.background, out: layout(p.a, p.b, p.background) };
        goalYaw = facingB();
      }
      const theta = cache ? Math.acos(clamp(cache.out.b[1], -1, 1)) : 0;
      const k = reduced ? 1 : 1 - Math.exp(-dt * 9);
      yaw += (goalYaw - yaw) * k;
      pitch += (goalPitch - pitch) * k;
      shownTheta += (theta - shownTheta) * (reduced ? 1 : 1 - Math.exp(-dt * 10));
      const settled =
        Math.abs(goalYaw - yaw) < 1e-4 && Math.abs(goalPitch - pitch) < 1e-4 && Math.abs(theta - shownTheta) < 1e-4;
      if (settled) {
        yaw = goalYaw;
        pitch = goalPitch;
        shownTheta = theta;
      }
      draw();
      if (!settled) raf = requestAnimationFrame(frame);
    };

    // drawn on demand: a frame is scheduled only by input, new props, resize or coming into view
    const invalidate = () => {
      if (raf) return;
      last = performance.now();
      raf = requestAnimationFrame(frame);
    };
    invalidateRef.current = invalidate;
    const offTheme = onThemeChange((t) => {
      theme = t;
      invalidate();
    });

    const resize = () => {
      const rect = canvas.getBoundingClientRect();
      size = rect.width;
      dpr = Math.min(2, window.devicePixelRatio || 1);
      canvas.width = Math.round(rect.width * dpr);
      canvas.height = Math.round(rect.height * dpr);
      invalidate();
    };
    const ro = new ResizeObserver(resize);
    ro.observe(canvas);
    resize();

    // a move to a screen of another density changes the pixel ratio but not the box, so no resize fires
    let dprQuery: MediaQueryList | null = null;
    const onDpr = () => {
      resize();
      watchDpr();
    };
    const watchDpr = () => {
      dprQuery = window.matchMedia(`(resolution: ${window.devicePixelRatio}dppx)`);
      dprQuery.addEventListener("change", onDpr, { once: true });
    };
    watchDpr();

    const io = new IntersectionObserver(([e]) => {
      visible = e.isIntersecting;
      if (visible) invalidate();
    });
    io.observe(canvas);

    const onMotion = (e: MediaQueryListEvent) => {
      reduced = e.matches;
      invalidate();
    };
    motion.addEventListener("change", onMotion);

    // Mouse and pen orbit freely. Touch only turns the globe on horizontal drags and never captures
    // the pointer, so a vertical swipe that starts on the canvas still scrolls the page (touch-pan-y).
    const down = (e: PointerEvent) => {
      if (e.pointerType === "mouse" && e.button !== 0) return;
      const mouse = e.pointerType !== "touch";
      drag = { x: e.clientX, y: e.clientY, id: e.pointerId, mouse };
      if (mouse) canvas.setPointerCapture(e.pointerId);
    };
    const move = (e: PointerEvent) => {
      if (!drag || drag.id !== e.pointerId) return;
      const dx = e.clientX - drag.x;
      const dy = e.clientY - drag.y;
      drag.x = e.clientX;
      drag.y = e.clientY;
      if (drag.mouse) {
        goalYaw += dx * 0.01;
        goalPitch = clamp(goalPitch + dy * 0.006, 0.2, 1.5);
      } else if (Math.abs(dx) > Math.abs(dy)) {
        goalYaw += dx * 0.01;
      } else return;
      invalidate();
    };
    const up = () => (drag = null);
    const reset = () => {
      goalPitch = PITCH;
      goalYaw = facingB();
      invalidate();
    };
    canvas.addEventListener("pointerdown", down);
    canvas.addEventListener("pointermove", move);
    canvas.addEventListener("pointerup", up);
    canvas.addEventListener("pointercancel", up);
    canvas.addEventListener("dblclick", reset);

    return () => {
      offTheme();
      cancelAnimationFrame(raf);
      invalidateRef.current = () => {};
      ro.disconnect();
      io.disconnect();
      dprQuery?.removeEventListener("change", onDpr);
      motion.removeEventListener("change", onMotion);
      canvas.removeEventListener("pointerdown", down);
      canvas.removeEventListener("pointermove", move);
      canvas.removeEventListener("pointerup", up);
      canvas.removeEventListener("pointercancel", up);
      canvas.removeEventListener("dblclick", reset);
    };
  }, []);

  const { a, b, background, tau, naiveTau, tone, similarity } = props;
  useEffect(() => {
    propsRef.current = { a, b, background, tau, naiveTau, tone, similarity };
    invalidateRef.current();
  }, [a, b, background, tau, naiveTau, tone, similarity]);

  const theta = (Math.acos(clamp(similarity, -1, 1)) * 180) / Math.PI;
  return (
    <canvas
      ref={canvasRef}
      className="block aspect-square w-full cursor-grab touch-pan-y select-none active:cursor-grabbing"
      role="img"
      aria-label={`Embedding space around the cached key A. B sits ${theta.toFixed(1)}° from A, cosine ${similarity.toFixed(3)}; the acceptance cap starts at τ ${tau.toFixed(2)}.`}
    />
  );
}
