// Robowski Studio - 54-Well TLC Solvent System Advisor (SiO2 Normal Phase + C18 Reverse Phase)
import { PredictedSpecies, WellConditionConfig, WellPredictionResult } from './types';
import { predictWellReactions } from './engine';
import { extractWellForPrediction } from './plateBridge';
import { wellLabel } from '../tlcLanes';
import { RunResult, RunState } from '../../types';

export type TlcStationaryPhase = 'SiO2' | 'C18';
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
  | 'c18_rp';

export interface TlcSolventSystemDef {
  id: string;
  name: string;
  shortLabel: string;
  ratio: string;
  chamberPrep20mL: string;
  stationaryPhase: TlcStationaryPhase;
  preferenceTier: SolventPreferenceTier;
  family: SolventFamily;
  strength: number; // Effective eluent strength (~0.10 to ~0.92 within its stationary phase)
  alcoholPct: number; // % MeOH / protic H-bond competitor
  organicPct?: number; // % organic co-solvent for C18 reverse phase
  baseModifier?: string; // e.g. '1% Et₃N', '2M NH₃ in MeOH'
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
}

export const TLC_SOLVENT_LIBRARY: TlcSolventSystemDef[] = [
  // =========================================================================
  // PRIMARY / PREFERRED WORKHORSE SYSTEMS (EtOAc/Hex, MeOH/DCM, Et3N, 2M NH3/MeOH, AcOH)
  // =========================================================================
  {
    id: 'etoac_hex_10',
    name: '10% EtOAc / Hexanes',
    shortLabel: '10% EtOAc/Hex',
    ratio: '1:9 v/v EtOAc / Hexanes',
    chamberPrep20mL: '2.0 mL EtOAc + 18.0 mL Hexanes',
    stationaryPhase: 'SiO2',
    preferenceTier: 'primary',
    family: 'etoac_hex',
    strength: 0.14,
    alcoholPct: 0,
    polarityClass: 'Non-Polar',
    bestFor: 'Lipophilic arenes, halides, simple esters, nonpolar ketones',
  },
  {
    id: 'etoac_hex_25',
    name: '25% EtOAc / Hexanes',
    shortLabel: '25% EtOAc/Hex',
    ratio: '1:3 v/v EtOAc / Hexanes',
    chamberPrep20mL: '5.0 mL EtOAc + 15.0 mL Hexanes',
    stationaryPhase: 'SiO2',
    preferenceTier: 'primary',
    family: 'etoac_hex',
    strength: 0.28,
    alcoholPct: 0,
    polarityClass: 'Low-Med Polarity',
    bestFor: 'Aldehydes, ketones, indoles, moderately lipophilic adducts',
  },
  {
    id: 'etoac_hex_50',
    name: '50% EtOAc / Hexanes',
    shortLabel: '50% EtOAc/Hex',
    ratio: '1:1 v/v EtOAc / Hexanes',
    chamberPrep20mL: '10.0 mL EtOAc + 10.0 mL Hexanes',
    stationaryPhase: 'SiO2',
    preferenceTier: 'primary',
    family: 'etoac_hex',
    strength: 0.45,
    alcoholPct: 0,
    polarityClass: 'Medium Polarity',
    bestFor: 'Workhorse neutral organics, amides, mono-heterocycles',
  },
  {
    id: 'etoac_hex_80',
    name: '80% EtOAc / Hexanes',
    shortLabel: '80% EtOAc/Hex',
    ratio: '4:1 v/v EtOAc / Hexanes',
    chamberPrep20mL: '16.0 mL EtOAc + 4.0 mL Hexanes',
    stationaryPhase: 'SiO2',
    preferenceTier: 'primary',
    family: 'etoac_hex',
    strength: 0.59,
    alcoholPct: 0,
    polarityClass: 'Medium Polarity',
    bestFor: 'Polar carbonyls, sulfones, neutral heterocycles',
  },
  {
    id: 'etoac_100',
    name: '100% EtOAc',
    shortLabel: '100% EtOAc',
    ratio: 'Neat Ethyl Acetate',
    chamberPrep20mL: '20.0 mL EtOAc',
    stationaryPhase: 'SiO2',
    preferenceTier: 'primary',
    family: 'etoac_hex',
    strength: 0.69,
    alcoholPct: 0,
    polarityClass: 'Polar',
    bestFor: 'Strongly retained neutral products without MeOH alcoholysis risk',
  },
  {
    id: 'meoh_dcm_3',
    name: '3% MeOH / DCM',
    shortLabel: '3% MeOH/DCM',
    ratio: '3:97 v/v MeOH / DCM',
    chamberPrep20mL: '0.6 mL MeOH + 19.4 mL DCM',
    stationaryPhase: 'SiO2',
    preferenceTier: 'primary',
    family: 'meoh_dcm',
    strength: 0.61,
    alcoholPct: 3,
    polarityClass: 'Medium Polarity',
    bestFor: 'Secondary amides, alcohols, benzimidazoles, clean sharp spots',
  },
  {
    id: 'meoh_dcm_7',
    name: '7% MeOH / DCM',
    shortLabel: '7% MeOH/DCM',
    ratio: '7:93 v/v MeOH / DCM',
    chamberPrep20mL: '1.4 mL MeOH + 18.6 mL DCM',
    stationaryPhase: 'SiO2',
    preferenceTier: 'primary',
    family: 'meoh_dcm',
    strength: 0.74,
    alcoholPct: 7,
    polarityClass: 'Polar',
    bestFor: 'Imidazoles, ureas, poly-heterocycles, polar cascade adducts',
  },
  {
    id: 'meoh_dcm_12',
    name: '12% MeOH / DCM',
    shortLabel: '12% MeOH/DCM',
    ratio: '12:88 v/v MeOH / DCM',
    chamberPrep20mL: '2.4 mL MeOH + 17.6 mL DCM',
    stationaryPhase: 'SiO2',
    preferenceTier: 'primary',
    family: 'meoh_dcm',
    strength: 0.85,
    alcoholPct: 12,
    polarityClass: 'Polar',
    bestFor: 'Very polar multi-heterocycle / polyol / bis-amide targets',
  },
  {
    id: 'nh3_meoh_dcm_5',
    name: 'DCM / MeOH / (2M NH₃ in MeOH) (95:3:2)',
    shortLabel: '95:3:2 DCM/MeOH/NH₃',
    ratio: '95:3:2 v/v/v DCM / MeOH / (2M NH₃ in MeOH)',
    chamberPrep20mL: '19.0 mL DCM + 0.6 mL MeOH + 0.4 mL (2M NH₃ in MeOH)',
    stationaryPhase: 'SiO2',
    preferenceTier: 'primary',
    family: 'basic_mod',
    strength: 0.70,
    alcoholPct: 5,
    baseModifier: '2% (2M NH₃ in MeOH)',
    polarityClass: 'Basic Polar',
    bestFor: '5% total MeOH with controlled NH₃ — prevents amine/azole tailing without excess base',
  },
  {
    id: 'nh3_meoh_dcm_10',
    name: 'DCM / MeOH / (2M NH₃ in MeOH) (88:10:2)',
    shortLabel: '88:10:2 DCM/MeOH/NH₃',
    ratio: '88:10:2 v/v/v DCM / MeOH / (2M NH₃ in MeOH)',
    chamberPrep20mL: '17.6 mL DCM + 2.0 mL MeOH + 0.4 mL (2M NH₃ in MeOH)',
    stationaryPhase: 'SiO2',
    preferenceTier: 'primary',
    family: 'basic_mod',
    strength: 0.86,
    alcoholPct: 12,
    baseModifier: '2% (2M NH₃ in MeOH)',
    polarityClass: 'Basic Polar',
    bestFor: '12% total MeOH with 2% (2M NH₃/MeOH) — matches 12% MeOH ceiling for polar amines, guanidines & diamines',
  },
  {
    id: 'meoh_dcm_et3n',
    name: '12% MeOH / DCM + 1% Et₃N',
    shortLabel: '12% MeOH/DCM + Et₃N',
    ratio: '12:87:1 v/v/v MeOH / DCM / Et₃N',
    chamberPrep20mL: '2.4 mL MeOH + 17.4 mL DCM + 0.2 mL Et₃N',
    stationaryPhase: 'SiO2',
    preferenceTier: 'primary',
    family: 'basic_mod',
    strength: 0.84,
    alcoholPct: 12,
    baseModifier: '1% Et₃N',
    polarityClass: 'Basic Polar',
    bestFor: '12% MeOH/DCM with silanol deactivation by Et₃N — basic amines, amidines & N-rich heterocycles',
  },
  {
    id: 'meoh_dcm_acoh',
    name: '8% MeOH / DCM + 1% AcOH',
    shortLabel: '8% MeOH/DCM + AcOH',
    ratio: '8:91:1 v/v/v MeOH / DCM / AcOH',
    chamberPrep20mL: '1.6 mL MeOH + 18.2 mL DCM + 0.2 mL AcOH',
    stationaryPhase: 'SiO2',
    preferenceTier: 'primary',
    family: 'acid_mod',
    strength: 0.78,
    alcoholPct: 8,
    acidModifier: '1% AcOH',
    polarityClass: 'Acidic Polar',
    bestFor: 'Carboxylic acids & acidic heterocycles to prevent silica tailing',
  },

  // =========================================================================
  // OTHER AVAILABLE COMPLEMENTARY SYSTEMS (Acetone/Hex, MeOH/EtOAc, MeOH/Toluene, EtOAc/DCM, Et2O/Pentane, C18 RP)
  // =========================================================================
  {
    id: 'acetone_hex_25',
    name: '25% Acetone / Hexanes',
    shortLabel: '25% Acetone/Hex',
    ratio: '1:3 v/v Acetone / Hexanes',
    chamberPrep20mL: '5.0 mL Acetone + 15.0 mL Hexanes',
    stationaryPhase: 'SiO2',
    preferenceTier: 'secondary',
    family: 'acetone_hex',
    strength: 0.34,
    alcoholPct: 0,
    polarityClass: 'Low-Med Polarity',
    bestFor: 'Orthogonal H-bond acceptor selectivity when EtOAc/Hex spots co-elute',
  },
  {
    id: 'acetone_hex_50',
    name: '50% Acetone / Hexanes',
    shortLabel: '50% Acetone/Hex',
    ratio: '1:1 v/v Acetone / Hexanes',
    chamberPrep20mL: '10.0 mL Acetone + 10.0 mL Hexanes',
    stationaryPhase: 'SiO2',
    preferenceTier: 'secondary',
    family: 'acetone_hex',
    strength: 0.56,
    alcoholPct: 0,
    polarityClass: 'Medium Polarity',
    bestFor: 'Polar alcohols, amides & heterocycles — often sharper than EtOAc/Hex',
  },
  {
    id: 'meoh_etoac_5',
    name: '5% MeOH / EtOAc',
    shortLabel: '5% MeOH/EtOAc',
    ratio: '1:19 v/v MeOH / EtOAc',
    chamberPrep20mL: '1.0 mL MeOH + 19.0 mL EtOAc',
    stationaryPhase: 'SiO2',
    preferenceTier: 'secondary',
    family: 'meoh_etoac',
    strength: 0.77,
    alcoholPct: 5,
    polarityClass: 'Polar',
    bestFor: 'DCM-free polar eluent for multi-H-bond acceptors, nucleosides & azoles',
  },
  {
    id: 'meoh_etoac_10',
    name: '10% MeOH / EtOAc',
    shortLabel: '10% MeOH/EtOAc',
    ratio: '1:9 v/v MeOH / EtOAc',
    chamberPrep20mL: '2.0 mL MeOH + 18.0 mL EtOAc',
    stationaryPhase: 'SiO2',
    preferenceTier: 'secondary',
    family: 'meoh_etoac',
    strength: 0.87,
    alcoholPct: 10,
    polarityClass: 'Polar',
    bestFor: 'Very polar neutral polyols/bis-amides without chlorinated solvents',
  },
  {
    id: 'meoh_toluene_5',
    name: '5% MeOH / Toluene',
    shortLabel: '5% MeOH/Toluene',
    ratio: '1:19 v/v MeOH / Toluene',
    chamberPrep20mL: '1.0 mL MeOH + 19.0 mL Toluene',
    stationaryPhase: 'SiO2',
    preferenceTier: 'secondary',
    family: 'meoh_toluene',
    strength: 0.54,
    alcoholPct: 5,
    polarityClass: 'Medium Polarity',
    bestFor: 'Aromatic π-π selectivity — separates indoles, benzimidazoles & regioisomers',
  },
  {
    id: 'meoh_toluene_10',
    name: '10% MeOH / Toluene',
    shortLabel: '10% MeOH/Toluene',
    ratio: '1:9 v/v MeOH / Toluene',
    chamberPrep20mL: '2.0 mL MeOH + 18.0 mL Toluene',
    stationaryPhase: 'SiO2',
    preferenceTier: 'secondary',
    family: 'meoh_toluene',
    strength: 0.68,
    alcoholPct: 10,
    polarityClass: 'Polar',
    bestFor: 'Polar aromatic heterocycles that streak or overlap in MeOH/DCM',
  },
  {
    id: 'etoac_dcm_20',
    name: '20% EtOAc / DCM',
    shortLabel: '20% EtOAc/DCM',
    ratio: '1:4 v/v EtOAc / DCM',
    chamberPrep20mL: '4.0 mL EtOAc + 16.0 mL DCM',
    stationaryPhase: 'SiO2',
    preferenceTier: 'secondary',
    family: 'etoac_dcm',
    strength: 0.38,
    alcoholPct: 0,
    polarityClass: 'Low-Med Polarity',
    bestFor: 'Aprotic medium polarity for poorly hexane-soluble heterocycles',
  },
  {
    id: 'et2o_pentane_40',
    name: '40% Et₂O / Pentane',
    shortLabel: '40% Et₂O/Pentane',
    ratio: '2:3 v/v Et₂O / Pentane',
    chamberPrep20mL: '8.0 mL Et₂O + 12.0 mL Pentane',
    stationaryPhase: 'SiO2',
    preferenceTier: 'secondary',
    family: 'ether_pentane',
    strength: 0.24,
    alcoholPct: 0,
    polarityClass: 'Non-Polar',
    bestFor: 'Volatile nonpolar products, aldehydes, enones & low-MW intermediates',
  },
  {
    id: 'c18_mecn_30',
    name: '30% MeCN / H₂O (C18 RP)',
    shortLabel: '30% MeCN/H₂O (C18)',
    ratio: '3:7 v/v MeCN / H₂O on C18 Silica',
    chamberPrep20mL: '6.0 mL MeCN + 14.0 mL H₂O (C18 plate)',
    stationaryPhase: 'C18',
    preferenceTier: 'secondary',
    family: 'c18_rp',
    strength: 0.30,
    alcoholPct: 0,
    organicPct: 30,
    polarityClass: 'Reverse Phase (C18)',
    bestFor: 'Highly polar water-soluble products, guanidines & zwitterions pinned on SiO₂',
  },
  {
    id: 'c18_mecn_60',
    name: '60% MeCN / H₂O (C18 RP)',
    shortLabel: '60% MeCN/H₂O (C18)',
    ratio: '3:2 v/v MeCN / H₂O on C18 Silica',
    chamberPrep20mL: '12.0 mL MeCN + 8.0 mL H₂O (C18 plate)',
    stationaryPhase: 'C18',
    preferenceTier: 'secondary',
    family: 'c18_rp',
    strength: 0.60,
    alcoholPct: 0,
    organicPct: 60,
    polarityClass: 'Reverse Phase (C18)',
    bestFor: 'General med-chem reverse-phase separation orthogonal to normal-phase SiO₂',
  },
  {
    id: 'c18_mecn_85',
    name: '85% MeCN / H₂O (C18 RP)',
    shortLabel: '85% MeCN/H₂O (C18)',
    ratio: '17:3 v/v MeCN / H₂O on C18 Silica',
    chamberPrep20mL: '17.0 mL MeCN + 3.0 mL H₂O (C18 plate)',
    stationaryPhase: 'C18',
    preferenceTier: 'secondary',
    family: 'c18_rp',
    strength: 0.85,
    alcoholPct: 0,
    organicPct: 85,
    polarityClass: 'Reverse Phase (C18)',
    bestFor: 'Lipophilic products (cLogP > 3) verified by orthogonal reverse-phase C18',
  },
  {
    id: 'c18_meoh_50_tfa',
    name: '50% MeOH / H₂O + 0.1% TFA (C18 RP)',
    shortLabel: '50% MeOH/H₂O + TFA (C18)',
    ratio: '50:50:0.1 MeOH / H₂O / TFA on C18',
    chamberPrep20mL: '10.0 mL MeOH + 10.0 mL H₂O + 20 µL TFA (C18 plate)',
    stationaryPhase: 'C18',
    preferenceTier: 'secondary',
    family: 'c18_rp',
    strength: 0.45,
    alcoholPct: 50,
    organicPct: 50,
    acidModifier: '0.1% TFA',
    polarityClass: 'Reverse Phase (C18)',
    bestFor: 'Sharp LC-MS-matched C18 spots for basic amines, guanidines & carboxylic acids',
  },
];

