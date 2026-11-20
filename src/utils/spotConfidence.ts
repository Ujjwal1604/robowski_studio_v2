/**
 * Continuous multi-stop color scale for automated TLC spot detection confidence.
 *
 * Replaces binary (< 45% vs >= 45%) confidence coloring with a smooth 5-stop
 * perceptual gradient (Rose → Orange → Gold → Teal → Sky Cyan) and 5 named tiers
 * so chemists can visually judge trace, faint, moderate, strong, and textbook
 * spots at a glance across UV254 (green), UV366 (blue), Visible (white), and
 * false-color composite plates.
 */

export type ConfidenceTierLabel = 'Very Low' | 'Low' | 'Medium' | 'High' | 'Very High';
export type ConfidenceShortLabel = 'Trace' | 'Low' | 'Med' | 'High' | 'Strong';

export interface SpotConfidenceStyle {
  /** Clamped confidence in [0, 1] */
  value: number;
  /** Integer percentage in [0, 100] */
  pct: number;
  /** Smoothly interpolated hex color along the 5-stop gradient */
  color: string;
  /** RGB tuple [r, g, b] in [0..255] */
  rgb: [number, number, number];
  /** Soft translucent fill for badges/cards */
  bg: string;
  /** Accent border color for badges/cards */
  border: string;
  /** High-contrast foreground text color on dark surfaces */
  text: string;
  /** Descriptive 5-level tier label */
  label: ConfidenceTierLabel;
  /** Compact 5-level tier label */
  shortLabel: ConfidenceShortLabel;
  /** True when spot warrants visual confirmation (< 0.45) */
  needsReview: boolean;
  /** Smooth dashed-ring emphasis alpha in [0..1] (0 when >= 0.55) */
  reviewRingAlpha: number;
}

interface ColorStop {
  t: number;
  rgb: [number, number, number];
}

/**
 * 5-stop confidence gradient anchors:
 *  - 0.15 (Very Low / Trace): Rose Red     #f43f5e
 *  - 0.38 (Low):              Tangerine    #fb923c
 *  - 0.56 (Medium):           Warm Gold    #facc15
 *  - 0.75 (High):             Teal Aqua    #2dd4bf
 *  - 0.92 (Very High):        Sky Cyan     #38bdf8
 */
export const SPOT_CONFIDENCE_STOPS: readonly ColorStop[] = [
  { t: 0.15, rgb: [244, 63, 94] },   // #f43f5e
  { t: 0.38, rgb: [251, 146, 60] },  // #fb923c
  { t: 0.56, rgb: [250, 204, 21] },  // #facc15
  { t: 0.75, rgb: [45, 212, 191] },  // #2dd4bf
  { t: 0.92, rgb: [56, 189, 248] },  // #38bdf8
];

/** CSS linear-gradient matching SPOT_CONFIDENCE_STOPS for legends and colorbars. */
export const SPOT_CONFIDENCE_GRADIENT_CSS =
  'linear-gradient(90deg, #f43f5e 0%, #fb923c 28%, #facc15 52%, #2dd4bf 76%, #38bdf8 100%)';

function toHexByte(v: number): string {
  return Math.max(0, Math.min(255, Math.round(v)))
    .toString(16)
    .padStart(2, '0');
}

export function rgbToHex([r, g, b]: [number, number, number]): string {
  return `#${toHexByte(r)}${toHexByte(g)}${toHexByte(b)}`;
}

/**
 * Interpolate RGB continuously along the 5-stop confidence scale.
 */
export function interpolateConfidenceRgb(confidence: number): [number, number, number] {
  const c = Number.isFinite(confidence) ? Math.max(0, Math.min(1, confidence)) : 0.85;
  const stops = SPOT_CONFIDENCE_STOPS;
  if (c <= stops[0].t) return [...stops[0].rgb];
  const last = stops[stops.length - 1];
  if (c >= last.t) return [...last.rgb];

  for (let i = 0; i < stops.length - 1; i++) {
    const a = stops[i];
    const b = stops[i + 1];
    if (c >= a.t && c <= b.t) {
      const f = (c - a.t) / Math.max(1e-6, b.t - a.t);
      return [
        Math.round(a.rgb[0] + (b.rgb[0] - a.rgb[0]) * f),
        Math.round(a.rgb[1] + (b.rgb[1] - a.rgb[1]) * f),
        Math.round(a.rgb[2] + (b.rgb[2] - a.rgb[2]) * f),
      ];
    }
  }
  return [...last.rgb];
}

/**
 * Return the full visual style for an automated spot's confidence score in [0..1].
 * When confidence is undefined (e.g., legacy or synthetic spots without a score),
 * defaults to a high-confidence sky cyan (0.88).
 */
export function getSpotConfidenceStyle(confidence?: number): SpotConfidenceStyle {
  const value =
    typeof confidence === 'number' && Number.isFinite(confidence)
      ? Math.max(0, Math.min(1, confidence))
      : 0.88;
  const pct = Math.round(value * 100);
  const rgb = interpolateConfidenceRgb(value);
  const color = rgbToHex(rgb);
  const [r, g, b] = rgb;

  // Lift text slightly toward white for ultra-legible HUD typography
  const text = rgbToHex([
    Math.min(255, Math.round(r + (255 - r) * 0.22)),
    Math.min(255, Math.round(g + (255 - g) * 0.22)),
    Math.min(255, Math.round(b + (255 - b) * 0.22)),
  ]);

  let label: ConfidenceTierLabel;
  let shortLabel: ConfidenceShortLabel;
  if (value < 0.35) {
    label = 'Very Low';
    shortLabel = 'Trace';
  } else if (value < 0.52) {
    label = 'Low';
    shortLabel = 'Low';
  } else if (value < 0.70) {
    label = 'Medium';
    shortLabel = 'Med';
  } else if (value < 0.86) {
    label = 'High';
    shortLabel = 'High';
  } else {
    label = 'Very High';
    shortLabel = 'Strong';
  }

  const needsReview = value < 0.45;
  const reviewRingAlpha =
    value >= 0.55 ? 0 : Math.min(0.95, 0.35 + ((0.55 - value) / 0.40) * 0.60);

  return {
    value,
    pct,
    color,
    rgb,
    bg: `rgba(${r}, ${g}, ${b}, 0.16)`,
    border: `rgba(${r}, ${g}, ${b}, 0.58)`,
    text,
    label,
    shortLabel,
    needsReview,
    reviewRingAlpha,
  };
}

/**
 * Helper to return an rgba() string from a SpotConfidenceStyle with custom alpha.
 */
export function confidenceRgba(style: SpotConfidenceStyle, alpha: number): string {
  const [r, g, b] = style.rgb;
  return `rgba(${r}, ${g}, ${b}, ${Math.max(0, Math.min(1, alpha)).toFixed(2)})`;
}
