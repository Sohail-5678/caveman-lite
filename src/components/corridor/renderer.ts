/**
 * Request-corridor renderer: a small perspective projector drawing to Canvas 2D.
 * Drawn like an architectural maquette — hairline structures on a dotted base plate — so the only
 * coloured pixels are small signal marks: packet glyphs, breaker rings and gate accents.
 * Motion happens on events only. When nothing is in flight and the camera has settled, no frame is drawn.
 */
import type { ProviderId } from "@/lib/types";
import type { BreakerState } from "@/lib/router/circuit-breaker";
import { BREAKER_COOLDOWN_MS, type GatewayController } from "@/lib/gateway/controller";
import {
  SCENE,
  positionAt,
  segmentAt,
  workerPosition,
  type GateId,
  type PacketPlan,
  type SceneEvent,
  type Tone,
  type Vec3,
} from "@/lib/gateway/choreography";

export const TONE_RGB: Record<Tone, [number, number, number]> = {
  bone: [243, 240, 233],
  malachite: [67, 205, 153],
  glacier: [92, 171, 238],
  amber: [255, 198, 93],
  cinnabar: [241, 97, 89],
};

const TONES = Object.keys(TONE_RGB) as Tone[];
const GATES: GateId[] = ["firewall", "t1", "t2", "lock", "router"];
const PROVIDERS: ProviderId[] = ["groq", "gemini", "claude"];

/** rgba() strings at 1% alpha steps, so hot loops never format colours. */
const RGBA: Record<Tone, string[]> = (() => {
  const out = {} as Record<Tone, string[]>;
  for (const tone of TONES) {
    const [r, g, b] = TONE_RGB[tone];
    out[tone] = Array.from({ length: 101 }, (_, i) => `rgba(${r},${g},${b},${i / 100})`);
  }
  return out;
})();
/** bg-0 keyline that separates a glyph from the hairlines behind it. */
const KEYLINE = Array.from({ length: 101 }, (_, i) => `rgba(7,8,11,${i / 100})`);

const lut = (a: number) => (a <= 0 ? 0 : a >= 1 ? 100 : Math.round(a * 100));
const rgba = (tone: Tone, a: number) => RGBA[tone][lut(a)];
const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

/* Liang–Barsky clip, used to test leaders against label boxes without allocating. */
const lb = { t0: 0, t1: 1 };
function lbClip(p: number, q: number): boolean {
  if (p === 0) return q >= 0;
  const t = q / p;
  if (p < 0) {
    if (t > lb.t1) return false;
    if (t > lb.t0) lb.t0 = t;
  } else {
    if (t < lb.t0) return false;
    if (t < lb.t1) lb.t1 = t;
  }
  return true;
}
function segmentHitsRect(x0: number, y0: number, x1: number, y1: number, r: ScreenRect, pad = 0): boolean {
  lb.t0 = 0;
  lb.t1 = 1;
  const dx = x1 - x0;
  const dy = y1 - y0;
  return (
    lbClip(-dx, x0 - (r.x - pad)) && lbClip(dx, r.x + r.w + pad - x0) && lbClip(-dy, y0 - (r.y - pad)) && lbClip(dy, r.y + r.h + pad - y0)
  );
}
function segmentsCross(ax: number, ay: number, bx: number, by: number, cx: number, cy: number, dx: number, dy: number): boolean {
  const d1 = (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);
  const d2 = (bx - ax) * (dy - ay) - (by - ay) * (dx - ax);
  const d3 = (dx - cx) * (ay - cy) - (dy - cy) * (ax - cx);
  const d4 = (dx - cx) * (by - cy) - (dy - cy) * (bx - cx);
  return d1 * d2 < 0 && d3 * d4 < 0;
}
const decay = (v: number, dt: number, tau: number) => {
  const next = v * Math.exp(-dt / tau);
  return next < 0.004 ? 0 : next;
};
const easeOut = (t: number) => 1 - Math.pow(1 - t, 3);

const unitCircles = new Map<number, Float32Array>();
/** [cos, sin] pairs for n + 1 points around the circle. */
function unitCircle(n: number): Float32Array {
  let u = unitCircles.get(n);
  if (!u) {
    u = new Float32Array((n + 1) * 2);
    for (let i = 0; i <= n; i++) {
      const a = (i / n) * Math.PI * 2;
      u[i * 2] = Math.cos(a);
      u[i * 2 + 1] = Math.sin(a);
    }
    unitCircles.set(n, u);
  }
  return u;
}

interface Cam {
  yaw: number;
  pitch: number;
  distance: number;
}

export const DEFAULT_CAMERA: Cam = { yaw: -0.74, pitch: 0.52, distance: 44 };
/** Phones look further down the corridor and from higher up, so the pipeline reads top to bottom. */
export const NARROW_CAMERA: Cam = { yaw: -1.1, pitch: 0.75, distance: 44 };
/** Canvas width (px) below which the phone camera and compact callouts take over. */
export const NARROW_BELOW = 720;
const CAM_KEYS = ["yaw", "pitch", "distance"] as const;
const TARGET: Vec3 = [-0.9, 0.9, 0];
const NEAR = 0.5;
/** Scrolling past the figure raises the camera until the maquette lies nearly flat. */
const SCROLL_PITCH = 0.38;
const SCROLL_DISTANCE = 8;
const MAX_PITCH = 1.42;

const ROUTER_REST = Math.PI / 4;
const ROUTER_TURN_MS = 240;

/* label layout, px */
const EDGE = 20;
/** Fallback floor for labels until the dock has been measured. */
const DOCK_CLEARANCE = 76;
const LABEL_GAP = 6;
/** Provider stacks sit further apart than the lines inside each stack, so they group. */
const RIGHT_GAP = 14;
/** Labels inside this distance of each other count as touching. */
const TOUCH = 4;
/** Right-side labels align their first text line with the anchor. */
const RIGHT_BASELINE = 8;
/** How far inside a label's end its leader lands when the label hangs to one side of the anchor. */
const LEADER_INSET = 8;
/** Gate captions try this many rows outward from their rail before collapsing to an index tag. */
const ROWS = 5;

interface Spark {
  p: Vec3;
  v: Vec3;
  life: number;
  max: number;
  tone: Tone;
}

interface Flash {
  tone: Tone;
  v: number;
}

/** Provider activity. Hue on the monolith belongs to the breaker alone, so traffic shows as brightness. */
interface ProviderFx {
  busy: number;
  flash: number;
  flashTau: number;
}

export interface ScreenRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface BreakerSnapshot {
  state: BreakerState;
  /** Date.now() of the last transition. */
  since: number;
}

export interface LabelSlot {
  id: string;
  anchor: Vec3;
  /** Screen-space distance from the anchor to the label, px. */
  lift: number;
  /** Which side of the anchor the label sits on. */
  side?: "above" | "below" | "right";
  /**
   * Share one rail with the other railed labels on the same side, like dimensions on a drawing:
   * one baseline for "above", one for "below", one column for "right".
   */
  rail?: boolean;
  /** Also draw a floor leader from this point to the anchor. */
  foot?: Vec3;
  /** False hides the label together with its leader and anchor dot. */
  visible?: boolean;
  el: HTMLElement | null;
  /** Index-only tag shown at the anchor when the full label finds no clear place. */
  tag?: HTMLElement | null;
}

type Projected = { x: number; y: number; s: number; z: number };
const projected = (): Projected => ({ x: 0, y: 0, s: 0, z: 0 });

interface LabelState {
  w: number;
  h: number;
  ok: boolean;
  shown: boolean;
  fade: number;
  q: Projected;
  /** Where the label belongs this frame (collisions are tested against this). */
  box: ScreenRect;
  /** Where it is drawn: eases toward box, so a re-stack slides instead of jumping. */
  view: ScreenRect;
  /** view - base and box - base, where base is the un-collided rail position */
  offX: number;
  offY: number;
  /** Candidate chosen last frame (row * 3 + alignment), tried first while the camera moves. */
  pick: number;
  /** Right-side leader: 0 runs level then drops, 1 drops then runs level. */
  route: number;
  /** last values written to the element */
  tx: number;
  ty: number;
  opacity: number;
  tag: { w: number; h: number; shown: boolean; box: ScreenRect; tx: number; ty: number };
}

const labelState = (): LabelState => ({
  w: 0,
  h: 0,
  ok: false,
  shown: false,
  fade: 1,
  q: projected(),
  box: { x: 0, y: 0, w: 0, h: 0 },
  view: { x: 0, y: 0, w: 0, h: 0 },
  offX: 0,
  offY: 0,
  pick: -1,
  route: 0,
  tx: NaN,
  ty: NaN,
  opacity: NaN,
  tag: { w: 0, h: 0, shown: false, box: { x: 0, y: 0, w: 0, h: 0 }, tx: NaN, ty: NaN },
});

/* static geometry */
const WORKERS: Vec3[] = Array.from({ length: 50 }, (_, i) => workerPosition(i));
const WORKER_HALF = 0.105;

const FIREWALL_FACE: Vec3[] = (() => {
  const { x, width, height } = SCENE.gates.firewall;
  const W = width / 2;
  return [
    [x, 0, -W],
    [x, height, -W],
    [x, height, W],
    [x, 0, W],
  ];
})();

const square = (x: number, cy: number, h: number): Vec3[] => [
  [x, cy - h, -h],
  [x, cy + h, -h],
  [x, cy + h, h],
  [x, cy - h, h],
];
const T1_HALF = SCENE.gates.t1.size / 2;
const T1_CY = 0.05 + T1_HALF;
const T1_OUTER = square(SCENE.gates.t1.x, T1_CY, T1_HALF);
const T1_INNER = square(SCENE.gates.t1.x, T1_CY, T1_HALF * 0.46);
const T1_WRITE = square(SCENE.gates.t1.x, T1_CY, T1_HALF * 0.33);

/** Eight points around a YZ circle: enough to bound its projection. */
const ringYZ = (x: number, cy: number, r: number): Vec3[] =>
  Array.from({ length: 8 }, (_, i): Vec3 => [x, cy + r * Math.sin((i / 8) * Math.PI * 2), r * Math.cos((i / 8) * Math.PI * 2)]);

/** Gate silhouettes that captions above the floor keep off. */
const GATE_SOLIDS: Vec3[][] = (() => {
  const { firewall, t2, lock, router } = SCENE.gates;
  const W = firewall.width / 2 + 0.1;
  return [
    [
      [firewall.x, 0, -W],
      [firewall.x, firewall.height + 0.08, -W],
      [firewall.x, firewall.height + 0.08, W],
      [firewall.x, 0, W],
    ],
    T1_OUTER,
    ringYZ(t2.x, 0.07 + t2.radius, t2.radius),
    ringYZ(lock.x, lock.y, lock.radius + 0.05),
    [
      [router.x, router.y + router.size, 0],
      [router.x, router.y - router.size, 0],
      [router.x - router.size, router.y, 0],
      [router.x + router.size, router.y, 0],
      [router.x, router.y, -router.size],
      [router.x, router.y, router.size],
    ],
  ];
})();

