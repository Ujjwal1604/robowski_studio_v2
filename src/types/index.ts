export interface Reagent {
  code: string;
  name: string;
  molarMass: number | string;
  density: number | string;
  liquidDensity?: number;
  stock: number | string;
  solvent: string;
  pipettingMode?: string;
  min?: number | string;
  step?: number | string;
  max?: number | string;
  prepareVolumeMl?: number;
  color?: string;
  iupac?: string;
  smiles?: string;
}

export interface VialSetItem {
  on: boolean;
  min: number | string;
  step: number | string;
  max: number | string;
}

export interface VialSet {
  name: string;
  items: VialSetItem[];
}

export interface TripletAdditive {
  code: string;
  equiv: number | string;
}

export interface TripletGroup {
  id: string;
  name: string;
  members: string[];
  derived?: boolean;
  scale?: number;
}

export interface TripletPlate {
  sections: string[];
  flat?: boolean;
}

export interface TripletSetup {
  base: number | string;
  ratios: number[][];
  adds: TripletAdditive[];
  groups: TripletGroup[];
  plates: (TripletPlate | null)[];
  derivedRatio?: 'keep' | 'equal';
  reps?: number;
}

export interface ProductInfo {
  name?: string;
  code?: string;
  smiles?: string;
}

export interface DeckConfig {
  solventPlate: number;
  solventKind: 'jar' | 'bottle';
  solventPos: number;
  stockPlates: number[];
}

export interface ImportedVials {
  name: string;
  rows: number[][];
  skipped?: number;
  note?: string;
  differ?: boolean;
}

export interface RunState {
  id: string | null;
  name: string;
  mode: 'concentration' | 'equivalence' | 'triplet';
  hood: 'left' | 'right';
  vialVolume: number | string;
  threshold: number | string;
  dilutionFactor: number | string;
  reactionSolvent: string;
  temperatureC?: number | string;
  waterPct?: number | string;
  leftoverMl: number | string;
  flasksText: string;
  randomize: boolean;
  randomSeed: number | string;
  solventAfter: number | string;
  deckPlates: DeckConfig | null;
  stockVolumeCheck: boolean;
  newTipEveryTransfer: boolean;
  /** True = main_auto_liquid_height.py (0 probe tips); false = legacy main.py volume probing */
  autoLiquidHeight?: boolean;
  /** Pipetting order in main.py: 'by_solvent' (default) or 'by_vial' */
  pipettingStrategy?: 'by_solvent' | 'by_vial';
  /** Optional wait time (seconds) after each substance addition (main.py ask_time_delays) */
  substanceDelaySec?: number;
  /** Manually measured Zeus liquid surface Z heights (0.1 mm units) keyed by 'solvent' or stock key */
  measuredSurfaceZ?: Record<string, number>;
  reagents: Reagent[];
  sets?: VialSet[];
  tri?: TripletSetup;
  product?: ProductInfo;
  imported?: ImportedVials;
  eln?: HteElnRecord;
}

export interface Issue {
  severity: 'block' | 'warning';
  type: string;
  code?: string;
  codes?: string[];
  row?: number;
  globalIndex?: number;
  message: string;
}

export interface RecipeItem {
  code: string;
  name: string;
  color: string;
  target_concentration: number;
  value: number;
  equivalence: number | null;
  base_volume: number;
  transfer_volume: number;
  stock_key: string | null;
  dilution_level: number;
  stock_concentration: number;
  solvent: string;
  molarMass: number;
  chemicalDensity: number;
  liquidDensity: number;
}

export interface RunRow {
  local_index: number;
  global_index: number;
  combo_index: number;
  plate_number: number;
  container_id: number;
  recipe: RecipeItem[];
  'vol#solvent': number;
  [key: `vol#${string}`]: number | any;
  label?: { name: string; cond: string } | null;
}

export interface StockDetail {
  substance: string;
  source_reagent: string;
  source_name: string;
  solvent: string;
  density: number;
  chemicalDensity: number | null;
  molarMass: number;
  base_stock_concentration: number;
  concentration_mM: number;
  dilution_level: number;
  dilution_label: string;
  pipetting_mode: string;
  consumption_uL: number;
  reagent_color: string;
  leftover_mL: number;
  direct_consumption_ml: number;
  additional_dilution_source_ml: number;
  required_mL: number;
  recommended_volume_ml: number;
  recommended_volume_uL: number;
  base_stock_source_ml?: number;
  base_stock_volume_ml?: number | null;
  parent_stock_key?: string;
  parent_source_volume_ml?: number | null;
  diluent_volume_ml?: number | null;
  prep_volume_ml: number;
  flask_label: string;
  mass_g: number | null;
  chemical_volume_ml: number | null;
  breadboard_plate_id: number;
  container_id: number;
  deck_overflow?: boolean;
  source_only?: boolean;
}

