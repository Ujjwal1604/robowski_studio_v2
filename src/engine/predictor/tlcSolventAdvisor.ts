// Robowski Studio - 54-Well TLC Solvent System Advisor (SiO2 Normal Phase + C18 Reverse Phase)
import { PredictedSpecies, WellConditionConfig, WellPredictionResult } from './types';
import { predictWellReactions } from './engine';
import { extractWellForPrediction } from './plateBridge';
import { wellLabel } from '../tlcLanes';
import { RunResult, RunState } from '../../types';
import {
  CORE_ELUENT_SPECS,
  MODIFIER_SPECS,
  MixturePhysicalDescriptors,
  composeSolventSystem,
  generateExtendedDynamicSpecs,
  generatePrismaTernarySpecs,
  synthesizePlateTailoredSpecs,
  validateEluentCompatibility,
} from './solventSystemModel';

export type TlcStationaryPhase = 'SiO2' | 'C18';
export type ConcreteStationaryPhase = 'SiO2' | 'C18' | 'Al2O3_neutral' | 'Al2O3_basic';
export type TlcStationaryPhasePreference =
  | 'auto'
  | 'all_equal'
  | 'SiO2'
  | 'C18'
  | 'Al2O3_neutral'
  | 'Al2O3_basic';
export type SolventPreferenceTier = 'primary' | 'secondary';
export type SolventFamily =
  | 'etoac_hex'
  | 'meoh_dcm'
  | 'basic_mod'
  | 'acid_mod'
  | 'acetone_hex'
  | 'meoh_etoac'
  | 'meoh_toluene'
  | 'etoac_dcm'
  | 'ether_pentane'
  | 'mtbe_hex'
  | 'prisma_ternary'
  | 'c18_rp';

export interface TlcSolventSystemDef {
  id: string;
  name: string;
  shortLabel: string;
  ratio: string;
  chamberPrep50mL: string;
  stationaryPhase: TlcStationaryPhase;
  /** Optional concrete stationary phase (e.g. 'Al2O3_neutral' or 'Al2O3_basic' when comparing all phases equally). */
  effectivePhase?: ConcreteStationaryPhase;
  preferenceTier: SolventPreferenceTier;
  family: SolventFamily;
  strength: number; // Effective eluent strength (~0.00 to ~0.92 within its stationary phase)
  alcoholPct: number; // % MeOH / protic H-bond competitor
  organicPct?: number; // % organic co-solvent for C18 reverse phase
  baseModifier?: string; // e.g. '1% Et₃N', '2% (2M NH₃ in MeOH)'
  acidModifier?: string; // e.g. '1% AcOH', '0.1% TFA'
  polarityClass:
    | 'Non-Polar'
    | 'Low-Med Polarity'
    | 'Medium Polarity'
    | 'Polar'
    | 'Basic Polar'
    | 'Acidic Polar'
    | 'Reverse Phase (C18)';
  bestFor: string;
  descriptors?: MixturePhysicalDescriptors;
  isSynthesized?: boolean;
  synthesisNote?: string;
  composition?: {
    strongSolvent: string;
    weakSolvent: string;
    ternaryCoSolvent?: { solvent: string; pct: number };
    strongPct: number;
    modifierId: string;
  };
}

export function resolveSystemPhase(
  system: Pick<TlcSolventSystemDef, 'stationaryPhase' | 'effectivePhase'>,
  stationaryPhasePref: TlcStationaryPhasePreference = 'auto'
): ConcreteStationaryPhase {
  if (system.effectivePhase) return system.effectivePhase;
  if (system.stationaryPhase === 'C18') return 'C18';
  if (stationaryPhasePref === 'Al2O3_neutral') return 'Al2O3_neutral';
  if (stationaryPhasePref === 'Al2O3_basic') return 'Al2O3_basic';
  return 'SiO2';
}

export const TLC_SOLVENT_LIBRARY: TlcSolventSystemDef[] =
  CORE_ELUENT_SPECS.map(composeSolventSystem);

const ALL_DYNAMIC_FALLBACK_SYSTEMS: TlcSolventSystemDef[] = [
  ...generateExtendedDynamicSpecs({
    hasStrongWellAcid: true,
    needsBasicMod: true,
    needsAcidMod: true,
    aromaticHeavyPlate: true,
  }),
  ...generatePrismaTernarySpecs({
    targetStrengths: [0.3, 0.5, 0.72],
    aromaticHeavyPlate: true,
    hasStrongWellAcid: false,
    maxAcidStress: 0,
    needsBasicMod: false,
    needsAcidMod: false,
  }),
].map(composeSolventSystem);

const CORE_SYSTEM_IDS = new Set(TLC_SOLVENT_LIBRARY.map((s) => s.id));
export const ALL_KNOWN_SOLVENT_SYSTEMS: TlcSolventSystemDef[] = [
  ...TLC_SOLVENT_LIBRARY,
  ...ALL_DYNAMIC_FALLBACK_SYSTEMS.filter((s) => !CORE_SYSTEM_IDS.has(s.id)),
];

export function findSolventSystemById(id: string): TlcSolventSystemDef | undefined {
  const direct = ALL_KNOWN_SOLVENT_SYSTEMS.find((s) => s.id === id);
  if (direct) return direct;
  if (id.endsWith('__al2o3_neutral')) {
    const base = ALL_KNOWN_SOLVENT_SYSTEMS.find((s) => s.id === id.slice(0, -'__al2o3_neutral'.length));
    return base ? { ...base, id, effectivePhase: 'Al2O3_neutral' } : undefined;
  }
  if (id.endsWith('__al2o3_basic')) {
    const base = ALL_KNOWN_SOLVENT_SYSTEMS.find((s) => s.id === id.slice(0, -'__al2o3_basic'.length));
    return base ? { ...base, id, effectivePhase: 'Al2O3_basic' } : undefined;
  }
  return undefined;
}

export interface TlcMolLser {
  E: number; // Excess molar refraction / pi-polarizability proxy
  S: number; // Dipolarity / polarizability proxy
  A: number; // Solute H-bond acidity (HBD)
  B: number; // Solute H-bond basicity (electronically attenuated HBA)
  displacementN: number; // Snyder-Soczewinski displacement slope n_i (~0.78..1.34)
}

export interface TlcMolProfile {
  smiles: string;
  /** Canonical RDKit SMILES for leak-free compound identity grouping in calibration CV */
  canonicalSmiles?: string;
  exactmw: number;
  heavyAtomCount?: number;
  tpsa: number;
  clogP: number;
  hbd: number;
  hba: number;
  aromaticRings: number;
  aliphAmineCount: number;
  azoleCount: number;
  basicAzoleNCount?: number; // [nX2r5] sp2 basic nitrogen (excludes non-basic pyrrole/indole NH)
  anilineCount?: number; // aromatic amine Ar-NH2 / Ar-NHR (protonates in strong acid wells)
  imineCount?: number; // acyclic C=N basic nitrogen
  pyridineCount: number;
  carboxylicAcidCount: number;
  primaryAmideCount: number;
  secondaryAmideCount: number;
  ureaCount: number;
  sulfonamideCount: number;
  phenolCount: number;
  boronicCount: number;
  phosphonateCount: number;
  heavyHalogenCount: number; // Cl, Br, I
  cf3Count: number;
  nitroCount?: number;
  cyanoCount?: number;
  /** Strong 6-membered intramolecular O-H...O=C / N=C / NO2 / n chelate rings (e.g. 2'-hydroxyacetophenone, salicylaldehyde, 2-nitrophenol) */
  intraHbondOhCount?: number;
  /** Moderate 6-membered intramolecular N-H...O=C / NO2 chelate rings (e.g. 2'-aminoacetophenone, anthranilates, 2-nitroaniline) */
  intraHbondNhCount?: number;
  zwitterionOrQuatCount: number;
  /** True when the neutral structure carries both a strong basic site and an acidic group (e.g. amino acid) */
  isInternalZwitterion?: boolean;
  /** Electronic EWG attenuation factor (0.35..1.0) on pyridine/aniline/azole basicity (e.g. 4-nitroaniline, 2-chloropyridine) */
  ewgAttenuatedBasicity?: number;
  /** Reactive functional group label if the molecule can condense with Acetone eluents */
  acetoneReactiveLabel?: string | null;
  /** Reactive functional group label if the molecule can undergo methanolysis in MeOH eluents */
  meohReactiveLabel?: string | null;
  /** has a chromophore that shows under UV254/366 (aromatic ring or conjugated C=C/C=O/C=N) */
  uvActive: boolean;
  /** Solute LSER (E, S, A, B) & Snyder-Soczewinski displacement slope n_i */
  lser?: TlcMolLser;
}

export interface WellTlcContext {
  hasAcidAdditive?: boolean;
  hasBaseAdditive?: boolean;
  hasSaltCounterion?: boolean;
  additiveLabel?: string;
  /** Total acid equivalents loaded in well (additive + salt counterions) */
  acidLoadEq?: number;
  /** Residual unconsumed free acid equivalents from well equilibrium */
  freeAcidEq?: number;
  /** Strength & counterion volatility class for spot-on-silica neutralization */
  acidStrength?: 'strong_nonvolatile' | 'strong_volatile' | 'weak';
  /** Approximate DMSO-scale pH from acid-base solver */
  wellPh?: number;
  /** Total base additive equivalents loaded */
  baseLoadEq?: number;
  /** Residual unconsumed free base equivalents */
  freeBaseEq?: number;
  /** Base strength class */
  baseStrength?: 'strong' | 'weak';
}

export interface SimulatedSpot {
  kind: 'substrate' | 'product';
  label: string;
  code: string;
  smiles: string;
  formula: string;
  rf: number;
  /** Per-spot Rf prediction uncertainty (±1σ) widening for salts, zwitterions, tailing, and uncalibrated eluents */
  rfSigma?: number;
  score?: number;
  tier?: PredictedSpecies['tier'];
  tailing: boolean;
  tailingReason?: string;
  /** false: no chromophore, only visible with a stain */
  uvActive?: boolean;
  /** reversible species expected to fall apart on acidic silica or react with eluent */
  mayDecompose?: boolean;
  /** basic amine in an Et₃N eluent where NH₃/MeOH is available: slight residual streaking expected */
  mildStreak?: boolean;
}

export interface SimulatedWellLane {
  wellIndex: number;
  wellCoord: string;
  isBlank: boolean;
  isAssignedHere: boolean;
  hasHighOrMed: boolean;
  resolutionScore: number; // 0..1
  deltaRf: number;
  bestProductRf: number | null;
  spots: SimulatedSpot[];
}

export interface SolventRiskSummary {
  tailingWells: number;
  baselineWells: number;
  frontWells: number;
  coelutedWells: number;
  stainOnlyWells: number;
  reactiveWells: number;
}

export interface RecommendedPlateSolvent {
  system: TlcSolventSystemDef;
  rank: number;
  assignedWellIndices: number[];
  assignedWellCoords: string[];
  /** Wells that ONLY this system resolves within the recommended set (marginal rescue count) */
  uniqueWellIndices?: number[];
  uniqueWellCoords?: string[];
  resolvedWellCount: number;
  highRankedResolvedCount: number;
  wellCoveragePct: number;
  meanResolutionScore: number;
  /** Mean predicted Rf uncertainty (±1σ) across spots in assigned/resolved wells */
  meanRfSigma?: number;
  /** Mean predicted product–substrate |ΔRf| across resolved wells with products */
  meanProductDeltaRf?: number;
  /** Breakdown of predicted chromatographic failure risks on this plate */
  riskSummary?: SolventRiskSummary;
  /** Concise plate-specific explanation of why this system was chosen */
  rationale?: string;
  /** Calibration evidence backing predictions for this solvent family */
  evidenceSummary?: string;
  lanes: SimulatedWellLane[];
  /** Et₃N <-> NH₃/MeOH swap that resolves (almost) the same wells: use whichever base you have at hand */
  alternatives?: TlcSolventSystemDef[];
  /** why the alternative is offered when it is more than a swap (e.g. fewer streak warnings) */
  alternativeNote?: string;
}

export interface PlateSolventGroup {
  label: string;
  systems: RecommendedPlateSolvent[];
  resolvedWellCount: number;
  coveragePct: number;
}

export type SolventPoolMode = 'prefer_primary' | 'primary_only' | 'balanced';

export interface TlcCalibrationSpotPair {
  wellIndex: number;
  wellCoord: string;
  speciesLabel: string;
  speciesKind: 'substrate' | 'product';
  compoundKey?: string;
  observedRf: number;
  predictedRfBefore: number;
  predictedRfAfter: number;
  residualRf: number; // observedRf - predictedRfBefore
  residualDemand: number; // inferredDemand - predictedDemand
  weight: number;
  matchMethod?: 'consensus' | 'per_well';
  consensusWellCount?: number;
  consensusTotalWells?: number;
}

export interface CalibratedCompoundSummary {
  compoundKey: string;
  label: string;
  kind: 'substrate' | 'product';
  wellsPresent: number;
  wellsMatched: number;
  predictedRfBefore: number;
  predictedRfAfter: number;
  observedRfMean: number;
  observedRfSpread: number;
  rfShift: number; // observedRfMean - predictedRfBefore
  matchMethod: 'consensus' | 'per_well';
  channels?: Array<'UV254' | 'UV366' | 'White'>;
}

export interface CalibratedLaneComparison {
  wellIndex: number;
  wellCoord: string;
  isBlank: boolean;
  frontOccupied?: boolean;
  originOccupied?: boolean;
  frontExcess?: number;
  originExcess?: number;
  /** True when 2D measured spots in this lane show real streaking/tailing asymmetry */
  measuredTailing?: boolean;
  /** Maximum measured tailing asymmetry ratio across spots in this lane */
  maxMeasuredTailing?: number;
  measuredSpots: Array<{
    rf: number;
    strength: number;
    widthFrac?: number;
    tailing?: number;
    rfSpan?: number;
    matchedLabel?: string;
    matchedKind?: 'substrate' | 'product';
    matchedPredRfBefore?: number;
    matchedPredRfAfter?: number;
    matchMethod?: 'consensus' | 'per_well';
  }>;
  predictedSpots: Array<{
    label: string;
    kind: 'substrate' | 'product';
    tier?: PredictedSpecies['tier'];
    rfBefore: number;
    rfAfter: number;
    found: boolean;
    boundaryStatus?: 'found' | 'front_saturated' | 'baseline_pinned' | 'missing';
    matchedObsRf?: number;
    matchMethod?: 'consensus' | 'per_well';
  }>;
}

export interface CalibratedPlateSummary {
  setUid: string;
  setName: string;
  plateIndex: number;
  matchedSystemId: string;
  matchedSystemName: string;
  matchedSystem?: TlcSolventSystemDef;
  stationaryPhase: TlcStationaryPhasePreference;
  family: SolventFamily;
  matchSource: 'auto' | 'manual';
  laneCountWithSpots: number;
  pairedCount: number;
  consensusMatchCount?: number;
  frontCensoredCount?: number;
  baselineCensoredCount?: number;
  tailingLaneCount?: number;
  meanRfResidual: number;
  rmseBefore: number;
  rmseAfter: number;
  midplateRfShift: number;
  demandShift: number;
  pairs: TlcCalibrationSpotPair[];
  lanes: CalibratedLaneComparison[];
  compoundSummaries?: CalibratedCompoundSummary[];
}

export interface TlcCalibrationFeatureWeights {
  tpsa?: number;
  hbd?: number;
  aromaticRings?: number;
  basicN?: number;
  clogP?: number;
}

export interface TlcCalibrationFamilyStats {
  plateCount: number;
  pairedCount: number;
  rmseBefore: number;
  rmseAfter: number;
}

export interface TlcCalibrationPhaseFit {
  globalDemandShift: number; // clamped [-0.22, +0.22]
  demandSlope?: number; // clamped [0.82, 1.25], defaults to 1.0
  familyDemandShifts: Partial<Record<SolventFamily, number>>; // clamped [-0.12, +0.12]
  familyStats?: Partial<Record<SolventFamily, TlcCalibrationFamilyStats>>;
  featureWeights?: TlcCalibrationFeatureWeights; // L2-regularized Ridge descriptor offsets
  midplateRfShift: number; // equivalent delta-Rf at Rf = 0.50
  calibratedSigma: number; // blended around RF_SIGMA = 0.12
  pairedSpotCount: number;
  matchedLaneCount: number;
  frontCensoredCount?: number;
  baselineCensoredCount?: number;
  meanRfBias: number;
  rmseBefore: number;
  rmseAfter: number;
  /** number of distinct compounds behind the fit (a compound seen in many wells counts once) */
  uniqueCompounds?: number;
  /** number of distinct compounds confirmed via plate-wide cross-well presence/absence consensus */
  consensusCompoundCount?: number;
  /** per-compound summary of predicted vs measured Rf across the phase's plates */
  compoundSummaries?: CalibratedCompoundSummary[];
  /** true when a leave-compounds-out check could be run */
  validated?: boolean;
  /** held-out Rf error of the fitted model / of the uncalibrated model (only when validated) */
  cvRmse?: number;
  cvRmseBaseline?: number;
  /** leave-one-plate-out held-out Rf error when >= 2 plates exist in this phase */
  plateCvRmse?: number;
  plateCvRmseBaseline?: number;
  /** false when the correction did not beat the uncalibrated model on held-out compounds and was switched off */
  calibrationApplied?: boolean;
  /** families whose whole plate ran far from the prediction; demand shift taken from the plate-level estimate */
  plateLevelFamilies?: Partial<Record<SolventFamily, number>>;
}

export interface TlcCalibrationModel {
  byPhase: Partial<Record<TlcStationaryPhasePreference, TlcCalibrationPhaseFit>>;
  plates: CalibratedPlateSummary[];
  unmatchedSets: Array<{
    key: string;
    uid: string;
    name: string;
    plateIndex: number;
    laneCountWithSpots: number;
  }>;
}

export interface CalibrationAppliedSummary {
  active: boolean;
  stationaryPhase: TlcStationaryPhasePreference;
  pairedSpotCount: number;
  matchedLaneCount: number;
  matchedPlateCount: number;
  uniqueCompounds?: number;
  frontCensoredCount?: number;
  baselineCensoredCount?: number;
  globalDemandShift: number;
  demandSlope?: number;
  hasFeatureWeights?: boolean;
  midplateRfShift: number;
  calibratedSigma: number;
  rmseBefore: number;
  rmseAfter: number;
  cvRmse?: number;
  cvRmseBaseline?: number;
  plateCvRmse?: number;
  familyStats?: Partial<Record<SolventFamily, TlcCalibrationFamilyStats>>;
}

export interface FollowUpFailureSummary {
  measuredWellCount: number;
  resolvedWellCount: number;
  frontCrowdedWells: number[];
  baselinePinnedWells: number[];
  coelutedWells: number[];
  tailingWells?: number[];
  /** Multi-plate measured outcome delta when >= 2 plates have been run for this plateIndex */
  plateProgressionNote?: string;
}

export interface FollowUpSolventOption {
  system: TlcSolventSystemDef;
  rescuedWellIndices: number[];
  rescuedWellCoords: string[];
  rescuedFrontCount: number;
  rescuedBaselineCount: number;
  rescuedCoelutedCount: number;
  rescuedTailingCount?: number;
  beforeRfRange: [number, number] | null;
  afterRfRange: [number, number] | null;
  reason: string;
}

export interface PlateFollowUpPlan {
  plateIndex: number;
  summary: FollowUpFailureSummary;
  recommendations: FollowUpSolventOption[];
}

export interface EmpiricalPlateProfile {
  targetStrengthMin: number;
  targetStrengthMax: number;
  meanAromaticRings: number;
  meanHbd: number;
  maxAcidStress: number;
  acidLabel?: string;
  recommendedMinBaseCap: number;
  tolueneRecommended: boolean;
  topTolueneCandidate?: {
    id: string;
    name: string;
    meanScore: number;
    coveragePct: number;
    aromaticMix: number;
  };
  synthesizedCandidateCount: number;
  synthesizedInTopSetCount: number;
  prismaCandidateCount?: number;
}

export interface PlateSolventPlanResult {
  plateIndex: number;
  stationaryPhase: TlcStationaryPhasePreference;
  activeWellCount: number;
  highRankedWellCount: number;
  resolvedWellCount: number;
  unresolvedWellIndices: number[];
  totalCoveragePct: number;
  recommendedSystems: RecommendedPlateSolvent[];
  otherSystems: RecommendedPlateSolvent[];
  /** remaining systems grouped into complementary sets (best first); leftovers stay in otherSystems only */
  otherGroups: PlateSolventGroup[];
  wellPredictions: Record<number, WellPredictionResult>;
  summaryNotes: string[];
  calibrationApplied?: CalibrationAppliedSummary;
  followUpPlan?: PlateFollowUpPlan;
  empiricalProfile?: EmpiricalPlateProfile;
}

export interface PlateSolventPlanOptions {
  plateIndex?: number;
  maxSystems?: number; // 2, 3, or 4 (default 3)
  poolMode?: SolventPoolMode; // default 'prefer_primary'
  stationaryPhase?: TlcStationaryPhasePreference; // default 'auto' (SiO2 + C18 fallback)
  conditionOverrides?: Partial<WellConditionConfig>;
  cachedPredictions?: Record<string, WellPredictionResult>;
  includeSpeculative?: boolean;
  /** weight of Low-confidence products relative to High/Medium (0..1, default 0.2); only matters when they are included */
  lowTierWeight?: number;
  /** weight of the clean-spot coverage term in eluent selection (default 0.10; 0 disables) */
  cleanSpotWeight?: number;
  calibration?: TlcCalibrationModel;
  onProgress?: (done: number, total: number) => void;
  signal?: AbortSignal;
}

type MotifCountKey = keyof Pick<
  TlcMolProfile,
  | 'aliphAmineCount'
  | 'azoleCount'
  | 'basicAzoleNCount'
  | 'anilineCount'
  | 'imineCount'
  | 'pyridineCount'
  | 'carboxylicAcidCount'
  | 'primaryAmideCount'
  | 'secondaryAmideCount'
  | 'ureaCount'
  | 'sulfonamideCount'
  | 'phenolCount'
  | 'boronicCount'
  | 'phosphonateCount'
  | 'heavyHalogenCount'
  | 'cf3Count'
  | 'nitroCount'
  | 'cyanoCount'
  | 'intraHbondOhCount'
  | 'intraHbondNhCount'
  | 'zwitterionOrQuatCount'
>;