interface MonolithGeometry {
  front: Vec3[];
  side: Vec3[];
  top: Vec3[];
  edges: Array<[Vec3, Vec3]>;
  /** Box corners plus the breaker ring's extremes: the screen footprint labels keep off. */
  corners: Vec3[];
  led: Vec3;
}

const RING_Y = 1.28;

function monolith(id: ProviderId): MonolithGeometry {
  const { x, z } = SCENE.providers[id];
  const { w, d, h } = SCENE.monolith;
  const x0 = x - w / 2;
  const x1 = x + w / 2;
  const z0 = z - d / 2;
  const z1 = z + d / 2;
  // b = base, t = top; digits are (x, z) in {0, 1}
  const b00: Vec3 = [x0, 0, z0];
  const b01: Vec3 = [x0, 0, z1];
  const b11: Vec3 = [x1, 0, z1];
  const b10: Vec3 = [x1, 0, z0];
  const t00: Vec3 = [x0, h, z0];
  const t01: Vec3 = [x0, h, z1];
  const t11: Vec3 = [x1, h, z1];
  const t10: Vec3 = [x1, h, z0];
  return {
    front: [b00, t00, t01, b01],
    side: [b01, t01, t11, b11],
    top: [t00, t10, t11, t01],
    // the two base edges facing away from the camera are left out, as on a drawing
    edges: [
      [b00, t00],
      [b01, t01],
      [b11, t11],
      [b10, t10],
      [t00, t10],
      [t10, t11],
      [t11, t01],
      [t01, t00],
      [b00, b01],
      [b01, b11],
    ],
    corners: [
      b00,
      b01,
      b11,
      b10,
      t00,
      t01,
      t11,
      t10,
      [x - w * 0.95, RING_Y, z],
      [x + w * 0.95, RING_Y, z],
      [x, RING_Y, z - d * 1.25],
      [x, RING_Y, z + d * 1.25],
    ],
    led: [x0 - 0.01, h - 0.22, z],
  };
}

type StructureId = GateId | ProviderId;

export class CorridorRenderer {
  private main: CanvasRenderingContext2D;
  /** Points at the static layer while it is being rebuilt. */
  private ctx: CanvasRenderingContext2D;
  private layer: HTMLCanvasElement;
  private layerCtx: CanvasRenderingContext2D;
  private layerCam: Cam = { yaw: NaN, pitch: NaN, distance: NaN };
  private layerDirty = true;

  private w = 0;
  private h = 0;
  private dpr = 1;
  private f = 1;
  private cx = 0;
  private cy = 0;
  private narrow: boolean | null = null;

  private cam: Cam = { ...DEFAULT_CAMERA };
  /** Where the user put the camera. */
  private goal: Cam = { ...DEFAULT_CAMERA };
  /** goal raised by scroll progress; the camera eases toward this. */
  private aim: Cam = { ...DEFAULT_CAMERA };
  private scroll = 0;
  private camPos: Vec3 = [0, 0, 0];
  private right: Vec3 = [1, 0, 0];
  private up: Vec3 = [0, 1, 0];
  private fwd: Vec3 = [0, 0, -1];

  private raf = 0;
  private running = false;
  private last = 0;
  private lastDraw = 0;
  private dirty = true;
  private reduced = false;

  private gateFlash: Record<GateId, Flash> = {
    firewall: { tone: "bone", v: 0 },
    t1: { tone: "bone", v: 0 },
    t2: { tone: "bone", v: 0 },
    lock: { tone: "bone", v: 0 },
    router: { tone: "bone", v: 0 },
  };
  /** Cache writes: a response coming home through T1 / T2. */
  private writeMark = { t1: 0, t2: 0 };
  private iris = 0;
  private router = { from: ROUTER_REST, to: ROUTER_REST, t0: -Infinity };
  private routerEq: Vec3[] = [
    [0, 0, 0],
    [0, 0, 0],
    [0, 0, 0],
    [0, 0, 0],
  ];
  private routerTop: Vec3 = [SCENE.gates.router.x, SCENE.gates.router.y + SCENE.gates.router.size, 0];
  private routerBottom: Vec3 = [SCENE.gates.router.x, SCENE.gates.router.y - SCENE.gates.router.size, 0];
  private provider: Record<ProviderId, ProviderFx> = {
    groq: { busy: 0, flash: 0, flashTau: 0.5 },
    gemini: { busy: 0, flash: 0, flashTau: 0.5 },
    claude: { busy: 0, flash: 0, flashTau: 0.5 },
  };
  private breakers: Record<ProviderId, BreakerSnapshot> = {
    groq: { state: "CLOSED", since: 0 },
    gemini: { state: "CLOSED", since: 0 },
    claude: { state: "CLOSED", since: 0 },
  };
  private monoliths: Record<ProviderId, MonolithGeometry> = {
    groq: monolith("groq"),
    gemini: monolith("gemini"),
    claude: monolith("claude"),
  };
  private workerFlash: Flash[] = Array.from({ length: 50 }, () => ({ tone: "bone" as Tone, v: 0 }));
  private workerSq: Vec3[] = [
    [0, 0, 0],
    [0, 0, 0],
    [0, 0, 0],
    [0, 0, 0],
  ];
  private sparks: Spark[] = [];
  private sprites: Record<Tone, HTMLCanvasElement>;
  private floor: Float32Array;
  private order: Array<{ id: StructureId; at: Vec3; depth: number }>;
  private depth = {} as Record<StructureId, number>;

  private labels: LabelSlot[] = [];
  private labelState: LabelState[] = [];
  private labelObserver: ResizeObserver | null = null;
  private obstacles: ScreenRect[] = [];
  private vetoCard: ScreenRect | null = null;
  /** Top of the control dock (and anything docked on it), in canvas px; labels stay above it. */
  private floorY: number | null = null;
  private placed: ScreenRect[] = [];
  /** Rects the leader layer is knocked out of: overlays, drawn labels and index tags. */
  private knock: ScreenRect[] = [];
  /** Placed leaders as flat [x0, y0, x1, y1, …]; later labels must not cover them. */
  private segs: number[] = [];
  /** Screen bounds of the provider monoliths and their rings; gate captions keep off them. */
  private solids: ScreenRect[] = PROVIDERS.map(() => ({ x: 0, y: 0, w: 0, h: 0 }));
  /** Screen bounds of the gates; captions above the floor keep off them. */
  private gateSolids: ScreenRect[] = GATE_SOLIDS.map(() => ({ x: 0, y: 0, w: 0, h: 0 }));
  private candidate: ScreenRect = { x: 0, y: 0, w: 0, h: 0 };
  /** Scratch polyline for leader routing. */
  private pts: number[] = [0, 0, 0, 0, 0, 0, 0, 0];
  /** Labels are still sliding toward a new place. */
  private settling = false;
  private moving = false;

  private unsubscribe: (() => void) | null = null;
  private drag: { id: number; x: number; y: number } | null = null;

  /* scratch, so per-frame work allocates nothing */
  private qa = projected();
  private qb = projected();
  private qc = projected();
  private tmp: Vec3 = [0, 0, 0];

  constructor(
    private canvas: HTMLCanvasElement,
    private controller: GatewayController,
  ) {
    const ctx = canvas.getContext("2d");
    const layer = document.createElement("canvas");
    const layerCtx = layer.getContext("2d");
    if (!ctx || !layerCtx) throw new Error("Canvas 2D unavailable");
    this.main = this.ctx = ctx;
    this.layer = layer;
    this.layerCtx = layerCtx;
    this.reduced = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;

    const pts: number[] = [];
    for (let x = -11; x <= 8.51; x += 0.5) for (let z = -4; z <= 4.01; z += 0.5) pts.push(x, z);
    this.floor = new Float32Array(pts);

    this.sprites = {} as Record<Tone, HTMLCanvasElement>;
    for (const tone of TONES) this.sprites[tone] = this.makeSprite(tone);

    const g = SCENE.gates;
    this.order = [
      ...GATES.map((id) => ({ id, at: [g[id].x, 1, 0] as Vec3, depth: 0 })),
      ...PROVIDERS.map((id) => ({ id, at: [SCENE.providers[id].x, 1, SCENE.providers[id].z] as Vec3, depth: 0 })),
    ];

    this.unsubscribe = controller.onScene((e) => this.onEvent(e));
    canvas.addEventListener("pointerdown", this.onPointerDown);
    canvas.addEventListener("pointermove", this.onPointerMove);
    canvas.addEventListener("pointerup", this.onPointerUp);
    canvas.addEventListener("pointercancel", this.onPointerUp);
    canvas.addEventListener("lostpointercapture", this.onPointerUp);
    canvas.addEventListener("dblclick", this.onDoubleClick);
  }

  /* ── public API ──────────────────────────────────────────────────────── */

  /** Labels in priority order: when two would overlap, the earlier one keeps its place. */
  setLabels(labels: LabelSlot[]): void {
    this.labelObserver?.disconnect();
    this.labels = labels;
    this.labelState = labels.map(labelState);
    labels.forEach((_, i) => this.measureLabel(i));
    if (typeof ResizeObserver !== "undefined") {
      const index = new Map<Element, number>();
      labels.forEach((l, i) => l.el && index.set(l.el, i));
      this.labelObserver = new ResizeObserver((entries) => {
        let refit = false;
        for (const entry of entries) {
          const i = index.get(entry.target);
          if (i !== undefined && this.measureLabel(i) && this.labels[i].side === "right") refit = true;
        }
        if (refit) this.fit();
        this.dirty = true;
      });
      for (const el of index.keys()) this.labelObserver.observe(el);
    }
    this.fit();
  }

  setLabelVisible(id: string, visible: boolean): void {
    const label = this.labels.find((l) => l.id === id);
    if (!label || (label.visible !== false) === visible) return;
    label.visible = visible;
    this.dirty = true;
  }

  /** HTML overlays (caption, legend) the labels must keep clear of, in canvas pixels. */
  setObstacles(rects: ScreenRect[]): void {
    this.obstacles = rects;
    this.dirty = true;
  }

  /** Top edge of the dock band in canvas pixels; the scene and its labels fit above it. */
  setFloor(y: number | null): void {
    if (y === this.floorY) return;
    this.floorY = y;
    this.fit();
  }

  /**
   * The docked entity-veto card, in canvas pixels, or null while it is hidden. While set, labels keep
   * clear of it and one leader ties it to the T2 iris, routed around the gate captions.
   */
  setVetoCard(rect: ScreenRect | null): void {
    this.vetoCard = rect;
    this.dirty = true;
  }

  setBreakers(states: Record<ProviderId, BreakerSnapshot>): void {
    for (const id of PROVIDERS) {
      const b = this.breakers[id];
      if (b.state !== states[id].state) this.layerDirty = true;
      b.state = states[id].state;
      b.since = states[id].since;
    }
    this.dirty = true;
  }