export interface DeckLayout {
  hood: 'left' | 'right';
  plates: number[];
  stock_plate: number;
  dilution_plate: number;
  solvent_plate: number;
  solvent_kind: 'jar' | 'bottle';
  solvent_container: number;
  stock_capacity: number;
  dilution_capacity: number;
  positions_fit: boolean;
  positions_message: string;
  solvent_location: string;
}

export interface TipCounts {
  50: number;
  300: number;
  1000: number;
  rackCapacity: number;
  racks: { 50: number; 300: number; 1000: number };
  perPlate: Array<{
    plate: number;
    counts: { 50: number; 300: number; 1000: number };
    transfers: number;
  }>;
  stockCheck: boolean;
  newTipEach: boolean;
  stockCheckTips: number;
  autoLiquidHeight?: boolean;
  pipettingStrategy?: 'by_solvent' | 'by_vial';
}

export interface RuntimeEstimate {
  lowSeconds: number;
  highSeconds: number;
  seconds: number;
  label: string;
  events: number;
  transfers: number;
  cycles: number;
  tipChanges: number;
  plates: number;
  stockBottles: number;
  delaySeconds?: number;
  pipettingStrategy?: 'by_solvent' | 'by_vial';
  calibrationNote: string;
}

export interface PreFlightContainerCheck {
  substance: string;
  isSolvent: boolean;
  plate: number;
  containerId: number;
  containerKind: 'bottle' | 'jar';
  bottleSizeLabel: string;
  solvent: string;
  preparedUl: number;
  neededUl: number;
  deadVolumeUl: number;
  deadVolumeMeasured: boolean;
  marginUl: number;
  surfaceHeightZ: number;
  bottomZ: number;
  mmAboveBottom: number;
  heightValid: boolean;
  prewetUlByTip: { 50: number; 300: number; 1000: number };
  status: 'ok' | 'warn' | 'block';
  summary: string;
}

export type RobotProfileId = 'roboski2' | 'roboski1';

export interface RobotProfile {
  id: RobotProfileId;
  pipetterName: string;
  label: string;
  hood: 'left' | 'right';
  arduinoPort: string;
  balancePort: string;
  trashXy: [number, number];
  idleXy: [number, number];
  traverseZ: number;
  tipPickZ: number;
  tipDepositZ: number;
  corruptedLiquidClasses: number[];
  notes: string;
}

export interface RunResult {
  runName: string;
  modeLabel?: string | null;
  descMeta: any;
  solventAfter: number;
  mode: string;
  hood: 'left' | 'right';
  reactionSolvent: string;
  temperatureC?: number;
  waterPct?: number;
  vialVolume: number;
  threshold: number;
  dilutionFactor: number;
  leftoverMl: number;
  randomize: boolean;
  randomSeed: number;
  rows: RunRow[];
  stocks: Record<string, StockDetail>;
  issues: Issue[];
  blockingIssues: number;
  warningCount: number;
  autoFix: { stockMultiplier: number; reason: string };
  reactions: number;
  plates: number;
  slotsUsedThisLoad: number;
  requiresReload: boolean;
  activeTransfers: number;
  tipCounts: TipCounts;
  runtime: RuntimeEstimate;
  deck: DeckLayout;
  reagents: Reagent[];
  sourceOnlyStocks: StockDetail[];
  totalStockConsumptionMl: number;
  solventConsumptionMl: number;
  solventRecommendedMl: number;
  maxPlates: number;
  robotProfile?: RobotProfileId;
  preFlight?: PreFlightContainerCheck[];
}

export interface LibraryReagent {
  id: string;
  name: string;
  molarMass: number;
  density?: number;
  solvent?: string;
  stock?: number;
  cas?: string;
  notes?: string;
  smiles?: string;
  iupac?: string;
  note?: string;
}

export interface SavedRunSummaryLine {
  code: string;
  text: string;
}

export interface SavedRun {
  id: string;
  name: string;
  mode: string;
  hood: string;
  reactions: number;
  plates: number;
  tips: string;
  stocks: number;
  codes: string[];
  colors: string[];
  status: 'draft' | 'exported';
  updated: number;
  state: RunState;
  summary?: SavedRunSummaryLine[];
  exports?: Array<{ t: number; kind: string }>;
  tlc_status?: 'ready' | 'pending';
  tlc_sets?: any[];
}