const TLCMOTIF_SMARTS: Array<[MotifCountKey, string]> = [
  [
    'aliphAmineCount',
    // basic N: not nitro / N-oxide / N-N / N-O, not attached to an aromatic ring, acyl, sulfonyl or a C=C (enamine);
    // amidines and guanidines are counted through their N-C=N pattern; free hydrazine NH2 is counted too.
    '[$([NX3;H2,H1,H0;+0;$(N-[#6;X4]);!$(N-C=[O,S,N]);!$(N-c);!$(N-S=O);!$(N-[#7,#8]);!$(N-[CX3]=[CX3])]),$([NX3;H2,H1,H0;+0;!$(N-C=O);!$(N-[#8])]-[CX3]=[NX2]),$([NX3;H2;+0;$(N-[NX3;!$(N-C=[O,S])]);!$(N-C=[O,S,N]);!$(N-N=*)])]',
  ],
  ['azoleCount', '[nX2r5,nX3H1r5]'],
  ['basicAzoleNCount', '[nX2r5]'],
  ['anilineCount', '[NX3;H2,H1,H0;+0;$(N-c);!$(N-C=[O,S,N]);!$(N-S=O);!$(N-[#7,#8]);!$(N=[*])]'],
  ['imineCount', '[NX2;$(N=[CX3]);!$(N-O);!$(N-N);!$([n])]'],
  ['pyridineCount', '[nX2r6]'],
  ['carboxylicAcidCount', '[CX3](=[OX1])[OX2H1]'],
  ['primaryAmideCount', '[CX3;$([C](=[OX1])([NX3;H2;+0])[#6])]'],
  ['secondaryAmideCount', '[CX3;$([C](=[OX1])([NX3;H1;+0])[#6])]'],
  ['ureaCount', '[CX3;$([C](=[OX1])([NX3])[NX3])]'],
  ['sulfonamideCount', '[SX4;$([S](=[OX1])(=[OX1])[NX3;H2,H1;+0])]'],
  ['phenolCount', '[OX2H1;$([O]c)]'],
  ['boronicCount', '[BX3;$([B]([OX2H1])[OX2])]'],
  ['phosphonateCount', '[PX4;$([P](=[OX1])([OX2])[OX2])]'],
  ['heavyHalogenCount', '[Cl,Br,I]'],
  ['cf3Count', '[CX4;$(C(F)(F)F)]'],
  ['nitroCount', '[$([NX3](=O)=O),$([NX3+](=O)[O-])]'],
  ['cyanoCount', '[CX2]#[NX1]'],
  [
    'intraHbondOhCount',
    // 6-membered intramolecular O-H...O=C / N=C / NO2 / aza-ring chelate (masks OH & acceptor from silica Si-OH)
    '[OX2H1;$([O]c:c[CX3]=[OX1,NX2]),$([O]c:c[$([NX3](=O)=O),$([NX3+](=O)[O-])]),$([O]c:c[c,n]:[nX2]),$([O][CX3]=[CX3][CX3]=[OX1])]',
  ],
  [
    'intraHbondNhCount',
    // 6-membered intramolecular N-H...O=C / NO2 chelate (o-aminoaryl carbonyls, anthranilates, 2-nitroanilines)
    '[NX3;H2,H1;+0;$([N]c:c[CX3]=[OX1]),$([N]c:c[$([NX3](=O)=O),$([NX3+](=O)[O-])])]',
  ],
  ['zwitterionOrQuatCount', '[NX4+]'],
];

const CONJUGATED_SMARTS =
  '[$([CX3]=[CX3]-[CX3]=[CX3,OX1,NX2]),$([CX3]=[CX3]-[CX2]#[NX1]),$([CX3]=[CX3]-[NX2]=[#6,#7]),$([CX3]=[NX2]-[CX3]=[CX3,OX1,NX2]),$([NX2]=[NX2])]';

/** Standardized 5D descriptor vector used by Ridge self-calibration and prediction */
export function computeCalibrationFeatureVector(profile: TlcMolProfile): [number, number, number, number, number] {
  const basicN =
    profile.aliphAmineCount +
    profile.pyridineCount +
    (profile.basicAzoleNCount ?? profile.azoleCount * 0.5);
  return [
    (profile.tpsa - 55) / 35,
    (profile.hbd - 1.2) / 1.2,
    (profile.aromaticRings - 1.5) / 1.2,
    (basicN - 0.8) / 1.0,
    (profile.clogP - 2.0) / 1.5,
  ];
}

export function computeFeatureDemandDelta(
  profile: TlcMolProfile,
  weights?: TlcCalibrationFeatureWeights
): number {
  if (!weights) return 0;
  const [fTpsa, fHbd, fArom, fBasicN, fClogP] = computeCalibrationFeatureVector(profile);
  const raw =
    (weights.tpsa ?? 0) * fTpsa +
    (weights.hbd ?? 0) * fHbd +
    (weights.aromaticRings ?? 0) * fArom +
    (weights.basicN ?? 0) * fBasicN +
    (weights.clogP ?? 0) * fClogP;
  return Math.max(-0.14, Math.min(0.14, raw));
}

let tlcQueryCache: WeakMap<object, Map<string, any>> = new WeakMap();

function getTlcQuery(rdkit: any, key: string, smarts: string): any | null {
  let map = tlcQueryCache.get(rdkit);
  if (!map) {
    map = new Map();
    tlcQueryCache.set(rdkit, map);
  }
  if (map.has(key)) return map.get(key);
  try {
    const q = rdkit.get_qmol(smarts);
    map.set(key, q || null);
    return q || null;
  } catch {
    map.set(key, null);
    return null;
  }
}

const ACETONE_REACTIVE_SMARTS: Array<[string, string]> = [
  ['primary amine', '[NX3;H2;!$(NC=[O,S,N]);!$(N-a)][CX4]'],
  ['aniline', '[NX3;H2]-c'],
  ['hydrazine/hydrazide', '[NX3;H2]-[NX3]'],
];
const MEOH_REACTIVE_SMARTS: Array<[string, string]> = [
  ['acid chloride', '[CX3](=O)[Cl,Br]'],
  ['anhydride', '[CX3](=O)O[CX3](=O)'],
  ['sulfonyl chloride', 'S(=O)(=O)[Cl,F]'],
  ['isocyanate/isothiocyanate', 'N=C=[O,S]'],
  ['NHS/active ester', '[CX3](=O)ON1C(=O)CCC1=O'],
];

function matchesAny(rdkit: any, smiles: string, list: Array<[string, string]>): string | null {
  let mol: any = null;
  try {
    mol = rdkit.get_mol(smiles);
    if (!mol) return null;
    for (const [label, sma] of list) {
      const q = getTlcQuery(rdkit, `rx_${label}`, sma);
      if (!q) continue;
      try {
        const m = JSON.parse(mol.get_substruct_matches(q) || '[]');
        if (Array.isArray(m) && m.length > 0) return label;
      } catch {
        /* ignore */
      }
    }
  } catch {
    return null;
  } finally {
    try { mol?.delete(); } catch { /* ignore */ }
  }
  return null;
}

/** Warns when a recommended eluent can chemically react with a sample component on the plate. */
export function eluentReactivityWarnings(
  rdkit: any,
  substrateSmiles: string[],
  systems: TlcSolventSystemDef[]
): string[] {
  const out: string[] = [];
  const uniq = Array.from(new Set(substrateSmiles.map((x) => (x || '').trim()).filter(Boolean)));
  const hasAcetone = systems.some(
    (s) => s.family === 'acetone_hex' || s.composition?.strongSolvent === 'Acetone' || s.composition?.ternaryCoSolvent?.solvent === 'Acetone'
  );
  const hasMeOH = systems.some(
    (s) => /MeOH/i.test(s.name || '') || s.composition?.strongSolvent === 'MeOH' || s.composition?.ternaryCoSolvent?.solvent === 'MeOH' || Boolean(s.baseModifier?.includes('NH₃'))
  );
  if (hasAcetone) {
    const hit = uniq.map((u) => matchesAny(rdkit, u, ACETONE_REACTIVE_SMARTS)).find(Boolean);
    if (hit) {
      out.push(`Acetone eluent with a ${hit} component on the plate: it can condense to an imine/hydrazone on the silica and create an artefact spot; prefer an EtOAc or MTBE system for those wells.`);
    }
  }
  if (hasMeOH) {
    const hit = uniq.map((u) => matchesAny(rdkit, u, MEOH_REACTIVE_SMARTS)).find(Boolean);
    if (hit) {
      out.push(`MeOH-containing eluent with a reactive ${hit} sample component: it can be methanolysed to the methyl ester/carbamate on the plate; quench the aliquot or use a non-alcohol eluent.`);
    }
  }
  return out;
}

export function profileMoleculeForTlc(
  rdkit: any,
  smiles: string,
  cache?: Map<string, TlcMolProfile>
): TlcMolProfile {
  const clean = (smiles || '').trim();
  if (cache?.has(clean)) return cache.get(clean)!;

  const fallback: TlcMolProfile = {
    smiles: clean,
    exactmw: 180,
    tpsa: 35,
    clogP: 1.5,
    hbd: 1,
    hba: 2,
    aromaticRings: 1,
    aliphAmineCount: 0,
    azoleCount: 0,
    basicAzoleNCount: 0,
    anilineCount: 0,
    imineCount: 0,
    pyridineCount: 0,
    carboxylicAcidCount: 0,
    primaryAmideCount: 0,
    secondaryAmideCount: 0,
    ureaCount: 0,
    sulfonamideCount: 0,
    phenolCount: 0,
    boronicCount: 0,
    phosphonateCount: 0,
    heavyHalogenCount: 0,
    cf3Count: 0,
    nitroCount: 0,
    cyanoCount: 0,
    zwitterionOrQuatCount: 0,
    uvActive: true,
    lser: { E: 0.7, S: 0.65, A: 0.42, B: 0.65, displacementN: 0.94 },
  };
  if (!rdkit || !clean) return fallback;

  let mol: any = null;
  try {
    mol = rdkit.get_mol(clean);
    if (!mol || !mol.is_valid()) return fallback;
    const desc = JSON.parse(mol.get_descriptors());

    const counts: Record<MotifCountKey, number> = {
      aliphAmineCount: 0,
      azoleCount: 0,
      basicAzoleNCount: 0,
      anilineCount: 0,
      imineCount: 0,
      pyridineCount: 0,
      carboxylicAcidCount: 0,
      primaryAmideCount: 0,
      secondaryAmideCount: 0,
      ureaCount: 0,
      sulfonamideCount: 0,
      phenolCount: 0,
      boronicCount: 0,
      phosphonateCount: 0,
      heavyHalogenCount: 0,
      cf3Count: 0,
      nitroCount: 0,
      cyanoCount: 0,
      intraHbondOhCount: 0,
      intraHbondNhCount: 0,
      zwitterionOrQuatCount: 0,
    };
    for (const [k, sma] of TLCMOTIF_SMARTS) {
      const q = getTlcQuery(rdkit, k, sma);
      if (!q) continue;
      try {
        const mJson = mol.get_substruct_matches(q);
        const matches = JSON.parse(mJson || '[]');
        counts[k] = Array.isArray(matches) ? matches.length : 0;
      } catch {
        counts[k] = 0;
      }
    }

    let conjugated = false;
    const cq = getTlcQuery(rdkit, 'conjugated', CONJUGATED_SMARTS);
    if (cq) {
      try {
        const cm = JSON.parse(mol.get_substruct_matches(cq) || '[]');
        conjugated = Array.isArray(cm) && cm.length > 0;
      } catch {}
    }

    // Check reactive eluent motifs directly on the already-parsed mol (zero extra RDKit parsing later)
    let acetoneReactiveLabel: string | null = null;
    for (const [label, sma] of ACETONE_REACTIVE_SMARTS) {
      const q = getTlcQuery(rdkit, `rx_${label}`, sma);
      if (!q) continue;
      try {
        const m = JSON.parse(mol.get_substruct_matches(q) || '[]');
        if (Array.isArray(m) && m.length > 0) {
          acetoneReactiveLabel = label;
          break;
        }
      } catch {}
    }
    let meohReactiveLabel: string | null = null;
    for (const [label, sma] of MEOH_REACTIVE_SMARTS) {
      const q = getTlcQuery(rdkit, `rx_${label}`, sma);
      if (!q) continue;
      try {
        const m = JSON.parse(mol.get_substruct_matches(q) || '[]');
        if (Array.isArray(m) && m.length > 0) {
          meohReactiveLabel = label;
          break;
        }
      } catch {}
    }

    let canonicalSmiles = clean;
    try {
      const can = mol.get_smiles?.();
      if (typeof can === 'string' && can.trim().length > 0) canonicalSmiles = can.trim();
    } catch {}

    const exactmw = Number(desc.exactmw) || Number(desc.amw) || 0;
    const heavyAtomCount =
      Number(desc.NumHeavyAtoms) || Math.max(4, Math.round(exactmw / 13.5));
    const tpsa = Number(desc.tpsa) || 0;
    const hbd = Number(desc.NumHBD) || 0;
    const hba = Number(desc.NumHBA) || 0;
    const aromaticRings = Number(desc.NumAromaticRings) || 0;

    // Abraham LSER solute vector with inductive EWG attenuation (-CF3, halogens, -NO2, -CN)
    const inductiveAtten = Math.max(
      0.62,
      1 -
        counts.cf3Count * 0.14 -
        counts.heavyHalogenCount * 0.045 -
        counts.nitroCount * 0.10 -
        counts.cyanoCount * 0.07
    );
    // Stronger resonance + inductive basicity attenuation for aromatic/sp2 N bases (2-Cl-pyridine, 4-NO2-aniline, etc.)
    const ewgAttenuatedBasicity =
      Math.round(
        Math.max(
          0.35,
          1 -
            counts.nitroCount * 0.28 -
            counts.cyanoCount * 0.20 -
            counts.cf3Count * 0.22 -
            counts.heavyHalogenCount * 0.09
        ) * 1000
      ) / 1000;
    // Internal zwitterion detection (e.g. amino acids, aminophosphonic acids): both strong basic N and strong acidic OH
    const isInternalZwitterion =
      counts.aliphAmineCount > 0 &&
      (counts.carboxylicAcidCount > 0 || counts.phosphonateCount > 0);
    const lserE = Math.round(
      Math.min(2.6, aromaticRings * 0.65 + counts.heavyHalogenCount * 0.22 + Math.max(0, heavyAtomCount - 12) * 0.03) *
        1000
    ) / 1000;
    const lserS = Math.round(
      Math.min(2.8, tpsa * 0.014 + counts.nitroCount * 0.35 + counts.cyanoCount * 0.28 + aromaticRings * 0.15) *
        1000
    ) / 1000;
    const lserA = Math.round(
      Math.max(
        0,
        Math.min(
          2.4,
          hbd * 0.42 +
            counts.phenolCount * 0.22 +
            counts.carboxylicAcidCount * 0.25 +
            counts.boronicCount * 0.20 -
            counts.intraHbondOhCount * 0.48 -
            counts.intraHbondNhCount * 0.20
        )
      ) * 1000
    ) / 1000;
    const lserB = Math.round(
      Math.max(
        0,
        Math.min(
          2.8,
          (hba * 0.32 + counts.aliphAmineCount * 0.35 + counts.basicAzoleNCount * 0.20 + counts.pyridineCount * 0.22) *
            inductiveAtten -
            counts.intraHbondOhCount * 0.22 -
            counts.intraHbondNhCount * 0.10
        )
      ) * 1000
    ) / 1000;

    // Snyder-Soczewinski displacement slope n_i = A_s / n_B
    const footprintPatches =
      (hbd > 0 ? 1 : 0) +
      (hba >= 2 ? 1 : 0) +
      Math.min(2, aromaticRings * 0.5) +
      Math.min(
        1.5,
        (counts.primaryAmideCount +
          counts.secondaryAmideCount +
          counts.ureaCount +
          counts.sulfonamideCount +
          counts.carboxylicAcidCount +
          counts.basicAzoleNCount +
          counts.pyridineCount) *
          0.45
      );
    const rawDispN =
      1.0 +
      Math.max(-0.10, Math.min(0.22, (heavyAtomCount - 12) * 0.011)) +
      Math.max(-0.04, Math.min(0.12, (footprintPatches - 1.8) * 0.05));
    const displacementN = Math.round(Math.max(0.86, Math.min(1.32, rawDispN)) * 1000) / 1000;

    const prof: TlcMolProfile = {
      smiles: clean,
      canonicalSmiles,
      exactmw,
      heavyAtomCount,
      tpsa,
      clogP: Number(desc.CrippenClogP) || 0,
      hbd,
      hba,
      aromaticRings,
      aliphAmineCount: counts.aliphAmineCount,
      azoleCount: counts.azoleCount,
      basicAzoleNCount: counts.basicAzoleNCount,
      anilineCount: counts.anilineCount,
      imineCount: counts.imineCount,
      pyridineCount: counts.pyridineCount,
      carboxylicAcidCount: counts.carboxylicAcidCount,
      primaryAmideCount: counts.primaryAmideCount,
      secondaryAmideCount: counts.secondaryAmideCount,
      ureaCount: counts.ureaCount,
      sulfonamideCount: counts.sulfonamideCount,
      phenolCount: counts.phenolCount,
      boronicCount: counts.boronicCount,
      phosphonateCount: counts.phosphonateCount,
      heavyHalogenCount: counts.heavyHalogenCount,
      cf3Count: counts.cf3Count,
      nitroCount: counts.nitroCount,
      cyanoCount: counts.cyanoCount,
      intraHbondOhCount: counts.intraHbondOhCount,
      intraHbondNhCount: counts.intraHbondNhCount,
      zwitterionOrQuatCount: counts.zwitterionOrQuatCount,
      isInternalZwitterion,
      ewgAttenuatedBasicity,
      acetoneReactiveLabel,
      meohReactiveLabel,
      uvActive: aromaticRings > 0 || conjugated,
      lser: {
        E: lserE,
        S: lserS,
        A: lserA,
        B: lserB,
        displacementN,
      },
    };
    cache?.set(clean, prof);
    return prof;
  } catch {
    return fallback;
  } finally {
    try {
      mol?.delete?.();
    } catch {}
  }
}

/**
 * Builds rich acid-base & salt context for a reaction well so TLC Rf and streaking models
 * reflect actual acid loading (e.g. TsOH equivalents), counterion volatility, and well pH.
 */
export function buildWellTlcContext(
  ext: {
    substrates: Array<{ smiles: string; name?: string; iupac?: string; equivalence?: number }>;
    condition: WellConditionConfig;
  },
  pred?: WellPredictionResult | null
): WellTlcContext {
  const saltPattern =
    /\.(Cl|Br|I|F)\b|FC\(F\)\(F\)C\(=O\)O|S\(=O\)\(=O\)O|hydrochloride|trifluoroacetate|tosylate|mesylate/i;
  const nonVolatileSaltPattern = /S\(=O\)\(=O\)O|tosylate|mesylate/i;

  let hasSaltCounterion = false;
  let hasNonVolatileSalt = false;
  let inferredSaltEq = 0;
  for (const s of ext.substrates || []) {
    const smi = s.smiles || '';
    const isSalt =
      (smi.includes('.') && saltPattern.test(smi)) ||
      saltPattern.test(s.name || '') ||
      saltPattern.test(s.iupac || '');
    if (isSalt) {
      hasSaltCounterion = true;
      inferredSaltEq += Math.max(0.25, Number(s.equivalence) || 1.0);
      if (nonVolatileSaltPattern.test(smi) || nonVolatileSaltPattern.test(s.name || '') || nonVolatileSaltPattern.test(s.iupac || '')) {
        hasNonVolatileSalt = true;
      }
    }
  }

  const addName = ext.condition.additiveName || '';
  const addEquiv = Math.max(0, Number(ext.condition.additiveEquiv) || 0);
  const addPka = Number(ext.condition.additivePka);

  const isStrongNonVolatileAcidName =
    /\b(p?-?TsOH|PTSA|TfOH|MsOH|CSA|PPTS|H2SO4|H3PO4|KHSO4|NaHSO4)\b|toluenesulfon|benzenesulfon|tosyl|mesyl|camphorsulfon/i.test(
      addName
    );
  const isStrongVolatileAcidName = /\b(TFA|HCl|HBr|HI|trifluoroacetic)\b/i.test(addName);
  const isWeakAcidName = /\b(AcOH|HOAc|HCOOH|acetic|formic|citric|benzoic)\b/i.test(addName);

  const hasAcidAdditive =
    ext.condition.medium === 'acid' ||
    pred?.acidBase?.effectiveMedium === 'free_acid' ||
    (pred?.acidBase?.effectiveMedium === 'buffered' &&
      (isStrongNonVolatileAcidName || isStrongVolatileAcidName || isWeakAcidName));

  const isStrongBaseName = /\b(DBU|TBD|MTBD|BTMG|K2CO3|Cs2CO3|NaOH|KOH|KOtBu|NaOtBu|LiOH|K3PO4|NaH|LDA|LiHMDS|NaHMDS)\b/i.test(
    addName
  );
  const isWeakBaseName = /\b(Et3N|TEA|DIPEA|Pyridine|DMAP|DABCO|NaHCO3|NaOAc)\b/i.test(addName);
  const hasBaseAdditive =
    ext.condition.medium === 'base' ||
    pred?.acidBase?.effectiveMedium === 'basic' ||
    (pred?.acidBase?.effectiveMedium === 'buffered' && (isStrongBaseName || isWeakBaseName));

  let acidStrength: WellTlcContext['acidStrength'];
  if (hasAcidAdditive || hasSaltCounterion) {
    if (isStrongNonVolatileAcidName || hasNonVolatileSalt) {
      acidStrength = 'strong_nonvolatile';
    } else if (isStrongVolatileAcidName || hasSaltCounterion) {
      acidStrength = 'strong_volatile';
    } else if (isWeakAcidName) {
      acidStrength = 'weak';
    } else if (Number.isFinite(addPka) && addPka <= 2.5) {
      acidStrength = 'strong_nonvolatile';
    } else {
      acidStrength = 'weak';
    }
  }

  const acidLoadEq =
    pred?.acidBase?.totalAddedAcidEq != null && pred.acidBase.totalAddedAcidEq > 0
      ? pred.acidBase.totalAddedAcidEq
      : (hasAcidAdditive ? (addEquiv > 0 ? addEquiv : 0.25) : 0) + (hasSaltCounterion ? inferredSaltEq : 0);

  const freeAcidEq =
    pred?.acidBase?.freeAcidEq != null
      ? pred.acidBase.freeAcidEq
      : acidLoadEq > 0
      ? acidLoadEq * 0.4
      : 0;

  const baseLoadEq =
    pred?.acidBase?.totalAddedBaseEq != null && pred.acidBase.totalAddedBaseEq > 0
      ? pred.acidBase.totalAddedBaseEq
      : hasBaseAdditive
      ? addEquiv > 0
        ? addEquiv
        : 0.25
      : 0;

  const freeBaseEq =
    pred?.acidBase?.freeBaseEq != null
      ? pred.acidBase.freeBaseEq
      : baseLoadEq > 0
      ? baseLoadEq * 0.5
      : 0;

  const baseStrength: WellTlcContext['baseStrength'] = hasBaseAdditive
    ? isStrongBaseName || (Number.isFinite(addPka) && addPka >= 11)
      ? 'strong'
      : 'weak'
    : undefined;

  return {
    hasAcidAdditive,
    hasBaseAdditive,
    hasSaltCounterion,
    additiveLabel: addName && addName !== 'None (Neutral)' ? addName : undefined,
    acidLoadEq: acidLoadEq > 0 ? Math.round(acidLoadEq * 1000) / 1000 : 0,
    freeAcidEq: freeAcidEq > 0 ? Math.round(freeAcidEq * 1000) / 1000 : 0,
    acidStrength,
    wellPh: pred?.acidBase?.effectivePhDmso,
    baseLoadEq: baseLoadEq > 0 ? Math.round(baseLoadEq * 1000) / 1000 : 0,
    freeBaseEq: freeBaseEq > 0 ? Math.round(freeBaseEq * 1000) / 1000 : 0,
    baseStrength,
  };
}