  /** 0 while the figure is in view, 1 once it has scrolled away. Ignored under reduced motion. */
  setScrollProgress(p: number): void {
    const v = clamp(Number.isFinite(p) ? p : 0, 0, 1);
    if (v === this.scroll) return;
    this.scroll = v;
    this.dirty = true;
  }

  setReducedMotion(reduced: boolean): void {
    if (reduced === this.reduced) return;
    this.reduced = reduced;
    if (reduced) {
      this.sparks.length = 0;
      this.settleRouter();
    }
    this.dirty = true;
  }

  resize(width: number, height: number): void {
    this.dpr = Math.min(2, window.devicePixelRatio || 1);
    this.w = width;
    this.h = height;
    const pw = Math.round(width * this.dpr);
    const ph = Math.round(height * this.dpr);
    this.canvas.width = this.layer.width = pw;
    this.canvas.height = this.layer.height = ph;
    const narrow = width < NARROW_BELOW;
    if (narrow !== this.narrow) {
      this.narrow = narrow;
      Object.assign(this.goal, this.home());
      Object.assign(this.cam, this.home());
    }
    this.labels.forEach((_, i) => this.measureLabel(i));
    this.fit();
    // resizing cleared the canvas; repaint before the browser presents a blank frame
    if (this.running) {
      const now = performance.now();
      this.dirty = false;
      this.lastDraw = now;
      this.draw(now, Date.now(), 0, this.controller.activePlans(now));
    }
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.clearTransients();
    this.dirty = true;
    this.last = performance.now();
    this.raf = requestAnimationFrame(this.loop);
  }

  stop(): void {
    this.running = false;
    cancelAnimationFrame(this.raf);
  }

  resetCamera(): void {
    Object.assign(this.goal, this.home());
    this.dirty = true;
  }

  dispose(): void {
    this.stop();
    this.unsubscribe?.();
    this.labelObserver?.disconnect();
    this.canvas.removeEventListener("pointerdown", this.onPointerDown);
    this.canvas.removeEventListener("pointermove", this.onPointerMove);
    this.canvas.removeEventListener("pointerup", this.onPointerUp);
    this.canvas.removeEventListener("pointercancel", this.onPointerUp);
    this.canvas.removeEventListener("lostpointercapture", this.onPointerUp);
    this.canvas.removeEventListener("dblclick", this.onDoubleClick);
  }

  /* ── interaction ─────────────────────────────────────────────────────── */

  private onPointerDown = (e: PointerEvent) => {
    if (e.button !== 0) return;
    this.drag = { id: e.pointerId, x: e.clientX, y: e.clientY };
    try {
      this.canvas.setPointerCapture(e.pointerId);
    } catch {
      // capture is best-effort; pointerup on the canvas still ends the drag
    }
    this.canvas.style.cursor = "grabbing";
  };

  private onPointerMove = (e: PointerEvent) => {
    if (!this.drag || e.pointerId !== this.drag.id) return;
    const dx = e.clientX - this.drag.x;
    const dy = e.clientY - this.drag.y;
    this.drag.x = e.clientX;
    this.drag.y = e.clientY;
    this.goal.yaw = clamp(this.goal.yaw - dx * 0.0055, -1.15, 0.55);
    // touch keeps vertical swipes for page scroll (touch-action: pan-y), so only a mouse tilts
    if (e.pointerType === "mouse") this.goal.pitch = clamp(this.goal.pitch + dy * 0.004, 0.16, 0.98);
    this.dirty = true;
  };

  private onPointerUp = (e: PointerEvent) => {
    if (!this.drag || e.pointerId !== this.drag.id) return;
    this.drag = null;
    this.canvas.style.cursor = "";
    if (e.type !== "lostpointercapture" && this.canvas.hasPointerCapture?.(e.pointerId)) {
      this.canvas.releasePointerCapture(e.pointerId);
    }
  };

  private onDoubleClick = () => this.resetCamera();

  /* ── events from the controller ──────────────────────────────────────── */

  private onEvent(e: SceneEvent): void {
    if (e.type === "breaker") {
      const b = this.breakers[e.provider];
      if (b.state !== e.to) this.layerDirty = true;
      b.state = e.to;
      b.since = Date.now();
      this.dirty = true;
      return;
    }
    // Transients only mean something while watched; a backlog replayed on return would invent traffic.
    if (!this.running) return;
    this.dirty = true;
    switch (e.type) {
      case "gate":
        if ((e.gate === "t1" || e.gate === "t2") && e.tone === "bone") {
          this.writeMark[e.gate] = 1;
          break;
        }
        this.flashGate(e.gate, e.tone, e.tone === "bone" ? 0.55 : 1);
        if (e.gate === "router") this.turnRouter();
        break;
      case "veto":
        this.iris = 1;
        this.flashGate("t2", "cinnabar", 1);
        break;
      case "block":
        this.flashGate("firewall", "cinnabar", 1);
        break;
      case "spark":
        this.burst(e.pos, e.tone, e.count);
        break;
      case "provider":
        this.onProvider(e.provider, e.status, e.late === true);
        break;
      case "spawn":
        this.flashWorker(e.worker, "bone");
        break;
      case "complete":
        this.flashWorker(e.worker, e.tone);
        break;
      default:
        break;
    }
  }

  private flashGate(gate: GateId, tone: Tone, strength: number): void {
    const flash = this.gateFlash[gate];
    if (tone !== "bone" || strength >= flash.v) {
      flash.tone = tone;
      flash.v = strength;
    }
  }

  private flashWorker(worker: number, tone: Tone): void {
    const f = this.workerFlash[worker % 50];
    f.tone = tone;
    f.v = 1;
  }

  /**
   * The ring's hue is the breaker state and nothing else; the packet glyph already carries the tier.
   * A call arriving or returning brightens the ring in bone.
   */
  private onProvider(id: ProviderId, status: "busy" | "done" | "429" | "deflect", late = false): void {
    const p = this.provider[id];
    const probing = this.breakers[id].state === "HALF_OPEN";
    if (status === "busy") {
      p.busy = 1;
      // a request reaching a half-open provider is the probe: mark it once
      if (probing) this.pulseRing(p, true);
      return;
    }
    p.busy = status === "done" ? 0.6 : 0;
    // a straggler 429 after the trip is noise, not news: no pulse
    if (!late) this.pulseRing(p, probing);
  }

  private pulseRing(p: ProviderFx, probing: boolean): void {
    if (probing && this.reduced) return;
    p.flash = 1;
    p.flashTau = probing ? 0.25 : 0.5;
  }

  private turnRouter(): void {
    if (this.reduced) return;
    const now = performance.now();
    this.router.from = this.routerAngle(now);
    this.router.to += Math.PI / 2;
    this.router.t0 = now;
  }

  /** The octahedron has quarter-turn symmetry, so every completed turn comes to rest at the same pose. */
  private routerAngle(now: number): number {
    const r = this.router;
    const t = (now - r.t0) / ROUTER_TURN_MS;
    if (t >= 1) {
      this.settleRouter();
      return ROUTER_REST;
    }
    return r.from + (r.to - r.from) * easeOut(Math.max(0, t));
  }

  private settleRouter(): void {
    this.router.from = this.router.to = ROUTER_REST;
    this.router.t0 = -Infinity;
  }

  private burst(pos: Vec3, tone: Tone, count: number): void {
    if (this.reduced) return;
    const n = Math.round(count * 0.6);
    for (let i = 0; i < n; i++) {
      const u = Math.random() * 2 - 1;
      const th = Math.random() * Math.PI * 2;
      const r = Math.sqrt(1 - u * u);
      const speed = 0.9 + Math.random() * 1.8;
      const life = 340 + Math.random() * 360;
      this.sparks.push({
        p: [pos[0], pos[1], pos[2]],
        v: [-Math.abs(r * Math.cos(th)) * speed * 0.9, u * speed + 0.6, r * Math.sin(th) * speed],
        life,
        max: life,
        tone,
      });
    }
    if (this.sparks.length > 240) this.sparks.splice(0, this.sparks.length - 240);
  }

  private clearTransients(): void {
    for (const g of GATES) this.gateFlash[g].v = 0;
    this.writeMark.t1 = this.writeMark.t2 = 0;
    this.iris = 0;
    for (const id of PROVIDERS) {
      this.provider[id].flash = 0;
      this.provider[id].busy = 0;
    }
    for (const w of this.workerFlash) w.v = 0;
    this.sparks.length = 0;
    this.settleRouter();
  }

  /* ── camera & projection ─────────────────────────────────────────────── */

  private home(): Cam {
    return this.narrow ? NARROW_CAMERA : DEFAULT_CAMERA;
  }

  private updateBasis(cam: Cam): void {
    const cp = Math.cos(cam.pitch);
    const sp = Math.sin(cam.pitch);
    const cy = Math.cos(cam.yaw);
    const sy = Math.sin(cam.yaw);
    const p = this.camPos;
    p[0] = TARGET[0] + cam.distance * sy * cp;
    p[1] = TARGET[1] + cam.distance * sp;
    p[2] = TARGET[2] + cam.distance * cy * cp;
    let fx = TARGET[0] - p[0];
    let fy = TARGET[1] - p[1];
    let fz = TARGET[2] - p[2];
    const fl = Math.hypot(fx, fy, fz);
    fx /= fl;
    fy /= fl;
    fz /= fl;
    this.fwd[0] = fx;
    this.fwd[1] = fy;
    this.fwd[2] = fz;
    // right = fwd × worldUp
    const rl = Math.hypot(fz, fx) || 1;
    const rx = -fz / rl;
    const rz = fx / rl;
    this.right[0] = rx;
    this.right[1] = 0;
    this.right[2] = rz;
    // up = right × fwd
    this.up[0] = -rz * fy;
    this.up[1] = rz * fx - rx * fz;
    this.up[2] = rx * fy;
  }

  /** Normalised camera-space projection (before scale and offset). */
  private projectRaw(x: number, y: number, z: number, out: Projected): boolean {
    const vx = x - this.camPos[0];
    const vy = y - this.camPos[1];
    const vz = z - this.camPos[2];
    const d = vx * this.fwd[0] + vy * this.fwd[1] + vz * this.fwd[2];
    if (d < NEAR) return false;
    out.x = (vx * this.right[0] + vy * this.right[1] + vz * this.right[2]) / d;
    out.y = -(vx * this.up[0] + vy * this.up[1] + vz * this.up[2]) / d;
    out.s = 1 / d;
    out.z = d;
    return true;
  }

  private project(x: number, y: number, z: number, out: Projected): boolean {
    if (!this.projectRaw(x, y, z, out)) return false;
    out.x = this.cx + this.f * out.x;
    out.y = this.cy + this.f * out.y;
    out.s = this.f * out.s;
    return true;
  }

