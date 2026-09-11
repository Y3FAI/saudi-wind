import type { WindStylePreset } from "./windStyle";

/**
 * Device classification for the Saudi Wind renderer.
 *
 * PERFORMANCE BUDGETS (rationale in docs/PERFORMANCE.md)
 * ------------------------------------------------------
 * Initial JS for the map view : <= 260 kB raw / <= 90 kB gzip (measured: see report)
 * First interactive, mid phone: <= 2.5 s on a simulated 4G profile
 * Steady-state frame time     : <= 16.7 ms desktop, <= 22 ms mobile (tier budget)
 * Particle count per class    : low 400-900, mid 600-1900, high 900-2600
 * Peak GPU/CPU memory         : <= 26 MB WebGL render targets, <= 3 MB JS typed arrays
 *
 * These thresholds are heuristics derived from screen area, device pixel ratio,
 * core count and (where exposed) navigator.deviceMemory. They CANNOT be validated
 * on a headless CI host: a real browser on real hardware must confirm the frame
 * time, first-interactive and memory numbers (see the report).
 */

export type DeviceTier = "low" | "mid" | "high";

export interface DeviceProfile {
  tier: DeviceTier;
  /**
   * Maximum device pixel ratio used for render targets. Fill rate (and therefore
   * frame time) scales with the *square* of this value, so it is capped below the
   * device DPR on weaker hardware and on very large viewports.
   */
  dprCap: number;
  /** Multiplier applied to the style particle min/max for this tier. */
  particleScale: number;
  /** Target frame interval in milliseconds for steady-state animation. */
  frameBudgetMs: number;
  /** CPU time the particle pass may consume before the governor shrinks it. */
  renderBudgetMs: number;
  /** Absolute particle floor the governor will never go below (keeps trails visible). */
  governorFloorMobile: number;
  governorFloorDesktop: number;
  prefersReducedMotion: boolean;
  cores: number;
  memoryGb: number | null;
  cssArea: number;
  reasons: string[];
}

/**
 * Upper bound on render-target pixels for the wind canvas. Colour + stencil at
 * 5.2 Mpx is roughly 26 MB of GPU memory; capping here keeps large retina
 * desktops bounded without changing the 1440x900 desktop baseline (5.18 Mpx).
 */
export const MAX_RENDER_PIXELS = 5_200_000;

interface TierSettings {
  dprCap: number;
  particleScale: number;
  frameBudgetMs: number;
  governorFloorMobile: number;
  governorFloorDesktop: number;
}

const TIER_SETTINGS: Record<DeviceTier, TierSettings> = {
  low: {
    dprCap: 1.5,
    particleScale: 0.45,
    frameBudgetMs: 26,
    governorFloorMobile: 380,
    governorFloorDesktop: 520,
  },
  mid: {
    dprCap: 2,
    particleScale: 0.72,
    frameBudgetMs: 22,
    governorFloorMobile: 450,
    governorFloorDesktop: 600,
  },
  high: {
    dprCap: 2,
    particleScale: 1,
    frameBudgetMs: 16.7,
    governorFloorMobile: 450,
    governorFloorDesktop: 600,
  },
};

function readDeviceMemory(): number | null {
  const value = (navigator as Navigator & { deviceMemory?: number })
    .deviceMemory;
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? value
    : null;
}

function classify(score: number): DeviceTier {
  if (score <= 1) return "low";
  if (score <= 3) return "mid";
  return "high";
}

/**
 * Classify the current device once per mount. Safe to call in a non-browser
 * environment (returns a conservative mid profile) so module import never throws.
 */
