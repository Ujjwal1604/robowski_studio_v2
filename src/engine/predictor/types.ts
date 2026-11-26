// Robowski Studio - General N-Component Mechanistic Reaction Prediction Types
import type { TlcVisibilityInfo } from './tlcVisibility';

export type MediumMode = 'acid' | 'base' | 'neutral' | 'auto';
export type EquivBasis = 'limiting' | 'total';
export type ConfidenceClass = 'A' | 'B' | 'C';
export type PredictionTier = 'High' | 'Medium' | 'Low' | 'Speculative';

export interface PredictorSubstrateInput {
  id: string;
  code: string;
  name: string;
  iupac?: string;
  smiles: string;
  equivalents: number;
  concentrationMm?: number;
  roleHint?: string;
}

export interface WellConditionConfig {
  medium: MediumMode;
  additiveName: string;
  additiveEquiv: number;
  additivePka: number; // conjugate-acid pKa in DMSO (TsOH ~0.9, DBU ~13.9, TEA ~9.0)
  temperatureC: number; // e.g. 25, 80, 120
  waterPct: number; // effective vol % water (baseWaterPct + hydrateWaterPct)
  baseWaterPct?: number; // nominal solvent / added moisture vol % excluding hydrate water
  hydrateWaterPct?: number; // vol % water contributed by hydrate reagents/additives
  hydrateWaterMm?: number; // mM H2O released by hydrate reagents/additives
  hydrateWaterEquiv?: number; // total equivalents of H2O from hydrates relative to limiting substrate
  hydrateSources?: string[]; // human-readable descriptions of hydrate contributors
  additiveHydrateWaterMm?: number; // mM H2O from additives/catalysts excluded from organic substrates
  additiveHydrateWaterEquiv?: number; // equiv H2O from additives/catalysts
  additiveHydrateSources?: string[];
  solvent: string; // e.g. 'DMSO'
  equivBasis: EquivBasis;
  dilutionFactor?: number; // well total conc factor (default ~50 mM base)
  reactionTimeHours?: number | string;
  atmosphere?: string;
  agitation?: string;
}

export interface IonizableSite {
  id: string;
  substrateCode: string;
  label: string;
  kind: 'acid' | 'base'; // 'acid' = neutral HA -> A- ; 'base' = neutral B -> BH+
  pka: number; // DMSO scale
  atomIndices: number[];
  count: number;
  freeFraction: number; // active reactive fraction under current condition (for nucleophile: unprotonated B or deprotonated A-)
  protonatedFraction: number; // BH+ or HA
}

export interface ParsedSubstrate {
  id: string;
  code: string;
  name: string;
  rawSmiles: string;
  neutralSmiles: string; // active organic parent (counterions/water stripped, protonated nitrogens neutralized)
  equivalents: number;
  concentrationMm: number;
  saltDetected: string | null; // e.g. "HCl (1 eq)", "TFA (1 eq)", "Hydrate"
  saltAcidEquiv: number; // total proton equivalents introduced by salt form (equiv * counterion H+)
  hydrateWaterEquiv: number;
  sites: IonizableSite[];
  exactMass: number;
  formula: string;
  tlcVisibility?: TlcVisibilityInfo;
  valid: boolean;
  error?: string;
}

export interface AcidBaseSummary {
  effectiveMedium: 'free_acid' | 'buffered' | 'basic' | 'neutral';
  effectivePhDmso: number;
  totalAddedAcidEq: number; // from TsOH / acid additive + salt counterions
  totalAddedBaseEq: number; // from DBU / base additive
  freeAcidEq: number;
  freeBaseEq: number;
  acidBlend: number; // 0..1 share of acid-favored catalysis
  baseBlend: number; // 0..1 share of base-favored catalysis
  neutralBlend: number; // 0..1 share of neutral/buffered reactivity
  notes: string[];
}

export interface StepEvent {
  ruleId: string;
  stepLabel: string; // NA(N), NA(C), DH, MI(N), MI(C), SN, AR, AS, IS, EA, AO, DC, EL, OX, PC, Tautomer
  description: string;
  reactantSmiles: string[];
  stepWeight: number;
  bottleneckFactor: number;
  conditionFactor: number;
  tempFactor: number;
  stericFactor: number;
  ringFactor: number;
  electronicFactor: number;
  reversible: boolean;
  releasedFragment?: string | null;
  releasedGas?: string | null;
  productSmiles?: string;
}

export type ChemicalAlertKind =
  | 'gas_evolution'
  | 'chelator_motif'
  | 'michael_acceptor'
  | 'salt_effect'
  | 'hydrate_water'
  | 'buffered_well'
  | 'unmodeled_reactive_group'
  | 'uv_invisible_product'
  | 'python_3d_strain'
  | 'tlc_history'
  | 'dmso_reactivity'
  | 'search_truncated'
  | 'blank_likely';

export interface ChemicalAlert {
  kind: ChemicalAlertKind;
  severity: 'info' | 'warn';
  message: string;
}

export interface LossIon {
  label: string; // e.g. [M+H-H2O]+
  mz: number;
  note: string;
}

export interface PredictedSpecies {
  key: string; // canonical SMILES (stereo stripped for v1)
  smiles: string;
  formula: string;
  exactMass: number;
  mhPlus: number;
  mNaPlus: number;
  mHMinus: number;
  clogP: number;
  tpsa: number;
  numRings: number;
  numAromaticRings: number;
  inventory: number[]; // equivalents consumed from each input substrate
  fragmentUses: number; // how many released small-fragment additions used
  score: number; // 0..1 ranking score = likelihood * (0.4 + 0.6 * persistence)
  likelihood: number; // 0..1 kinetic / path plausibility
  persistence: number; // 0..1 equilibrium share expected to persist (1 for irreversible sinks)
  reversibleEnd: boolean; // ends in a reversible equilibrium step
  tautomerKey: string; // shared across mobile-H / tautomer forms of one connectivity
  tautomerForms: number; // count of predicted forms sharing tautomerKey
  lossIons: LossIon[]; // expected ESI in-source loss ions
  bottleneckScore: number;
  thermoBonus: number;
  tier: PredictionTier;
  status: 'sink' | 'transient' | 'byproduct';
  isSubstrate: boolean;
  isSmallFragment: boolean;
  releasedFragmentName?: string;
  stepsCount: number;
  bestChain: StepEvent[];
  alternativeChains: StepEvent[][];
  mechanismSummary: string;
  tlcVisibility?: TlcVisibilityInfo;
  alerts: ChemicalAlert[];
}

export interface PredictionOptions {
  maxDepth?: number; // default 6
  maxExpansions?: number; // default 160
  maxSpecies?: number; // default 260
  minFrontierScore?: number; // default 0.04
  maxMw?: number; // default 750
  includeSpeculative?: boolean;
  includeTautomers?: boolean;
}

export interface WellPredictionResult {
  wellLabel?: string;
  wellIndex?: number;
  plateIndex?: number;
  condition: WellConditionConfig;
  substrates: ParsedSubstrate[];
  acidBase: AcidBaseSummary;
  species: PredictedSpecies[]; // ranked descending by score (excluding raw substrates)
  releasedFragments: PredictedSpecies[];
  releasedGases: string[];
  alerts: ChemicalAlert[];
  stats: {
    highCount: number;
    mediumCount: number;
    lowCount: number;
    speculativeCount: number;
    sinkCount: number;
    transientCount: number;
    expansionsRun: number;
    totalSpeciesExplored: number;
    truncated: boolean;
    truncationReason?: 'max_expansions' | 'max_species' | null;
    elapsedMs: number;
    pythonRefined?: boolean;
  };
}