  /**
   * Fit the scene into the canvas at the home camera, inside insets: the caption and legend above,
   * the control dock below, and room on the right for the provider callouts.
   */
  private fit(): void {
    if (!this.w || !this.h) return;
    this.updateBasis(this.home());
    const narrow = !!this.narrow;
    const top = narrow ? 96 : 64;
    const bottom = this.floorY === null ? 92 : this.h - this.floorY + 16;
    const left = narrow ? 8 : 40;
    const right = EDGE;
    const q = this.qa;
    // [raw x, px that must fit to its right]
    const reach: number[] = [];
    let minX = Infinity;
    let minY = Infinity;
    let maxY = -Infinity;
    for (const x of [-10.9, 8.2]) {
      for (const y of [0, 2.9]) {
        for (const z of [-3.9, 3.9]) {
          if (!this.projectRaw(x, y, z, q)) continue;
          minX = Math.min(minX, q.x);
          minY = Math.min(minY, q.y);
          maxY = Math.max(maxY, q.y);
          reach.push(q.x, 0);
        }
      }
    }
    this.labels.forEach((l, i) => {
      if (l.side !== "right" || !this.projectRaw(l.anchor[0], l.anchor[1], l.anchor[2], q)) return;
      reach.push(q.x, l.lift + (this.labelState[i].w || 100) + 4);
    });
    if (!Number.isFinite(minX) || maxY <= minY) return;
    const W = this.w - left - right;
    const H = this.h - top - bottom;
    let f = H / (maxY - minY);
    for (let i = 0; i < reach.length; i += 2) {
      const span = reach[i] - minX;
      if (span > 1e-6) f = Math.min(f, (W - reach[i + 1]) / span);
    }
    f = Math.max(1, f);
    let far = -Infinity;
    for (let i = 0; i < reach.length; i += 2) far = Math.max(far, f * reach[i] + reach[i + 1]);
    const lo = left - f * minX;
    const hi = this.w - right - far;
    this.f = f;
    this.cx = hi >= lo ? (lo + hi) / 2 : lo;
    this.cy = top + H / 2 - (f * (minY + maxY)) / 2;
    this.layerDirty = true;
    this.dirty = true;
  }

  /* ── frame ───────────────────────────────────────────────────────────── */

  private loop = (now: number): void => {
    if (!this.running) return;
    this.raf = requestAnimationFrame(this.loop);
    this.tick(now);
  };

  private tick(now: number): void {
    const dt = clamp((now - this.last) / 1000, 0, 0.05);
    this.last = now;

    // camera: critically damped follow toward the user's goal, raised by scroll
    const lift = this.reduced ? 0 : this.scroll;
    this.aim.yaw = this.goal.yaw;
    this.aim.pitch = Math.min(MAX_PITCH, this.goal.pitch + SCROLL_PITCH * lift);
    this.aim.distance = this.goal.distance + SCROLL_DISTANCE * lift;
    const k = 1 - Math.exp(-dt * 7);
    let moving = false;
    for (const key of CAM_KEYS) {
      const d = this.aim[key] - this.cam[key];
      if (Math.abs(d) < 2e-4) this.cam[key] = this.aim[key];
      else {
        this.cam[key] += d * k;
        moving = true;
      }
    }
    this.moving = moving || this.drag !== null;

    // decay transient state, tracking whether anything is still visibly changing
    let live = 0;
    for (const g of GATES) live = Math.max(live, (this.gateFlash[g].v = decay(this.gateFlash[g].v, dt, 0.42)));
    live = Math.max(live, (this.writeMark.t1 = decay(this.writeMark.t1, dt, 0.6)));
    live = Math.max(live, (this.writeMark.t2 = decay(this.writeMark.t2, dt, 0.6)));
    live = Math.max(live, (this.iris = decay(this.iris, dt, 0.9)));
    for (const id of PROVIDERS) {
      const p = this.provider[id];
      live = Math.max(live, (p.flash = decay(p.flash, dt, p.flashTau)));
      if (p.busy < 1) live = Math.max(live, (p.busy = decay(p.busy, dt, 0.6)));
    }
    for (const wf of this.workerFlash) live = Math.max(live, (wf.v = decay(wf.v, dt, 0.7)));

    const plans = this.controller.activePlans(now);
    const wall = Date.now();
    const turning = this.router.t0 + ROUTER_TURN_MS > now;
    const animating = moving || live > 0 || plans.length > 0 || this.sparks.length > 0 || turning || this.settling;
    // an open breaker's cooldown arc drains slowly; a few redraws a second keep it honest
    const draining = !animating && now - this.lastDraw > 120 && this.anyCooling(wall);
    if (!animating && !this.dirty && !draining) return;
    this.dirty = false;
    this.lastDraw = now;
    this.draw(now, wall, dt, plans);
  }

  private anyCooling(wall: number): boolean {
    for (const id of PROVIDERS) {
      const b = this.breakers[id];
      if (b.state === "OPEN" && wall - b.since < BREAKER_COOLDOWN_MS) return true;
    }
    return false;
  }

  private draw(now: number, wall: number, dt: number, plans: PacketPlan[]): void {
    this.updateBasis(this.cam);
    const c = this.cam;
    const l = this.layerCam;
    if (this.layerDirty || c.yaw !== l.yaw || c.pitch !== l.pitch || c.distance !== l.distance) this.renderLayer();

    const ctx = this.main;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    ctx.drawImage(this.layer, 0, 0);
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.lineCap = "round";
    ctx.lineJoin = "round";

    this.drawWorkerFlashes();

    let orbiting = 0;
    for (const p of plans) {
      if (now >= p.start && now <= p.end && segmentAt(p, now)?.kind === "orbit") orbiting++;
    }

    // structures, far to near (order is re-sorted whenever the camera moves)
    for (const s of this.order) {
      switch (s.id) {
        case "firewall":
          this.drawFirewall();
          break;
        case "t1":
          this.drawT1();
          break;
        case "t2":
          this.drawT2();
          break;
        case "lock":
          this.drawLock(orbiting);
          break;
        case "router":
          this.drawRouter(now);
          break;
        default:
          this.drawProvider(s.id, wall);
      }
    }

    this.drawPackets(plans, now);
    if (this.sparks.length) this.drawSparks(dt);
    this.placeLabels(dt);
  }

  /** Floor, plate, ruler, lanes, footprints and worker outlines: redrawn only when the view changes. */
  private renderLayer(): void {
    const lc = this.layerCtx;
    lc.setTransform(1, 0, 0, 1, 0, 0);
    lc.clearRect(0, 0, this.layer.width, this.layer.height);
    lc.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    lc.lineCap = "round";
    lc.lineJoin = "round";
    this.ctx = lc;
    this.drawFloor();
    this.drawLanes();
    this.drawWorkerOutlines();
    this.ctx = this.main;
    Object.assign(this.layerCam, this.cam);
    this.layerDirty = false;

    const q = this.qa;
    for (const s of this.order) {
      s.depth = this.projectRaw(s.at[0], s.at[1], s.at[2], q) ? q.z : 0;
      this.depth[s.id] = s.depth;
    }
    this.order.sort((a, b) => b.depth - a.depth);
  }

  private fog(z: number): number {
    const near = this.cam.distance - 9;
    const far = this.cam.distance + 9;
    return clamp(1 - ((z - near) / (far - near)) * 0.7, 0.28, 1);
  }

  /* ── primitives ──────────────────────────────────────────────────────── */

  private path(points: readonly Vec3[], close = false): boolean {
    const ctx = this.ctx;
    const q = this.qa;
    ctx.beginPath();
    let started = false;
    let any = false;
    for (let i = 0; i < points.length; i++) {
      const p = points[i];
      if (!this.project(p[0], p[1], p[2], q)) {
        started = false;
        continue;
      }
      if (!started) {
        ctx.moveTo(q.x, q.y);
        started = any = true;
      } else ctx.lineTo(q.x, q.y);
    }
    if (close && any) ctx.closePath();
    return any;
  }

  private stroke(points: readonly Vec3[], style: string, width = 1, close = false): void {
    if (this.path(points, close)) this.strokeCurrent(style, width);
  }

  private fill(points: readonly Vec3[], style: string): void {
    if (!this.path(points, true)) return;
    this.ctx.fillStyle = style;
    this.ctx.fill();
  }

  private strokeCurrent(style: string, width: number): void {
    this.ctx.strokeStyle = style;
    this.ctx.lineWidth = width;
    this.ctx.stroke();
  }

  private line(ax: number, ay: number, az: number, bx: number, by: number, bz: number, style: string, width = 1): void {
    const a = this.qb;
    const b = this.qc;
    if (!this.project(ax, ay, az, a) || !this.project(bx, by, bz, b)) return;
    const ctx = this.ctx;
    ctx.beginPath();
    ctx.moveTo(a.x, a.y);
    ctx.lineTo(b.x, b.y);
    ctx.strokeStyle = style;
    ctx.lineWidth = width;
    ctx.stroke();
  }

  /** Arc in the YZ plane from angle a0 sweeping by `sweep`; angle 0 points at +z, π/2 straight up. */
  private arcYZ(x: number, cy: number, cz: number, r: number, a0 = 0, sweep = Math.PI * 2, n = 56): boolean {
    const ctx = this.ctx;
    const q = this.qa;
    const full = Math.abs(sweep) >= Math.PI * 2 - 1e-6;
    const u = full ? unitCircle(n) : null;
    ctx.beginPath();
    let started = false;
    let any = false;
    for (let i = 0; i <= n; i++) {
      let c: number;
      let s: number;
      if (u) {
        c = u[i * 2];
        s = u[i * 2 + 1];
      } else {
        const a = a0 + (sweep * i) / n;
        c = Math.cos(a);
        s = Math.sin(a);
      }
      if (!this.project(x, cy + r * s, cz + r * c, q)) {
        started = false;
        continue;
      }
      if (!started) {
        ctx.moveTo(q.x, q.y);
        started = any = true;
      } else ctx.lineTo(q.x, q.y);
    }
    return any;
  }

  private ringXZ(cx: number, y: number, cz: number, rx: number, rz: number, n = 48): boolean {
    const ctx = this.ctx;
    const q = this.qa;
    const u = unitCircle(n);
    ctx.beginPath();
    let started = false;
    let any = false;
    for (let i = 0; i <= n; i++) {
      if (!this.project(cx + rx * u[i * 2], y, cz + rz * u[i * 2 + 1], q)) {
        started = false;
        continue;
      }
      if (!started) {
        ctx.moveTo(q.x, q.y);
        started = any = true;
      } else ctx.lineTo(q.x, q.y);
    }
    return any;
  }