function resolveWellAcidStress(profile: TlcMolProfile, wellCtx?: WellTlcContext): {
  hasAcidEffect: boolean;
  acidStrength: 'strong_nonvolatile' | 'strong_volatile' | 'weak';
  acidLoad: number;
  acidSeverity: number;
  effBasicCount: number;
  acidStress: number;
  label: string;
} {
  if (!wellCtx || (!wellCtx.hasAcidAdditive && !wellCtx.hasSaltCounterion)) {
    return {
      hasAcidEffect: false,
      acidStrength: 'weak',
      acidLoad: 0,
      acidSeverity: 0,
      effBasicCount: 0,
      acidStress: 0,
      label: '',
    };
  }

  const label = wellCtx.additiveLabel || (wellCtx.hasSaltCounterion ? 'Salt counterion' : 'Acid');
  let acidStrength = wellCtx.acidStrength;
  if (!acidStrength) {
    if (
      /\b(p?-?TsOH|PTSA|TfOH|MsOH|CSA|PPTS|H2SO4|H3PO4|KHSO4|NaHSO4)\b|toluenesulfon|benzenesulfon|tosyl|mesyl|camphorsulfon/i.test(
        label
      )
    ) {
      acidStrength = 'strong_nonvolatile';
    } else if (/\b(TFA|HCl|HBr|HI|trifluoroacetic)\b/i.test(label) || wellCtx.hasSaltCounterion) {
      acidStrength = 'strong_volatile';
    } else {
      acidStrength = 'weak';
    }
  }

  const acidLoad = Math.max(0, wellCtx.acidLoadEq ?? 0.25);
  const freeAcid = Math.max(0, wellCtx.freeAcidEq ?? acidLoad * 0.4);
  const acidSeverity = acidStrength === 'strong_nonvolatile' ? 1.0 : acidStrength === 'strong_volatile' ? 0.72 : 0.35;

  const basicAzole = profile.basicAzoleNCount ?? profile.azoleCount * 0.5;
  const aniline = profile.anilineCount ?? 0;
  const imine = profile.imineCount ?? 0;
  const basicityAtten = profile.ewgAttenuatedBasicity ?? 1.0;
  // Electron-deficient aromatic bases (4-nitroaniline, 2-Cl-pyridine, CF3-azoles) protonate far less readily
  const medBasicSites = (profile.pyridineCount + basicAzole + aniline + 0.55 * imine) * basicityAtten;
  const strongBasicSites = profile.aliphAmineCount;
  const effBasicCount =
    acidStrength === 'weak'
      ? strongBasicSites + 0.25 * medBasicSites
      : strongBasicSites + 0.80 * medBasicSites;

  if (effBasicCount <= 0 || acidLoad <= 0) {
    return {
      hasAcidEffect: false,
      acidStrength,
      acidLoad,
      acidSeverity,
      effBasicCount: 0,
      acidStress: 0,
      label,
    };
  }

  // Note: when imidazoles/benzimidazoles (pKa_BH+ ~7 in DMSO) absorb added TsOH to form BH+ TsO- salts,
  // effectivePhDmso sits near ~7.0-8.2 with freeAcidEq=0 — the acid is NOT neutralized, it is bound as
  // imidazolium tosylate salt! Only attenuate when an external or much stronger base pushes well pH high.
  let pHFactor = 1.0;
  if (wellCtx.wellPh != null) {
    const isStrongAliph = strongBasicSites > 0;
    if (isStrongAliph) {
      if (wellCtx.hasBaseAdditive && (wellCtx.freeBaseEq ?? 0) > 0.08 && wellCtx.wellPh > 11.5) {
        pHFactor = Math.max(0.15, 1 / (1 + Math.pow(10, (wellCtx.wellPh - 12.2) * 0.7)));
      }
    } else if (wellCtx.wellPh >= 8.6) {
      const midPh = wellCtx.hasBaseAdditive && (wellCtx.freeBaseEq ?? 0) > 0.05 ? 9.0 : 10.2;
      pHFactor = Math.max(0.15, Math.min(1.05, 1 / (1 + Math.pow(10, (wellCtx.wellPh - midPh) * 0.7))));
    }
  }

  const rawEqStress = Math.min(1.6, 0.34 + 0.68 * acidLoad + 0.25 * freeAcid);
  const acidStress =
    acidSeverity * rawEqStress * pHFactor * Math.min(1.12, 0.72 + 0.16 * effBasicCount);

  return {
    hasAcidEffect: acidStress > 0.04,
    acidStrength,
    acidLoad,
    acidSeverity,
    effBasicCount,
    acidStress,
    label,
  };
}

/** Compute per-spot Rf prediction uncertainty (±1σ) reflecting chemical difficulty & calibration coverage */
function computeSpotRfSigma(
  profile: TlcMolProfile,
  system: TlcSolventSystemDef,
  tailing: boolean,
  mildStreak: boolean,
  wellAcidStress: number,
  baseSigma: number,
  familyCalibrated: boolean
): number {
  let sigma = Number.isFinite(baseSigma) && baseSigma > 0 ? baseSigma : RF_SIGMA;
  if (familyCalibrated) sigma -= 0.015;
  if (profile.zwitterionOrQuatCount > 0 || profile.isInternalZwitterion) sigma += 0.05;
  if (tailing) sigma += 0.04;
  else if (mildStreak) sigma += 0.018;
  if (wellAcidStress >= 0.65) sigma += 0.025;
  if (profile.tpsa > 120 || profile.hbd >= 4) sigma += 0.022;
  if (!familyCalibrated && (system.family === 'prisma_ternary' || system.preferenceTier === 'secondary')) {
    sigma += 0.018;
  }
  return Math.round(Math.max(0.08, Math.min(0.24, sigma)) * 1000) / 1000;
}

/**
 * Predicts TLC Rf (0.02..0.99), per-spot uncertainty (±1σ), and streaking risk on
 * Normal-Phase SiO2, Al2O3 (Neutral/Basic), or Reverse-Phase C18.
 */
export function predictTlcRf(
  profile: TlcMolProfile,
  system: TlcSolventSystemDef,
  wellCtx?: WellTlcContext,
  stationaryPhasePref: TlcStationaryPhasePreference = 'auto',
  demandShift: number = 0,
  demandSlope: number = 1.0,
  featureWeights?: TlcCalibrationFeatureWeights,
  baseSigma: number = RF_SIGMA,
  familyCalibrated: boolean = false
): { rf: number; rfSigma: number; tailing: boolean; tailingReason?: string; mildStreak?: boolean } {
  const primAmide = profile.primaryAmideCount || 0;
  const secAmide = profile.secondaryAmideCount || 0;
  const urea = profile.ureaCount || 0;
  const sulfonamide = profile.sulfonamideCount || 0;
  const phenol = profile.phenolCount || 0;
  const boronic = profile.boronicCount || 0;
  const phosphonate = profile.phosphonateCount || 0;
  const heavyHalogen = profile.heavyHalogenCount || 0;
  const cf3 = profile.cf3Count || 0;
  const nitro = profile.nitroCount || 0;
  const cyano = profile.cyanoCount || 0;
  const intraOh = profile.intraHbondOhCount || 0;
  const intraNh = profile.intraHbondNhCount || 0;
  const quat = profile.zwitterionOrQuatCount || 0;
  const isInternalZwitterion = Boolean(
    profile.isInternalZwitterion ||
      (profile.aliphAmineCount > 0 && (profile.carboxylicAcidCount > 0 || phosphonate > 0))
  );
  const basicityAtten = profile.ewgAttenuatedBasicity ?? 1.0;
  const exactmw = profile.exactmw || 0;
  const featureDelta = computeFeatureDemandDelta(profile, featureWeights);
  const wellAcid = resolveWellAcidStress(profile, wellCtx);

  // -------------------------------------------------------------------------
  // CASE A: REVERSE-PHASE C18 TLC (Polarity & elution order inverted!)
  // -------------------------------------------------------------------------
  if (system.stationaryPhase === 'C18') {
    const desc = system.descriptors;
    const orgFrac = (system.organicPct ?? desc?.organicPct ?? system.strength * 100) / 100;
    const isMeCN = system.composition
      ? system.composition.strongSolvent === 'MeCN'
      : system.id.includes('mecn');
    const isAcidic = Boolean(system.acidModifier);

    // Lipophilicity increases C18 binding; TPSA/HBD/ionizable groups decrease C18 binding
    // Intramolecular H-bonds reduce aqueous solvation (lower polarRelease -> slightly tighter C18 retention)
    let polarRelease = Math.max(
      0,
      Math.min(0.45, profile.tpsa * 0.0042) +
        profile.hbd * 0.055 +
        profile.aliphAmineCount * (isAcidic ? 0.24 : 0.14) +
        profile.azoleCount * 0.07 +
        profile.carboxylicAcidCount * (isAcidic ? 0.04 : 0.14) +
        primAmide * 0.055 +
        urea * 0.065 +
        sulfonamide * 0.045 +
        boronic * 0.09 +
        phosphonate * 0.08 +
        quat * 0.28 +
        (isInternalZwitterion ? 0.22 : 0) -
        Math.min(0.09, intraOh * 0.055 + intraNh * 0.025)
    );

    // Protonated basic sites from acid/salt reaction wells elute earlier on C18
    if (wellAcid.hasAcidEffect) {
      polarRelease += Math.min(0.16, 0.04 + 0.08 * wellAcid.acidStress);
    }

    const mwLipo = exactmw > 420 ? Math.min(0.08, (exactmw - 420) * 0.00022) : 0;
    const lipoRetention =
      0.16 +
      Math.max(-0.2, profile.clogP * 0.21) +
      profile.aromaticRings * 0.055 +
      mwLipo +
      heavyHalogen * 0.018 +
      cf3 * 0.03 -
      polarRelease +
      demandShift +
      featureDelta;

    const rpEluentPower = orgFrac * (isMeCN ? 1.08 : 0.94) + (isAcidic ? 0.05 : 0);

    let tailing = false;
    let tailingReason: string | undefined;
    let mildStreak = false;
    if (!isAcidic && profile.aliphAmineCount >= 1) {
      tailing = true;
      tailingReason = 'Basic amine can tail on C18 without 0.1% TFA modifier';
    } else if (!isAcidic && wellAcid.hasAcidEffect && wellAcid.acidStress >= 0.45) {
      mildStreak = true;
      tailingReason = `${wellAcid.label} protonated salt can split/streak on unbuffered C18 — use 0.1% TFA modifier`;
    }

    const effDispN = profile.lser?.displacementN ?? 1.0;
    const z = Math.max(-10, Math.min(10, 4.8 * demandSlope * (0.6 + 0.4 * effDispN) * (rpEluentPower - lipoRetention)));
    const rawRf = 1 / (1 + Math.exp(-z));
    const rf = Math.round(Math.max(0.02, Math.min(0.96, rawRf)) * 100) / 100;
    const rfSigma = computeSpotRfSigma(profile, system, tailing, mildStreak, wellAcid.acidStress, baseSigma, familyCalibrated);
    return { rf, rfSigma, tailing, tailingReason, mildStreak };
  }

  // -------------------------------------------------------------------------
  // CASE B: ALUMINA (Al2O3 Neutral / Basic — Lewis-acidic Al3+ + basic O2- surface)
  // Modeled independently from SiO2: stronger dipole/pi/ester/nitro & phenol/acid
  // binding, much weaker basic-amine/pyridine silanol retention.
  // -------------------------------------------------------------------------
  const resolvedPhase = resolveSystemPhase(system, stationaryPhasePref);
  const isNeutralAlumina = resolvedPhase === 'Al2O3_neutral';
  const isBasicAlumina = resolvedPhase === 'Al2O3_basic';
  const isAlumina = isNeutralAlumina || isBasicAlumina;

  const lipophilicityOffset = Math.max(-0.14, Math.min(0.22, (profile.clogP - 1.4) * 0.04));
  // Heavy halogens & -CF3 reduce adjacent heteroatom H-bond basicity; keep -NO2/-CN dipole neutral
  const halogenCf3Relief = Math.min(0.09, cf3 * 0.036 + heavyHalogen * 0.016);
  // Larger MW (> 450 Da) adds modest nonspecific adsorption unless already very lipophilic
  const mwAdsorption = exactmw > 450 ? Math.min(0.055, (exactmw - 450) * 0.00016) : 0;

  const aniline = profile.anilineCount || 0;
  const basicAzoleN = profile.basicAzoleNCount ?? profile.azoleCount * 0.5;
  const azoleNH = Math.max(0, profile.azoleCount - basicAzoleN);
  // Tautomeric NH + basic =N- azoles (imidazole, benzimidazole, pyrazole, triazole) form strong H-bond chains
  const nhBasicAzole = Math.min(basicAzoleN, azoleNH);

  // Protic alcohol eluents (MeOH/EtOH) partially compete with and disrupt intramolecular H-bonds
  const intraProticFactor =
    system.alcoholPct > 0 ? Math.max(0.55, 1 - system.alcoholPct * 0.035) : 1.0;
  const intraHbondReliefSiO2 =
    (Math.min(0.24, intraOh * 0.165) + Math.min(0.14, intraNh * 0.08)) * intraProticFactor;
  const intraHbondReliefAlumina =
    (Math.min(0.20, intraOh * 0.125) + Math.min(0.11, intraNh * 0.06)) * intraProticFactor;

  let demand = 0;
  if (isAlumina) {
    // Alumina retains dipolar/pi-rich groups (nitro, cyano, carbonyl/HBA, polyaromatics) and acidic OH
    // (phenols, carboxylic acids, boronic acids) more strongly than SiO2, while releasing free amines cleanly.
    const dipolePiRetention =
      Math.min(0.14, profile.aromaticRings * 0.024 + nitro * 0.045 + cyano * 0.032) +
      Math.min(0.10, (profile.lser?.S ?? 0) * 0.032);
    const aluminaFunctionalDemand =
      Math.min(0.16, primAmide * 0.068) +
      Math.min(0.10, secAmide * 0.032) +
      Math.min(0.20, urea * 0.088) +
      Math.min(0.16, sulfonamide * 0.062) +
      // Phenols are acidic (pKa ~10) and bind noticeably tighter to basic/neutral alumina than SiO2
      Math.min(0.22, phenol * (isBasicAlumina ? 0.095 : 0.068)) +
      Math.min(0.09, aniline * basicityAtten * (isBasicAlumina ? 0.022 : 0.036)) +
      Math.min(0.22, phosphonate * 0.095) +
      Math.min(0.26, boronic * 0.14) +
      dipolePiRetention +
      mwAdsorption -
      halogenCf3Relief * 0.85 -
      intraHbondReliefAlumina;

    demand =
      (isBasicAlumina ? 0.02 : 0.03) +
      Math.min(0.52, profile.tpsa * 0.0039) +
      profile.hbd * (isBasicAlumina ? 0.066 : 0.060) +
      Math.max(0, profile.hba - 1) * 0.024 +
      Math.min(0.18, profile.azoleCount * (isBasicAlumina ? 0.028 : 0.036)) +
      Math.min(0.10, basicAzoleN * basicityAtten * (isBasicAlumina ? 0.014 : 0.024)) +
      Math.min(0.14, nhBasicAzole * (isBasicAlumina ? 0.034 : 0.055)) +
      profile.pyridineCount * basicityAtten * (isBasicAlumina ? 0.022 : 0.034) +
      aluminaFunctionalDemand -
      lipophilicityOffset +
      demandShift +
      featureDelta;
  } else {
    // -------------------------------------------------------------------------
    // CASE C: NORMAL-PHASE SILICA (SiO2 — acidic Si-OH silanol surface)
    // -------------------------------------------------------------------------
    const functionalGroupDemand =
      Math.min(0.18, primAmide * 0.075) +
      Math.min(0.11, secAmide * 0.035) +
      Math.min(0.22, urea * 0.095) +
      Math.min(0.16, sulfonamide * 0.06) +
      Math.min(0.12, phenol * 0.045) +
      Math.min(0.11, aniline * basicityAtten * 0.045) +
      Math.min(0.18, phosphonate * 0.075) +
      mwAdsorption -
      halogenCf3Relief -
      intraHbondReliefSiO2;

    demand =
      0.04 +
      Math.min(0.55, profile.tpsa * 0.0044) +
      profile.hbd * 0.062 +
      Math.max(0, profile.hba - 1) * 0.018 +
      Math.min(0.22, profile.azoleCount * 0.040) +
      Math.min(0.14, basicAzoleN * basicityAtten * 0.045) +
      Math.min(0.18, nhBasicAzole * 0.095) +
      profile.pyridineCount * basicityAtten * 0.055 +
      functionalGroupDemand -
      lipophilicityOffset +
      demandShift +
      featureDelta;
  }

  // Continuous empirical mixture selectivity adjustments (derived from Kamlet-Taft alpha/beta/pi*, LSER & aromaticMix)
  const desc = system.descriptors;
  const aromMix = desc?.aromaticMix ?? (system.family === 'meoh_toluene' ? 0.92 : 0);
  if (aromMix > 0.15) {
    // Aromatic pi-pi competition reduces retention of aromatic rings relative to aliphatic H-bonders
    const aromScale = Math.min(1.05, aromMix / 0.9);
    demand -= Math.min(0.115, profile.aromaticRings * 0.032 * aromScale);
  }
  if (system.family === 'acetone_hex' || system.composition?.strongSolvent === 'Acetone') {
    // Acetone carbonyl competes selectively against HBD, phenols, primary amides & ureas relative to EtOAc
    const betaScale = desc ? Math.min(1.12, 0.55 + desc.betaMix * 1.35) : 1.0;
    demand -= Math.min(0.105, (profile.hbd * 0.028 + (primAmide + urea + phenol) * 0.02) * betaScale);
  } else if (system.family === 'mtbe_hex' || system.composition?.strongSolvent === 'MTBE') {
    // Pure ether HBA (beta=0.49, low pi*=0.27): lifts HBD solutes selectively while retaining non-HBD dipolar aromatics slightly tighter than EtOAc
    const betaScale = desc ? Math.min(1.15, 0.6 + desc.betaMix * 1.25) : 1.0;
    const hbdLift = Math.min(0.085, ((profile.lser?.A ?? profile.hbd * 0.42) * 0.065 + (phenol + primAmide) * 0.015) * betaScale);
    const dipolarHold = profile.hbd === 0 ? Math.min(0.03, (profile.lser?.S ?? 0) * 0.015) : 0;
    demand -= hbdLift - dipolarHold;
  } else if (system.family === 'meoh_etoac' || (desc && desc.alcoholPct > 0 && desc.betaMix >= 0.44)) {
    demand -= Math.min(0.08, profile.hbd * 0.022 + profile.hba * 0.008 + (primAmide + urea) * 0.018);
  } else if (
    system.family === 'etoac_dcm' ||
    (desc && desc.piStarMix >= 0.72 && desc.alcoholPct === 0 && desc.aromaticMix === 0)
  ) {
    demand -= Math.min(0.06, profile.aromaticRings * 0.02);
  } else if ((system.family === 'meoh_dcm' || (desc && desc.alphaMix >= 0.22)) && (urea > 0 || primAmide > 0)) {
    // MeOH/DCM disrupts amide/urea H-bond dimers noticeably better than neat EtOAc
    const dimerScale = desc ? Math.min(1.15, Math.max(0.65, desc.alphaMix / 0.35)) : 1.0;
    demand -= Math.min(0.065, (urea * 0.035 + primAmide * 0.025) * dimerScale);
  }

  // PRISMA ternary & continuous Abraham LSER cross-selectivity:
  // blends dipolar pi* (split non-HBD carbonyl/aromatic dipoles) + beta HBA competition against LSER A/B/S
  if (system.family === 'prisma_ternary' && desc && profile.lser) {
    const dipolarPull = Math.max(0, desc.piStarMix - 0.32) * (profile.lser.S * 0.032 + profile.lser.E * 0.018);
    const hbdPull = Math.max(0, desc.betaMix - 0.16) * profile.lser.A * 0.038;
    demand -= Math.max(-0.04, Math.min(0.08, dipolarPull + hbdPull));
  }

  let tailing = false;
  let tailingReason: string | undefined;
  let mildStreak = false;

  if (isAlumina) {
    // Alumina lacks acidic Si-OH groups, freeing basic amines/guanidines/pyridines without Et3N
    if (profile.aliphAmineCount > 0) {
      if (isBasicAlumina) {
        demand += Math.min(0.13, profile.aliphAmineCount * 0.05);
      } else {
        demand += Math.min(0.18, profile.aliphAmineCount * 0.085);
        if (profile.aliphAmineCount >= 2 && profile.hbd >= 3 && system.alcoholPct === 0 && !system.baseModifier) {
          tailing = true;
          tailingReason = 'Poly-amine/guanidine can streak on Neutral Al₂O₃ in aprotic eluent — add MeOH or use Basic Al₂O₃';
        }
      }
    }

    // Well acid/salt effects: Basic Al2O3 neutralizes acid/salt at the origin up to ~1.25 eq;
    // Neutral Al2O3 gives protonation retention & tailing under strong or stoichiometric acid loads.
    if (wellAcid.hasAcidEffect) {
      if (isBasicAlumina) {
        const cap = wellAcid.acidStrength === 'strong_nonvolatile' ? 1.25 : 1.55;
        const overload = Math.max(0, wellAcid.acidStress - cap);
        if (overload > 0) {
          demand += Math.min(0.10, 0.03 + overload * 0.14);
          mildStreak = true;
          tailingReason = `High ${wellAcid.label} (${wellAcid.acidLoad.toFixed(1)} eq) loading may leave slight residual drag on Basic Al₂O₃`;
        }
      } else {
        demand += Math.min(0.18, 0.04 + 0.10 * wellAcid.acidStress);
        if (profile.aliphAmineCount > 0 || wellAcid.acidStress >= 0.60) {
          tailing = true;
          tailingReason = `${wellAcid.label} (${wellAcid.acidLoad.toFixed(1)} eq) in well protonates N-base on Neutral Al₂O₃ — try Basic Al₂O₃ or 2M NH₃/MeOH`;
        } else {
          mildStreak = true;
          tailingReason = `Trace ${wellAcid.label} protonation on Neutral Al₂O₃ — Basic Al₂O₃ buffers cleaner`;
        }
      }
    }

    // Carboxylic acids bind strongly / smear on alumina (especially Basic Al2O3) and AcOH strips the support
    if (profile.carboxylicAcidCount > 0) {
      demand += Math.min(0.75, 0.42 + profile.carboxylicAcidCount * 0.24);
      tailing = true;
      tailingReason = isBasicAlumina
        ? 'Carboxylic acid pins/tails on Basic Al₂O₃ — switch to SiO₂ (+ 1% AcOH) or C18'
        : 'Carboxylic acid pins/tails on Neutral Al₂O₃ — switch to SiO₂ (+ 1% AcOH) or C18';
    }
  } else {
    // Aliphatic amines / guanidines / amidines pin tightly to silanols unless base modifier is present
    if (profile.aliphAmineCount > 0) {
      if (system.baseModifier) {
        const isNh3 = system.baseModifier.includes('NH₃');
        demand += Math.min(isNh3 ? 0.14 : 0.17, profile.aliphAmineCount * (isNh3 ? 0.055 : 0.07));
      } else {
        demand += Math.min(0.58, 0.30 + profile.aliphAmineCount * 0.16);
        if (system.acidModifier) demand += 0.08;
        tailing = true;
        tailingReason = system.acidModifier
          ? 'Acidic modifier protonates basic amine — use Et₃N or NH₃-MeOH'
          : 'Basic amine pins/tails without Et₃N or NH₃-MeOH';
      }
    } else if (profile.azoleCount >= 3 && system.alcoholPct === 0 && !system.baseModifier) {
      tailing = true;
      tailingReason = 'Multi-azole H-bonding may streak in aprotic solvent';
    }

    // Reaction-well acid additives or salt counterions protonate basic N-sites;
    // 1% Et3N (~72 mM, partly consumed by Si-OH silanols) has finite capacity and cannot fully neutralize
    // stoichiometric strong non-volatile acids (TsOH, MsOH, TfOH) on basic/poly-basic spots.
    if (wellAcid.hasAcidEffect) {
      const isNh3 = desc ? desc.modifierKind === 'base_nh3' : Boolean(system.baseModifier?.includes('NH₃'));
      const isEt3n = desc ? desc.modifierKind === 'base_et3n' : Boolean(system.baseModifier && !isNh3);
      const modCap = desc?.modifierCapacity;

      if (!system.baseModifier) {
        demand += Math.min(0.46, 0.12 + 0.24 * wellAcid.acidStress);
        if (system.acidModifier) demand += 0.04;
        tailing = true;
        if (!tailingReason) {
          tailingReason =
            wellAcid.acidLoad >= 0.4 && wellAcid.acidStrength === 'strong_nonvolatile'
              ? `${wellAcid.label} (${wellAcid.acidLoad.toFixed(1)} eq) protonates basic N-sites into non-volatile salts — use 2M NH₃/MeOH, Basic Al₂O₃, or pre-neutralize`
              : `${wellAcid.label}/salt in well protonates N-base — add Et₃N or NH₃-MeOH`;
        }
      } else if (isEt3n) {
        const baseCap = modCap && modCap > 0 ? modCap : 0.46;
        const et3nCap =
          wellAcid.acidStrength === 'strong_nonvolatile'
            ? baseCap
            : wellAcid.acidStrength === 'strong_volatile'
            ? baseCap * (0.65 / 0.46)
            : baseCap * (1.10 / 0.46);
        const preCapCoeff =
          wellAcid.acidStrength === 'strong_nonvolatile'
            ? 0.24
            : wellAcid.acidStrength === 'strong_volatile'
            ? 0.14
            : 0;
        const preCapDrag = preCapCoeff > 0 ? Math.min(0.14, wellAcid.acidStress * preCapCoeff) : 0;
        const overload = Math.max(0, wellAcid.acidStress - et3nCap);
        demand += preCapDrag;
        if (overload > 0) {
          demand += Math.min(0.24, 0.04 + overload * 0.28);
          if (overload >= 0.12) {
            tailing = true;
            if (!tailingReason) {
              tailingReason = `1% Et₃N may not fully neutralize ${wellAcid.label} (${wellAcid.acidLoad.toFixed(1)} eq) & silica Si–OH — try 2M NH₃/MeOH, Basic Al₂O₃, or pre-neutralize`;
            }
          } else {
            mildStreak = true;
            if (!tailingReason) {
              tailingReason = `Residual ${wellAcid.label} salt may streak in 1% Et₃N — 2M NH₃/MeOH or Basic Al₂O₃ neutralizes cleaner`;
            }
          }
        } else if (wellAcid.acidStrength === 'strong_nonvolatile' && wellAcid.acidStress >= 0.40) {
          mildStreak = true;
          if (!tailingReason) {
            tailingReason = `Catalytic ${wellAcid.label} (${wellAcid.acidLoad.toFixed(1)} eq) salt can leave slight baseline drag in 1% Et₃N — 2M NH₃/MeOH runs sharper`;
          }
        }
      } else if (isNh3) {
        const baseCap = modCap && modCap > 0 ? modCap : 0.95;
        const nh3Cap =
          wellAcid.acidStrength === 'strong_nonvolatile' ? baseCap : baseCap * (1.25 / 0.95);
        const preCapDrag =
          wellAcid.acidStrength === 'strong_nonvolatile' ? Math.min(0.05, wellAcid.acidStress * 0.04) : 0;
        const overload = Math.max(0, wellAcid.acidStress - nh3Cap);
        demand += preCapDrag;
        if (overload > 0) {
          demand += Math.min(0.14, 0.025 + overload * 0.18);
          if (overload >= 0.35) {
            tailing = true;
            if (!tailingReason) {
              tailingReason =
                baseCap < 1.2
                  ? `Excess ${wellAcid.label} (${wellAcid.acidLoad.toFixed(1)} eq) can overload ${system.baseModifier || '2% (2M NH₃/MeOH)'} — use 4% (2M NH₃/MeOH), Basic Al₂O₃, or pre-neutralize`
                  : `Excess ${wellAcid.label} (${wellAcid.acidLoad.toFixed(1)} eq) can overload ${system.baseModifier || '4% NH₃/MeOH'} — use Basic Al₂O₃ or pre-neutralize`;
            }
          } else {
            mildStreak = true;
            if (!tailingReason) {
              tailingReason = `High ${wellAcid.label} (${wellAcid.acidLoad.toFixed(1)} eq) loading may leave slight residual drag even in ${system.baseModifier || '2M NH₃/MeOH'}`;
            }
          }
        }
      }
    }

    // Carboxylic acids dimerize & streak unless AcOH modifier is present;
    // excess strong non-volatile base (KOH, DBU, Cs2CO3 >= 1.2 eq) can overwhelm 1% AcOH too.
    if (profile.carboxylicAcidCount > 0) {
      const baseLoad = Math.max(0, wellCtx?.baseLoadEq ?? (wellCtx?.hasBaseAdditive ? 0.3 : 0));
      const baseSeverity = wellCtx?.baseStrength === 'strong' ? 1.0 : 0.45;
      if (system.acidModifier) {
        demand += Math.min(0.18, profile.carboxylicAcidCount * 0.08);
        if (wellCtx?.hasBaseAdditive && baseLoad * baseSeverity >= 0.95) {
          const baseOverload = Math.min(0.14, (baseLoad * baseSeverity - 0.95) * 0.10 + 0.04);
          demand += baseOverload;
          mildStreak = true;
          if (!tailingReason) {
            tailingReason = `1% AcOH may not fully acidify excess ${wellCtx.additiveLabel || 'base'} (${baseLoad.toFixed(1)} eq) — pre-acidify or use C18`;
          }
        }
      } else {
        demand += Math.min(0.55, 0.28 + profile.carboxylicAcidCount * 0.15);
        if (wellCtx?.hasBaseAdditive) {
          demand += Math.min(0.22, 0.08 + 0.10 * baseLoad * baseSeverity);
        }
        tailing = true;
        tailingReason = wellCtx?.hasBaseAdditive
          ? `${wellCtx.additiveLabel || 'Base'} (${baseLoad.toFixed(1)} eq) in well deprotonates carboxylic acid — add AcOH modifier`
          : 'Carboxylic acid tails without AcOH';
      }
    }

    // Free boronic acids (-B(OH)2 / hemiesters) smear on unmodified silica without MeOH + AcOH
    if (boronic > 0) {
      if (system.acidModifier || system.alcoholPct >= 7) {
        demand += Math.min(0.20, boronic * 0.11);
      } else {
        demand += Math.min(0.38, 0.18 + boronic * 0.15);
        tailing = true;
        if (!tailingReason) {
          tailingReason = 'Free boronic acid can streak on SiO₂ — add MeOH/AcOH or use C18';
        }
      }
    }
  }

  // Quaternary ammonium / permanently charged N & internal zwitterions (e.g. amino acids) pin near baseline on normal-phase plates
  if (quat > 0) {
    demand += Math.min(0.85, 0.58 + quat * 0.24);
    if (!(system.alcoholPct >= 10 && system.baseModifier)) {
      tailing = true;
      if (!tailingReason) {
        tailingReason = 'Quaternary/charged N pins on normal phase — use 12% MeOH/DCM + NH₃ or C18';
      }
    }
  } else if (isInternalZwitterion) {
    // Internal zwitterion (amine + carboxylic/phosphonic acid) has high ionic polarity even in modified eluents
    demand += system.alcoholPct >= 10 && (system.baseModifier || system.acidModifier) ? 0.34 : 0.58;
    tailing = true;
    tailingReason = 'Internal zwitterion (amine + acid) pins/tails on normal phase — prefer C18 RP (+ 0.1% TFA)';
  }

  // Protic MeOH competes strongly against normal-phase H-bonding (including primary amides & ureas)
  const proticSites = profile.hbd + basicAzoleN * 0.20 + primAmide * 0.45 + urea * 0.6;
  const proticBoost =
    system.alcoholPct > 0
      ? Math.min(0.18, system.alcoholPct * 0.0105 * Math.max(0.4, proticSites * 0.45))
      : 0;

  const effectiveStrength = system.strength + proticBoost;
  const rawDispN = profile.lser?.displacementN ?? 1.0;
  // Compact non-polar solutes (no HBD, TPSA < 12, HBA <= 1 like benzyl bromide/aryl halides) partition negligibly
  // into polar eluents and run straight with the solvent front instead of being flattened down to ~0.94.
  const isApolarMobile = profile.tpsa < 12 && profile.hbd === 0 && profile.hba <= 1;
  const effDispN =
    effectiveStrength > demand
      ? isApolarMobile && effectiveStrength >= 0.35
        ? Math.max(1.18, rawDispN)
        : Math.max(1.0, rawDispN)
      : rawDispN;
  const z = Math.max(-12, Math.min(12, 6.2 * demandSlope * effDispN * (effectiveStrength - demand)));
  let rawRf = 1 / (1 + Math.exp(-z));

  // Geiss secondary solvent-front (beta-front) demixing compression on dry SiO2 plates:
  // applies ONLY to H-bonding/amine/acid polar solutes (demand >= 0.32) that depend on adsorbed MeOH to move,
  // never artificially dragging non-HBD lipophilic azoles/ketones down out of the front band.
  if (!isAlumina && desc?.betaFrontCeiling !== undefined) {
    const freeHbd = Math.max(0, profile.hbd - intraOh);
    const effectivePolarDemand = demand + (freeHbd > 0 ? intraHbondReliefSiO2 * 0.65 : 0);
    const isAlcoholDependent =
      effectivePolarDemand >= 0.32 &&
      (freeHbd >= 1 ||
        profile.aliphAmineCount >= 1 ||
        primAmide >= 1 ||
        urea >= 1 ||
        profile.carboxylicAcidCount >= 1);
    const betaCap = desc.betaFrontCeiling;
    const knee = betaCap - 0.06;
    if (isAlcoholDependent && rawRf > knee) {
      const excess = rawRf - knee;
      const headroom = Math.max(0.04, betaCap - knee);
      rawRf = knee + headroom * (excess / (excess + headroom * 0.45));
    }
  }

  const rf = Math.round(Math.max(0.02, Math.min(0.99, rawRf)) * 100) / 100;

  // In practice 2M NH₃/MeOH suppresses amine streaking better than Et₃N, so Et₃N eluents keep a tiny penalty
  // for basic amines (a tie-break only: NH₃ is listed first when equal; the card also offers the "or" swap).
  if (!tailing && !mildStreak && profile.aliphAmineCount > 0 && !!system.baseModifier?.includes('Et₃N')) {
    mildStreak = true;
  }

  const rfSigma = computeSpotRfSigma(profile, system, tailing, mildStreak, wellAcid.acidStress, baseSigma, familyCalibrated);
  return { rf, rfSigma, tailing, tailingReason, mildStreak };
}