export interface VerifiedFix {
  kind: 'threshold' | 'vial' | 'dilution' | 'stock' | 'both';
  label: string;
  patch: Record<string, any>;
  warns: number;
  dist?: number;
}

export interface TlcLane {
  id: number;
  x0: number;
  y0: number;
  length: number;
  width: number;
  angle: number;
  spotRadius?: number | null;
  zeroRf?: number | null;
  customSpots?: TlcSpot[];
}

export interface TlcLaneConfig {
  lanes: TlcLane[];
  hasZeroRf: boolean;
  warnings: string[];
}

export interface TlcLaneRow {
  plate: number;
  lane: number;
  half: number;
  well: string;
  vial: number;
  reaction: number;
  row: any;
}

export interface TlcSpot {
  pos: number;
  rf: number;
  strength: number; // 0 to 1
  label?: string;
  areaPct?: number;
  rfRaw?: number; // measured Rf before the edge-effect correction
  edgeGain?: number; // relative migration speed g used for the correction
  edgeOffset?: number; // additive Rf shift used for the correction
  source?: 'auto' | 'adjusted' | 'manual';
  channels?: ('UV254' | 'UV366' | 'White')[];
  /** Detection confidence score in [0..1] based on SNR, lateral centering, band specificity, and channel agreement */
  confidence?: number;
  /** Segmented lower (origin-side) boundary in lane pixels */
  extentStart?: number;
  /** Segmented upper (front-side) boundary in lane pixels */
  extentEnd?: number;
  /** 2D horizontal spot width fraction relative to lane width (0..1) */
  widthFrac?: number;
  /** Chromatographic asymmetry / tailing factor (~1.0 symmetric, >1.5 tailing/fronting) */
  tailing?: number;
  /** Which spot detector produced this spot ('2d' watershed segmentation, 'densitogram' cutoff peak picker, or '1d' legacy fallback) */
  detector?: TlcSpotDetectorMode;
}

export type TlcSpotDetectorMode = '2d' | 'densitogram' | '1d';

export interface ProfileHistogramStats {
  bgMode: number;
  bgSigma: number;
  contrastSpan: number;
  sigTail: number;
  clipLowFrac: number;
  clipHighFrac: number;
  otsuThresh: number;
  otsuEta: number;
  sampleCount: number;
}

export interface LaneSpotMap2d {
  /** Working grid width (downsampled to <= 32 px for fast 2D segmentation) */
  w: number;
  /** Working grid height (downsampled to <= 512 px; row 0 = origin end, row h-1 = front end) */
  h: number;
  /** Original lane pixel length L (origPos = row * (L - 1) / (h - 1)) */
  origLen: number;
  /** Channel-calibrated 2D spot intensity above clean silica (length = w * h, ~0..255 scale) */
  map: Float32Array;
  /** Row-gutter-suppressed 2D intensity (cancels full-width horizontal solvent-front bands & pencil lines) */
  localMap: Float32Array;
  /** Robust 2D background pixel noise estimate */
  bgSigma: number;
  /** Channel identity for physics-aware thresholds */
  channel: 'UV254' | 'UV366' | 'White';
}

export interface Lane2dMetrics {
  /** Center-vs-gutter contrast at each pixel row (positive = lane center differs from clean flanking silica) */
  lateralExcess: Float32Array;
  /** Ratio of max(leftEdge, rightEdge) deviation to center deviation (>1.55 indicates neighbor lane spillover) */
  edgeRatio: Float32Array;
  /** Interleaved [R, G, B] mean of the lane center core at each row (length = L * 3) */
  coreRgb: Float32Array;
  /** Clean silica background [R, G, B] estimated from the lane flanks */
  bgRgb: [number, number, number];
  /** True when the lane sits off the physical silica plate (pitch-black cabinet surround in UV254/White) */
  offPlate?: boolean;
  /** True when the lane straddles the vertical glass-plate edge (one flank on black void, one on silica) */
  borderStraddle?: boolean;
  /** Cross-lane integrated spot mass (mean background deviation across interior 76% of lane width) at each row */
  rowMass?: Float32Array;
  /** Smooth 2D lateral spot width fraction [0..1] across interior 76% of lane width at each row (detects hourglass waists) */
  spotWidth?: Float32Array;
  /** Mean scalar intensity of left + right outer flanks at each row (same scale/sign as 1D profile, for 2D horizontal-continuity front detection) */
  flankProfile?: Float32Array;
  /** Optional signed lateral centerline offset in lane-width pixels (length = L, index 0 = bottom/origin) when curved-lane automiddle tracking is active */
  automiddleOffsets?: Float32Array;
  /** Compact 2D channel-calibrated spot-likelihood map for true 2D connected-region & watershed spot segmentation */
  spotMap2d?: LaneSpotMap2d;
}