  /** Signal mark in its glyph shape: malachite ●, glacier ◆, amber ▲, cinnabar ■, bone ●. */
  private glyph(tone: Tone, x: number, y: number, r: number, alpha = 1, keyline = true): void {
    const ctx = this.ctx;
    ctx.beginPath();
    if (tone === "glacier") {
      const d = r * 1.1;
      ctx.moveTo(x, y - d);
      ctx.lineTo(x + d, y);
      ctx.lineTo(x, y + d);
      ctx.lineTo(x - d, y);
      ctx.closePath();
    } else if (tone === "amber") {
      const d = r * 1.1;
      ctx.moveTo(x, y - d);
      ctx.lineTo(x + d, y + d * 0.82);
      ctx.lineTo(x - d, y + d * 0.82);
      ctx.closePath();
    } else if (tone === "cinnabar") {
      const d = r * 0.92;
      ctx.rect(x - d, y - d, d * 2, d * 2);
    } else ctx.arc(x, y, r, 0, Math.PI * 2);
    if (keyline) {
      // small marks would otherwise be mostly keyline
      ctx.lineWidth = Math.min(1.5, r * 0.5);
      ctx.strokeStyle = KEYLINE[lut(alpha * 0.85)];
      ctx.stroke();
    }
    ctx.fillStyle = rgba(tone, tone === "bone" ? alpha * 0.92 : alpha);
    ctx.fill();
  }

  /**
   * The one hairline per gate that may take the decision's hue at peak. Everything else on a gate
   * answers a flash with brightness only (see gateBone), so the packets stay the colour carriers.
   */
  private gateStroke(gate: GateId, base = 0.4): string {
    const flash = this.gateFlash[gate];
    const depth = this.fog(this.depth[gate] ?? this.cam.distance);
    if (flash.tone === "bone" || flash.v < 0.02) return rgba("bone", (base + flash.v * 0.35) * depth);
    return rgba(flash.tone, (base + flash.v * 0.55) * depth);
  }

  private gateBone(gate: GateId, base = 0.4, gain = 0.35): string {
    const depth = this.fog(this.depth[gate] ?? this.cam.distance);
    return rgba("bone", (base + this.gateFlash[gate].v * gain) * depth);
  }

  /** Accent tone of a gate while its flash is visible, else null. */
  private accent(gate: GateId, min = 0.02): Tone | null {
    const flash = this.gateFlash[gate];
    return flash.tone !== "bone" && flash.v > min ? flash.tone : null;
  }

  /* ── static layer ────────────────────────────────────────────────────── */

  private drawFloor(): void {
    const ctx = this.ctx;
    const pts = this.floor;
    const q = this.qa;
    for (let i = 0; i < pts.length; i += 2) {
      const x = pts[i];
      const z = pts[i + 1];
      if (!this.project(x, 0, z, q)) continue;
      const major = Math.abs(x % 2) < 0.01 && Math.abs(z % 2) < 0.01;
      const edge = Math.max(Math.abs(z) / 4.1, Math.max(0, (Math.abs(x + 1.2) - 7.5) / 3));
      const a = (major ? 0.32 : 0.15) * this.fog(q.z) * (1 - Math.min(1, edge) * 0.55);
      ctx.fillStyle = rgba("bone", a);
      const s = clamp(q.s * (major ? 0.06 : 0.045), 0.8, 1.8);
      ctx.fillRect(q.x - s / 2, q.y - s / 2, s, s);
    }

    // base plate outline with a ruler along the front edge
    const plate: Vec3[] = [
      [-11.2, 0, -4.2],
      [8.7, 0, -4.2],
      [8.7, 0, 4.2],
      [-11.2, 0, 4.2],
    ];
    this.stroke(plate, rgba("bone", 0.09), 1, true);
    for (let x = -11; x <= 8.5; x += 0.5) {
      const major = Math.abs(x % 2.5) < 0.01;
      this.line(x, 0, 4.2, x, 0, 4.2 - (major ? 0.26 : 0.12), rgba("bone", major ? 0.24 : 0.12));
    }
  }

  private drawLanes(): void {
    const { laneSpread, entryX, gates, providers, shieldX } = SCENE;
    const a = rgba("bone", 0.075);
    for (const z of [-laneSpread - 0.08, laneSpread + 0.08]) {
      this.stroke(
        [
          [entryX, 0, z],
          [gates.lock.x + 0.6, 0, z],
          [gates.router.x, 0, z * 0.18],
        ],
        a,
      );
    }
    for (const id of PROVIDERS) {
      const p = providers[id];
      this.stroke(
        [
          [gates.router.x, 0, 0],
          [shieldX - 0.4, 0, p.z * 0.9],
          [p.x - 0.4, 0, p.z],
        ],
        rgba("bone", this.breakers[id].state === "OPEN" ? 0.04 : 0.09),
      );
    }
    // gate footprints
    const foot = (x: number, half: number) =>
      this.stroke(
        [
          [x - 0.07, 0, -half],
          [x + 0.07, 0, -half],
          [x + 0.07, 0, half],
          [x - 0.07, 0, half],
        ],
        rgba("bone", 0.14),
        1,
        true,
      );
    foot(gates.firewall.x, gates.firewall.width / 2);
    foot(gates.t1.x, gates.t1.size / 2);
    foot(gates.t2.x, 0.5);
    foot(gates.lock.x, 0.3);
  }

  private workerSquare(i: number): Vec3[] {
    const [x, y, z] = WORKERS[i];
    const s = WORKER_HALF;
    const sq = this.workerSq;
    sq[0][0] = x - s;
    sq[0][1] = y;
    sq[0][2] = z - s;
    sq[1][0] = x + s;
    sq[1][1] = y;
    sq[1][2] = z - s;
    sq[2][0] = x + s;
    sq[2][1] = y;
    sq[2][2] = z + s;
    sq[3][0] = x - s;
    sq[3][1] = y;
    sq[3][2] = z + s;
    return sq;
  }

  private drawWorkerOutlines(): void {
    const style = rgba("bone", 0.2);
    for (let i = 0; i < 50; i++) this.stroke(this.workerSquare(i), style, 1, true);
  }

  /* ── dynamic layer ───────────────────────────────────────────────────── */

  /** Spawn brightens the tile; completion leaves the outcome glyph in it. The tile itself stays bone. */
  private drawWorkerFlashes(): void {
    const q = this.qa;
    for (let i = 0; i < 50; i++) {
      const f = this.workerFlash[i];
      if (f.v < 0.01) continue;
      this.stroke(this.workerSquare(i), rgba("bone", 0.2 + f.v * 0.4), 1, true);
      if (f.tone === "bone") continue;
      const [x, y, z] = WORKERS[i];
      if (this.project(x, y, z, q)) this.glyph(f.tone, q.x, q.y, clamp(q.s * 0.07, 1.4, 2.6), Math.min(1, f.v * 1.5));
    }
  }

  private drawFirewall(): void {
    const { x, width, height } = SCENE.gates.firewall;
    const W = width / 2;
    this.fill(FIREWALL_FACE, rgba("bone", 0.016));
    // the face outline takes the block's hue; the louvres only brighten
    this.stroke(FIREWALL_FACE, this.gateStroke("firewall"), 1.2, true);
    const bar = rgba("bone", 0.16 + this.gateFlash.firewall.v * 0.45);
    const bars = 9;
    for (let i = 1; i < bars; i++) {
      const z = -W + (i / bars) * width;
      this.line(x, 0.06, z, x, height - 0.06, z, bar);
    }
    // top rail
    this.line(x, height + 0.08, -W - 0.1, x, height + 0.08, W + 0.1, rgba("bone", 0.28), 1.4);
  }

  private drawT1(): void {
    const { x } = SCENE.gates.t1;
    const h = T1_HALF;
    const ih = h * 0.46;
    const cy = T1_CY;
    const tone = this.accent("t1");
    const v = this.gateFlash.t1.v;
    this.fill(T1_OUTER, rgba("bone", 0.014));
    this.stroke(T1_OUTER, this.gateBone("t1"), 1.2, true);
    // the inner square is the hit's one toned line
    this.stroke(T1_INNER, tone ? rgba(tone, 0.45 + v * 0.5) : rgba("bone", 0.3), 1, true);
    // a response written into the cache on its way home
    if (this.writeMark.t1 > 0.01) this.dashed(T1_WRITE, this.writeMark.t1, true);
    // corner ticks join the two squares like a precision fixture
    const tick = rgba("bone", 0.12);
    this.line(x, cy - h, -h, x, cy - ih, -ih, tick);
    this.line(x, cy - h, h, x, cy - ih, ih, tick);
    this.line(x, cy + h, -h, x, cy + ih, -ih, tick);
    this.line(x, cy + h, h, x, cy + ih, ih, tick);
  }

  private dashed(points: readonly Vec3[] | null, v: number, close = false): void {
    if (points && !this.path(points, close)) return;
    const ctx = this.ctx;
    ctx.setLineDash([3, 3]);
    this.strokeCurrent(rgba("bone", 0.6 * v), 1);
    ctx.setLineDash([]);
  }

  private drawT2(): void {
    const { x, radius } = SCENE.gates.t2;
    const cy = 0.07 + radius;
    const tone = this.accent("t2", 0.05);
    const v = this.gateFlash.t2.v;
    if (this.arcYZ(x, cy, 0, radius)) {
      this.ctx.fillStyle = rgba("bone", 0.014);
      this.ctx.fill();
      this.strokeCurrent(this.gateBone("t2"), 1.2);
    }
    // iris: the gate's one toned line; it closes on an entity-guard veto
    const close = 1 - Math.pow(1 - this.iris, 3);
    const ir = radius * (0.56 - 0.42 * close);
    const vetoed = this.iris > 0.05;
    const irisTone: Tone = vetoed ? "cinnabar" : (tone ?? "bone");
    const strength = Math.max(this.iris, v);
    const irisAlpha = irisTone === "bone" ? 0.3 : 0.45 + strength * 0.5;
    if (this.arcYZ(x, cy, 0, ir, 0, Math.PI * 2, 40)) {
      if (vetoed) {
        this.ctx.fillStyle = rgba("cinnabar", 0.06 + this.iris * 0.12);
        this.ctx.fill();
      }
      this.strokeCurrent(rgba(irisTone, irisAlpha), 1.1);
    }
    const blades = 8;
    const twist = 0.35 + close * 0.9;
    const blade = rgba("bone", irisTone === "bone" ? 0.13 : 0.13 + strength * 0.3);
    for (let i = 0; i < blades; i++) {
      const a = (i / blades) * Math.PI * 2;
      this.line(x, cy + ir * Math.sin(a), ir * Math.cos(a), x, cy + radius * Math.sin(a + twist), radius * Math.cos(a + twist), blade);
    }
    if (this.writeMark.t2 > 0.01 && this.arcYZ(x, cy, 0, ir * 0.72, 0, Math.PI * 2, 32)) this.dashed(null, this.writeMark.t2);
  }

