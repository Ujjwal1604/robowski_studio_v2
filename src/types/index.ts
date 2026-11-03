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
  leftoverMl: number | string;
  flasksText: string;
  randomize: boolean;
  randomSeed: number | string;
  solventAfter: number | string;
  deckPlates: DeckConfig | null;
  stockVolumeCheck: boolean;
  newTipEveryTransfer: boolean;
  reagents: Reagent[];
  sets?: VialSet[];
  tri?: TripletSetup;
  product?: ProductInfo;
  imported?: ImportedVials;
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
  calibrationNote: string;
}

export interface RunResult {
  runName: string;
  modeLabel?: string | null;
  descMeta: any;
  solventAfter: number;
  mode: string;
  hood: 'left' | 'right';
  reactionSolvent: string;
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
}

export interface TlcProfileOptions {
  sign: number;
  origin: number;
  front: number;
  radius?: number;
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
}

export interface TlcImageEntry {
  name: string;
  bmp: ImageBitmap;
}

export interface TlcSet {
  uid: string;
  name: string;
  cfg: TlcLaneConfig | null;
  cfgName: string;
  cfgText?: string;
  frameW: number;
  frontPx?: number | null;
  frontAuto?: Record<number, number>;
  prof?: Record<string, number[]>;
  imgs: Record<string, TlcImageEntry>;
  missing?: string[];
}