export interface TlcProfileOptions {
  sign: number;
  origin: number;
  front: number;
  radius?: number;
  minProminence?: number;
  minDistance?: number;
  plateHistogram?: ProfileHistogramStats;
  /** Optional 2D lateral lane strip metrics for neighbor-spillover & horizontal-band artifact rejection */
  lane2d?: Lane2dMetrics;
  /** Optional plate-wide near-front background profile (41 Rf bins covering Rf 0.80..1.00) for meniscus vs real high-Rf spot separation */
  frontBandBg?: number[];
  /** Spot detection engine: '2d' (default when spotMap2d is available), 'densitogram' (direct densitogram cutoff peak picker), or '1d' (legacy fallback) */
  detectorMode?: TlcSpotDetectorMode;
  /** Minimum 2D horizontal spot width (FWHM fraction of lane width, 0..0.65). Rejects narrow spotter microdroplets & their skinny vertical runs (0 = Off, default 0.28). */
  minSpotWidthFrac?: number;
}

export interface TlcDensitogramPoint {
  pos: number;
  rf: number;
  raw: number;
  smooth: number;
  baseline: number;
  signal: number;
}

export interface TlcDensitogramData {
  points: TlcDensitogramPoint[];
  spots: TlcSpot[];
  origin: number;
  front: number;
  maxSignal: number;
  totalArea: number;
  /** Active intensity cutoff threshold when detectorMode === 'densitogram' (for plotting the cutoff guide line) */
  densitogramCutoff?: number;
  /** Plate contrast span used to calibrate densitogramCutoff (for 1-to-1 draggable cutoff conversion) */
  densitogramPlateSpan?: number;
  /** Minimum noise floor used to calibrate densitogramCutoff */
  densitogramNoiseFloor?: number;
  /** Peaks above cutoff that were rejected by the 2D microdroplet / minimum-width filter (for transparent UI inspection) */
  rejectedNarrowPeaks?: Array<{
    pos: number;
    rf: number;
    widthFrac: number;
    signal: number;
    reason: 'narrow' | 'microdroplet-run';
  }>;
}

export interface TlcImageEntry {
  name: string;
  bmp: ImageBitmap;
  /** True when loaded from a lab-calibrated uni_linint_corrected_* file (already flat-fielded) */
  preFlatFielded?: boolean;
  /** True when loaded from a lab-calibrated linint_corrected_* or uni_linint_corrected_* file (linear radiance) */
  linearized?: boolean;
  /** Optional unclipped float32 RGB data (floatWidth * floatHeight * 3, scaled to ~0..255+ display radiance units) from direct .npy import */
  floatRgb?: Float32Array;
  floatWidth?: number;
  floatHeight?: number;
}

export interface EdgePick {
  lane: number;
  pos: number;
  group: number;
}

export type EdgeMode = 'auto' | 'on' | 'off';

export interface EdgeSetting {
  mode: EdgeMode;
  strength: number; // 0..1
}

export interface TlcPreRunAlignment {
  dyPx: number;
  slopePxPerLane: number;
  matchedAnchors: number;
  residualPx: number;
  mode: 'rigid-merged' | 'direct-box';
}

export type TlcChannelKey = 'UV254' | 'UV366' | 'White';

export interface TlcChannelAlignment {
  /** Horizontal scale mapping source normalized coords into reference image space */
  sx: number;
  /** Vertical scale mapping source normalized coords into reference image space */
  sy: number;
  /** Horizontal translation in reference-image fraction (x_ref = (sx * u_src + dx) * refW) */
  dx: number;
  /** Vertical translation in reference-image fraction (y_ref = (sy * v_src + dy) * refH) */
  dy: number;
  /** Normalized cross-correlation confidence (0..1) */
  confidence: number;
  /** Canonical reference channel this channel was registered against */
  refChannel: TlcChannelKey;
}