export function detectDeviceProfile(): DeviceProfile {
  const settingsFor = (tier: DeviceTier): TierSettings => TIER_SETTINGS[tier];

  if (typeof window === "undefined" || typeof navigator === "undefined") {
    return buildProfile("mid", 1024 * 768, 1, 4, null, false, [
      "no browser environment",
    ]);
  }

  const width = window.innerWidth || 1024;
  const height = window.innerHeight || 768;
  const cssArea = Math.max(1, width * height);
  const cores = Math.max(1, navigator.hardwareConcurrency || 4);
  const memoryGb = readDeviceMemory();
  const prefersReducedMotion =
    window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;

  const reasons: string[] = [];
  let score = 0;

  if (cores >= 8) {
    score += 2;
    reasons.push("8+ cores");
  } else if (cores >= 6) {
    score += 1;
    reasons.push("6+ cores");
  } else if (cores <= 2) {
    score -= 1;
    reasons.push("<=2 cores");
  }

  if (memoryGb !== null) {
    if (memoryGb >= 8) {
      score += 2;
      reasons.push("8+ GB memory");
    } else if (memoryGb >= 4) {
      score += 1;
      reasons.push("4+ GB memory");
    } else {
      score -= 1;
      reasons.push("<4 GB memory");
    }
  } else if (cores >= 6) {
    // Safari and Firefox do not expose deviceMemory; lean on core count instead.
    score += 1;
    reasons.push("memory unknown, 6+ cores");
  }

  if ((window.devicePixelRatio || 1) >= 3 && cores <= 4) {
    score -= 1;
    reasons.push("high DPR on few cores");
  }
  if (cssArea <= 320 * 568) {
    score -= 1;
    reasons.push("very small screen");
  }

  const tier = classify(score);
  return buildProfile(
    tier,
    cssArea,
    window.devicePixelRatio || 1,
    cores,
    memoryGb,
    prefersReducedMotion,
    reasons.length ? reasons : ["balanced default"],
  );
}

function buildProfile(
  tier: DeviceTier,
  cssArea: number,
  dpr: number,
  cores: number,
  memoryGb: number | null,
  prefersReducedMotion: boolean,
  reasons: string[],
): DeviceProfile {
  const settings = TIER_SETTINGS[tier];
  const dprCap = Math.min(settings.dprCap, Math.max(1, dpr));
  return {
    tier,
    dprCap,
    particleScale: settings.particleScale,
    frameBudgetMs: settings.frameBudgetMs,
    renderBudgetMs: settings.frameBudgetMs * 0.75,
    governorFloorMobile: settings.governorFloorMobile,
    governorFloorDesktop: settings.governorFloorDesktop,
    prefersReducedMotion,
    cores,
    memoryGb,
    cssArea,
    reasons,
  };
}

export interface ParticleBudget {
  /** Steady-state particle target before the frame-time governor runs. */
  target: number;
  /** Absolute floor the governor may shrink to. */
  floor: number;
}

/**
 * Particle budget for the current viewport. Screen area drives visual density
 * (matching the style's areaDivisor) while the device tier caps it so weak
 * hardware never allocates more than it can sustain.
 */
export function particleBudgetFor(
  density: WindStylePreset["density"],
  profile: DeviceProfile,
  width: number,
  height: number,
): ParticleBudget {
  const mobile = width < 680;
  const ceiling = Math.max(
    200,
    Math.round(
      (mobile ? density.mobileMax : density.desktopMax) * profile.particleScale,
    ),
  );
  const floorFromStyle = Math.max(
    160,
    Math.round(
      (mobile ? density.mobileMin : density.desktopMin) * profile.particleScale,
    ),
  );
  const area = Math.max(1, width * height);
  const desired = Math.round(area / density.areaDivisor);
  const target = Math.max(
    Math.min(floorFromStyle, ceiling),
    Math.min(ceiling, Math.max(floorFromStyle, desired)),
  );
  const floor = Math.min(
    target,
    mobile ? profile.governorFloorMobile : profile.governorFloorDesktop,
  );
  return { target, floor };
}

/** Render-target DPR after applying both the tier cap and the pixel budget. */
export function effectivePixelRatio(
  devicePixelRatio: number,
  profile: DeviceProfile,
  width: number,
  height: number,
): number {
  const capped = Math.min(devicePixelRatio || 1, profile.dprCap);
  const area = Math.max(1, width * height);
  const pixelLimit = Math.sqrt(MAX_RENDER_PIXELS / area);
  return Math.max(1, Math.min(capped, pixelLimit));
}