/** Backwards-compatible alias for predictTlcRf */
export const predictNormalPhaseRf = predictTlcRf;

// Low-confidence products are unlikely to be on the plate; they count for little so they cannot crowd the choice.
export const DEFAULT_LOW_TIER_WEIGHT = 0.2;

function tierImportance(tier: PredictedSpecies['tier']): number {
  if (tier === 'High') return 1.65;
  if (tier === 'Medium') return 1.05;
  if (tier === 'Low') return 0.42;
  return 0.12;
}

function windowScore(rf: number): number {
  if (rf >= 0.22 && rf <= 0.68) return 1.0;
  if (rf >= 0.14 && rf < 0.22) return 0.55 + ((rf - 0.14) / 0.08) * 0.45;
  if (rf > 0.68 && rf <= 0.82) return 1.0 - ((rf - 0.68) / 0.14) * 0.48;
  if (rf >= 0.07 && rf < 0.14) return 0.15 + ((rf - 0.07) / 0.07) * 0.4;
  if (rf > 0.82 && rf <= 0.90) return 0.22 + ((0.90 - rf) / 0.08) * 0.3;
  return 0.05;
}

/**
 * Starting-material tracking window: chemists only need a crisp SM spot cleanly off the
 * origin and below the solvent front (Rf ~0.16-0.83). Front-blown SMs (>0.85) lose tracking credit.
 */
function smWindowScore(rf: number): number {
  if (rf >= 0.16 && rf <= 0.74) return 1.0;
  if (rf >= 0.10 && rf < 0.16) return 0.58 + ((rf - 0.10) / 0.06) * 0.42;
  if (rf > 0.74 && rf <= 0.83) return 1.0 - ((rf - 0.74) / 0.09) * 0.38;
  if (rf > 0.83 && rf <= 0.89) return 0.14 + ((0.89 - rf) / 0.06) * 0.48;
  if (rf >= 0.06 && rf < 0.10) return 0.16 + ((rf - 0.06) / 0.04) * 0.42;
  return 0.04;
}

// Rf predictions are hand-tuned guesses (error roughly +-0.12), so separation is scored as the
// probability that two spots really are apart, not as a point estimate of the gap.
export const RF_SIGMA = 0.12;

/** A well counts as resolved when its (set) score reaches this value; shared by the engine and the UI. */
export const RESOLVED_SCORE = 0.55;

/** A plate-tailored eluent only joins the pool if it beats the best standard eluent by this much for a well. */
const DYNAMIC_MIN_GAIN = 0.05;
const RF_MIN_VISIBLE_GAP = 0.03;

function erf(x: number): number {
  const sign = x < 0 ? -1 : 1;
  const ax = Math.abs(x);
  const t = 1 / (1 + 0.3275911 * ax);
  const y =
    1 -
    (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) *
      t *
      Math.exp(-ax * ax);
  return sign * y;
}

function deltaScore(deltaRf: number, sigma: number = RF_SIGMA, minGap: number = RF_MIN_VISIBLE_GAP): number {
  const z = (Math.abs(deltaRf) - minGap) / (Math.max(0.05, sigma) * Math.SQRT2);
  const p = 0.5 * (1 + erf(z));
  return Math.max(0.03, Math.min(1, p));
}

/** Effective chromatographic spot width in Rf units (diffusional broadening + tailing smear) */
function spotWidthRf(spot: Pick<SimulatedSpot, 'rf' | 'tailing' | 'mildStreak'>): number {
  const base = 0.022 + 0.018 * Math.max(0, Math.min(1, spot.rf));
  return spot.tailing ? base * 2.2 : spot.mildStreak ? base * 1.35 : base;
}

function pairDeltaSigma(a: Pick<SimulatedSpot, 'rfSigma'>, b: Pick<SimulatedSpot, 'rfSigma'>, fallback: number): number {
  const sa = a.rfSigma ?? fallback;
  const sb = b.rfSigma ?? fallback;
  // Pair difference sigma normalized to single-spot scale used by deltaScore
  return Math.hypot(sa, sb) / Math.SQRT2;
}

function systemUsesAcetone(system: TlcSolventSystemDef): boolean {
  return (
    system.family === 'acetone_hex' ||
    system.composition?.strongSolvent === 'Acetone' ||
    system.composition?.ternaryCoSolvent?.solvent === 'Acetone'
  );
}

function systemUsesMeOH(system: TlcSolventSystemDef): boolean {
  return (
    /MeOH/i.test(system.name || '') ||
    system.composition?.strongSolvent === 'MeOH' ||
    system.composition?.ternaryCoSolvent?.solvent === 'MeOH' ||
    Boolean(system.baseModifier?.includes('NH₃'))
  );
}

interface WellCandidateData {
  wellIndex: number;
  wellCoord: string;
  importanceWeight: number;
  hasHighOrMed: boolean;
  needsBasicMod: boolean;
  needsAcidMod: boolean;
  wellCtx: WellTlcContext;
  substrates: Array<{ code: string; name: string; smiles: string; formula: string; profile: TlcMolProfile }>;
  products: Array<{
    key: string;
    smiles: string;
    formula: string;
    score: number;
    tier: PredictedSpecies['tier'];
    weight: number;
    label: string;
    profile: TlcMolProfile;
    persistence: number;
    reversibleEnd: boolean;
  }>;
}

function calibrationPhaseKeyForSystem(
  system: TlcSolventSystemDef,
  stationaryPhasePref: TlcStationaryPhasePreference
): ConcreteStationaryPhase {
  return resolveSystemPhase(system, stationaryPhasePref);
}

function resolveCalibrationOffsets(
  calibration: TlcCalibrationModel | undefined,
  system: TlcSolventSystemDef,
  stationaryPhasePref: TlcStationaryPhasePreference
): {
  demandShift: number;
  demandSlope: number;
  sigma: number;
  featureWeights?: TlcCalibrationFeatureWeights;
  familyCalibrated: boolean;
} {
  if (!calibration) return { demandShift: 0, demandSlope: 1.0, sigma: RF_SIGMA, familyCalibrated: false };
  const pKey = calibrationPhaseKeyForSystem(system, stationaryPhasePref);
  const fit = calibration.byPhase[pKey];
  const evidence = (fit?.pairedSpotCount ?? 0) + (fit?.frontCensoredCount ?? 0) + (fit?.baselineCensoredCount ?? 0);
  const hasPlateLevel = Boolean(fit?.plateLevelFamilies && Object.keys(fit.plateLevelFamilies).length > 0);
  if (!fit || (evidence === 0 && !hasPlateLevel)) {
    return { demandShift: 0, demandSlope: 1.0, sigma: RF_SIGMA, familyCalibrated: false };
  }
  const famShift = fit.familyDemandShifts[system.family] ?? 0;
  const famStats = fit.familyStats?.[system.family];
  const familyCalibrated = Boolean(famStats && famStats.pairedCount >= 6);
  return {
    demandShift: fit.globalDemandShift + famShift,
    demandSlope: fit.demandSlope ?? 1.0,
    sigma: fit.calibratedSigma || RF_SIGMA,
    featureWeights: fit.featureWeights,
    familyCalibrated,
  };
}

interface WellSolventEvaluation {
  score: number;
  deltaRf: number;
  bestProductRf: number | null;
  spots: SimulatedSpot[];
  smReadability: number[];
  prodReadability: number[];
  reactiveWarning?: string;
}

function evaluateWellInSolvent(
  well: WellCandidateData,
  system: TlcSolventSystemDef,
  stationaryPhasePref: TlcStationaryPhasePreference = 'auto',
  calibration?: TlcCalibrationModel
): WellSolventEvaluation {
  const resolvedPhase = resolveSystemPhase(system, stationaryPhasePref);
  const { demandShift, demandSlope, sigma, featureWeights, familyCalibrated } = resolveCalibrationOffsets(
    calibration,
    system,
    resolvedPhase
  );
  const usesAcetone = systemUsesAcetone(system);
  const usesMeOH = systemUsesMeOH(system);
  let reactiveWarning: string | undefined;

  const checkReactive = (prof: TlcMolProfile): { factor: number; reason?: string } => {
    if (usesAcetone && prof.acetoneReactiveLabel) {
      const reason = `Acetone can condense with ${prof.acetoneReactiveLabel} on silica (imine/hydrazone artefact)`;
      if (!reactiveWarning) reactiveWarning = reason;
      return { factor: 0.45, reason };
    }
    if (usesMeOH && prof.meohReactiveLabel) {
      const reason = `MeOH can methanolyse reactive ${prof.meohReactiveLabel} on the plate`;
      if (!reactiveWarning) reactiveWarning = reason;
      return { factor: 0.40, reason };
    }
    return { factor: 1.0 };
  };

  const subReactiveFactors: number[] = [];
  const subSpots: SimulatedSpot[] = well.substrates.map((s) => {
    const pred = predictTlcRf(
      s.profile,
      system,
      well.wellCtx,
      resolvedPhase,
      demandShift,
      demandSlope,
      featureWeights,
      sigma,
      familyCalibrated
    );
    const rx = checkReactive(s.profile);
    subReactiveFactors.push(rx.factor);
    return {
      kind: 'substrate',
      label: s.name || s.code,
      code: s.code,
      smiles: s.smiles,
      formula: s.formula,
      rf: pred.rf,
      rfSigma: pred.rfSigma,
      tailing: pred.tailing,
      tailingReason: pred.tailingReason || rx.reason,
      uvActive: s.profile.uvActive,
      mayDecompose: rx.factor < 1,
      mildStreak: pred.mildStreak,
    };
  });

  const prodReactiveFactors: number[] = [];
  const prodSpots: SimulatedSpot[] = well.products.map((p, idx) => {
    const pred = predictTlcRf(
      p.profile,
      system,
      well.wellCtx,
      resolvedPhase,
      demandShift,
      demandSlope,
      featureWeights,
      sigma,
      familyCalibrated
    );
    const rx = checkReactive(p.profile);
    prodReactiveFactors.push(rx.factor);
    return {
      kind: 'product',
      label: p.label || `Product #${idx + 1}`,
      code: `#${idx + 1}`,
      smiles: p.smiles,
      formula: p.formula,
      rf: pred.rf,
      rfSigma: pred.rfSigma,
      score: p.score,
      tier: p.tier,
      tailing: pred.tailing,
      tailingReason: pred.tailingReason || rx.reason,
      uvActive: p.profile.uvActive,
      mayDecompose: (system.stationaryPhase === 'SiO2' && p.reversibleEnd && p.persistence < 0.6) || rx.factor < 1,
      mildStreak: pred.mildStreak,
    };
  });

  // Penalize unneeded or mismatched mobile-phase additives on SiO2 / Al2O3
  let additiveOverheadFactor = 1.0;
  if (system.stationaryPhase === 'SiO2') {
    if (system.baseModifier) {
      if (well.needsAcidMod && !well.needsBasicMod) {
        additiveOverheadFactor = 0.80;
      } else if (!well.needsBasicMod) {
        additiveOverheadFactor = 0.93;
      }
    } else if (system.acidModifier) {
      if (well.needsBasicMod && !well.needsAcidMod) {
        additiveOverheadFactor = 0.80;
      } else if (!well.needsAcidMod) {
        additiveOverheadFactor = 0.93;
      }
    }
  }

  // Per-SM readability on THIS plate (gates front blow-out, baseline pinning, tailing, spot-width SM-SM co-elution, and reactivity)
  const smReadability: number[] = subSpots.map((sSpot, si) => {
    let worstSmSep = 1.0;
    for (let sj = 0; sj < subSpots.length; sj++) {
      if (sj === si) continue;
      if (sSpot.uvActive !== false && subSpots[sj].uvActive !== false) {
        const d = Math.abs(sSpot.rf - subSpots[sj].rf);
        const minGap = 0.5 * (spotWidthRf(sSpot) + spotWidthRf(subSpots[sj]));
        const pSigma = pairDeltaSigma(sSpot, subSpots[sj], sigma);
        const sep = deltaScore(d, pSigma, minGap);
        if (sep < worstSmSep) worstSmSep = sep;
      }
    }
    const smOverlapFactor = subSpots.length > 1 ? 0.68 + 0.32 * worstSmSep : 1.0;
    const smTailFactor = sSpot.tailing ? 0.50 : sSpot.mildStreak ? 0.92 : 1.0;
    const smVisFactor = sSpot.uvActive === false ? 0.55 : 1.0;
    return (
      smWindowScore(sSpot.rf) *
      smOverlapFactor *
      smTailFactor *
      smVisFactor *
      subReactiveFactors[si] *
      additiveOverheadFactor
    );
  });

  const trackIndices = subSpots
    .map((s, idx) => (s.uvActive !== false ? idx : -1))
    .filter((idx) => idx >= 0);
  const effTrack = trackIndices.length > 0 ? trackIndices : subSpots.map((_, idx) => idx);
  let smSum = 0;
  let smMin = 1;
  for (const idx of effTrack) {
    const r = smReadability[idx];
    smSum += r;
    if (r < smMin) smMin = r;
  }
  const smMean = effTrack.length > 0 ? smSum / effTrack.length : 1;
  const smCoverageSingle = effTrack.length > 0 ? 0.55 * smMean + 0.45 * smMin : 1;

  if (well.products.length === 0) {
    return {
      score: Math.round(smCoverageSingle * 1000) / 1000,
      deltaRf: 0,
      bestProductRf: null,
      spots: [...subSpots],
      smReadability,
      prodReadability: [],
      reactiveWarning,
    };
  }

  let wSum = 0;
  let scoreSum = 0;
  let bestQual = 0;
  let prodVisSum = 0;
  let primaryDelta = 0;
  let primaryRf: number | null = null;
  const prodReadability: number[] = new Array(well.products.length).fill(0);

  const STAIN_ONLY_FACTOR = 0.4; // no chromophore: needs a stain, cannot be judged under UV
  const DECOMPOSE_FACTOR = 0.7; // reversible product that may fall apart on acidic silica

  const visibleSubs = subSpots.filter((s) => s.uvActive !== false);
  // If no substrates are UV-active, compare against all substrates (stain view) instead of awarding a fake 0.25 gap
  const refSubs = visibleSubs.length > 0 ? visibleSubs : subSpots;

  well.products.forEach((p, idx) => {
    const pSpot = prodSpots[idx];
    let minSubDelta = 0.25;
    let worstSubSep = 1.0;
    if (refSubs.length > 0) {
      minSubDelta = Infinity;
      for (const s of refSubs) {
        const d = Math.abs(pSpot.rf - s.rf);
        if (d < minSubDelta) minSubDelta = d;
        const minGap = 0.5 * (spotWidthRf(pSpot) + spotWidthRf(s));
        const pSigma = pairDeltaSigma(pSpot, s, sigma);
        const sep = deltaScore(d, pSigma, minGap);
        if (sep < worstSubSep) worstSubSep = sep;
      }
      if (!Number.isFinite(minSubDelta)) minSubDelta = 0.25;
    }

    // Uncertainty- & width-aware product–product separation (smoothly replaces step cliffs)
    let crowdFactor = 1.0;
    const important = (t: PredictedSpecies['tier'] | undefined) => t === 'High' || t === 'Medium';
    for (let j = 0; j < idx; j++) {
      const other = prodSpots[j];
      const gap = Math.abs(pSpot.rf - other.rf);
      const minGap = 0.5 * (spotWidthRf(pSpot) + spotWidthRf(other));
      const pSigma = pairDeltaSigma(pSpot, other, sigma);
      const pSep = deltaScore(gap, pSigma, minGap);
      if (important(pSpot.tier) && important(other.tier)) {
        // Scales smoothly from 0.58 (overlapping) up to 1.0 (clearly resolved beyond spot widths + sigma)
        crowdFactor *= 0.58 + 0.42 * pSep;
      } else if (!(important(pSpot.tier) && !important(other.tier))) {
        // A Low-confidence neighbour does not spoil a likely product; peer-low overlap is mildly penalized
        crowdFactor *= 0.84 + 0.16 * pSep;
      }
    }

    const tailFactor = pSpot.tailing ? 0.52 : 1.0;
    const subTailPenalty = subSpots.some((s) => s.tailing) ? 0.88 : 1.0;
    const visFactor = pSpot.uvActive === false ? STAIN_ONLY_FACTOR : 1.0;
    const decompFactor =
      system.stationaryPhase === 'SiO2' && p.reversibleEnd && p.persistence < 0.6
        ? DECOMPOSE_FACTOR
        : 1.0;
    const rxFactor = prodReactiveFactors[idx];
    const hasMildWellOverload = pSpot.mildStreak && Boolean(pSpot.tailingReason);
    const hasSubMildWellOverload = subSpots.some((s) => s.mildStreak && Boolean(s.tailingReason));
    const mildStreakFactor = hasMildWellOverload
      ? 0.90
      : hasSubMildWellOverload
      ? 0.95
      : pSpot.mildStreak
      ? 0.98
      : 1.0;
    const qual =
      windowScore(pSpot.rf) *
      worstSubSep *
      tailFactor *
      subTailPenalty *
      crowdFactor *
      visFactor *
      decompFactor *
      rxFactor *
      mildStreakFactor *
      additiveOverheadFactor;

    prodReadability[idx] = qual;
    if (idx === 0) {
      primaryDelta = Math.round(minSubDelta * 100) / 100;
      primaryRf = pSpot.rf;
    }

    wSum += p.weight;
    scoreSum += p.weight * qual;
    prodVisSum += p.weight * windowScore(pSpot.rf) * (pSpot.tailing ? 0.65 : 1) * visFactor;
    if (p.weight > 0.0001 && qual > bestQual) bestQual = qual;
  });

  // Single-plate score blends product resolution with known SM visibility so a single tank cannot
  // hide front-blown starting materials behind speculative predicted products.
  const blendedQual = wSum > 0 ? 0.5 * (scoreSum / wSum) + 0.5 * bestQual : 0;
  const smGate = effTrack.length > 0 ? 0.45 + 0.55 * smCoverageSingle : 1;
  const prodVisGate = wSum > 0 ? 0.80 + 0.20 * (prodVisSum / wSum) : 1;

  return {
    score: Math.round(blendedQual * smGate * prodVisGate * 1000) / 1000,
    deltaRf: primaryDelta,
    bestProductRf: primaryRf,
    spots: [...subSpots, ...prodSpots],
    smReadability,
    prodReadability,
    reactiveWarning,
  };
}