export interface TlcMolProfile {
  smiles: string;
  tpsa: number;
  clogP: number;
  hbd: number;
  hba: number;
  aromaticRings: number;
  aliphAmineCount: number;
  azoleCount: number;
  pyridineCount: number;
  carboxylicAcidCount: number;
}

export interface SimulatedSpot {
  kind: 'substrate' | 'product';
  label: string;
  code: string;
  smiles: string;
  formula: string;
  rf: number;
  score?: number;
  tier?: PredictedSpecies['tier'];
  tailing: boolean;
  tailingReason?: string;
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

export interface RecommendedPlateSolvent {
  system: TlcSolventSystemDef;
  rank: number;
  assignedWellIndices: number[];
  assignedWellCoords: string[];
  resolvedWellCount: number;
  highRankedResolvedCount: number;
  wellCoveragePct: number;
  meanResolutionScore: number;
  lanes: SimulatedWellLane[];
}

export type SolventPoolMode = 'prefer_primary' | 'primary_only' | 'balanced';

export interface PlateSolventPlanResult {
  plateIndex: number;
  activeWellCount: number;
  highRankedWellCount: number;
  resolvedWellCount: number;
  totalCoveragePct: number;
  recommendedSystems: RecommendedPlateSolvent[];
  otherSystems: RecommendedPlateSolvent[];
  wellPredictions: Record<number, WellPredictionResult>;
  summaryNotes: string[];
}

export interface PlateSolventPlanOptions {
  plateIndex?: number;
  maxSystems?: number; // 2, 3, or 4 (default 3)
  poolMode?: SolventPoolMode; // default 'prefer_primary'
  conditionOverrides?: Partial<WellConditionConfig>;
  cachedPredictions?: Record<string, WellPredictionResult>;
  includeSpeculative?: boolean;
  onProgress?: (done: number, total: number) => void;
  signal?: AbortSignal;
}

const TLCMOTIF_SMARTS: Array<[keyof Pick<TlcMolProfile, 'aliphAmineCount' | 'azoleCount' | 'pyridineCount' | 'carboxylicAcidCount'>, string]> = [
  [
    'aliphAmineCount',
    '[$([NX3;H2,H1,H0;$(N-[#6;X4]);!$(N-C=[O,S,N]);!$(N-c);!$(N-S=O)]),$([NX3;H2,H1,H0;!$(N-C=O)]-[CX3]=[NX2])]',
  ],
  ['azoleCount', '[nX2r5,nX3H1r5]'],
  ['pyridineCount', '[nX2r6]'],
  ['carboxylicAcidCount', '[CX3](=[OX1])[OX2H1]'],
];

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

export function profileMoleculeForTlc(
  rdkit: any,
  smiles: string,
  cache?: Map<string, TlcMolProfile>
): TlcMolProfile {
  const clean = (smiles || '').trim();
  if (cache?.has(clean)) return cache.get(clean)!;

  const fallback: TlcMolProfile = {
    smiles: clean,
    tpsa: 35,
    clogP: 1.5,
    hbd: 1,
    hba: 2,
    aromaticRings: 1,
    aliphAmineCount: 0,
    azoleCount: 0,
    pyridineCount: 0,
    carboxylicAcidCount: 0,
  };
  if (!rdkit || !clean) return fallback;

  let mol: any = null;
  try {
    mol = rdkit.get_mol(clean);
    if (!mol || !mol.is_valid()) return fallback;
    const desc = JSON.parse(mol.get_descriptors());

    const counts: Record<string, number> = {
      aliphAmineCount: 0,
      azoleCount: 0,
      pyridineCount: 0,
      carboxylicAcidCount: 0,
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

    const prof: TlcMolProfile = {
      smiles: clean,
      tpsa: Number(desc.tpsa) || 0,
      clogP: Number(desc.CrippenClogP) || 0,
      hbd: Number(desc.NumHBD) || 0,
      hba: Number(desc.NumHBA) || 0,
      aromaticRings: Number(desc.NumAromaticRings) || 0,
      aliphAmineCount: counts.aliphAmineCount,
      azoleCount: counts.azoleCount,
      pyridineCount: counts.pyridineCount,
      carboxylicAcidCount: counts.carboxylicAcidCount,
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
 * Predicts TLC Rf (0.02..0.96) and streaking risk on either Normal-Phase SiO2 or Reverse-Phase C18.
 */
export function predictTlcRf(
  profile: TlcMolProfile,
  system: TlcSolventSystemDef
): { rf: number; tailing: boolean; tailingReason?: string } {
  // -------------------------------------------------------------------------
  // CASE A: REVERSE-PHASE C18 TLC (Polarity & elution order inverted!)
  // -------------------------------------------------------------------------
  if (system.stationaryPhase === 'C18') {
    const orgFrac = (system.organicPct ?? system.strength * 100) / 100;
    const isMeCN = system.id.includes('mecn');
    const isAcidic = Boolean(system.acidModifier);

    // Lipophilicity increases C18 binding; TPSA/HBD/ionizable groups decrease C18 binding
    const polarRelease =
      Math.min(0.45, profile.tpsa * 0.0042) +
      profile.hbd * 0.055 +
      profile.aliphAmineCount * (isAcidic ? 0.24 : 0.14) +
      profile.azoleCount * 0.07 +
      profile.carboxylicAcidCount * (isAcidic ? 0.04 : 0.14);

    const lipoRetention =
      0.16 +
      Math.max(-0.2, profile.clogP * 0.21) +
      profile.aromaticRings * 0.055 -
      polarRelease;

    const rpEluentPower = orgFrac * (isMeCN ? 1.08 : 0.94) + (isAcidic ? 0.05 : 0);

    let tailing = false;
    let tailingReason: string | undefined;
    if (!isAcidic && profile.aliphAmineCount >= 1) {
      tailing = true;
      tailingReason = 'Basic amine can tail on C18 without 0.1% TFA modifier';
    }

    const z = Math.max(-10, Math.min(10, 4.8 * (rpEluentPower - lipoRetention)));
    const rawRf = 1 / (1 + Math.exp(-z));
    const rf = Math.round(Math.max(0.02, Math.min(0.96, rawRf)) * 100) / 100;
    return { rf, tailing, tailingReason };
  }

  // -------------------------------------------------------------------------
  // CASE B: NORMAL-PHASE SILICA (SiO2)
  // -------------------------------------------------------------------------
  const lipophilicityOffset = Math.max(-0.14, Math.min(0.22, (profile.clogP - 1.4) * 0.04));

  let demand =
    0.04 +
    Math.min(0.55, profile.tpsa * 0.0044) +
    profile.hbd * 0.062 +
    Math.max(0, profile.hba - 1) * 0.018 +
    Math.min(0.28, profile.azoleCount * 0.055) +
    profile.pyridineCount * 0.055 -
    lipophilicityOffset;

  // Solvent-family orthogonal selectivity adjustments
  if (system.family === 'meoh_toluene') {
    // Aromatic pi-pi competition reduces retention of aromatic rings relative to aliphatic H-bonders
    demand -= Math.min(0.11, profile.aromaticRings * 0.032);
  } else if (system.family === 'acetone_hex') {
    // Acetone carbonyl competes selectively against HBD & alcohols relative to EtOAc
    demand -= Math.min(0.08, profile.hbd * 0.028);
  } else if (system.family === 'meoh_etoac') {
    demand -= Math.min(0.07, profile.hbd * 0.022 + profile.hba * 0.008);
  } else if (system.family === 'etoac_dcm') {
    demand -= Math.min(0.06, profile.aromaticRings * 0.02);
  }

  let tailing = false;
  let tailingReason: string | undefined;

  // Aliphatic amines / guanidines / amidines pin tightly to silanols unless base modifier is present
  if (profile.aliphAmineCount > 0) {
    if (system.baseModifier) {
      const isNh3 = system.baseModifier.includes('NH₃');
      demand += Math.min(isNh3 ? 0.14 : 0.17, profile.aliphAmineCount * (isNh3 ? 0.055 : 0.07));
    } else {
      demand += Math.min(0.58, 0.30 + profile.aliphAmineCount * 0.16);
      tailing = true;
      tailingReason = 'Basic amine pins/tails without Et₃N or NH₃-MeOH';
    }
  } else if (profile.azoleCount >= 3 && system.alcoholPct === 0 && !system.baseModifier) {
    tailing = true;
    tailingReason = 'Multi-azole H-bonding may streak in aprotic solvent';
  }

  // Carboxylic acids dimerize & streak unless AcOH modifier is present
  if (profile.carboxylicAcidCount > 0) {
    if (system.acidModifier) {
      demand += Math.min(0.18, profile.carboxylicAcidCount * 0.08);
    } else {
      demand += Math.min(0.55, 0.28 + profile.carboxylicAcidCount * 0.15);
      tailing = true;
      tailingReason = 'Carboxylic acid tails without AcOH';
    }
  }

  // Protic MeOH competes strongly against silica H-bonding
  const proticBoost =
    system.alcoholPct > 0
      ? Math.min(0.18, system.alcoholPct * 0.0115 * Math.max(0.4, (profile.hbd + profile.azoleCount * 0.5) * 0.5))
      : 0;

  const effectiveStrength = system.strength + proticBoost;
  const z = Math.max(-12, Math.min(12, 6.2 * (effectiveStrength - demand)));
  const rawRf = 1 / (1 + Math.exp(-z));
  const rf = Math.round(Math.max(0.02, Math.min(0.96, rawRf)) * 100) / 100;

  return { rf, tailing, tailingReason };
}

/** Backwards-compatible alias for predictTlcRf */
export const predictNormalPhaseRf = predictTlcRf;

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

function deltaScore(deltaRf: number): number {
  if (deltaRf >= 0.16) return 1.0;
  if (deltaRf >= 0.10) return 0.65 + ((deltaRf - 0.10) / 0.06) * 0.35;
  if (deltaRf >= 0.05) return 0.25 + ((deltaRf - 0.05) / 0.05) * 0.4;
  return Math.max(0.05, (deltaRf / 0.05) * 0.25);
}

interface WellCandidateData {
  wellIndex: number;
  wellCoord: string;
  importanceWeight: number;
  hasHighOrMed: boolean;
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
  }>;
}

function evaluateWellInSolvent(
  well: WellCandidateData,
  system: TlcSolventSystemDef
): { score: number; deltaRf: number; bestProductRf: number | null; spots: SimulatedSpot[] } {
  const subSpots: SimulatedSpot[] = well.substrates.map((s) => {
    const pred = predictTlcRf(s.profile, system);
    return {
      kind: 'substrate',
      label: s.name || s.code,
      code: s.code,
      smiles: s.smiles,
      formula: s.formula,
      rf: pred.rf,
      tailing: pred.tailing,
      tailingReason: pred.tailingReason,
    };
  });

  const prodSpots: SimulatedSpot[] = well.products.map((p, idx) => {
    const pred = predictTlcRf(p.profile, system);
    return {
      kind: 'product',
      label: p.label || `Product #${idx + 1}`,
      code: `#${idx + 1}`,
      smiles: p.smiles,
      formula: p.formula,
      rf: pred.rf,
      score: p.score,
      tier: p.tier,
      tailing: pred.tailing,
      tailingReason: pred.tailingReason,
    };
  });

  if (well.products.length === 0) {
    const readableFrac =
      subSpots.length > 0
        ? subSpots.reduce((acc, s) => acc + windowScore(s.rf) * (s.tailing ? 0.65 : 1), 0) / subSpots.length
        : 0;
    return {
      score: Math.round(readableFrac * 1000) / 1000,
      deltaRf: 0,
      bestProductRf: null,
      spots: [...subSpots],
    };
  }

  let wSum = 0;
  let scoreSum = 0;
  let primaryDelta = 0;
  let primaryRf: number | null = null;

  well.products.forEach((p, idx) => {
    const pSpot = prodSpots[idx];
    const minSubDelta =
      subSpots.length > 0 ? Math.min(...subSpots.map((s) => Math.abs(pSpot.rf - s.rf))) : 0.25;

    let crowdFactor = 1.0;
    for (let j = 0; j < idx; j++) {
      if (Math.abs(pSpot.rf - prodSpots[j].rf) < 0.04) {
        crowdFactor *= 0.85;
      }
    }

    const tailFactor = pSpot.tailing ? 0.52 : 1.0;
    const subTailPenalty = subSpots.some((s) => s.tailing) ? 0.88 : 1.0;
    const qual = windowScore(pSpot.rf) * deltaScore(minSubDelta) * tailFactor * subTailPenalty * crowdFactor;

    if (idx === 0) {
      primaryDelta = Math.round(minSubDelta * 100) / 100;
      primaryRf = pSpot.rf;
    }

    wSum += p.weight;
    scoreSum += p.weight * qual;
  });

  return {
    score: Math.round((wSum > 0 ? scoreSum / wSum : 0) * 1000) / 1000,
    deltaRf: primaryDelta,
    bestProductRf: primaryRf,
    spots: [...subSpots, ...prodSpots],
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

function polarityBand(sys: TlcSolventSystemDef): string {
  if (sys.stationaryPhase === 'C18') return 'c18';
  if (sys.baseModifier) return 'basic_np';
  if (sys.acidModifier) return 'acid_np';
  if (sys.strength < 0.35) return 'low_np';
  if (sys.strength < 0.65) return 'med_np';
  return 'polar_np';
}

function buildSystemPlanEntry(
  sys: TlcSolventSystemDef,
  rank: number,
  activeWellsCount: number,
  wellDataByIdx: Map<number, WellCandidateData>,
  sysMap: Map<number, ReturnType<typeof evaluateWellInSolvent>>,
  bestOwnerByWell: Map<number, string>
): RecommendedPlateSolvent {
  const PLATE_SIZE = 54;
  const assignedWellIndices: number[] = [];
  let resCount = 0;
  let highMedCount = 0;
  let scoreAccum = 0;

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
    if (evalRes.score >= 0.48) {
      resCount++;
      if (wData.hasHighOrMed) highMedCount++;
    }
    scoreAccum += evalRes.score;

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

  return {
    system: sys,
    rank,
    assignedWellIndices,
    assignedWellCoords: assignedWellIndices.map((idx) => wellLabel(idx)),
    resolvedWellCount: resCount,
    highRankedResolvedCount: highMedCount,
    wellCoveragePct: activeWellsCount > 0 ? Math.round((resCount / activeWellsCount) * 100) : 0,
    meanResolutionScore: activeWellsCount > 0 ? Math.round((scoreAccum / activeWellsCount) * 100) / 100 : 0,
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
  const includeSpeculative = options.includeSpeculative ?? false;

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

    const rawProds = (pred?.species || []).slice(0, 8);
    const products = rawProds.map((sp) => {
      const imp = tierImportance(sp.tier) * Math.max(0.08, sp.score * sp.score);
      return {
        key: sp.key,
        smiles: sp.smiles,
        formula: sp.formula,
        score: sp.score,
        tier: sp.tier,
        weight: imp,
        label: sp.mechanismSummary || sp.formula,
        profile: profileMoleculeForTlc(rdkit, sp.smiles, profileCache),
      };
    });

    const hasHighOrMed = products.some((p) => p.tier === 'High' || p.tier === 'Medium');
    const topScore = products[0]?.score ?? 0;
    const importanceWeight = hasHighOrMed
      ? 1.0 + (products[0]?.tier === 'High' ? 1.4 : 0.7) * topScore
      : products.length > 0
      ? 0.45 + 0.4 * topScore
      : 0.16;

    wellDataByIdx.set(w, {
      wellIndex: w,
      wellCoord: wellLabel(w),
      importanceWeight,
      hasHighOrMed,
      substrates: subsProfiles,
      products,
    });

    options.onProgress?.(i + 1, activeIndices.length);
    await yieldIfFrameExceeded();
  }

  // 2. Score every system in TLC_SOLVENT_LIBRARY across every active well
  const activeWells = activeIndices
    .map((w) => wellDataByIdx.get(w))
    .filter((x): x is WellCandidateData => Boolean(x && x.substrates.length > 0));

  const evalMatrix = new Map<string, Map<number, ReturnType<typeof evaluateWellInSolvent>>>();
  for (const sys of TLC_SOLVENT_LIBRARY) {
    const m = new Map<number, ReturnType<typeof evaluateWellInSolvent>>();
    for (const w of activeWells) {
      m.set(w.wellIndex, evaluateWellInSolvent(w, sys));
    }
    evalMatrix.set(sys.id, m);
    await yieldIfFrameExceeded();
  }

  // 3. Filter candidate search pool by poolMode, then run exact complementary set cover
  const searchPool =
    poolMode === 'primary_only'
      ? TLC_SOLVENT_LIBRARY.filter((s) => s.preferenceTier === 'primary')
      : TLC_SOLVENT_LIBRARY;

  const numActive = activeWells.length;
  const importanceArr = new Float64Array(numActive);
  let totalImportance = 0;
  for (let wi = 0; wi < numActive; wi++) {
    const imp = activeWells[wi].importanceWeight;
    importanceArr[wi] = imp;
    totalImportance += imp;
  }
  if (totalImportance <= 0) totalImportance = 1;

  const poolLen = searchPool.length;
  const scoreGrid: Float64Array[] = searchPool.map((sys) => {
    const sysMap = evalMatrix.get(sys.id)!;
    const arr = new Float64Array(numActive);
    for (let wi = 0; wi < numActive; wi++) {
      arr[wi] = sysMap.get(activeWells[wi].wellIndex)!.score;
    }
    return arr;
  });

  const famIndexMap = new Map<string, number>();
  const bandIndexMap = new Map<string, number>();
  const famBit = new Int32Array(poolLen);
  const bandBit = new Int32Array(poolLen);
  const primaryFlag = new Uint8Array(poolLen);

  for (let sIdx = 0; sIdx < poolLen; sIdx++) {
    const sys = searchPool[sIdx];
    let fi = famIndexMap.get(sys.family);
    if (fi === undefined) {
      fi = famIndexMap.size;
      famIndexMap.set(sys.family, fi);
    }
    famBit[sIdx] = 1 << fi;

    const bKey = polarityBand(sys);
    let bi = bandIndexMap.get(bKey);
    if (bi === undefined) {
      bi = bandIndexMap.size;
      bandIndexMap.set(bKey, bi);
    }
    bandBit[sIdx] = 1 << bi;
    primaryFlag[sIdx] = sys.preferenceTier === 'primary' ? 1 : 0;
  }

  const pairPenalty = new Float64Array(poolLen * poolLen);
  for (let i = 0; i < poolLen; i++) {
    const a = searchPool[i];
    for (let j = i + 1; j < poolLen; j++) {
      const b = searchPool[j];
      let pen = 0;
      if (a.family === b.family && Math.abs(a.strength - b.strength) < 0.16) {
        pen = 0.065;
      } else if (a.stationaryPhase === 'C18' && b.stationaryPhase === 'C18' && Math.abs(a.strength - b.strength) < 0.25) {
        pen = 0.05;
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

  let bestComboIdx: number[] = [0];
  let bestObjective = -1e9;
  const assignedCounts = new Int32Array(effK);

  for (let cNum = 0; cNum < combos.length; cNum++) {
    const combo = combos[cNum];
    assignedCounts.fill(0);
    let weightedSum = 0;

    for (let wi = 0; wi < numActive; wi++) {
      let bestW = -1;
      let bestOwner = 0;
      for (let cIdx = 0; cIdx < effK; cIdx++) {
        const sc = scoreGrid[combo[cIdx]][wi];
        if (sc > bestW) {
          bestW = sc;
          bestOwner = cIdx;
        }
      }
      if (bestW > 0.35) assignedCounts[bestOwner]++;
      if (bestW > 0) weightedSum += importanceArr[wi] * bestW;
    }

    let activeSystemsUsed = 0;
    let famMask = 0;
    let bandMask = 0;
    let primaryCount = 0;
    let redundancyPenalty = 0;

    for (let i = 0; i < effK; i++) {
      const si = combo[i];
      if (assignedCounts[i] > 0) activeSystemsUsed++;
      famMask |= famBit[si];
      bandMask |= bandBit[si];
      primaryCount += primaryFlag[si];
      for (let j = i + 1; j < effK; j++) {
        redundancyPenalty += pairPenalty[si * poolLen + combo[j]];
      }
    }

    const distinctFamilies = popCount(famMask);
    const distinctBands = popCount(bandMask);
    const primaryBonus =
      poolMode === 'prefer_primary' ? 0.055 * (primaryCount / effK) : 0;

    const obj =
      weightedSum / totalImportance +
      activeSystemsUsed * 0.012 +
      distinctFamilies * 0.014 +
      distinctBands * 0.012 +
      primaryBonus -
      redundancyPenalty;

    if (obj > bestObjective) {
      bestObjective = obj;
      bestComboIdx = combo;
    }

    if ((cNum & 1023) === 1023) {
      await yieldIfFrameExceeded();
    }
  }

  const chosenSystems = bestComboIdx.map((idx) => searchPool[idx]);
  const chosenIds = new Set(chosenSystems.map((s) => s.id));

  // 4. Assign each active well to its best eluent inside chosenSystems (favoring primary on near-ties)
  const bestOwnerByWell = new Map<number, string>();
  let resolvedWellCount = 0;
  for (const w of activeWells) {
    let topSys = chosenSystems[0];
    let topScore = -1;
    for (const sys of chosenSystems) {
      const sc = evalMatrix.get(sys.id)!.get(w.wellIndex)!.score;
      const tieBias = sys.preferenceTier === 'primary' ? 0.015 : 0;
      const prevBias = topSys.preferenceTier === 'primary' ? 0.015 : 0;
      if (sc + tieBias > topScore + prevBias) {
        topScore = sc;
        topSys = sys;
      }
    }
    bestOwnerByWell.set(w.wellIndex, topSys.id);
    if (topScore >= 0.48) resolvedWellCount++;
  }

  const recommendedSystems = chosenSystems
    .map((sys) =>
      buildSystemPlanEntry(sys, 0, activeWells.length, wellDataByIdx, evalMatrix.get(sys.id)!, bestOwnerByWell)
    )
    .filter((entry, _idx, arr) => entry.assignedWellIndices.length > 0 || arr.length === 1)
    .sort((a, b) => b.assignedWellIndices.length - a.assignedWellIndices.length)
    .map((entry, idx) => ({ ...entry, rank: idx + 1 }));

  // Ensure every system not in final recommendedSystems is still available for plate simulation & inspection
  const chosenFinalIds = new Set(recommendedSystems.map((r) => r.system.id));
  const emptyOwnerMap = new Map<number, string>();
  const otherSystems = TLC_SOLVENT_LIBRARY.filter((sys) => !chosenFinalIds.has(sys.id))
    .map((sys) =>
      buildSystemPlanEntry(sys, 0, activeWells.length, wellDataByIdx, evalMatrix.get(sys.id)!, emptyOwnerMap)
    )
    .sort((a, b) => {
      if (b.wellCoveragePct !== a.wellCoveragePct) return b.wellCoveragePct - a.wellCoveragePct;
      return b.meanResolutionScore - a.meanResolutionScore;
    });

  // Also ensure any recommended primary/secondary flags don't leave chosenIds stale
  void chosenIds;

  const highRankedWellCount = activeWells.filter((w) => w.hasHighOrMed).length;
  const totalCoveragePct =
    activeWells.length > 0 ? Math.round((resolvedWellCount / activeWells.length) * 100) : 0;

  const summaryNotes: string[] = [];
  if (recommendedSystems.length > 0) {
    summaryNotes.push(
      `${recommendedSystems.length} complementary eluent${recommendedSystems.length > 1 ? 's' : ''} resolve ${resolvedWellCount}/${activeWells.length} active wells (${totalCoveragePct}% coverage across all predicted SM & products).`
    );
  }
  const hasNh3 = recommendedSystems.some((s) => s.system.baseModifier?.includes('NH₃'));
  const hasEt3n = recommendedSystems.some((s) => s.system.baseModifier?.includes('Et₃N'));
  if (hasNh3) {
    summaryNotes.push('Includes DCM / MeOH / (2M NH₃ in MeOH) ternary blend for clean release of polar amines & azoles.');
  } else if (hasEt3n) {
    summaryNotes.push('Includes 1% Et₃N mobile phase to release basic amines/azoles from silica baseline.');
  }
  if (recommendedSystems.some((s) => s.system.stationaryPhase === 'C18')) {
    summaryNotes.push('Includes C18 Reverse-Phase TLC to rescue ultra-polar/ionizable wells orthogonal to SiO₂.');
  }
  if (recommendedSystems.some((s) => s.system.acidModifier && s.system.stationaryPhase === 'SiO2')) {
    summaryNotes.push('Includes 1% AcOH mobile phase to sharpen carboxylic acid spots.');
  }

  return {
    plateIndex,
    activeWellCount: activeWells.length,
    highRankedWellCount,
    resolvedWellCount,
    totalCoveragePct,
    recommendedSystems,
    otherSystems,
    wellPredictions,
    summaryNotes,
  };
}