  /**
   * Singleflight lock. Its 24 ticks are a waiter gauge: one lit tick per ~2 coalesced followers,
   * filling clockwise from 12 o'clock, so the count can be read off the structure itself. The gauge
   * sits inside the rings and the followers orbit outside them, so the two never overprint.
   */
  private drawLock(orbiting: number): void {
    const { x, y, radius } = SCENE.gates.lock;
    const load = Math.min(1, orbiting / 50);
    const lit = orbiting > 0 ? Math.ceil(load * 24) : 0;
    // while followers wait, the lit ticks are the toned element and the rings only brighten
    const inner = orbiting > 0 ? rgba("bone", 0.4 + load * 0.25) : this.gateStroke("lock");
    if (this.arcYZ(x, y, 0, radius - 0.04)) this.strokeCurrent(inner, 1.2);
    if (this.arcYZ(x, y, 0, radius + 0.05)) this.strokeCurrent(rgba("bone", 0.22 + load * 0.12), 1);
    const on = rgba("glacier", 0.9);
    const off = rgba("bone", 0.14);
    const r0 = radius - 0.12;
    for (let i = 0; i < 24; i++) {
      // clockwise as seen from the camera: from straight up toward +z
      const a = Math.PI / 2 - (i / 24) * Math.PI * 2;
      const major = i % 6 === 0;
      const r1 = radius - (major ? 0.32 : 0.22);
      const s = Math.sin(a);
      const c = Math.cos(a);
      const isLit = i < lit;
      this.line(x, y + r0 * s, r0 * c, x, y + r1 * s, r1 * c, isLit ? on : off, isLit ? (major ? 2 : 1.6) : 1);
    }
    // pylon
    this.line(x, 0, 0, x, y - radius - 0.06, 0, rgba("bone", 0.16));
  }

  private drawRouter(now: number): void {
    const { x, y, size } = SCENE.gates.router;
    // the equator takes the tier's hue; the eight flanks only brighten
    const equator = this.gateStroke("router", 0.46);
    const flank = this.gateBone("router", 0.46, 0.3);
    const a = this.routerAngle(now);
    const eq = this.routerEq;
    for (let i = 0; i < 4; i++) {
      const ai = a + (i * Math.PI) / 2;
      eq[i][0] = x + size * Math.cos(ai);
      eq[i][1] = y;
      eq[i][2] = size * Math.sin(ai);
    }
    const top = this.routerTop;
    const bottom = this.routerBottom;
    for (let i = 0; i < 4; i++) {
      const e0 = eq[i];
      this.line(top[0], top[1], top[2], e0[0], e0[1], e0[2], flank, 1.1);
      this.line(bottom[0], bottom[1], bottom[2], e0[0], e0[1], e0[2], flank, 1.1);
    }
    for (let i = 0; i < 4; i++) {
      const e0 = eq[i];
      const e1 = eq[(i + 1) % 4];
      this.line(e0[0], e0[1], e0[2], e1[0], e1[1], e1[2], equator, 1.1);
    }
    this.line(bottom[0], bottom[1], bottom[2], x, 0, 0, rgba("bone", 0.16));
  }

  private drawProvider(id: ProviderId, wall: number): void {
    const { x, z } = SCENE.providers[id];
    const { w, d } = SCENE.monolith;
    const geo = this.monoliths[id];
    const { state, since } = this.breakers[id];
    const p = this.provider[id];
    const depth = this.fog(this.depth[id] ?? this.cam.distance);
    const busy = p.busy > 0.05 ? p.busy : 0;
    const edge = rgba("bone", (0.42 + busy * 0.25) * depth);

    // faces: front (facing the corridor), side, top
    this.fill(geo.front, rgba("bone", 0.03));
    this.fill(geo.side, rgba("bone", 0.018));
    this.fill(geo.top, rgba("bone", 0.06 + busy * 0.08));
    for (const [a, b] of geo.edges) this.line(a[0], a[1], a[2], b[0], b[1], b[2], edge, 1.1);

    // breaker ring: its hue is the breaker state only; traffic reaching it shows as a bone pulse
    const ringTone: Tone = state === "OPEN" ? "cinnabar" : state === "HALF_OPEN" ? "amber" : "malachite";
    const ringAlpha = state === "CLOSED" ? 0.5 : state === "HALF_OPEN" ? 0.6 : 0.8;
    if (this.ringXZ(x, RING_Y, z, w * 0.95, d * 1.25)) {
      this.strokeCurrent(rgba(ringTone, ringAlpha * depth), state === "CLOSED" ? 1.1 : 1.4);
      if (p.flash > 0.02) this.strokeCurrent(rgba("bone", p.flash * 0.5 * depth), 1.1 + p.flash * 0.7);
    }

    // status LED on the corridor-facing face, in the state's glyph shape
    const led = this.qa;
    if (this.project(geo.led[0], geo.led[1], geo.led[2], led)) {
      const lx = led.x;
      const ly = led.y;
      const r = Math.max(3, led.s * 0.12);
      this.ctx.globalAlpha = 0.3;
      this.ctx.drawImage(this.sprites[ringTone], lx - r, ly - r, r * 2, r * 2);
      this.ctx.globalAlpha = 1;
      this.glyph(ringTone, lx, ly, clamp(led.s * 0.07, 1.4, 2.2));
    }

    // shield in front of a tripped circuit; while open, an arc drains with the remaining cooldown
    if (state === "CLOSED") return;
    const open = state === "OPEN";
    const tone: Tone = open ? "cinnabar" : "amber";
    const sx = SCENE.shieldX;
    const sy = 1.12;
    const sz = z * 0.92;
    if (this.arcYZ(sx, sy, sz, 0.98, 0, Math.PI * 2, 48)) {
      this.ctx.fillStyle = rgba(tone, open ? 0.05 : 0.03);
      this.ctx.fill();
      this.strokeCurrent(rgba(tone, open ? 0.5 : 0.4), 1.2);
    }
    if (!open) {
      if (this.arcYZ(sx, sy, sz, 0.62, 0, Math.PI * 2, 40)) this.strokeCurrent(rgba(tone, 0.2), 1);
      return;
    }
    // open: a countdown dial, a faint track with the remaining cooldown drawn over it
    const narrow = !!this.narrow;
    const width = narrow ? 1.8 : 2;
    if (!narrow && this.arcYZ(sx, sy, sz, 0.8, 0, Math.PI * 2, 48)) this.strokeCurrent(rgba("cinnabar", 0.12), width);
    const left = clamp((BREAKER_COOLDOWN_MS - (wall - since)) / BREAKER_COOLDOWN_MS, 0, 1);
    if (left <= 0.002) return;
    // from 12 o'clock, clockwise as the camera sees it; the free end retreats toward 12 as time runs out
    const sweep = -left * Math.PI * 2;
    if (this.arcYZ(sx, sy, sz, 0.8, Math.PI / 2, sweep, Math.max(2, Math.ceil(left * 56)))) {
      this.ctx.lineCap = "butt";
      this.strokeCurrent(rgba("cinnabar", 0.8), width);
      this.ctx.lineCap = "round";
    }
    // a bone tick marks the free end, so the drain reads as a hand moving
    const end = Math.PI / 2 + sweep;
    const s = Math.sin(end);
    const c = Math.cos(end);
    this.line(sx, sy + 0.72 * s, sz + 0.72 * c, sx, sy + 0.9 * s, sz + 0.9 * c, rgba("bone", 0.85), 1.5);
  }

  /* ── packets & particles ─────────────────────────────────────────────── */

  private drawPackets(plans: PacketPlan[], now: number): void {
    const ctx = this.ctx;
    const q = this.qa;
    for (const plan of plans) {
      if (now < plan.start || now > plan.end) continue;
      const seg = segmentAt(plan, now);
      if (!seg) continue;
      // coalesced followers circling the lock are counted by the gauge; they draw as bare marks
      const orbit = seg.kind === "orbit";
      if (!orbit && !this.reduced) this.drawTrail(plan, now);
      const pos = positionAt(plan, now, this.tmp);
      if (!pos || !this.project(pos[0], pos[1], pos[2], q)) continue;
      const tone = seg.tone;
      // marks scale with the projection like the worker glyphs, so on a phone they never outsize a gate
      const r = clamp(q.s * 0.085 * plan.size, 1.6, 3);
      if (orbit) {
        this.glyph(tone, q.x, q.y, Math.max(1.2, r * 0.6), 0.7, false);
        continue;
      }
      const halo = Math.max(3, q.s * 0.2 * plan.size);
      ctx.globalAlpha = tone === "bone" ? 0.28 : 0.4;
      ctx.drawImage(this.sprites[tone], q.x - halo, q.y - halo, halo * 2, halo * 2);
      ctx.globalAlpha = 1;
      this.glyph(tone, q.x, q.y, tone === "bone" ? r * 0.7 : r);
    }
  }

  /** A short wake: the same path sampled slightly in the past. */
  private drawTrail(plan: PacketPlan, now: number): void {
    const ctx = this.ctx;
    const steps = 10;
    let prev = this.qb;
    let cur = this.qc;
    let has = false;
    for (let i = steps; i >= 0; i--) {
      const t = now - i * 17;
      if (t < plan.start) continue;
      const s = segmentAt(plan, t);
      const pos = s && s.kind !== "orbit" ? positionAt(plan, t, this.tmp) : null;
      if (!s || !pos || !this.project(pos[0], pos[1], pos[2], cur)) {
        has = false;
        continue;
      }
      if (has) {
        const k = 1 - i / steps;
        ctx.strokeStyle = rgba(s.tone, k * k * 0.32);
        ctx.lineWidth = clamp(cur.s * 0.05 * plan.size * k, 0.7, 1.3);
        ctx.beginPath();
        ctx.moveTo(prev.x, prev.y);
        ctx.lineTo(cur.x, cur.y);
        ctx.stroke();
      }
      const swap = prev;
      prev = cur;
      cur = swap;
      has = true;
    }
  }

  private drawSparks(dt: number): void {
    const ctx = this.ctx;
    const ms = dt * 1000;
    const a = this.qb;
    const b = this.qc;
    let n = 0;
    for (let i = 0; i < this.sparks.length; i++) {
      const s = this.sparks[i];
      s.life -= ms;
      if (s.life <= 0) continue;
      this.sparks[n++] = s;
      s.v[1] -= 3.2 * dt;
      s.p[0] += s.v[0] * dt;
      s.p[1] = Math.max(0, s.p[1] + s.v[1] * dt);
      s.p[2] += s.v[2] * dt;
      if (!this.project(s.p[0], s.p[1], s.p[2], a)) continue;
      if (!this.project(s.p[0] - s.v[0] * 0.035, s.p[1] - s.v[1] * 0.035, s.p[2] - s.v[2] * 0.035, b)) continue;
      ctx.strokeStyle = rgba(s.tone, (s.life / s.max) * 0.7);
      ctx.lineWidth = clamp(a.s * 0.02, 0.6, 1.2);
      ctx.beginPath();
      ctx.moveTo(b.x, b.y);
      ctx.lineTo(a.x, a.y);
      ctx.stroke();
    }
    this.sparks.length = n;
  }

