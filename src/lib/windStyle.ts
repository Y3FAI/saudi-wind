export interface WindStylePreset {
  id: "flow";
  density: {
    desktopMin: number;
    desktopMax: number;
    mobileMin: number;
    mobileMax: number;
    areaDivisor: number;
  };
  fadeRate: number;
  fadeInSeconds: number;
  fadeOutSeconds: number;
  warmup: readonly [minimum: number, maximum: number];
  advection: readonly [desktop: number, mobile: number];
  minimumLength: readonly [desktop: number, mobile: number];
  alpha: readonly [base: number, speed: number];
  width: {
    base: number;
    speed: number;
    desktopScale: number;
    mobileScale: number;
  };
}

export const FLOW_WIND_STYLE: WindStylePreset = {
  id: "flow",
  density: {
    desktopMin: 1800,
    desktopMax: 2600,
    mobileMin: 1100,
    mobileMax: 1550,
    areaDivisor: 340,
  },
  fadeRate: 0.36,
  fadeInSeconds: 0.9,
  fadeOutSeconds: 1.4,
  warmup: [0.5, 1],
  advection: [0.058, 0.066],
  minimumLength: [1.75, 2.15],
  alpha: [0.17, 0.4],
  width: {
    base: 0.42,
    speed: 0.4,
    desktopScale: 1.08,
    mobileScale: 1.3,
  },
};