function generateCombinations(n: number, k: number): number[][] {
  const out: number[][] = [];
  const cur: number[] = [];
  function backtrack(start: number) {
    if (cur.length === k) {
      out.push([...cur]);
      return;
    }
    for (let i = start; i <= n - (k - cur.length); i++) {
      cur.push(i);
      backtrack(i + 1);
      cur.pop();
    }
  }
  backtrack(0);
  return out;
}

function polarityBand(sys: TlcSolventSystemDef, stationaryPhasePref: TlcStationaryPhasePreference = 'auto'): string {
  const effPhase = resolveSystemPhase(sys, stationaryPhasePref);
  if (effPhase === 'C18') {
    if (stationaryPhasePref === 'C18' || stationaryPhasePref === 'all_equal') {
      if (sys.acidModifier) return 'c18_tfa';
      if (sys.strength < 0.35) return 'c18_aq';
      if (sys.strength < 0.65) return 'c18_med';
      return 'c18_org';
    }
    return 'c18';
  }
  const phasePrefix =
    stationaryPhasePref === 'all_equal' && effPhase !== 'SiO2' ? `${effPhase}_` : '';
  if (sys.baseModifier) return `${phasePrefix}${sys.strength < 0.65 ? 'basic_low_med' : 'basic_polar'}`;
  if (sys.acidModifier) return `${phasePrefix}${sys.strength < 0.65 ? 'acid_low_med' : 'acid_polar'}`;
  if (sys.strength < 0.35) return `${phasePrefix}low_np`;
  if (sys.strength < 0.65) return `${phasePrefix}med_np`;
  return `${phasePrefix}polar_np`;
}

function buildSystemPlanEntry(
  sys: TlcSolventSystemDef,
  rank: number,
  activeWellsCount: number,
  wellDataByIdx: Map<number, WellCandidateData>,
  sysMap: Map<number, ReturnType<typeof evaluateWellInSolvent>>,
  bestOwnerByWell: Map<number, string>,
  extra?: {
    uniqueWellIndices?: number[];
    stationaryPhasePref?: TlcStationaryPhasePreference;
    calibration?: TlcCalibrationModel;
  }
): RecommendedPlateSolvent {
  const PLATE_SIZE = 54;
  const assignedWellIndices: number[] = [];
  let resCount = 0;
  let highMedCount = 0;
  let scoreAccum = 0;
  let sigmaSum = 0;
  let sigmaCount = 0;
  let deltaSum = 0;
  let deltaCount = 0;
  const riskSummary: SolventRiskSummary = {
    tailingWells: 0,
    baselineWells: 0,
    frontWells: 0,
    coelutedWells: 0,
    stainOnlyWells: 0,
    reactiveWells: 0,
  };

  const lanes: SimulatedWellLane[] = [];
  for (let w = 0; w < PLATE_SIZE; w++) {
    const wData = wellDataByIdx.get(w);
    const evalRes = sysMap.get(w);
    if (!wData || !evalRes) {
      lanes.push({
        wellIndex: w,
        wellCoord: wellLabel(w),
        isBlank: true,
        isAssignedHere: false,
        hasHighOrMed: false,
        resolutionScore: 0,
        deltaRf: 0,
        bestProductRf: null,
        spots: [],
      });
      continue;
    }

    const isAssignedHere = bestOwnerByWell.get(w) === sys.id;
    if (isAssignedHere) assignedWellIndices.push(w);
    const isResolved = evalRes.score >= RESOLVED_SCORE;
    if (isResolved) {
      resCount++;
      if (wData.hasHighOrMed) highMedCount++;
      if (wData.products.length > 0 && evalRes.deltaRf > 0) {
        deltaSum += evalRes.deltaRf;
        deltaCount++;
      }
    }
    scoreAccum += evalRes.score;

    // Collect uncertainty and failure risks across assigned wells (or all active wells for solo cards)
    const countInRisk = bestOwnerByWell.size === 0 || isAssignedHere;
    if (countInRisk) {
      for (const sp of evalRes.spots) {
        if (typeof sp.rfSigma === 'number' && Number.isFinite(sp.rfSigma)) {
          sigmaSum += sp.rfSigma;
          sigmaCount++;
        }
      }
      if (evalRes.spots.some((sp) => sp.tailing)) riskSummary.tailingWells++;
      if (evalRes.spots.some((sp) => sp.rf <= 0.08)) riskSummary.baselineWells++;
      if (evalRes.spots.some((sp) => sp.rf >= 0.88)) riskSummary.frontWells++;
      if (evalRes.spots.some((sp) => sp.uvActive === false)) riskSummary.stainOnlyWells++;
      if (evalRes.reactiveWarning) riskSummary.reactiveWells++;
      if (!isResolved && wData.products.length > 0 && evalRes.deltaRf < 0.08) {
        riskSummary.coelutedWells++;
      }
    }

    lanes.push({
      wellIndex: w,
      wellCoord: wData.wellCoord,
      isBlank: false,
      isAssignedHere,
      hasHighOrMed: wData.hasHighOrMed,
      resolutionScore: evalRes.score,
      deltaRf: evalRes.deltaRf,
      bestProductRf: evalRes.bestProductRf,
      spots: evalRes.spots,
    });
  }

  const uniqueWellIndices = extra?.uniqueWellIndices ?? [];
  const uniqueWellCoords = uniqueWellIndices.map((idx) => wellLabel(idx));
  const meanRfSigma = sigmaCount > 0 ? Math.round((sigmaSum / sigmaCount) * 100) / 100 : RF_SIGMA;
  const meanProductDeltaRf = deltaCount > 0 ? Math.round((deltaSum / deltaCount) * 100) / 100 : 0;

  // Build concise plate-specific chemical rationale
  const rationaleParts: string[] = [];
  if (uniqueWellIndices.length > 0) {
    rationaleParts.push(
      `Uniquely resolves ${uniqueWellIndices.length} well${uniqueWellIndices.length > 1 ? 's' : ''} (${uniqueWellCoords.slice(0, 5).join(', ')}${uniqueWellCoords.length > 5 ? ', …' : ''})`
    );
  }
  const effPhase = resolveSystemPhase(sys, extra?.stationaryPhasePref ?? 'auto');
  if (effPhase === 'C18') {
    rationaleParts.push(
      extra?.stationaryPhasePref === 'all_equal'
        ? 'reverse-phase C18 separation for polar/ionizable or lipophilic species'
        : 'reverse-phase rescue for highly polar/ionic species'
    );
  } else if (effPhase === 'Al2O3_basic') {
    rationaleParts.push('Basic Al₂O₃ releases basic amines & azoles cleanly in neat organic eluent');
  } else if (effPhase === 'Al2O3_neutral') {
    rationaleParts.push('Neutral Al₂O₃ provides silanol-free separation in neat organic eluent');
  } else if (sys.baseModifier?.includes('NH₃')) {
    rationaleParts.push('2M NH₃/MeOH neutralizes protonated amines & azoles cleanly');
  } else if (sys.baseModifier) {
    rationaleParts.push('Et₃N deactivates silanols for basic heterocycles & amines');
  } else if (sys.acidModifier) {
    rationaleParts.push('AcOH sharpens carboxylic acids and suppresses dimer tailing');
  } else if (sys.family === 'prisma_ternary') {
    rationaleParts.push('PRISMA ternary selectivity breaks co-eluting regioisomers');
  } else if ((sys.descriptors?.aromaticMix ?? 0) >= 0.25) {
    rationaleParts.push('aromatic π–π selectivity separates aromatic heterocycles');
  } else if (sys.strength <= 0.30) {
    rationaleParts.push('mild polarity tracks lipophilic starting materials below the front');
  } else if (sys.strength >= 0.65) {
    rationaleParts.push('high eluent strength lifts polar H-bonding products off baseline');
  } else {
    rationaleParts.push('balanced mid-polarity separation across the plate');
  }
  const rationale = rationaleParts.join(' · ');

  // Calibration evidence backing this specific solvent family
  let evidenceSummary = `Uncalibrated model (±${meanRfSigma.toFixed(2)} Rf)`;
  if (extra?.calibration) {
    const pKey = calibrationPhaseKeyForSystem(sys, extra.stationaryPhasePref ?? 'auto');
    const phaseFit = extra.calibration.byPhase[pKey];
    const famStats = phaseFit?.familyStats?.[sys.family];
    if (famStats && famStats.pairedCount > 0) {
      const errTxt =
        phaseFit?.cvRmse !== undefined
          ? `CV ±${phaseFit.cvRmse.toFixed(2)}`
          : `RMSE ±${famStats.rmseAfter.toFixed(2)}`;
      evidenceSummary = `Calibrated on ${famStats.plateCount} ${sys.family.replace(/_/g, '/')} plate${famStats.plateCount > 1 ? 's' : ''} (${famStats.pairedCount} spots · ${errTxt})`;
    } else if (phaseFit && phaseFit.calibrationApplied && phaseFit.pairedSpotCount > 0) {
      const errTxt =
        phaseFit.cvRmse !== undefined
          ? `CV ±${phaseFit.cvRmse.toFixed(2)}`
          : `RMSE ±${phaseFit.rmseAfter.toFixed(2)}`;
      evidenceSummary = `Phase-calibrated (${pKey}, ${phaseFit.pairedSpotCount} spots · ${errTxt}; unseen family)`;
    }
  }

  return {
    system: sys,
    rank,
    assignedWellIndices,
    assignedWellCoords: assignedWellIndices.map((idx) => wellLabel(idx)),
    uniqueWellIndices,
    uniqueWellCoords,
    resolvedWellCount: resCount,
    highRankedResolvedCount: highMedCount,
    wellCoveragePct: activeWellsCount > 0 ? Math.round((resCount / activeWellsCount) * 100) : 0,
    meanResolutionScore: activeWellsCount > 0 ? Math.round((scoreAccum / activeWellsCount) * 100) / 100 : 0,
    meanRfSigma,
    meanProductDeltaRf,
    riskSummary,
    rationale,
    evidenceSummary,
    lanes,
  };
}

/**
 * Analyzes all 54 wells on the selected plate (prioritizing High & Medium ranked products)
 * and selects an optimal finite set of 2-4 complementary mobile phases, preferring primary workhorses
 * (EtOAc/Hexanes, MeOH/DCM, MeOH/DCM + Et3N, 2M NH3 in MeOH/DCM) while exposing secondary systems
 * (Acetone/Hexanes, MeOH/EtOAc, MeOH/Toluene, C18 RP, etc.) as complementary options.
 */