  private makeSprite(tone: Tone): HTMLCanvasElement {
    const c = document.createElement("canvas");
    c.width = c.height = 64;
    const g = c.getContext("2d");
    if (!g) return c;
    const grad = g.createRadialGradient(32, 32, 0, 32, 32, 32);
    grad.addColorStop(0, rgba(tone, 0.5));
    grad.addColorStop(0.18, rgba(tone, 0.12));
    grad.addColorStop(0.5, rgba(tone, 0.02));
    grad.addColorStop(1, rgba(tone, 0));
    g.fillStyle = grad;
    g.fillRect(0, 0, 64, 64);
    return c;
  }

  /* ── 3D-anchored HTML callouts ───────────────────────────────────────── */

  /** Returns true when the label's size changed. */
  private measureLabel(i: number): boolean {
    const l = this.labels[i];
    const s = this.labelState[i];
    if (!l || !s) return false;
    if (l.tag) {
      s.tag.w = l.tag.offsetWidth;
      s.tag.h = l.tag.offsetHeight;
    }
    if (!l.el) return false;
    const w = l.el.offsetWidth;
    const h = l.el.offsetHeight;
    if (w === s.w && h === s.h) return false;
    s.w = w;
    s.h = h;
    return true;
  }

  private labelFloor(): number {
    return this.floorY ?? this.h - DOCK_CLEARANCE;
  }

  private clampBox(b: ScreenRect): void {
    b.x = clamp(b.x, EDGE, Math.max(EDGE, this.w - EDGE - b.w));
    b.y = clamp(b.y, EDGE, Math.max(EDGE, this.labelFloor() - b.h));
  }

  private collide(b: ScreenRect, list: ScreenRect[], count = list.length): ScreenRect | null {
    for (let i = 0; i < count; i++) {
      const o = list[i];
      if (o === b) continue;
      if (b.x < o.x + o.w + TOUCH && o.x < b.x + b.w + TOUCH && b.y < o.y + o.h + TOUCH && o.y < b.y + b.h + TOUCH) return o;
    }
    return null;
  }

  private bounds(points: readonly Vec3[], out: ScreenRect): void {
    const q = this.qa;
    let x0 = Infinity;
    let y0 = Infinity;
    let x1 = -Infinity;
    let y1 = -Infinity;
    for (let i = 0; i < points.length; i++) {
      const p = points[i];
      if (!this.project(p[0], p[1], p[2], q)) continue;
      x0 = Math.min(x0, q.x);
      y0 = Math.min(y0, q.y);
      x1 = Math.max(x1, q.x);
      y1 = Math.max(y1, q.y);
    }
    if (x1 < x0) {
      out.x = out.y = -1e4;
      out.w = out.h = 0;
      return;
    }
    out.x = x0;
    out.y = y0;
    out.w = x1 - x0;
    out.h = y1 - y0;
  }

  private hideLabel(l: LabelSlot, s: LabelState): void {
    s.shown = false;
    if (l.el && s.opacity !== 0) {
      l.el.style.opacity = "0";
      s.opacity = 0;
    }
  }

  private hideTag(l: LabelSlot, s: LabelState): void {
    if (!s.tag.shown) return;
    s.tag.shown = false;
    if (l.tag) l.tag.style.opacity = "0";
  }

  /** Last resort for a gate caption with nowhere clear to go: its index beside the anchor dot. */
  private showTag(l: LabelSlot, s: LabelState): void {
    const tag = s.tag;
    if (!l.tag || !tag.w) return;
    const b = tag.box;
    b.w = tag.w;
    b.h = tag.h;
    const q = s.q;
    const below = l.side === "below";
    for (let k = 0; k < 2; k++) {
      b.x = k === 0 ? q.x + 5 : q.x - 5 - b.w;
      b.y = below ? q.y + 5 : q.y - 5 - b.h;
      this.clampBox(b);
      if (this.collide(b, this.placed)) continue;
      this.placed.push(b);
      this.knock.push(b);
      const tx = Math.round(b.x);
      const ty = Math.round(b.y);
      if (tx !== tag.tx || ty !== tag.ty) {
        l.tag.style.transform = `translate3d(${tx}px, ${ty}px, 0)`;
        tag.tx = tx;
        tag.ty = ty;
      }
      if (!tag.shown) l.tag.style.opacity = "1";
      tag.shown = true;
      return;
    }
    this.hideTag(l, s);
  }

  /**
   * Position every callout: snap gate captions to two shared rails, keep them inside the canvas and
   * clear of the dock and overlays, resolve overlaps in priority order, then draw the leaders.
   * Gate captions on a rail keep the order they are listed in (outward from the scene), so each rail
   * reads in pipeline order and every leader ends on its own caption.
   */
  private placeLabels(dt: number): void {
    const placed = this.placed;
    const knock = this.knock;
    placed.length = 0;
    knock.length = 0;
    this.segs.length = 0;
    if (this.vetoCard) {
      placed.push(this.vetoCard);
      knock.push(this.vetoCard);
    }
    for (const o of this.obstacles) {
      placed.push(o);
      knock.push(o);
    }
    for (let k = 0; k < PROVIDERS.length; k++) this.bounds(this.monoliths[PROVIDERS[k]].corners, this.solids[k]);
    for (let k = 0; k < GATE_SOLIDS.length; k++) this.bounds(GATE_SOLIDS[k], this.gateSolids[k]);

    let railAbove = Infinity;
    let railBelow = -Infinity;
    let railRight = -Infinity;
    for (let i = 0; i < this.labels.length; i++) {
      const l = this.labels[i];
      const s = this.labelState[i];
      s.ok = !!l.el && l.visible !== false && s.w > 0 && this.project(l.anchor[0], l.anchor[1], l.anchor[2], s.q);
      if (!s.ok || !l.rail) continue;
      const side = l.side ?? "above";
      if (side === "above") railAbove = Math.min(railAbove, s.q.y - l.lift);
      else if (side === "below") railBelow = Math.max(railBelow, s.q.y + l.lift);
      else railRight = Math.max(railRight, s.q.x + l.lift);
    }
    // the provider column stands clear of every breaker ring
    if (Number.isFinite(railRight)) for (const r of this.solids) if (r.w > 0) railRight = Math.max(railRight, r.x + r.w + 12);

    const ease = this.reduced || dt <= 0 ? 1 : 1 - Math.exp(-dt * 16);
    let settling = false;
    let lastAbove = -1;
    let lastBelow = -1;
    for (let i = 0; i < this.labels.length; i++) {
      const l = this.labels[i];
      const s = this.labelState[i];
      if (!s.ok || !l.el) {
        this.hideLabel(l, s);
        this.hideTag(l, s);
        continue;
      }
      const side = l.side ?? "above";
      const q = s.q;
      const box = s.box;
      box.w = s.w;
      box.h = s.h;
      let baseX: number;
      let baseY: number;
      let found: boolean;
      if (side === "right") {
        baseX = l.rail ? railRight : q.x + l.lift;
        baseY = q.y - RIGHT_BASELINE;
        found = this.placeRight(box, baseX, baseY);
      } else {
        baseX = q.x - s.w / 2;
        baseY = side === "above" ? (l.rail ? railAbove : q.y - l.lift) - s.h : l.rail ? railBelow : q.y + l.lift;
        found = this.placeGate(i, baseX, baseY, !l.rail ? -1 : side === "above" ? lastAbove : lastBelow);
      }
      if (!found) {
        s.pick = -1;
        this.hideLabel(l, s);
        this.showTag(l, s);
        continue;
      }
      this.hideTag(l, s);
      if (l.rail && side === "above") lastAbove = i;
      if (l.rail && side === "below") lastBelow = i;
      placed.push(box);
      this.pushLeader(i);

      // the drawn box eases toward its slot relative to the live rail, so it tracks the camera exactly
      // and only slides when it re-stacks
      const tx = box.x - baseX;
      const ty = box.y - baseY;
      if (!s.shown) {
        s.offX = tx;
        s.offY = ty;
      } else {
        s.offX += (tx - s.offX) * ease;
        s.offY += (ty - s.offY) * ease;
        if (Math.abs(tx - s.offX) < 0.3 && Math.abs(ty - s.offY) < 0.3) {
          s.offX = tx;
          s.offY = ty;
        } else settling = true;
      }
      const view = s.view;
      view.x = baseX + s.offX;
      view.y = baseY + s.offY;
      view.w = box.w;
      view.h = box.h;
      knock.push(view);
      s.shown = true;
      s.fade = this.fog(q.z);
      const x = Math.round(view.x);
      const y = Math.round(view.y);
      if (x !== s.tx || y !== s.ty) {
        l.el.style.transform = `translate3d(${x}px, ${y}px, 0)`;
        s.tx = x;
        s.ty = y;
      }
      const opacity = Math.round(Math.min(1, 0.5 + s.fade * 0.6) * 50) / 50;
      if (opacity !== s.opacity) {
        l.el.style.opacity = String(opacity);
        s.opacity = opacity;
      }
    }
    this.settling = settling;

    this.drawLeaders();
  }

  /** Provider column: step down past whatever is in the way, stacks spaced wider than their lines. */
  private placeRight(box: ScreenRect, x: number, y: number): boolean {
    box.x = x;
    box.y = y;
    this.clampBox(box);
    for (let attempt = 0; attempt <= 3; attempt++) {
      const hit = this.collide(box, this.placed);
      if (!hit) return true;
      if (attempt === 3) break;
      box.y = hit.y + hit.h + RIGHT_GAP;
      this.clampBox(box);
    }
    return false;
  }

  /**
   * Gate caption: try rows outward from the rail, and in each row three alignments (centred on the
   * anchor, hanging left of it, hanging right of it), until one is clear. While the camera moves, last
   * frame's choice is tried first so captions don't flicker between equally good places.
   */
  private placeGate(i: number, baseX: number, baseY: number, prev: number): boolean {
    const l = this.labels[i];
    const s = this.labelState[i];
    const side = l.side === "below" ? "below" : "above";
    const dir = side === "above" ? -1 : 1;
    const q = s.q;
    const c = this.candidate;
    c.w = s.w;
    c.h = s.h;
    const first = this.moving ? s.pick : -1;
    for (let n = first >= 0 ? -1 : 0; n < ROWS * 3; n++) {
      const pick = n < 0 ? first : n;
      if (n >= 0 && pick === first) continue;
      const row = Math.floor(pick / 3);
      const align = pick % 3;
      c.x = align === 0 ? baseX : align === 1 ? q.x - s.w + LEADER_INSET : q.x - LEADER_INSET;
      c.y = baseY + dir * row * (s.h + LABEL_GAP);
      this.clampBox(c);
      if (!this.slotClear(i, c, side, prev)) continue;
      s.pick = pick;
      s.box.x = c.x;
      s.box.y = c.y;
      return true;
    }
    return false;
  }

