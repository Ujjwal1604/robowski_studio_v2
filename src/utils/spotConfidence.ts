/**
 * High-contrast 5-category color scale for automated TLC spot detection confidence.
 *
 * Uses 5 discrete, maximally separated hues (Crimson Red, Vivid Orange, Bright Yellow,
 * Royal Blue, Electric Cyan) — avoiding green (UV254 silica), purple (User Adjusted),
 * and ambiguous intermediate blends — so every confidence tier is instantly distinguishable
 * on UV254, UV366, White-light, and false-color composite plates and supports 1-click
 * per-category removal.
 */

export type ConfidenceTierKey = 'very-low' | 'low' | 'medium' | 'high' | 'very-high';
export type ConfidenceTierLabel = 'Very Low' | 'Low' | 'Medium' | 'High' | 'Very High';
export type ConfidenceShortLabel = 'Trace' | 'Low' | 'Med' | 'High' | 'Strong';

export interface ConfidenceTierMeta {
  key: ConfidenceTierKey;
  label: ConfidenceTierLabel;
  shortLabel: ConfidenceShortLabel;
  rangeLabel: string;
  min: number;
  max: number;
  color: string;
  rgb: [number, number, number];
  text: string;
  bg: string;
  border: string;
  needsReview: boolean;
  reviewRingAlpha: number;
  /** Slight marker radius multiplier so top-tier spots read cleanly */
  radiusScale: number;
}

export interface SpotConfidenceStyle {
  /** Clamped confidence in [0, 1] */
  value: number;
  /** Integer percentage in [0, 100] */
  pct: number;
  /** Category key for grouping & 1-click removal */
  tier: ConfidenceTierKey;
  /** High-contrast discrete hex color for this confidence category */
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
  /** Human-readable percentage range */
  rangeLabel: string;
  /** True when spot warrants visual confirmation (< 0.52) */
  needsReview: boolean;
  /** Dashed outer ring alpha (0 for Medium and above) */
  reviewRingAlpha: number;
  /** Marker radius multiplier */
  radiusScale: number;
}

/**
 * 5 maximally distinct discrete confidence categories:
 *  - Very Low  (< 35%):     Crimson Red    #ff2d55  (dashed review ring)
 *  - Low       (35%–51%):   Vivid Orange   #ff7a00  (dashed review ring)
 *  - Medium    (52%–69%):   Bright Yellow  #ffef00
 *  - High      (70%–85%):   Royal Blue     #3b82f6
 *  - Very High (>= 86%):    Electric Cyan  #00f0ff
 */
export const SPOT_CONFIDENCE_TIERS: readonly ConfidenceTierMeta[] = [
  {
    key: 'very-low',
    label: 'Very Low',
    shortLabel: 'Trace',
    rangeLabel: '<35%',
    min: 0,
    max: 0.35,
    color: '#ff2d55',
    rgb: [255, 45, 85],
    text: '#ff708d',
    bg: 'rgba(255, 45, 85, 0.18)',
    border: 'rgba(255, 45, 85, 0.72)',
    needsReview: true,
    reviewRingAlpha: 0.95,
    radiusScale: 0.96,
  },
  {
    key: 'low',
    label: 'Low',
    shortLabel: 'Low',
    rangeLabel: '35–51%',
    min: 0.35,
    max: 0.52,
    color: '#ff7a00',
    rgb: [255, 122, 0],
    text: '#ffa94d',
    bg: 'rgba(255, 122, 0, 0.18)',
    border: 'rgba(255, 122, 0, 0.72)',
    needsReview: true,
    reviewRingAlpha: 0.72,
    radiusScale: 0.98,
  },
  {
    key: 'medium',
    label: 'Medium',
    shortLabel: 'Med',
    rangeLabel: '52–69%',
    min: 0.52,
    max: 0.70,
    color: '#ffef00',
    rgb: [255, 239, 0],
    text: '#fef08a',
    bg: 'rgba(255, 239, 0, 0.16)',
    border: 'rgba(255, 239, 0, 0.70)',
    needsReview: false,
    reviewRingAlpha: 0,
    radiusScale: 1.0,
  },
  {
    key: 'high',
    label: 'High',
    shortLabel: 'High',
    rangeLabel: '70–85%',
    min: 0.70,
    max: 0.86,
    color: '#3b82f6',
    rgb: [59, 130, 246],
    text: '#93c5fd',
    bg: 'rgba(59, 130, 246, 0.20)',
    border: 'rgba(59, 130, 246, 0.72)',
    needsReview: false,
    reviewRingAlpha: 0,
    radiusScale: 1.05,
  },
  {
    key: 'very-high',
    label: 'Very High',
    shortLabel: 'Strong',
    rangeLabel: '≥86%',
    min: 0.86,
    max: 1.01,
    color: '#00f0ff',
    rgb: [0, 240, 255],
    text: '#67f7ff',
    bg: 'rgba(0, 240, 255, 0.16)',
    border: 'rgba(0, 240, 255, 0.70)',
    needsReview: false,
    reviewRingAlpha: 0,
    radiusScale: 1.12,
  },
];

/** Return the discrete ConfidenceTierMeta for a confidence score in [0..1]. */
export function getConfidenceTierMeta(confidence?: number): ConfidenceTierMeta {
  const value =
    typeof confidence === 'number' && Number.isFinite(confidence)
      ? Math.max(0, Math.min(1, confidence))
      : 0.90;
  if (value < 0.35) return SPOT_CONFIDENCE_TIERS[0];
  if (value < 0.52) return SPOT_CONFIDENCE_TIERS[1];
  if (value < 0.70) return SPOT_CONFIDENCE_TIERS[2];
  if (value < 0.86) return SPOT_CONFIDENCE_TIERS[3];
  return SPOT_CONFIDENCE_TIERS[4];
}

/**
 * Return the full visual style for an automated spot's confidence score in [0..1].
 * When confidence is undefined (e.g., legacy or synthetic spots without a score),
 * defaults to Very High (0.90).
 */
export function getSpotConfidenceStyle(confidence?: number): SpotConfidenceStyle {
  const value =
    typeof confidence === 'number' && Number.isFinite(confidence)
      ? Math.max(0, Math.min(1, confidence))
      : 0.90;
  const pct = Math.round(value * 100);
  const meta = getConfidenceTierMeta(value);

  return {
    value,
    pct,
    tier: meta.key,
    color: meta.color,
    rgb: [...meta.rgb],
    bg: meta.bg,
    border: meta.border,
    text: meta.text,
    label: meta.label,
    shortLabel: meta.shortLabel,
    rangeLabel: meta.rangeLabel,
    needsReview: meta.needsReview,
    reviewRingAlpha: meta.reviewRingAlpha,
    radiusScale: meta.radiusScale,
  };
}

/**
 * Helper to return an rgba() string from a SpotConfidenceStyle with custom alpha.
 */
export function confidenceRgba(style: SpotConfidenceStyle, alpha: number): string {
  const [r, g, b] = style.rgb;
  return `rgba(${r}, ${g}, ${b}, ${Math.max(0, Math.min(1, alpha)).toFixed(2)})`;
}