export interface TlcPlateData {
  cfg: TlcLaneConfig | null;
  cfgName: string;
  cfgText?: string;
  frameW: number;
  frontPx?: number | null;
  frontHalfPx?: Record<number, number>; // side 0 (Lanes 0-26) and side 1 (Lanes 27-53)
  frontAuto?: Record<number, number>;
  frontAutoByLane?: Record<number, number>;
  /** per half: whether auto front/origin was genuinely detected (vs default guess) and signal strength */
  autoConf?: Record<string, { detected: boolean; score: number }>;
  originPx?: number | null;
  originAuto?: Record<number, number>;
  originAutoByLane?: Record<number, number>;
  prof?: Record<string, number[]>;
  imgs: Record<string, TlcImageEntry>;
  /** Automatic per-channel registration transforms aligning secondary channels (UV366/White) onto the reference channel (UV254) */
  channelAlign?: Partial<Record<TlcChannelKey, TlcChannelAlignment>>;
  /** Optional spotted-but-undeveloped pre-run photos per channel for exact origin registration */
  preRunImgs?: Record<string, TlcImageEntry>;
  /** Whether uploaded pre-run photos are actively merged into origin detection (default true when present) */
  preRunEnabled?: boolean;
  /** Per-half registration summary when pre-run origin was merged with developed plate */
  preRunAlignment?: Record<number, TlcPreRunAlignment>;
  missing?: string[];
  edgePicks?: EdgePick[];
  edgeSettings?: Record<number, EdgeSetting>;
  spotProminence?: number;
  /** Spot detection mode ('2d' watershed segmentation default, 'densitogram' cutoff peak picker, or '1d' legacy fallback) */
  spotDetectorMode?: TlcSpotDetectorMode;
  /** Minimum 2D horizontal spot width (FWHM fraction of lane width, 0..0.65) to filter out narrow spotter microdroplets & their runs (0 = Off) */
  minSpotWidthFrac?: number;
}

export interface TlcSet extends TlcPlateData {
  uid: string;
  name: string;
  /** Per-plate overrides for Plates 2+ (0-based plateIndex > 0). Plate 1 (0) lives on top-level fields. */
  plateData?: Record<number, TlcPlateData>;
}

export type WellOutcomeStatus =
  | 'none'
  | 'hit'             // ⭐ Top Hit / Best Condition
  | 'clean'           // 🟢 Clean Conversion / Product
  | 'partial'         // 🟡 Partial Conversion
  | 'sm_only'         // ⚪ Starting Material Only
  | 'decomp'          // 🔴 Decomposition / Complex Mixture
  | 'precipitate'     // ⚠️ Precipitate / Insoluble
  | 'blank';          // 🔘 Solvent / Negative Control

export type CommonObservationTag =
  | 'polymerized'
  | 'precipitated'
  | 'volume_decreased'
  | 'gas_evolution'
  | 'color_change'
  | 'biphasic'
  | 'viscous_gel'
  | 'turbid'
  | 'homogeneous';

export interface WellObservation {
  wellIndex: number;          // 0..53 (relative to plate)
  plateIndex: number;         // 0, 1, 2
  status?: WellOutcomeStatus;
  tags?: string[];            // e.g. ['polymerized', 'precipitated', 'volume_decreased', 'gas_evolution']
  notes?: string;             // Detailed freeform notes: e.g. "polymerized into solid plug", "volume decreased, possible gas evolution"
  conversion?: number | null; // % conversion (0-100)
  yield?: number | null;      // % yield (0-100)
  colorAfter?: string;        // Observation of color after reaction
  hitRank?: number | null;    // 1, 2, 3 for top candidates
  scaleUpSelected?: boolean;  // Mark for scale-up calculation
}

export interface HteElnRecord {
  campaignTitle?: string;
  objective?: string;
  chemist?: string;
  date?: string;
  reactionClass?: string;     // e.g. "Photoredox Cross-Coupling", "Buchwald-Hartwig", "Suzuki", "Alkylation"
  targetProduct?: string;
  // Physical & Reaction Execution Conditions
  temperatureC?: number | string;
  waterPct?: number | string;
  heatingApparatus?: string;  // e.g. "Aluminum heating block", "Oil bath", "Ambient 23°C", "Chilled 0°C"
  reactionTimeHours?: number | string;
  atmosphere?: string;        // "N2 Glovebox", "Argon Schlenk", "Ambient air", "Sealed septum cap"
  agitation?: string;         // "Tumble stirrer 800 rpm", "Orbital shaker 1000 rpm", "Magnetic tumble", "Static"
  illumination?: string;      // "Blue LED 450 nm, 40W, fan cooled", "UV 365 nm", "Dark / foil wrapped", "None"
  plateSealType?: string;     // "Teflon silicone bonded mat", "Heat-sealed foil", "Slit septum", "Glass inserts"
  postReactionNotes?: string; // General campaign-level observations
  
  // Well-level observations map: key is `${plateIndex}-${wellIndex}` or `${globalIndex}`
  wells: Record<string, WellObservation>;
  
  // Scale-up target
  selectedHitWell?: number | null; // globalIndex of selected well
  scaleUpMmol?: number | null;     // e.g. 1.0 mmol
}