  private slotClear(i: number, c: ScreenRect, side: "above" | "below", prev: number): boolean {
    if (this.collide(c, this.placed) || this.collide(c, this.solids)) return false;
    if (side === "above" && this.collide(c, this.gateSolids)) return false;
    const l = this.labels[i];
    const q = this.labelState[i].q;
    // reading order: below the floor the rail runs downward in pipeline order, above it upward
    if (prev >= 0) {
      const p = this.labelState[prev].box;
      // a later row, or the same row further along; never a row back toward the scene
      const inOrder =
        side === "below"
          ? c.y >= p.y + p.h || (c.x >= p.x + p.w && c.y >= p.y - 1)
          : c.y + c.h <= p.y || (c.x + c.w <= p.x && c.y + c.h <= p.y + p.h + 1);
      if (!inOrder) return false;
    }
    // its own leader must not pass under another caption or overlay
    const dir = side === "above" ? -1 : 1;
    const edge = side === "above" ? c.y + c.h : c.y;
    const lx = clamp(q.x, c.x + 6, c.x + c.w - 6);
    const ky = lx === q.x ? edge : edge - dir * 8;
    for (const r of this.placed) {
      if (segmentHitsRect(q.x, q.y + dir * 3, q.x, ky, r, 1)) return false;
      if (ky !== edge && segmentHitsRect(q.x, ky, lx, edge, r, 1)) return false;
    }
    // nor may it cover a leader already drawn
    const segs = this.segs;
    for (let k = 0; k < segs.length; k += 4) if (segmentHitsRect(segs[k], segs[k + 1], segs[k + 2], segs[k + 3], c, 2)) return false;
    // nor stand across the path of a caption still to come on the same rail
    if (l.rail) {
      for (let j = i + 1; j < this.labels.length; j++) {
        const o = this.labels[j];
        const t = this.labelState[j];
        if (!o.rail || !t.ok || (o.side ?? "above") !== side) continue;
        if (t.q.x > c.x - TOUCH && t.q.x < c.x + c.w + TOUCH) return false;
      }
    }
    return true;
  }

  /** Record a placed label's leader, so later labels keep off it. */
  private pushLeader(i: number): void {
    const l = this.labels[i];
    const s = this.labelState[i];
    const q = s.q;
    const b = s.box;
    const segs = this.segs;
    const side = l.side ?? "above";
    if (side === "right") {
      const k = PROVIDERS.indexOf(l.id as ProviderId);
      const solid = k >= 0 ? this.solids[k] : null;
      s.route = 0;
      for (let kind = 0; kind < 2; kind++) {
        const n = this.rightLeader(q, b, kind, solid);
        if (this.routeHits(n, b, solid) === 0) {
          s.route = kind;
          break;
        }
      }
      const p = this.pts;
      const n = this.rightLeader(q, b, s.route, solid);
      for (let k2 = 2; k2 < n; k2 += 2) segs.push(p[k2 - 2], p[k2 - 1], p[k2], p[k2 + 1]);
      return;
    }
    const dir = side === "above" ? -1 : 1;
    const edge = side === "above" ? b.y + b.h : b.y;
    const lx = clamp(q.x, b.x + 6, b.x + b.w - 6);
    const ky = lx === q.x ? edge : edge - dir * 8;
    segs.push(q.x, q.y, q.x, ky);
    if (ky !== edge) segs.push(q.x, ky, lx, edge);
  }

  /**
   * Right-side leader into this.pts; returns the number of coordinates. Kind 0 runs level from the
   * anchor and steps down at the column; kind 1 drops beside the monolith first, then runs level, for
   * when something (the legend, a stack above) sits on the level run.
   */
  private rightLeader(q: Projected, b: ScreenRect, kind: number, solid: ScreenRect | null): number {
    const p = this.pts;
    const ly = b.y + RIGHT_BASELINE;
    p[0] = q.x + 3;
    p[1] = q.y;
    if (Math.abs(ly - q.y) <= 1) {
      p[2] = b.x - 2;
      p[3] = ly;
      return 4;
    }
    if (kind === 0) {
      p[2] = Math.max(q.x + 3, b.x - 16);
      p[3] = q.y;
      p[4] = b.x - 8;
      p[5] = ly;
    } else {
      const kx = Math.min(b.x - 10, Math.max(q.x + 14, solid && solid.w > 0 ? solid.x + solid.w + 10 : q.x + 14));
      p[2] = kx;
      p[3] = q.y;
      p[4] = kx;
      p[5] = ly;
    }
    p[6] = b.x - 2;
    p[7] = ly;
    return 8;
  }

  /** Labels, overlays and other monoliths a polyline in this.pts runs into. */
  private routeHits(n: number, own: ScreenRect, solid: ScreenRect | null): number {
    const p = this.pts;
    let hits = 0;
    for (let k = 2; k < n; k += 2) {
      for (const r of this.placed) if (r !== own && segmentHitsRect(p[k - 2], p[k - 1], p[k], p[k + 1], r, 1)) hits++;
      for (const r of this.solids) if (r !== solid && r.w > 0 && segmentHitsRect(p[k - 2], p[k - 1], p[k], p[k + 1], r)) hits++;
    }
    return hits;
  }

  private drawLeaders(): void {
    const ctx = this.ctx;
    ctx.save();
    // knock every label and overlay out of the leader layer, so no line ever runs under text
    ctx.beginPath();
    ctx.rect(0, 0, this.w, this.h);
    for (const r of this.knock) ctx.rect(r.x - 2, r.y - 2, r.w + 4, r.h + 4);
    ctx.clip("evenodd");
    ctx.lineWidth = 1;

    const foot = this.qb;
    const p = this.pts;
    for (let i = 0; i < this.labels.length; i++) {
      const l = this.labels[i];
      const s = this.labelState[i];
      const q = s.q;
      if (!s.shown) {
        // an index tag stands beside its anchor dot
        if (s.tag.shown) {
          ctx.fillStyle = rgba("bone", 0.55 * this.fog(q.z));
          ctx.beginPath();
          ctx.arc(q.x, q.y, 1.6, 0, Math.PI * 2);
          ctx.fill();
        }
        continue;
      }
      const b = s.view;
      const side = l.side ?? "above";
      ctx.strokeStyle = rgba("bone", 0.24 * s.fade);
      ctx.beginPath();
      if (l.foot && this.project(l.foot[0], l.foot[1], l.foot[2], foot)) {
        ctx.moveTo(foot.x, foot.y);
        ctx.lineTo(q.x, q.y);
      }
      if (side === "right") {
        const k = PROVIDERS.indexOf(l.id as ProviderId);
        const n = this.rightLeader(q, b, s.route, k >= 0 ? this.solids[k] : null);
        ctx.moveTo(p[0], p[1]);
        for (let j = 2; j < n; j += 2) ctx.lineTo(p[j], p[j + 1]);
      } else {
        const dir = side === "above" ? -1 : 1;
        const edge = side === "above" ? b.y + b.h : b.y;
        ctx.moveTo(q.x, q.y + dir * 3);
        const lo = b.x + 6;
        const hi = b.x + b.w - 6;
        if (q.x >= lo && q.x <= hi) ctx.lineTo(q.x, edge);
        else {
          // clamped off-axis: rise straight, then kink to the label's near edge
          ctx.lineTo(q.x, edge - dir * 8);
          ctx.lineTo(clamp(q.x, lo, hi), edge);
        }
      }
      ctx.stroke();
      ctx.fillStyle = rgba("bone", 0.55 * s.fade);
      ctx.beginPath();
      ctx.arc(q.x, q.y, 1.6, 0, Math.PI * 2);
      ctx.fill();
    }

    this.drawVetoLeader();
    ctx.restore();
  }

  /**
   * Leader from the docked veto card to the T2 iris. Three routes are scored: an elbow out of the
   * card's right edge, a straight run from the card edge nearest the iris, and an elbow down out of its
   * bottom edge. Crossing a caption rules a route out; crossing another leader only counts against it.
   */
  private drawVetoLeader(): void {
    const card = this.vetoCard;
    const { x, radius } = SCENE.gates.t2;
    const iris = this.qc;
    if (!card || !this.project(x, 0.07 + radius, 0, iris)) return;
    let best = 1;
    let bestScore = Infinity;
    for (let kind = 0; kind < 3; kind++) {
      const n = this.vetoRoute(card, iris, kind);
      if (!n) continue;
      const score = this.vetoScore(n, card);
      if (score < bestScore) {
        best = kind;
        bestScore = score;
        if (score === 0) break;
      }
    }
    const n = this.vetoRoute(card, iris, best) || this.vetoRoute(card, iris, 1);
    const ctx = this.ctx;
    const p = this.pts;
    ctx.strokeStyle = rgba("bone", 0.3);
    ctx.beginPath();
    ctx.moveTo(p[0], p[1]);
    for (let j = 2; j < n; j += 2) ctx.lineTo(p[j], p[j + 1]);
    ctx.stroke();
    ctx.fillStyle = rgba("bone", 0.6);
    ctx.beginPath();
    ctx.arc(iris.x, iris.y, 1.8, 0, Math.PI * 2);
    ctx.fill();
  }

  /** Veto leader route into this.pts; 0 when that route doesn't fit the geometry. */
  private vetoRoute(card: ScreenRect, iris: Projected, kind: number): number {
    const p = this.pts;
    const right = card.x + card.w;
    const bottom = card.y + card.h;
    if (kind === 0) {
      if (iris.x < right + 16) return 0;
      p[0] = right;
      p[1] = clamp(iris.y, card.y + 14, bottom - 14);
      p[2] = iris.x;
      p[3] = p[1];
      p[4] = iris.x;
      p[5] = iris.y;
      return 6;
    }
    if (kind === 1) {
      if (iris.x > right) {
        p[0] = right;
        p[1] = clamp(iris.y, card.y + 12, bottom - 12);
      } else {
        p[0] = clamp(iris.x, card.x + 12, right - 12);
        p[1] = iris.y > bottom ? bottom : card.y;
      }
      p[2] = iris.x;
      p[3] = iris.y;
      return 4;
    }
    if (iris.y < bottom + 16) return 0;
    p[0] = clamp(iris.x, card.x + 14, right - 14);
    p[1] = bottom;
    p[2] = p[0];
    p[3] = iris.y;
    p[4] = iris.x;
    p[5] = iris.y;
    return 6;
  }

  private vetoScore(n: number, card: ScreenRect): number {
    const p = this.pts;
    const segs = this.segs;
    let score = 0;
    for (let k = 2; k < n; k += 2) {
      const ax = p[k - 2];
      const ay = p[k - 1];
      const bx = p[k];
      const by = p[k + 1];
      for (const r of this.knock) if (r !== card && segmentHitsRect(ax, ay, bx, by, r, 2)) score += 10;
      for (let j = 0; j < segs.length; j += 4) if (segmentsCross(ax, ay, bx, by, segs[j], segs[j + 1], segs[j + 2], segs[j + 3])) score += 1;
    }
    return score;
  }
}