export async function optimizePlateTlcSolvents(
  rdkit: any,
  state: RunState,
  run: RunResult | null,
  triMeta: any[] = [],
  options: PlateSolventPlanOptions = {}
): Promise<PlateSolventPlanResult> {
  const PLATE_SIZE = 54;
  const plateIndex = options.plateIndex ?? 0;
  const requestedK = Math.max(1, Math.min(4, options.maxSystems ?? 3));
  const poolMode: SolventPoolMode = options.poolMode ?? 'prefer_primary';
  const stationaryPhasePref: TlcStationaryPhasePreference = options.stationaryPhase ?? 'auto';
  const includeSpeculative = options.includeSpeculative ?? false;
  const lowTierWeight = Math.max(0, Math.min(1, options.lowTierWeight ?? DEFAULT_LOW_TIER_WEIGHT));

  const rowMap = new Map<number, any>();
  if (run?.rows) {
    run.rows.forEach((r, idx) => {
      const p = r.plate_number ?? Math.floor(idx / PLATE_SIZE);
      if (p !== plateIndex) return;
      const w = r.container_id ?? idx % PLATE_SIZE;
      rowMap.set(w, r);
    });
  }

  const profileCache = new Map<string, TlcMolProfile>();
  const reactionMemo = new Map<string, WellPredictionResult | undefined>();
  const wellPredictions: Record<number, WellPredictionResult> = {};
  const wellDataByIdx = new Map<number, WellCandidateData>();

  const activeIndices: number[] = [];
  for (let w = 0; w < PLATE_SIZE; w++) {
    const r = rowMap.get(w) ?? run?.rows?.[plateIndex * PLATE_SIZE + w];
    if (!r) continue;
    const gIdx = r.global_index ?? plateIndex * PLATE_SIZE + w;
    if (state.mode === 'triplet' && triMeta[gIdx]?.blank) continue;
    if (r.recipe?.every((rc: any) => rc.target_concentration <= 0)) continue;
    activeIndices.push(w);
  }

  const nowMs = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());
  let lastYield = nowMs();
  const yieldIfFrameExceeded = async (force = false) => {
    if (options.signal?.aborted) {
      const err = new Error('TLC solvent optimization cancelled');
      err.name = 'AbortError';
      throw err;
    }
    const elapsed = nowMs() - lastYield;
    if (force || elapsed >= 16) {
      await new Promise((res) => setTimeout(res, 0));
      lastYield = nowMs();
      if (options.signal?.aborted) {
        const err = new Error('TLC solvent optimization cancelled');
        err.name = 'AbortError';
        throw err;
      }
    }
  };

  // 1. Gather or compute predictions for every active well on this 54-well plate
  for (let i = 0; i < activeIndices.length; i++) {
    if (options.signal?.aborted) {
      const err = new Error('TLC solvent optimization cancelled');
      err.name = 'AbortError';
      throw err;
    }
    const w = activeIndices[i];
    const r = rowMap.get(w) ?? run?.rows?.[plateIndex * PLATE_SIZE + w];
    const cacheKey = `${plateIndex}-${w}`;
    let pred = options.cachedPredictions?.[cacheKey];

    const ext = extractWellForPrediction(state, r, options.conditionOverrides);
    const validSubs = ext.substrates.filter((s) => s.smiles.trim().length > 0);

    if (!pred && rdkit && validSubs.length > 0) {
      const sig =
        validSubs
          .map((s) => `${s.code}:${s.smiles.trim()}:${Math.round(s.equivalents * 100) / 100}`)
          .sort()
          .join('|') +
        `@${ext.condition.medium}:${ext.condition.additiveName}:${Math.round(ext.condition.additiveEquiv * 100) / 100}:${ext.condition.temperatureC}:${ext.condition.waterPct}`;

      if (reactionMemo.has(sig)) {
        pred = reactionMemo.get(sig);
      } else {
        try {
          pred = predictWellReactions(rdkit, validSubs, ext.condition, {
            includeSpeculative,
            maxDepth: 4,
            maxExpansions: 60,
          });
        } catch {
          pred = undefined;
        }
        reactionMemo.set(sig, pred);
      }
    }

    if (pred) {
      wellPredictions[w] = pred;
    }

    const subsProfiles = (
      pred?.substrates ||
      validSubs.map((s) => ({
        code: s.code,
        name: s.name,
        neutralSmiles: s.smiles,
        formula: '',
        valid: true,
      }))
    )
      .filter((s: any) => s.valid !== false && (s.neutralSmiles || s.smiles))
      .map((s: any) => {
        const smi = s.neutralSmiles || s.smiles || '';
        return {
          code: s.code,
          name: s.name || s.code,
          smiles: smi,
          formula: s.formula || '',
          profile: profileMoleculeForTlc(rdkit, smi, profileCache),
        };
      });

    // One spot per compound: tautomers / mobile-H forms of the same structure run as a single spot.
    const seenForms = new Set<string>();
    const rawProds = (pred?.species || [])
      .filter((sp) => {
        const k = sp.tautomerKey || sp.key;
        if (seenForms.has(k)) return false;
        seenForms.add(k);
        return true;
      })
      .slice(0, 8);
    const products = rawProds.map((sp) => {
      // Weight each candidate product continuously by mechanistic confidence & step depth so
      // high-confidence primary adducts anchor the eluent choice over deep speculative cascades.
      const tierBase =
        sp.tier === 'High' ? 1.15 : sp.tier === 'Medium' ? 0.85 : lowTierWeight;
      const scoreFactor = 0.35 + 0.65 * Math.max(0.1, Math.min(1, sp.score ?? 0.5));
      const steps = sp.stepsCount ?? 1;
      const depthFactor = steps <= 2 ? 1.0 : steps === 3 ? 0.88 : 0.76;
      const imp = tierBase * scoreFactor * depthFactor;
      return {
        key: sp.key,
        smiles: sp.smiles,
        formula: sp.formula,
        score: sp.score,
        tier: sp.tier,
        weight: imp,
        label: sp.mechanismSummary || sp.formula,
        profile: profileMoleculeForTlc(rdkit, sp.smiles, profileCache),
        persistence: sp.persistence ?? 1,
        reversibleEnd: Boolean(sp.reversibleEnd),
      };
    });

    const hasHighOrMed = products.some((p) => p.tier === 'High' || p.tier === 'Medium');
    const importanceWeight = hasHighOrMed ? 1.0 : products.length > 0 ? 0.9 : 0.5;

    const wellCtx = buildWellTlcContext(ext, pred);

    const allProfiles = [...subsProfiles.map((s) => s.profile), ...products.map((p) => p.profile)];
    const hasStrongWellAcid = Boolean(wellCtx.hasAcidAdditive || wellCtx.hasSaltCounterion);
    const needsBasicMod =
      stationaryPhasePref === 'Al2O3_basic' || stationaryPhasePref === 'Al2O3_neutral'
        ? false
        : allProfiles.some(
            (prof) =>
              prof.aliphAmineCount > 0 ||
              prof.azoleCount >= 3 ||
              (hasStrongWellAcid &&
                (prof.pyridineCount > 0 ||
                  (prof.basicAzoleNCount ?? prof.azoleCount) > 0 ||
                  (prof.anilineCount ?? 0) > 0 ||
                  (prof.imineCount ?? 0) > 0))
          );
    const needsAcidMod =
      stationaryPhasePref === 'Al2O3_basic' || stationaryPhasePref === 'Al2O3_neutral'
        ? false
        : allProfiles.some((prof) => prof.carboxylicAcidCount > 0);

    wellDataByIdx.set(w, {
      wellIndex: w,
      wellCoord: wellLabel(w),
      importanceWeight,
      hasHighOrMed,
      needsBasicMod,
      needsAcidMod,
      wellCtx,
      substrates: subsProfiles,
      products,
    });

    options.onProgress?.(i + 1, activeIndices.length);
    await yieldIfFrameExceeded();
  }

  // 2. Compose plate-tailored dynamic candidates alongside core library & score across every active well
  const isAllEqual = stationaryPhasePref === 'all_equal';
  const cloneForAlumina = (
    sys: TlcSolventSystemDef,
    phase: 'Al2O3_neutral' | 'Al2O3_basic'
  ): TlcSolventSystemDef => ({
    ...sys,
    id: `${sys.id}__${phase === 'Al2O3_basic' ? 'al2o3_basic' : 'al2o3_neutral'}`,
    effectivePhase: phase,
  });

  const phaseFilter = (sys: TlcSolventSystemDef): boolean => {
    if (stationaryPhasePref === 'SiO2') return sys.stationaryPhase === 'SiO2';
    if (stationaryPhasePref === 'C18') return sys.stationaryPhase === 'C18';
    if (stationaryPhasePref === 'Al2O3_neutral' || stationaryPhasePref === 'Al2O3_basic') {
      return sys.stationaryPhase === 'SiO2' && !sys.acidModifier && !sys.baseModifier;
    }
    return true;
  };

  const baseFilteredLibrary = TLC_SOLVENT_LIBRARY.filter(phaseFilter);
  const phaseFilteredLibrary: TlcSolventSystemDef[] = isAllEqual
    ? [
        ...baseFilteredLibrary.map((s) => ({
          ...s,
          effectivePhase: (s.stationaryPhase === 'C18' ? 'C18' : 'SiO2') as ConcreteStationaryPhase,
        })),
        ...baseFilteredLibrary
          .filter((s) => s.stationaryPhase === 'SiO2' && !s.acidModifier && !s.baseModifier)
          .map((s) => cloneForAlumina(s, 'Al2O3_neutral')),
        ...baseFilteredLibrary
          .filter((s) => s.stationaryPhase === 'SiO2' && !s.acidModifier && !s.baseModifier)
          .map((s) => cloneForAlumina(s, 'Al2O3_basic')),
      ]
    : baseFilteredLibrary;

  const activeWells = activeIndices
    .map((w) => wellDataByIdx.get(w))
    .filter((x): x is WellCandidateData => Boolean(x && x.substrates.length > 0));

  const plateNeedsBasicMod = activeWells.some((w) => w.needsBasicMod);
  const plateNeedsAcidMod = activeWells.some((w) => w.needsAcidMod);
  const hasStrongWellAcid = activeWells.some(
    (w) => w.wellCtx.acidStrength === 'strong_nonvolatile' && (w.wellCtx.acidLoadEq ?? 0) >= 0.30
  );

  // Empirical plate descriptor aggregation: aromaticity, HBD, acid stress, and ideal target strengths
  let totalArom = 0;
  let totalHbd = 0;
  let molCount = 0;
  let maxAcidStress = 0;
  let maxAcidLabel: string | undefined;
  const wellBestStrengths: number[] = [];
  const wellSmTrackStrengths: number[] = [];

  for (const w of activeWells) {
    const allProfs = [...w.substrates.map((s) => s.profile), ...w.products.map((p) => p.profile)];
    for (const prof of allProfs) {
      totalArom += prof.aromaticRings;
      totalHbd += prof.hbd;
      molCount++;
      const stress = resolveWellAcidStress(prof, w.wellCtx);
      if (stress.hasAcidEffect && stress.acidStress > maxAcidStress) {
        maxAcidStress = stress.acidStress;
        maxAcidLabel = stress.label;
      }
    }
    // Estimate ideal eluent strength for this well AND ideal SM-tracking strength across baseline SiO2 library
    let wBestSc = -1;
    let wBestStr = 0.50;
    let wBestSmSc = -1;
    let wBestSmStr = 0.30;
    for (const cs of baseFilteredLibrary) {
      if (cs.stationaryPhase !== 'SiO2') continue;
      const ev = evaluateWellInSolvent(w, cs, stationaryPhasePref, options.calibration);
      if (ev.score > wBestSc) {
        wBestSc = ev.score;
        wBestStr = cs.strength;
      }
      if (ev.smReadability.length > 0) {
        const smMinHere = Math.min(...ev.smReadability);
        const smMeanHere = ev.smReadability.reduce((a, b) => a + b, 0) / ev.smReadability.length;
        const smMetric = 0.55 * smMeanHere + 0.45 * smMinHere;
        if (smMetric > wBestSmSc) {
          wBestSmSc = smMetric;
          wBestSmStr = cs.strength;
        }
      }
    }
    wellBestStrengths.push(wBestStr);
    wellSmTrackStrengths.push(wBestSmStr);
  }

  const meanAromaticRings = molCount > 0 ? Math.round((totalArom / molCount) * 100) / 100 : 0;
  const meanHbd = molCount > 0 ? Math.round((totalHbd / molCount) * 100) / 100 : 0;
  const aromaticHeavyPlate = meanAromaticRings >= 1.5;

  wellBestStrengths.sort((a, b) => a - b);
  wellSmTrackStrengths.sort((a, b) => a - b);
  const qIdx = (arr: number[], q: number) =>
    arr.length > 0
      ? arr[Math.min(arr.length - 1, Math.floor(q * (arr.length - 1)))]
      : 0.5;
  const rawTargets = [
    qIdx(wellSmTrackStrengths, 0.15),
    qIdx(wellBestStrengths, 0.15),
    qIdx(wellBestStrengths, 0.5),
    qIdx(wellBestStrengths, 0.85),
  ];
  const targetStrengths = Array.from(new Set(rawTargets.map((v) => Math.round(v * 20) / 20)));
  const targetStrengthMin = wellBestStrengths.length > 0 ? Math.min(wellBestStrengths[0], wellSmTrackStrengths[0] ?? wellBestStrengths[0]) : 0.25;
  const targetStrengthMax = wellBestStrengths.length > 0 ? wellBestStrengths[wellBestStrengths.length - 1] : 0.75;

  const coreIds = new Set(baseFilteredLibrary.map((s) => s.id));
  const compKey = (c?: {
    strongSolvent: string;
    weakSolvent: string;
    ternaryCoSolvent?: { solvent: string; pct: number };
    strongPct: number;
    modifierId: string;
  }) =>
    c
      ? `${c.strongSolvent}:${c.ternaryCoSolvent?.solvent ?? ''}:${c.ternaryCoSolvent?.pct ?? 0}:${c.weakSolvent}:${c.strongPct}:${c.modifierId}`
      : '';
  const seenCompKeys = new Set(baseFilteredLibrary.map((s) => compKey(s.composition)).filter(Boolean));

  const synthInput = {
    targetStrengths,
    aromaticHeavyPlate,
    hasStrongWellAcid,
    maxAcidStress,
    needsBasicMod: plateNeedsBasicMod,
    needsAcidMod: plateNeedsAcidMod,
  };

  const synthesizedSpecs =
    stationaryPhasePref === 'C18' ? [] : synthesizePlateTailoredSpecs(synthInput);

  const prismaSpecs =
    stationaryPhasePref === 'C18' ? [] : generatePrismaTernarySpecs(synthInput);

  const extendedSpecs = generateExtendedDynamicSpecs({
    hasStrongWellAcid,
    needsBasicMod: plateNeedsBasicMod,
    needsAcidMod: plateNeedsAcidMod,
    aromaticHeavyPlate,
  });

  const dynamicSystems: TlcSolventSystemDef[] = [];
  for (const spec of [...synthesizedSpecs, ...prismaSpecs, ...extendedSpecs]) {
    if (coreIds.has(spec.id)) continue;
    const ck = `${spec.strongSolvent}:${spec.ternaryCoSolvent?.solvent ?? ''}:${spec.ternaryCoSolvent?.pct ?? 0}:${spec.weakSolvent}:${spec.strongPct}:${spec.modifierId}`;
    if (seenCompKeys.has(ck)) continue;
    if (!validateEluentCompatibility(spec, isAllEqual ? 'auto' : stationaryPhasePref).valid) continue;
    const composed = composeSolventSystem(spec);
    if (!phaseFilter(composed)) continue;
    seenCompKeys.add(ck);
    if (isAllEqual) {
      dynamicSystems.push({
        ...composed,
        effectivePhase: composed.stationaryPhase === 'C18' ? 'C18' : 'SiO2',
      });
      if (
        composed.stationaryPhase === 'SiO2' &&
        !composed.acidModifier &&
        !composed.baseModifier &&
        validateEluentCompatibility(spec, 'Al2O3_neutral').valid
      ) {
        dynamicSystems.push(cloneForAlumina(composed, 'Al2O3_neutral'));
        dynamicSystems.push(cloneForAlumina(composed, 'Al2O3_basic'));
      }
    } else {
      dynamicSystems.push(composed);
    }
  }

  const allCandidateSystems = [...phaseFilteredLibrary, ...dynamicSystems];

  const evalMatrix = new Map<string, Map<number, ReturnType<typeof evaluateWellInSolvent>>>();
  for (const sys of allCandidateSystems) {
    const m = new Map<number, ReturnType<typeof evaluateWellInSolvent>>();
    for (const w of activeWells) {
      m.set(w.wellIndex, evaluateWellInSolvent(w, sys, stationaryPhasePref, options.calibration));
    }
    evalMatrix.set(sys.id, m);
    await yieldIfFrameExceeded();
  }

  // 3. Filter candidate search pool by poolMode and enrich with top plate-tailored dynamic candidates
  const isPrimaryEligible = (s: TlcSolventSystemDef) =>
    s.preferenceTier === 'primary' || (isAllEqual && s.stationaryPhase === 'C18');

  const corePool =
    stationaryPhasePref !== 'C18' && poolMode === 'primary_only'
      ? phaseFilteredLibrary.filter(isPrimaryEligible)
      : phaseFilteredLibrary;

  const eligibleDynamic =
    stationaryPhasePref !== 'C18' && poolMode === 'primary_only'
      ? dynamicSystems.filter(isPrimaryEligible)
      : dynamicSystems;

  const coreBestByWell = new Map<number, number>();
  for (const w of activeWells) {
    let best = 0;
    for (const cs of corePool) {
      const sc = evalMatrix.get(cs.id)?.get(w.wellIndex)?.score ?? 0;
      if (sc > best) best = sc;
    }
    coreBestByWell.set(w.wellIndex, best);
  }

  const rankedDynamic = eligibleDynamic
    .map((sys) => {
      const sysMap = evalMatrix.get(sys.id)!;
      let gainSum = 0;
      let improvedCount = 0;
      let totalScore = 0;
      for (const w of activeWells) {
        const sc = sysMap.get(w.wellIndex)!.score;
        totalScore += sc;
        const coreBest = coreBestByWell.get(w.wellIndex) ?? 0;
        if (sc > coreBest + DYNAMIC_MIN_GAIN) {
          improvedCount++;
          gainSum += sc - coreBest;
        }
      }
      const meanScore = activeWells.length > 0 ? totalScore / activeWells.length : 0;
      return { sys, improvedCount, gainSum, meanScore };
    })
    .filter((d) => d.improvedCount > 0 || d.meanScore >= 0.48 || Boolean(d.sys.isSynthesized && d.meanScore >= 0.42))
    .sort((a, b) => b.gainSum * 3 + b.meanScore - (a.gainSum * 3 + a.meanScore));

  const maxDynAdd = requestedK >= 4 ? 6 : 8;
  const pickedDynamic = rankedDynamic.slice(0, maxDynAdd).map((d) => d.sys);
  let searchPool = [...corePool, ...pickedDynamic];

  // In all_equal mode, all 4 stationary phases (SiO2, C18, Neutral Al2O3, Basic Al2O3) enter the search.
  // Select the strongest, well-covering, polarity-diverse representatives from each phase so the
  // combinatorial search evaluates all 4 phases on equal footing while staying fast (< 100 ms).
  if (isAllEqual && activeWells.length > 0) {
    const phases: ConcreteStationaryPhase[] = ['SiO2', 'C18', 'Al2O3_neutral', 'Al2O3_basic'];
    const perPhaseCap = requestedK >= 4 ? 6 : 8;
    const balancedPool: TlcSolventSystemDef[] = [];
    const seenIds = new Set<string>();

    for (const ph of phases) {
      const phCandidates = searchPool.filter((s) => resolveSystemPhase(s, stationaryPhasePref) === ph);
      if (phCandidates.length <= perPhaseCap) {
        for (const s of phCandidates) {
          if (!seenIds.has(s.id)) {
            seenIds.add(s.id);
            balancedPool.push(s);
          }
        }
        continue;
      }

      // Count how many wells each candidate wins within its own phase (protects niche/orthogonal rescuers)
      const phaseWins = new Map<string, number>();
      for (const w of activeWells) {
        let bestId = '';
        let bestSc = -1;
        for (const s of phCandidates) {
          const sc = evalMatrix.get(s.id)!.get(w.wellIndex)!.score;
          if (sc > bestSc) {
            bestSc = sc;
            bestId = s.id;
          }
        }
        if (bestId && bestSc >= 0.35) {
          phaseWins.set(bestId, (phaseWins.get(bestId) ?? 0) + 1);
        }
      }

      const scored = phCandidates
        .map((s) => {
          const sysMap = evalMatrix.get(s.id)!;
          let sum = 0;
          let maxSc = 0;
          for (const w of activeWells) {
            const sc = sysMap.get(w.wellIndex)!.score;
            sum += sc;
            if (sc > maxSc) maxSc = sc;
          }
          const mean = sum / activeWells.length;
          const wins = phaseWins.get(s.id) ?? 0;
          const rankVal = mean + Math.min(0.35, (wins / activeWells.length) * 0.7) + (maxSc >= RESOLVED_SCORE ? 0.05 : 0);
          return { s, mean, wins, rankVal };
        })
        .sort((a, b) => b.rankVal - a.rankVal);

      // Seed with best candidate in each polarity band of this phase, then fill up to perPhaseCap
      const pickedForPhase: TlcSolventSystemDef[] = [];
      const seenBands = new Set<string>();
      for (const item of scored) {
        if (pickedForPhase.length >= perPhaseCap) break;
        const b = polarityBand(item.s, stationaryPhasePref);
        if (!seenBands.has(b) && (item.wins > 0 || item.mean >= 0.30)) {
          seenBands.add(b);
          pickedForPhase.push(item.s);
        }
      }
      for (const item of scored) {
        if (pickedForPhase.length >= perPhaseCap) break;
        if (!pickedForPhase.includes(item.s)) {
          pickedForPhase.push(item.s);
        }
      }
      for (const s of pickedForPhase) {
        if (!seenIds.has(s.id)) {
          seenIds.add(s.id);
          balancedPool.push(s);
        }
      }
    }

    if (balancedPool.length >= requestedK) {
      searchPool = balancedPool;
    }
  } else if (requestedK >= 4 && searchPool.length > 36 && activeWells.length > 0) {
    // Keep combinatorial search fast when poolMode exposes full library + dynamic specs at K=4
    const activePool = searchPool.filter((sys) => {
      const sysMap = evalMatrix.get(sys.id)!;
      let maxSc = 0;
      for (const w of activeWells) {
        const sc = sysMap.get(w.wellIndex)!.score;
        if (sc > maxSc) maxSc = sc;
      }
      return maxSc >= 0.30;
    });
    if (activePool.length >= requestedK) {
      searchPool = activePool.slice(0, 38);
    }
  }

  const numActive = activeWells.length;
  const importanceArr = new Float64Array(numActive);
  let totalImportance = 0;
  const wellTrackIndices: number[][] = new Array(numActive);
  const wellProdWeights: number[][] = new Array(numActive);
  const wellProdWeightSum = new Float64Array(numActive);

  for (let wi = 0; wi < numActive; wi++) {
    const w = activeWells[wi];
    const imp = w.importanceWeight;
    importanceArr[wi] = imp;
    totalImportance += imp;

    const uvIdx = w.substrates
      .map((s, idx) => (s.profile.uvActive !== false ? idx : -1))
      .filter((idx) => idx >= 0);
    wellTrackIndices[wi] = uvIdx.length > 0 ? uvIdx : w.substrates.map((_, idx) => idx);

    const pw = w.products.map((p) => p.weight);
    wellProdWeights[wi] = pw;
    wellProdWeightSum[wi] = pw.reduce((a, b) => a + b, 0);
  }
  if (totalImportance <= 0) totalImportance = 1;

  // Compute joint cross-plate species coverage score for any arbitrary subset of systems on well index `wi`.
  // Each SM is credited at its best readability across the plate set; each product is credited at its best
  // same-plate-resolved readability across the plate set.
  const evaluateSystemsOnWell = (systems: TlcSolventSystemDef[], wi: number): number => {
    const w = activeWells[wi];
    if (systems.length === 0) return 0;
    if (systems.length === 1) {
      return evalMatrix.get(systems[0].id)?.get(w.wellIndex)?.score ?? 0;
    }

    const evals = systems.map((sys) => evalMatrix.get(sys.id)!.get(w.wellIndex)!);
    const trackIdx = wellTrackIndices[wi];
    let smSum = 0;
    let smMin = 1;
    for (let t = 0; t < trackIdx.length; t++) {
      const smIdx = trackIdx[t];
      let bestSm = 0;
      for (let m = 0; m < evals.length; m++) {
        const val = evals[m].smReadability[smIdx] ?? 0;
        if (val > bestSm) bestSm = val;
      }
      smSum += bestSm;
      if (bestSm < smMin) smMin = bestSm;
    }
    const smCov = trackIdx.length > 0 ? 0.55 * (smSum / trackIdx.length) + 0.45 * smMin : 1;

    const pw = wellProdWeights[wi];
    const pwSum = wellProdWeightSum[wi];
    if (pw.length === 0 || pwSum <= 0) {
      return smCov;
    }

    let prodWeightedSum = 0;
    let bestProdQual = 0;
    for (let pIdx = 0; pIdx < pw.length; pIdx++) {
      const wgt = pw[pIdx];
      let bestP = 0;
      for (let m = 0; m < evals.length; m++) {
        const val = evals[m].prodReadability[pIdx] ?? 0;
        if (val > bestP) bestP = val;
      }
      prodWeightedSum += wgt * bestP;
      if (wgt > 0.0001 && bestP > bestProdQual) bestProdQual = bestP;
    }
    const prodCov = 0.50 * (prodWeightedSum / pwSum) + 0.50 * bestProdQual;
    const smGate = trackIdx.length > 0 ? 0.35 + 0.65 * smCov : 1;
    return (0.38 * smCov + 0.62 * prodCov) * smGate;
  };

  const poolLen = searchPool.length;
  const scoreGrid: Float64Array[] = searchPool.map((sys) => {
    const sysMap = evalMatrix.get(sys.id)!;
    const arr = new Float64Array(numActive);
    for (let wi = 0; wi < numActive; wi++) {
      arr[wi] = sysMap.get(activeWells[wi].wellIndex)!.score;
    }
    return arr;
  });

  // Flat typed per-species readability grids for ultra-fast cross-plate combination search
  const smGrid: number[][][] = searchPool.map((sys) => {
    const sysMap = evalMatrix.get(sys.id)!;
    return activeWells.map((w, wi) => {
      const ev = sysMap.get(w.wellIndex)!;
      return wellTrackIndices[wi].map((smIdx) => ev.smReadability[smIdx] ?? 0);
    });
  });
  const prodGrid: number[][][] = searchPool.map((sys) => {
    const sysMap = evalMatrix.get(sys.id)!;
    return activeWells.map((w) => sysMap.get(w.wellIndex)!.prodReadability);
  });

  // Clean-spot coverage (goal 3): a spot is "clean" in an eluent when it is not predicted to tail or streak
  // and sits in the usable window. Each chosen set should give every spot at least one clean eluent.
  // Only spots that can run clean in SOME candidate count, so inherently streaking species do not skew the search.
  const CLEAN_SPOT_CAP = 30;
  const CLEAN_SPOT_WEIGHT = options.cleanSpotWeight ?? 0.10;
  const cleanMask: Int32Array[] = searchPool.map((sys) => {
    const sysMap = evalMatrix.get(sys.id)!;
    const arr = new Int32Array(numActive);
    for (let wi = 0; wi < numActive; wi++) {
      const spots = sysMap.get(activeWells[wi].wellIndex)!.spots || [];
      let m = 0;
      for (let i = 0; i < spots.length && i < CLEAN_SPOT_CAP; i++) {
        const sp = spots[i];
        const counted = sp.kind === 'substrate' || sp.tier === 'High' || sp.tier === 'Medium';
        if (!counted) continue;
        const flagged = sp.tailing || (sp.mildStreak && Boolean(sp.tailingReason));
        if (!flagged && sp.rf >= 0.06 && sp.rf <= 0.94) m |= 1 << i;
      }
      arr[wi] = m;
    }
    return arr;
  });
  const countedSpotCount = new Int32Array(numActive);
  if (searchPool.length > 0) {
    const first = evalMatrix.get(searchPool[0].id)!;
    for (let wi = 0; wi < numActive; wi++) {
      const spots = first.get(activeWells[wi].wellIndex)!.spots || [];
      let n = 0;
      for (let i = 0; i < spots.length && i < CLEAN_SPOT_CAP; i++) {
        const sp = spots[i];
        if (sp.kind === 'substrate' || sp.tier === 'High' || sp.tier === 'Medium') n++;
      }
      countedSpotCount[wi] = n;
    }
  }

  const famIndexMap = new Map<string, number>();
  const bandIndexMap = new Map<string, number>();
  const famBit = new Int32Array(poolLen);
  const bandBit = new Int32Array(poolLen);
  const primaryFlag = new Uint8Array(poolLen);
  const unneededModFlag = new Uint8Array(poolLen);

  for (let sIdx = 0; sIdx < poolLen; sIdx++) {
    const sys = searchPool[sIdx];
    const effPhase = resolveSystemPhase(sys, stationaryPhasePref);
    const famKey = isAllEqual ? `${effPhase}:${sys.family}` : sys.family;
    let fi = famIndexMap.get(famKey);
    if (fi === undefined) {
      fi = famIndexMap.size;
      famIndexMap.set(famKey, fi);
    }
    famBit[sIdx] = 1 << (fi % 31);

    const bKey = polarityBand(sys, stationaryPhasePref);
    let bi = bandIndexMap.get(bKey);
    if (bi === undefined) {
      bi = bandIndexMap.size;
      bandIndexMap.set(bKey, bi);
    }
    bandBit[sIdx] = 1 << (bi % 31);
    // In all_equal mode, treat C18 core eluents on equal footing with primary SiO2/Al2O3 workhorses
    primaryFlag[sIdx] =
      sys.preferenceTier === 'primary' || (isAllEqual && effPhase === 'C18') ? 1 : 0;

    if (
      effPhase === 'SiO2' &&
      ((sys.baseModifier && !plateNeedsBasicMod) || (sys.acidModifier && !plateNeedsAcidMod))
    ) {
      unneededModFlag[sIdx] = 1;
    }
  }

  const practicalityArr = new Float64Array(poolLen);
  for (let sIdx = 0; sIdx < poolLen; sIdx++) {
    const sys = searchPool[sIdx];
    const rawPen = sys.descriptors?.practicalityPenalty ?? 0.15;
    // In all_equal mode, strip the C18 plate-cost surcharge (+0.35) so C18 competes strictly on separation quality
    practicalityArr[sIdx] = isAllEqual && sys.stationaryPhase === 'C18' ? Math.max(0.05, rawPen - 0.35) : rawPen;
  }

  // Pairwise redundancy combines chemical similarity (family + strength within same stationary phase) AND empirical
  // well-outcome overlap (Jaccard overlap of which wells each pair resolves, so two eluents that resolve the exact
  // same wells and fail the exact same hard wells are penalized for redundancy rather than rewarded).
  const pairPenalty = new Float64Array(poolLen * poolLen);
  for (let i = 0; i < poolLen; i++) {
    const a = searchPool[i];
    const pa = resolveSystemPhase(a, stationaryPhasePref);
    const sa = scoreGrid[i];
    for (let j = i + 1; j < poolLen; j++) {
      const b = searchPool[j];
      const pb = resolveSystemPhase(b, stationaryPhasePref);
      const sb = scoreGrid[j];
      let pen = 0;
      if (pa === pb) {
        if (a.family === b.family && Math.abs(a.strength - b.strength) < 0.16) {
          pen = 0.065;
        } else if (pa === 'C18' && Math.abs(a.strength - b.strength) < 0.25) {
          pen = 0.05;
        }
      }
      if (numActive >= 4) {
        let bothRes = 0;
        let eitherRes = 0;
        let diffSum = 0;
        for (let wi = 0; wi < numActive; wi++) {
          const ra = sa[wi] >= RESOLVED_SCORE;
          const rb = sb[wi] >= RESOLVED_SCORE;
          if (ra && rb) bothRes++;
          if (ra || rb) eitherRes++;
          diffSum += Math.abs(sa[wi] - sb[wi]);
        }
        const jaccard = eitherRes > 0 ? bothRes / eitherRes : 0;
        const meanAbsDiff = diffSum / numActive;
        // High overlap (>0.82 Jaccard) with nearly identical per-well scores (<0.07 mean diff) => redundant pair
        if (jaccard >= 0.82 && meanAbsDiff < 0.07) {
          pen = Math.max(pen, 0.032 * ((jaccard - 0.78) / 0.22));
        }
      }
      pairPenalty[i * poolLen + j] = pen;
    }
  }

  const popCount = (mask: number): number => {
    let m = mask;
    let c = 0;
    while (m) {
      c += m & 1;
      m >>>= 1;
    }
    return c;
  };

  const effK = Math.min(requestedK, poolLen);
  const combos = generateCombinations(poolLen, effK);

  const activePlateUsed = new Uint8Array(effK);

  // Best combination of effK systems from the pool using cross-plate SM + product species set coverage,
  // skipping any system index in `excluded`.
  const achievableClean = new Int32Array(numActive);
  for (let wi = 0; wi < numActive; wi++) {
    let m = 0;
    for (let si = 0; si < poolLen; si++) m |= cleanMask[si][wi];
    achievableClean[wi] = popCount(m);
  }
  const cleanCountForPoolIdx = (idxs: number[], wi: number): number => {
    let m = 0;
    for (const si of idxs) m |= cleanMask[si][wi];
    return popCount(m);
  };

  const searchBestCombo = async (excluded: Set<number>): Promise<{ combo: number[]; objective: number }> => {
    let bestComboIdx: number[] = [];
    let bestObjective = -1e9;
    for (let cNum = 0; cNum < combos.length; cNum++) {
      const combo = combos[cNum];
      if (excluded.size > 0 && combo.some((ci) => excluded.has(ci))) continue;
      activePlateUsed.fill(0);
      let weightedSum = 0;

      for (let wi = 0; wi < numActive; wi++) {
        if (effK === 1) {
          const sc = scoreGrid[combo[0]][wi];
          if (sc > 0.35) activePlateUsed[0] = 1;
          if (sc > 0) weightedSum += importanceArr[wi] * sc;
          continue;
        }

        // Cross-plate SM tracking across the combo
        const numSm = wellTrackIndices[wi].length;
        let smSum = 0;
        let smMin = 1;
        for (let t = 0; t < numSm; t++) {
          let bestSm = 0;
          let secondSm = 0;
          let bestM = 0;
          for (let cIdx = 0; cIdx < effK; cIdx++) {
            const val = smGrid[combo[cIdx]][wi][t];
            if (val > bestSm) {
              secondSm = bestSm;
              bestSm = val;
              bestM = cIdx;
            } else if (val > secondSm) {
              secondSm = val;
            }
          }
          if (bestSm - secondSm >= 0.06 && bestSm >= 0.35) {
            activePlateUsed[bestM] = 1;
          }
          smSum += bestSm;
          if (bestSm < smMin) smMin = bestSm;
        }
        const smCov = numSm > 0 ? 0.55 * (smSum / numSm) + 0.45 * smMin : 1;

        const pw = wellProdWeights[wi];
        const pwSum = wellProdWeightSum[wi];
        let wellJointScore = smCov;
        if (pw.length > 0 && pwSum > 0) {
          let prodWeightedSum = 0;
          let bestProdQual = 0;
          for (let pIdx = 0; pIdx < pw.length; pIdx++) {
            const wgt = pw[pIdx];
            let bestP = 0;
            let secondP = 0;
            let bestM = 0;
            for (let cIdx = 0; cIdx < effK; cIdx++) {
              const val = prodGrid[combo[cIdx]][wi][pIdx];
              if (val > bestP) {
                secondP = bestP;
                bestP = val;
                bestM = cIdx;
              } else if (val > secondP) {
                secondP = val;
              }
            }
            if (wgt > 0.0001 && bestP - secondP >= 0.06 && bestP >= 0.35) {
              activePlateUsed[bestM] = 1;
            }
            prodWeightedSum += wgt * bestP;
            if (wgt > 0.0001 && bestP > bestProdQual) bestProdQual = bestP;
          }
          const prodCov = 0.50 * (prodWeightedSum / pwSum) + 0.50 * bestProdQual;
          const smGate = numSm > 0 ? 0.35 + 0.65 * smCov : 1;
          wellJointScore = (0.38 * smCov + 0.62 * prodCov) * smGate;
        }

        // Also mark best overall single plate for this well as actively used
        let bestSingle = -1;
        let bestSingleOwner = 0;
        for (let cIdx = 0; cIdx < effK; cIdx++) {
          const sc = scoreGrid[combo[cIdx]][wi];
          if (sc > bestSingle) {
            bestSingle = sc;
            bestSingleOwner = cIdx;
          }
        }
        if (wellJointScore > 0.35) activePlateUsed[bestSingleOwner] = 1;
        if (wellJointScore > 0) weightedSum += importanceArr[wi] * wellJointScore;
      }

      if (CLEAN_SPOT_WEIGHT > 0) {
        let cleanSum = 0;
        for (let wi = 0; wi < numActive; wi++) {
          cleanSum +=
            achievableClean[wi] > 0
              ? (importanceArr[wi] * cleanCountForPoolIdx(combo, wi)) / achievableClean[wi]
              : importanceArr[wi];
        }
        weightedSum += CLEAN_SPOT_WEIGHT * cleanSum;
      }

      let activeSystemsUsed = 0;
      let famMask = 0;
      let bandMask = 0;
      let primaryCount = 0;
      let unneededModCount = 0;
      let c18AutoCount = 0;
      let redundancyPenalty = 0;
      let practicalitySum = 0;

      for (let i = 0; i < effK; i++) {
        const si = combo[i];
        if (activePlateUsed[i] > 0) activeSystemsUsed++;
        if (unneededModFlag[si]) {
          unneededModCount++;
        } else {
          famMask |= famBit[si];
          bandMask |= bandBit[si];
        }
        if (stationaryPhasePref === 'auto' && searchPool[si].stationaryPhase === 'C18') {
          c18AutoCount++;
        }
        primaryCount += primaryFlag[si];
        practicalitySum += practicalityArr[si];
        for (let j = i + 1; j < effK; j++) {
          redundancyPenalty += pairPenalty[si * poolLen + combo[j]];
        }
      }

      const distinctFamilies = popCount(famMask);
      const distinctBands = popCount(bandMask);
      const primaryBonus =
        poolMode === 'prefer_primary' ? 0.055 * (primaryCount / effK) : 0;
      const c18AutoPenalty = stationaryPhasePref === 'auto' ? c18AutoCount * 0.065 : 0;
      // Gentle EHS / volatility / cost tie-breaker (never overrides genuine resolution gains)
      const practicalityPenalty = 0.012 * (practicalitySum / effK);

      const obj =
        weightedSum / totalImportance +
        activeSystemsUsed * 0.004 +
        distinctFamilies * 0.005 +
        distinctBands * 0.004 +
        primaryBonus -
        unneededModCount * 0.03 -
        c18AutoPenalty -
        practicalityPenalty -
        redundancyPenalty;

      if (obj > bestObjective) {
        bestObjective = obj;
        bestComboIdx = combo;
      }

      if ((cNum & 1023) === 1023) {
        await yieldIfFrameExceeded();
      }
    }
    return { combo: bestComboIdx, objective: bestObjective };
  };

  const mainSearch = await searchBestCombo(new Set<number>());
  const bestComboIdx = mainSearch.combo.length > 0 ? mainSearch.combo : [0];

  let chosenSystems = bestComboIdx.map((idx) => searchPool[idx]);

  const resolvedCountFor = (systems: TlcSolventSystemDef[]): number => {
    let n = 0;
    for (let wi = 0; wi < numActive; wi++) {
      if (evaluateSystemsOnWell(systems, wi) >= RESOLVED_SCORE) n++;
    }
    return n;
  };

  // Drop eluents that add almost nothing to cross-plate species coverage: requested count is an upper bound.
  const minUniqueGain = activeWells.length <= 2 ? 1 : Math.max(2, Math.ceil(activeWells.length * 0.05));
  let droppedForSmallGain = 0;
  while (chosenSystems.length > 1) {
    const withAllIdx = chosenSystems.map((c) => searchPool.indexOf(c));
    const hasCleanIdx = CLEAN_SPOT_WEIGHT > 0 && withAllIdx.every((x) => x >= 0);
    let weakest = -1;
    let weakestLoss = Infinity;
    let weakestMean = Infinity;
    for (let i = 0; i < chosenSystems.length; i++) {
      const sys = chosenSystems[i];
      const reduced = chosenSystems.filter((_, j) => j !== i);
      const withoutIdx = hasCleanIdx ? withAllIdx.filter((_, j) => j !== i) : [];
      // Count distinct wells that lose resolution OR lose clean-spot coverage when removing this eluent
      // (avoiding double-counting a single well that loses both).
      let loss = 0;
      for (let wi = 0; wi < numActive; wi++) {
        const lostResolved =
          evaluateSystemsOnWell(chosenSystems, wi) >= RESOLVED_SCORE &&
          evaluateSystemsOnWell(reduced, wi) < RESOLVED_SCORE;
        const lostClean =
          hasCleanIdx && cleanCountForPoolIdx(withoutIdx, wi) < cleanCountForPoolIdx(withAllIdx, wi);
        if (lostResolved || lostClean) loss++;
      }
      const sMap = evalMatrix.get(sys.id)!;
      let scSum = 0;
      for (const w of activeWells) scSum += sMap.get(w.wellIndex)!.score;
      const meanSc = activeWells.length > 0 ? scSum / activeWells.length : 0;
      if (loss < weakestLoss || (loss === weakestLoss && meanSc < weakestMean)) {
        weakestLoss = loss;
        weakestMean = meanSc;
        weakest = i;
      }
    }
    if (weakest < 0 || weakestLoss >= minUniqueGain) break;
    chosenSystems = chosenSystems.filter((_, j) => j !== weakest);
    droppedForSmallGain++;
  }

  // 4. Mark each well as resolved if the cross-plate set covers its SMs + products (>= 0.55),
  // and assign it to its best contributing recommended plate (favoring primary on near-ties).
  const bestOwnerByWell = new Map<number, string>();
  const unresolvedWellIndices: number[] = [];
  let resolvedWellCount = 0;
  for (let wi = 0; wi < numActive; wi++) {
    const w = activeWells[wi];
    const setScore = evaluateSystemsOnWell(chosenSystems, wi);
    let topSys = chosenSystems[0];
    let topScore = -1;
    for (const sys of chosenSystems) {
      const sc = evalMatrix.get(sys.id)!.get(w.wellIndex)!.score;
      const tieBias =
        sys.preferenceTier === 'primary' || (isAllEqual && sys.stationaryPhase === 'C18') ? 0.015 : 0;
      const prevBias =
        topSys.preferenceTier === 'primary' || (isAllEqual && topSys.stationaryPhase === 'C18') ? 0.015 : 0;
      if (sc + tieBias > topScore + prevBias) {
        topScore = sc;
        topSys = sys;
      }
    }
    if (setScore >= RESOLVED_SCORE) {
      bestOwnerByWell.set(w.wellIndex, topSys.id);
      resolvedWellCount++;
    } else {
      unresolvedWellIndices.push(w.wellIndex);
    }
  }

  // Compute unique wells rescued by each chosen system (wells resolved with the full set, lost without this system)
  const uniqueWellsBySystem = new Map<string, number[]>();
  for (let i = 0; i < chosenSystems.length; i++) {
    const sys = chosenSystems[i];
    const reduced = chosenSystems.filter((_, j) => j !== i);
    const uniq: number[] = [];
    for (let wi = 0; wi < numActive; wi++) {
      const wIdx = activeWells[wi].wellIndex;
      if (
        evaluateSystemsOnWell(chosenSystems, wi) >= RESOLVED_SCORE &&
        (reduced.length === 0 || evaluateSystemsOnWell(reduced, wi) < RESOLVED_SCORE)
      ) {
        uniq.push(wIdx);
      }
    }
    uniqueWellsBySystem.set(sys.id, uniq);
  }

  // Order final recommended plates: weak-to-strong within each stationary phase;
  // in all_equal mode, lead with the phase covering the most wells (tie-break: SiO2 -> Basic Al2O3 -> Neutral Al2O3 -> C18).
  const rawRecommended = chosenSystems.map((sys) =>
    buildSystemPlanEntry(sys, 0, activeWells.length, wellDataByIdx, evalMatrix.get(sys.id)!, bestOwnerByWell, {
      uniqueWellIndices: uniqueWellsBySystem.get(sys.id) ?? [],
      stationaryPhasePref,
      calibration: options.calibration,
    })
  );
  const phaseAssignedTotal = new Map<ConcreteStationaryPhase, number>();
  for (const entry of rawRecommended) {
    const ph = resolveSystemPhase(entry.system, stationaryPhasePref);
    phaseAssignedTotal.set(ph, (phaseAssignedTotal.get(ph) ?? 0) + entry.assignedWellIndices.length);
  }
  const phaseOrderRank: Record<ConcreteStationaryPhase, number> = {
    SiO2: 0,
    Al2O3_basic: 1,
    Al2O3_neutral: 2,
    C18: 3,
  };
  const recommendedSystems = rawRecommended
    .sort((a, b) => {
      const pa = resolveSystemPhase(a.system, stationaryPhasePref);
      const pb = resolveSystemPhase(b.system, stationaryPhasePref);
      if (pa !== pb) {
        if (isAllEqual) {
          const totDiff = (phaseAssignedTotal.get(pb) ?? 0) - (phaseAssignedTotal.get(pa) ?? 0);
          if (totDiff !== 0) return totDiff;
          return phaseOrderRank[pa] - phaseOrderRank[pb];
        }
        return a.system.stationaryPhase === 'SiO2' ? -1 : 1;
      }
      if (Math.abs(a.system.strength - b.system.strength) > 0.02) {
        return a.system.strength - b.system.strength;
      }
      return b.assignedWellIndices.length - a.assignedWellIndices.length;
    })
    .map((entry, idx) => ({ ...entry, rank: idx + 1 }));

  // "Either/or": an Et3N eluent and an NH3/MeOH eluent that resolve (nearly) the same wells are interchangeable,
  // or a higher-capacity rung of the same base when the recommended eluent has streak warnings.
  const baseKind = (sys: TlcSolventSystemDef): 'et3n' | 'nh3' | null =>
    sys.baseModifier?.includes('Et₃N') ? 'et3n' : sys.baseModifier?.includes('NH₃') ? 'nh3' : null;
  const recIds = new Set(recommendedSystems.map((r) => r.system.id));
  const modCapacity = (sys: TlcSolventSystemDef): number => {
    const id = sys.composition?.modifierId;
    return id && MODIFIER_SPECS[id] ? MODIFIER_SPECS[id].neutralizingCapacity ?? 0 : 0;
  };
  const wellFlagged = (sysId: string, wi: number): boolean =>
    (evalMatrix.get(sysId)!.get(wi)!.spots || []).some(
      (sp) => sp.tailing || (sp.mildStreak && Boolean(sp.tailingReason))
    );
  for (const rec of recommendedSystems) {
    const kind = baseKind(rec.system);
    if (!kind || rec.assignedWellIndices.length === 0) continue;
    const recPhase = resolveSystemPhase(rec.system, stationaryPhasePref);
    const need = Math.ceil(rec.assignedWellIndices.length * 0.9);
    const recFlagged = rec.assignedWellIndices.filter((wi) => wellFlagged(rec.system.id, wi)).length;
    const recCap = modCapacity(rec.system);
    const alts = allCandidateSystems
      .filter((c) => resolveSystemPhase(c, stationaryPhasePref) === recPhase && !recIds.has(c.id))
      .map((c) => {
        const k = baseKind(c);
        if (k === null) return null;
        const flagged = rec.assignedWellIndices.filter((wi) => wellFlagged(c.id, wi)).length;
        // other base (Et3N <-> NH3), or the same base with headroom: a higher-capacity rung that streaks less
        const crossKind = k !== kind;
        const upgrade = !crossKind && modCapacity(c) > recCap && recFlagged > 0 && flagged < recFlagged;
        if (!crossKind && !upgrade) return null;
        const ok = rec.assignedWellIndices.filter((wi) => evalMatrix.get(c.id)!.get(wi)!.score >= RESOLVED_SCORE).length;
        return { c, ok, flagged, upgrade };
      })
      .filter((x): x is { c: TlcSolventSystemDef; ok: number; flagged: number; upgrade: boolean } => !!x && x.ok >= need)
      .sort((a, b) => a.flagged - b.flagged || b.ok - a.ok);
    if (alts.length > 0) {
      const best = alts[0];
      rec.alternatives = [best.c];
      if (best.upgrade || best.flagged < recFlagged) {
        const reasonSuffix = modCapacity(best.c) > recCap ? ' (more base capacity)' : '';
        rec.alternativeNote = `${best.c.name} resolves the same wells with ${best.flagged} streak warning${best.flagged === 1 ? '' : 's'} instead of ${recFlagged}${reasonSuffix}.`;
      }
    }
  }

  // Expose every core system in this stationary phase plus high-performing dynamic candidates for plate inspection
  const chosenFinalIds = new Set(recommendedSystems.map((r) => r.system.id));
  const emptyOwnerMap = new Map<number, string>();
  const exposedSystems = [...phaseFilteredLibrary, ...pickedDynamic];
  const otherSystems = exposedSystems
    .filter((sys) => !chosenFinalIds.has(sys.id))
    .map((sys) =>
      buildSystemPlanEntry(sys, 0, activeWells.length, wellDataByIdx, evalMatrix.get(sys.id)!, emptyOwnerMap, {
        stationaryPhasePref,
        calibration: options.calibration,
      })
    )
    .sort((a, b) => {
      if (b.wellCoveragePct !== a.wellCoveragePct) return b.wellCoveragePct - a.wellCoveragePct;
      return b.meanResolutionScore - a.meanResolutionScore;
    });

  // Group the remaining systems into complementary sets, using the same cross-plate set coverage logic:
  // repeat the combination search without the systems already used.
  const otherGroups: PlateSolventGroup[] = [];
  const usedIdx = new Set<number>(bestComboIdx);
  const MAX_GROUPS = 3;
  for (let g = 0; g < MAX_GROUPS; g++) {
    if (searchPool.length - usedIdx.size < effK) break;
    const found = await searchBestCombo(usedIdx);
    if (found.combo.length === 0) break;
    found.combo.forEach((ci) => usedIdx.add(ci));
    const groupSystems = found.combo.map((ci) => searchPool[ci]);
    const owner = new Map<number, string>();
    let groupResolved = 0;
    for (let wi = 0; wi < numActive; wi++) {
      const w = activeWells[wi];
      const setSc = evaluateSystemsOnWell(groupSystems, wi);
      let top = groupSystems[0];
      let topSc = -1;
      for (const sys of groupSystems) {
        const sc = evalMatrix.get(sys.id)!.get(w.wellIndex)!.score;
        if (sc > topSc) {
          topSc = sc;
          top = sys;
        }
      }
      if (setSc >= RESOLVED_SCORE) {
        owner.set(w.wellIndex, top.id);
        groupResolved++;
      }
    }
    if (groupResolved === 0) break;
    const entries = groupSystems
      .map((sys, idxG) => {
        const red = groupSystems.filter((_, j) => j !== idxG);
        const uniqG: number[] = [];
        for (let wi = 0; wi < numActive; wi++) {
          if (
            evaluateSystemsOnWell(groupSystems, wi) >= RESOLVED_SCORE &&
            (red.length === 0 || evaluateSystemsOnWell(red, wi) < RESOLVED_SCORE)
          ) {
            uniqG.push(activeWells[wi].wellIndex);
          }
        }
        return buildSystemPlanEntry(sys, 0, activeWells.length, wellDataByIdx, evalMatrix.get(sys.id)!, owner, {
          uniqueWellIndices: uniqG,
          stationaryPhasePref,
          calibration: options.calibration,
        });
      })
      .sort((a, b) => {
        const pa = resolveSystemPhase(a.system, stationaryPhasePref);
        const pb = resolveSystemPhase(b.system, stationaryPhasePref);
        if (pa !== pb) {
          return phaseOrderRank[pa] - phaseOrderRank[pb];
        }
        return a.system.strength - b.system.strength;
      })
      .map((entry, i) => ({ ...entry, rank: i + 1 }));
    otherGroups.push({
      label: `Alternative set ${String.fromCharCode(66 + g)}`,
      systems: entries,
      resolvedWellCount: groupResolved,
      coveragePct: activeWells.length > 0 ? Math.round((groupResolved / activeWells.length) * 100) : 0,
    });
  }


  const highRankedWellCount = activeWells.filter((w) => w.hasHighOrMed).length;
  const totalCoveragePct =
    activeWells.length > 0 ? Math.round((resolvedWellCount / activeWells.length) * 100) : 0;

  const summaryNotes: string[] = [];
  if (recommendedSystems.length > 0) {
    summaryNotes.push(
      `${recommendedSystems.length} eluent${recommendedSystems.length > 1 ? 's' : ''} estimated to resolve ${resolvedWellCount}/${activeWells.length} active wells (~${totalCoveragePct}%; model-based estimate, not measured).`
    );
  }
  if (droppedForSmallGain > 0) {
    summaryNotes.push(
      `${recommendedSystems.length} eluent${recommendedSystems.length > 1 ? 's are' : ' is'} enough: ${droppedForSmallGain} more would each rescue fewer than ${minUniqueGain} extra wells.`
    );
  }
  {
    const finalIdx = chosenSystems.map((c) => searchPool.indexOf(c)).filter((x) => x >= 0);
    let lostClean = 0;
    let alwaysStreaking = 0;
    for (let wi = 0; wi < numActive; wi++) {
      if (cleanCountForPoolIdx(finalIdx, wi) < achievableClean[wi]) lostClean++;
      if (achievableClean[wi] < countedSpotCount[wi]) alwaysStreaking++;
    }
    if (lostClean > 0) {
      summaryNotes.push(
        `${lostClean} well${lostClean > 1 ? 's have' : ' has'} a spot that would run clean in another candidate eluent but streaks in every chosen one — check the OR alternatives or the modifier.`
      );
    }
    if (alwaysStreaking > 0) {
      summaryNotes.push(
        `${alwaysStreaking} well${alwaysStreaking > 1 ? 's have' : ' has'} spots predicted to streak in every eluent tried (charged or poly-functional species); expect smears whatever you pick.`
      );
    }
  }
  if (unresolvedWellIndices.length > 0) {
    summaryNotes.push(
      `${unresolvedWellIndices.length} well${unresolvedWellIndices.length > 1 ? 's' : ''} not resolved in any recommended eluent (${unresolvedWellIndices.slice(0, 12).map((i) => wellLabel(i)).join(', ')}${unresolvedWellIndices.length > 12 ? ', …' : ''}); try another solvent pool or run them by LCMS.`
    );
  }
  if (stationaryPhasePref === 'all_equal') {
    const chosenPhases = Array.from(
      new Set(recommendedSystems.map((r) => resolveSystemPhase(r.system, stationaryPhasePref)))
    );
    const phaseLabels = chosenPhases.map((p) =>
      p === 'C18'
        ? 'Reverse-Phase C18'
        : p === 'Al2O3_basic'
        ? 'Basic Al₂O₃'
        : p === 'Al2O3_neutral'
        ? 'Neutral Al₂O₃'
        : 'SiO₂'
    );
    summaryNotes.push(
      `All stationary phases evaluated equally (SiO₂, Neutral Al₂O₃, Basic Al₂O₃, C18) — best resolution selected ${phaseLabels.join(' + ')}.`
    );
  } else if (stationaryPhasePref === 'Al2O3_basic') {
    summaryNotes.push('Basic Al₂O₃ mode: basic surface elutes free amines & azoles cleanly using neat organic eluents (no NH₃, Et₃N, or AcOH).');
  } else if (stationaryPhasePref === 'Al2O3_neutral') {
    summaryNotes.push('Neutral Al₂O₃ mode: silanol-free support for acid/base-sensitive & amine substrates using neat organic eluents (no NH₃, Et₃N, or AcOH).');
  } else if (stationaryPhasePref === 'C18') {
    summaryNotes.push('Reverse-Phase C18 mode: polar/ionizable products elute earliest; organic content controls lipophilic release.');
  } else if (stationaryPhasePref === 'SiO2') {
    summaryNotes.push('Normal-Phase Silica Gel (SiO₂) mode.');
  }
  summaryNotes.push(
    ...eluentReactivityWarnings(
      rdkit,
      activeWells.flatMap((w) => w.substrates.map((x) => x.smiles)),
      recommendedSystems.map((r) => r.system)
    )
  );
  const hasNh3 = recommendedSystems.some((s) => s.system.baseModifier?.includes('NH₃'));
  const hasEt3n = recommendedSystems.some((s) => s.system.baseModifier?.includes('Et₃N'));
  if (hasNh3) {
    summaryNotes.push('Includes DCM / MeOH / (2M NH₃ in MeOH) ternary blend for clean release of polar amines & azoles.');
  } else if (hasEt3n) {
    summaryNotes.push('Includes 1% Et₃N mobile phase to release basic amines/azoles from baseline.');
  }
  const hasStrongAcidBasicWells = activeWells.some(
    (w) =>
      w.needsBasicMod &&
      w.wellCtx.acidStrength === 'strong_nonvolatile' &&
      (w.wellCtx.acidLoadEq ?? 0) >= 0.35
  );
  const includesBasicAlumina = recommendedSystems.some(
    (s) => resolveSystemPhase(s.system, stationaryPhasePref) === 'Al2O3_basic'
  );
  if (hasStrongAcidBasicWells && stationaryPhasePref !== 'Al2O3_basic' && !includesBasicAlumina) {
    summaryNotes.push(
      'Strong non-volatile acid (e.g. TsOH) wells protonate basic N-heterocycles/anilines into tosylate salts; 1% Et₃N (~72 mM) may be overwhelmed by acid + silica Si–OH — prefer 2M NH₃/MeOH, Basic Al₂O₃, or pre-neutralize aliquots.'
    );
  }
  if (stationaryPhasePref === 'auto' && recommendedSystems.some((s) => s.system.stationaryPhase === 'C18')) {
    summaryNotes.push('Includes C18 Reverse-Phase TLC to rescue ultra-polar/ionizable wells orthogonal to SiO₂.');
  }
  if (recommendedSystems.some((s) => s.system.acidModifier && resolveSystemPhase(s.system, stationaryPhasePref) === 'SiO2')) {
    summaryNotes.push('Includes 1% AcOH mobile phase to sharpen carboxylic acid spots.');
  }

  if (recommendedSystems.some((s) => s.system.family === 'prisma_ternary')) {
    summaryNotes.push('Includes Nyiredy PRISMA ternary eluent to break co-eluting regioisomer/HBA overlaps.');
  }

  let primaryPhaseKey: ConcreteStationaryPhase =
    stationaryPhasePref === 'C18'
      ? 'C18'
      : stationaryPhasePref === 'Al2O3_neutral'
      ? 'Al2O3_neutral'
      : stationaryPhasePref === 'Al2O3_basic'
      ? 'Al2O3_basic'
      : 'SiO2';
  if (isAllEqual && options.calibration) {
    const candidateKeys: ConcreteStationaryPhase[] = [
      ...recommendedSystems.map((r) => resolveSystemPhase(r.system, stationaryPhasePref)),
      'SiO2',
      'Al2O3_basic',
      'Al2O3_neutral',
      'C18',
    ];
    for (const key of candidateKeys) {
      const f = options.calibration.byPhase[key];
      const ev = (f?.pairedSpotCount ?? 0) + (f?.frontCensoredCount ?? 0) + (f?.baselineCensoredCount ?? 0);
      if (f && ev > 0) {
        primaryPhaseKey = key;
        break;
      }
    }
  }
  const activePhaseFit = options.calibration?.byPhase[primaryPhaseKey];
  const matchedPhasePlates = (options.calibration?.plates || []).filter(
    (p) => p.stationaryPhase === primaryPhaseKey && (p.pairedCount > 0 || (p.frontCensoredCount ?? 0) > 0 || (p.baselineCensoredCount ?? 0) > 0)
  );
  const totalEvidence =
    (activePhaseFit?.pairedSpotCount ?? 0) +
    (activePhaseFit?.frontCensoredCount ?? 0) +
    (activePhaseFit?.baselineCensoredCount ?? 0);
  const calibrationApplied: CalibrationAppliedSummary | undefined =
    activePhaseFit && totalEvidence > 0
      ? {
          active: true,
          stationaryPhase: primaryPhaseKey,
          pairedSpotCount: activePhaseFit.pairedSpotCount,
          matchedLaneCount: activePhaseFit.matchedLaneCount,
          matchedPlateCount: matchedPhasePlates.length,
          uniqueCompounds: activePhaseFit.uniqueCompounds,
          frontCensoredCount: activePhaseFit.frontCensoredCount ?? 0,
          baselineCensoredCount: activePhaseFit.baselineCensoredCount ?? 0,
          globalDemandShift: activePhaseFit.globalDemandShift,
          demandSlope: activePhaseFit.demandSlope ?? 1.0,
          hasFeatureWeights: Boolean(activePhaseFit.featureWeights),
          midplateRfShift: activePhaseFit.midplateRfShift,
          calibratedSigma: activePhaseFit.calibratedSigma,
          rmseBefore: activePhaseFit.rmseBefore,
          rmseAfter: activePhaseFit.rmseAfter,
          cvRmse: activePhaseFit.cvRmse,
          cvRmseBaseline: activePhaseFit.cvRmseBaseline,
          plateCvRmse: activePhaseFit.plateCvRmse,
          familyStats: activePhaseFit.familyStats,
        }
      : undefined;

  if (calibrationApplied) {
    const dir = calibrationApplied.midplateRfShift >= 0 ? '+' : '';
    const censNote =
      (calibrationApplied.frontCensoredCount ?? 0) + (calibrationApplied.baselineCensoredCount ?? 0) > 0
        ? ` + ${(calibrationApplied.frontCensoredCount ?? 0)} front / ${(calibrationApplied.baselineCensoredCount ?? 0)} baseline bounds`
        : '';
    const ridgeNote = calibrationApplied.hasFeatureWeights ? ' · L2 Ridge descriptor weights' : '';
    summaryNotes.push(
      `Self-calibrated (${primaryPhaseKey}) from ${calibrationApplied.matchedPlateCount} measured plate${calibrationApplied.matchedPlateCount > 1 ? 's' : ''} (${calibrationApplied.pairedSpotCount} paired spots${censNote} · mid-plate Rf shift ${dir}${calibrationApplied.midplateRfShift.toFixed(2)}${ridgeNote} · RMSE ±${calibrationApplied.rmseBefore.toFixed(2)} → ±${calibrationApplied.rmseAfter.toFixed(2)}).`
    );
  }

  if (activePhaseFit?.plateLevelFamilies && Object.keys(activePhaseFit.plateLevelFamilies).length > 0) {
    const fams = Object.entries(activePhaseFit.plateLevelFamilies)
      .map(([f, v]) => `${f} (${(v as number) >= 0 ? '+' : ''}${(v as number).toFixed(2)} demand)`)
      .join(', ');
    summaryNotes.push(
      `Plate-level correction applied for ${fams}: the measured plate ran far from the predicted Rf distribution, which spot pairing alone does not catch. Confirm with the next plate in that eluent family.`
    );
  }

  // 5. Follow-up / Rescue Solvent Recommender driven directly by already-measured plate outcomes
  let followUpPlan: PlateFollowUpPlan | undefined;
  const relevantMeasuredPlates = (options.calibration?.plates || []).filter(
    (p) =>
      p.plateIndex === plateIndex &&
      (stationaryPhasePref === 'auto' || stationaryPhasePref === 'all_equal'
        ? true
        : p.stationaryPhase === primaryPhaseKey)
  );

  if (relevantMeasuredPlates.length > 0 && activeWells.length > 0) {
    const testedSystemIds = new Set(relevantMeasuredPlates.map((p) => p.matchedSystemId));
    const testedSystemNames = new Set(
      relevantMeasuredPlates.map((p) => p.matchedSystemName.toLowerCase().trim())
    );
    const frontCeilingByWell = new Map<number, number>(); // weakest strength that still caused front saturation
    const baseFloorByWell = new Map<number, number>(); // strongest unmodified strength that remained baseline-pinned
    const tailedMaxModCapByWell = new Map<number, number>(); // strongest base modifier capacity that still tailed empirically
    const measuredResolvedWells = new Set<number>();
    const frontCrowdedSet = new Set<number>();
    const baselinePinnedSet = new Set<number>();
    const coelutedSet = new Set<number>();
    const tailingSet = new Set<number>();
    const beforeRfValuesByWell = new Map<number, number[]>();
    const resolvedCountByPlate = relevantMeasuredPlates.map(() => 0);

    for (const w of activeWells) {
      const wi = w.wellIndex;
      let resolvedOnAny = false;
      let sawFront = false;
      let sawBaseline = false;
      let sawCoelution = false;
      let sawTailing = false;
      const rfVals: number[] = [];

      relevantMeasuredPlates.forEach((mp, mpIdx) => {
        const lane = mp.lanes?.[wi];
        const sysDef =
          mp.matchedSystem ||
          allCandidateSystems.find((s) => s.id === mp.matchedSystemId) ||
          findSolventSystemById(mp.matchedSystemId);
        if (!lane || lane.isBlank || !sysDef) return;

        const hasFrontPred = lane.predictedSpots.some(
          (p) => p.boundaryStatus === 'front_saturated' || p.rfAfter >= 0.85
        );
        const hasFrontMeas = lane.measuredSpots.some((m) => m.rf >= 0.86);
        const isFrontPlate =
          hasFrontPred ||
          hasFrontMeas ||
          (Boolean(lane.frontOccupied) && lane.predictedSpots.some((p) => p.rfAfter >= 0.72));

        const hasBasePred = lane.predictedSpots.some(
          (p) => p.boundaryStatus === 'baseline_pinned' || p.rfAfter <= 0.08
        );
        const hasBaseMeas = lane.measuredSpots.some((m) => m.rf <= 0.07);
        const isBasePlate =
          hasBasePred ||
          hasBaseMeas ||
          (Boolean(lane.originOccupied) && lane.predictedSpots.some((p) => p.rfAfter <= 0.25));

        const isMeasuredTailing = Boolean(
          lane.measuredTailing ||
            lane.measuredSpots.some(
              (m) => m.rf > 0.08 && m.rf < 0.90 && ((m.tailing ?? 0) >= 1.85 || (m.rfSpan ?? 0) >= 0.18)
            )
        );

        for (const p of lane.predictedSpots) {
          rfVals.push(p.boundaryStatus === 'front_saturated' ? 0.95 : p.boundaryStatus === 'baseline_pinned' ? 0.04 : p.rfAfter);
        }

        if (isFrontPlate) {
          sawFront = true;
          const prevC = frontCeilingByWell.get(wi);
          if (prevC === undefined || sysDef.strength < prevC) frontCeilingByWell.set(wi, sysDef.strength);
        }
        if (isBasePlate) {
          sawBaseline = true;
          const prevF = baseFloorByWell.get(wi);
          if (prevF === undefined || sysDef.strength > prevF) baseFloorByWell.set(wi, sysDef.strength);
        }
        if (isMeasuredTailing) {
          sawTailing = true;
          const capHere = sysDef.descriptors?.modifierCapacity ?? 0;
          const prevCap = tailedMaxModCapByWell.get(wi);
          if (prevCap === undefined || capHere > prevCap) tailedMaxModCapByWell.set(wi, capHere);
        }

        // Did this measured plate cleanly resolve a product vs SM inside 0.10..0.85 (without severe tailing)?
        const interiorMeas = lane.measuredSpots.filter((m) => m.rf >= 0.10 && m.rf <= 0.86);
        const interiorFoundProd = lane.predictedSpots.some(
          (p) => p.kind === 'product' && p.found && p.rfAfter >= 0.12 && p.rfAfter <= 0.85
        );
        const modelOkHere = (evalMatrix.get(sysDef.id)?.get(wi)?.score ?? 0) >= RESOLVED_SCORE;
        if (
          !isFrontPlate &&
          !isBasePlate &&
          !isMeasuredTailing &&
          ((interiorFoundProd && interiorMeas.length >= 2) || (modelOkHere && interiorMeas.length >= 1))
        ) {
          resolvedOnAny = true;
          resolvedCountByPlate[mpIdx]++;
        } else if (!isFrontPlate && !isBasePlate && !isMeasuredTailing && lane.measuredSpots.length > 0) {
          sawCoelution = true;
        }
      });

      if (rfVals.length > 0) beforeRfValuesByWell.set(wi, rfVals);
      if (resolvedOnAny) {
        measuredResolvedWells.add(wi);
      } else {
        if (sawFront) frontCrowdedSet.add(wi);
        if (sawBaseline) baselinePinnedSet.add(wi);
        if (sawTailing) tailingSet.add(wi);
        if (!sawFront && !sawBaseline && !sawTailing && (sawCoelution || rfVals.length > 0)) coelutedSet.add(wi);
      }
    }

    const unresolvedTargets = activeWells
      .map((w) => w.wellIndex)
      .filter(
        (wi) => frontCrowdedSet.has(wi) || baselinePinnedSet.has(wi) || tailingSet.has(wi) || coelutedSet.has(wi)
      );

    const recommendations: FollowUpSolventOption[] = [];
    if (unresolvedTargets.length > 0) {
      const remaining = new Set<number>(unresolvedTargets);
      const pickedIds = new Set<string>();
      const maxFollowUps = Math.min(3, requestedK);

      for (let step = 0; step < maxFollowUps && remaining.size > 0; step++) {
        let bestOpt: FollowUpSolventOption | null = null;
        let bestGain = 0;

        for (const sys of searchPool) {
          if (
            testedSystemIds.has(sys.id) ||
            testedSystemNames.has(sys.name.toLowerCase().trim()) ||
            pickedIds.has(sys.id)
          ) {
            continue;
          }
          const sysMap = evalMatrix.get(sys.id);
          if (!sysMap) continue;

          const rescued: number[] = [];
          let rFront = 0;
          let rBase = 0;
          let rCoel = 0;
          let rTail = 0;
          let weightedGain = 0;
          const beforeRfs: number[] = [];
          const afterRfs: number[] = [];

          for (const wi of remaining) {
            const candPhase = resolveSystemPhase(sys, stationaryPhasePref);
            // Respect empirical boundary exclusions from failed measured plates
            const fCeil = frontCeilingByWell.get(wi);
            if (frontCrowdedSet.has(wi) && fCeil !== undefined && candPhase === 'SiO2' && sys.strength >= fCeil - 0.025) {
              continue;
            }
            const bFloor = baseFloorByWell.get(wi);
            if (baselinePinnedSet.has(wi) && bFloor !== undefined && candPhase === 'SiO2' && sys.strength <= bFloor + 0.025 && !sys.baseModifier && !sys.acidModifier) {
              continue;
            }

            const evalRes = sysMap.get(wi);
            if (!evalRes || evalRes.score < RESOLVED_SCORE) continue;

            // If this well empirically tailed on a previous plate, require a cleaner eluent (higher modifier capacity,
            // protic MeOH/modifier switch, Basic Al2O3, or C18) that does not predict tailing here. When front-crowding is the
            // primary failure on a neutral non-ionizable well, let weaker neutral eluents rescue it freely.
            if (tailingSet.has(wi)) {
              const wellObj = wellDataByIdx.get(wi);
              const needsIonizableBuffering =
                !frontCrowdedSet.has(wi) || Boolean(wellObj?.needsBasicMod || wellObj?.needsAcidMod);
              if (needsIonizableBuffering) {
                const prevCap = tailedMaxModCapByWell.get(wi) ?? 0;
                const candCap = sys.descriptors?.modifierCapacity ?? 0;
                const predictsTailing = evalRes.spots.some((sp) => sp.tailing);
                const improvedBuffering =
                  candPhase === 'C18' ||
                  candPhase === 'Al2O3_basic' ||
                  candCap > prevCap + 0.05 ||
                  (prevCap === 0 && (Boolean(sys.baseModifier) || Boolean(sys.acidModifier) || sys.alcoholPct >= 5));
                if (predictsTailing || !improvedBuffering) continue;
              }
            }

            // Ensure spots in this candidate follow-up solvent actually sit inside 0.12..0.84 (not re-saturating!)
            const prodSpotsHere = evalRes.spots.filter((sp) => sp.kind === 'product');
            const anyInWindow =
              prodSpotsHere.length > 0
                ? prodSpotsHere.some((sp) => sp.rf >= 0.12 && sp.rf <= 0.84)
                : evalRes.spots.some((sp) => sp.rf >= 0.12 && sp.rf <= 0.84);
            if (!anyInWindow) continue;

            rescued.push(wi);
            const isFrontW = frontCrowdedSet.has(wi);
            const isBaseW = baselinePinnedSet.has(wi);
            const isTailW = tailingSet.has(wi);
            if (isFrontW) rFront++;
            if (isBaseW) rBase++;
            if (isTailW) rTail++;
            if (!isFrontW && !isBaseW && !isTailW) rCoel++;

            weightedGain += evalRes.score;
            const prevRfs = beforeRfValuesByWell.get(wi);
            if (prevRfs) beforeRfs.push(...prevRfs);
            for (const sp of evalRes.spots) afterRfs.push(sp.rf);
          }

          if (rescued.length === 0) continue;
          const tierBonus =
            sys.preferenceTier === 'primary' || (isAllEqual && sys.stationaryPhase === 'C18') ? 0.25 : 0;
          const scoreRank = weightedGain + tierBonus;
          if (scoreRank > bestGain) {
            bestGain = scoreRank;
            const bMin = beforeRfs.length > 0 ? Math.min(...beforeRfs) : null;
            const bMax = beforeRfs.length > 0 ? Math.max(...beforeRfs) : null;
            const aMin = afterRfs.length > 0 ? Math.min(...afterRfs) : null;
            const aMax = afterRfs.length > 0 ? Math.max(...afterRfs) : null;
            const parts: string[] = [];
            if (rFront > 0) parts.push(`${rFront} front-crowded`);
            if (rBase > 0) parts.push(`${rBase} baseline-pinned`);
            if (rTail > 0) parts.push(`${rTail} tailing`);
            if (rCoel > 0) parts.push(`${rCoel} unresolved`);
            const rangeTxt =
              bMin !== null && bMax !== null && aMin !== null && aMax !== null
                ? ` · moves predicted spots from Rf ${bMin.toFixed(2)}–${bMax.toFixed(2)} → ${aMin.toFixed(2)}–${aMax.toFixed(2)}`
                : '';
            bestOpt = {
              system: sys,
              rescuedWellIndices: rescued,
              rescuedWellCoords: rescued.map((idx) => wellLabel(idx)),
              rescuedFrontCount: rFront,
              rescuedBaselineCount: rBase,
              rescuedCoelutedCount: rCoel,
              rescuedTailingCount: rTail,
              beforeRfRange: bMin !== null && bMax !== null ? [bMin, bMax] : null,
              afterRfRange: aMin !== null && aMax !== null ? [aMin, aMax] : null,
              reason: `Rescues ${rescued.length} well${rescued.length > 1 ? 's' : ''} (${parts.join(', ')})${rangeTxt}`,
            };
          }
        }

        if (!bestOpt) break;
        recommendations.push(bestOpt);
        pickedIds.add(bestOpt.system.id);
        for (const wi of bestOpt.rescuedWellIndices) remaining.delete(wi);
      }
    }

    let plateProgressionNote: string | undefined;
    if (relevantMeasuredPlates.length >= 2) {
      const firstCount = resolvedCountByPlate[0];
      const combinedCount = measuredResolvedWells.size;
      const gain = combinedCount - firstCount;
      const latestName = relevantMeasuredPlates[relevantMeasuredPlates.length - 1].matchedSystemName;
      plateProgressionNote =
        gain > 0
          ? `Follow-up plates (+ ${latestName}) expanded measured coverage from ${firstCount} → ${combinedCount}/${activeWells.length} wells (+${gain} rescued)`
          : `Measured ${relevantMeasuredPlates.length} plates (${firstCount} solo → ${combinedCount}/${activeWells.length} combined resolved)`;
    }

    followUpPlan = {
      plateIndex,
      summary: {
        measuredWellCount: activeWells.length,
        resolvedWellCount: measuredResolvedWells.size,
        frontCrowdedWells: Array.from(frontCrowdedSet).sort((a, b) => a - b),
        baselinePinnedWells: Array.from(baselinePinnedSet).sort((a, b) => a - b),
        coelutedWells: Array.from(coelutedSet).sort((a, b) => a - b),
        tailingWells: Array.from(tailingSet).sort((a, b) => a - b),
        ...(plateProgressionNote ? { plateProgressionNote } : {}),
      },
      recommendations,
    };
  }

  // Compute empirical plate diagnostics summary so UI can transparently surface how solvent physics scored
  const tolueneEvaluated = allCandidateSystems
    .filter((s) => (s.descriptors?.aromaticMix ?? 0) >= 0.25)
    .map((s) => {
      const sysMap = evalMatrix.get(s.id);
      let sSum = 0;
      let res = 0;
      for (const w of activeWells) {
        const sc = sysMap?.get(w.wellIndex)?.score ?? 0;
        sSum += sc;
        if (sc >= RESOLVED_SCORE) res++;
      }
      const meanScore = activeWells.length > 0 ? Math.round((sSum / activeWells.length) * 100) / 100 : 0;
      const coveragePct = activeWells.length > 0 ? Math.round((res / activeWells.length) * 100) : 0;
      return {
        id: s.id,
        name: s.name,
        meanScore,
        coveragePct,
        aromaticMix: s.descriptors?.aromaticMix ?? 0,
      };
    })
    .sort((a, b) => (b.coveragePct !== a.coveragePct ? b.coveragePct - a.coveragePct : b.meanScore - a.meanScore));

  const topTol = tolueneEvaluated[0];
  const bestRecMean =
    recommendedSystems.length > 0
      ? Math.max(...recommendedSystems.map((r) => r.meanResolutionScore))
      : 0;
  const empiricalProfile: EmpiricalPlateProfile = {
    targetStrengthMin: Math.round(targetStrengthMin * 100) / 100,
    targetStrengthMax: Math.round(targetStrengthMax * 100) / 100,
    meanAromaticRings,
    meanHbd,
    maxAcidStress: Math.round(maxAcidStress * 100) / 100,
    acidLabel: maxAcidLabel,
    recommendedMinBaseCap: hasStrongWellAcid && maxAcidStress >= 0.90 ? 1.35 : hasStrongWellAcid || plateNeedsBasicMod ? 0.95 : 0,
    tolueneRecommended: Boolean(
      aromaticHeavyPlate &&
        topTol &&
        topTol.coveragePct >= totalCoveragePct - 2 &&
        topTol.meanScore >= bestRecMean - 0.01
    ),
    topTolueneCandidate: topTol,
    synthesizedCandidateCount: dynamicSystems.filter((s) => s.isSynthesized).length,
    synthesizedInTopSetCount: recommendedSystems.filter((r) => r.system.isSynthesized).length,
    prismaCandidateCount: dynamicSystems.filter((s) => s.family === 'prisma_ternary').length,
  };

  return {
    plateIndex,
    stationaryPhase: stationaryPhasePref,
    activeWellCount: activeWells.length,
    highRankedWellCount,
    resolvedWellCount,
    unresolvedWellIndices,
    totalCoveragePct,
    recommendedSystems,
    otherSystems,
    otherGroups,
    wellPredictions,
    summaryNotes,
    calibrationApplied,
    followUpPlan,
    empiricalProfile,
  };
}
