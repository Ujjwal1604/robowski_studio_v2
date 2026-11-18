// Robowski Studio - Empirical Solvent Descriptor & Dynamic TLC Eluent Composer
// Parameterizes neat solvents (Snyder eluent strength eps0, Kamlet-Taft alpha/beta/pi*, aromaticity)
// and chemical modifiers (Et3N, 2M NH3/MeOH, AcOH, TFA), enforces miscibility & stability rules,
// and computes continuous mixture properties via a Langmuir silanol-saturation mixing isotherm.

import type {
  SolventFamily,
  SolventPreferenceTier,
  TlcSolventSystemDef,
  TlcStationaryPhase,
  TlcStationaryPhasePreference,
} from './tlcSolventAdvisor';

export type NeatSolventId =
  | 'Hexanes'
  | 'Pentane'
  | 'Toluene'
  | 'DCM'
  | 'Et2O'
  | 'MTBE'
  | 'EtOAc'
  | 'Acetone'
  | 'MeCN'
  | 'MeOH'
  | 'H2O';

export type ModifierId =
  | 'none'
  | 'et3n_1'
  | 'nh3_meoh_1'
  | 'nh3_meoh_2'
  | 'nh3_meoh_4'
  | 'acoh_1'
  | 'tfa_01';

export interface NeatSolventDescriptor {
  id: NeatSolventId;
  shortName: string;
  /** Effective normal-phase SiO2 elution strength at 100% solvent (empirical Robowski scale ~0..1.06) */
  epsSio2: number;
  /** Silanol Langmuir adsorption affinity K_sat relative to weak alkane diluent */
  silanolAffinity: number;
  /** Kamlet-Taft H-bond donor acidity (alpha) */
  alphaHbd: number;
  /** Kamlet-Taft H-bond acceptor basicity (beta) */
  betaHba: number;
  /** Kamlet-Taft dipolarity/polarizability (pi*) */
  piStar: number;
  /** Aromatic pi-pi competition score (0..1) */
  aromaticity: number;
  /** Boiling point (°C) — informational for evaporation / volatile retention */
  bpC: number;
}

export interface ModifierDescriptor {
  id: ModifierId;
  /** Display string (matches TlcSolventSystemDef.baseModifier or acidModifier) */
  label: string;
  shortSuffix: string;
  kind: 'none' | 'base_et3n' | 'base_nh3' | 'acid_acoh' | 'acid_tfa';
  /** Volume percentage in the chamber (e.g. 1 for 1% Et3N, 2 for 2% 2M NH3/MeOH, 0.1 for TFA) */
  volPct: number;
  /** Extra MeOH percentage contributed directly by the modifier (e.g. 2M NH3 in MeOH contributes MeOH) */
  meohContributionPct: number;
  /** Effective molarity of acid/base modifier in chamber (M) */
  molarity: number;
  /** Conjugate-acid / acid pKa reference in DMSO/MeOH context */
  pkaRef: number;
  /** Small strength bump from deactivating silanols or adding ionic elution */
  strengthDelta: number;
  /** Base neutralizing capacity on the plate relative to well acidStress scale */
  neutralizingCapacity: number;
}

export interface MixturePhysicalDescriptors {
  strength: number;
  alphaMix: number;
  betaMix: number;
  piStarMix: number;
  aromaticMix: number;
  alcoholPct: number;
  organicPct?: number;
  /** Geiss secondary solvent front ceiling (Rf_beta) on dry SiO2 when polar modifiers demix */
  betaFrontCeiling?: number;
  modifierKind: ModifierDescriptor['kind'];
  modifierCapacity: number;
  modifierMolarity: number;
}

export interface DynamicEluentSpec {
  id: string;
  strongSolvent: NeatSolventId;
  weakSolvent: NeatSolventId;
  /** Optional third selectivity-triangle co-solvent (v/v %) for PRISMA ternary eluents */
  ternaryCoSolvent?: { solvent: NeatSolventId; pct: number };
  /** Percentage of strongSolvent (v/v) BEFORE subtracting modifier volume; 0..100 */
  strongPct: number;
  modifierId: ModifierId;
  stationaryPhase: TlcStationaryPhase;
  family: SolventFamily;
  preferenceTier: SolventPreferenceTier;
  isSynthesized?: boolean;
  synthesisNote?: string;
  /** Optional explicit overrides for legacy exact wording/notes while still using physics for strength & descriptors */
  nameOverride?: string;
  shortLabelOverride?: string;
  ratioOverride?: string;
  bestForOverride?: string;
}

export const NEAT_SOLVENTS: Record<NeatSolventId, NeatSolventDescriptor> = {
  Hexanes: {
    id: 'Hexanes',
    shortName: 'Hex',
    epsSio2: 0.0,
    silanolAffinity: 1.0,
    alphaHbd: 0.0,
    betaHba: 0.0,
    piStar: -0.08,
    aromaticity: 0.0,
    bpC: 69,
  },
  Pentane: {
    id: 'Pentane',
    shortName: 'Pentane',
    epsSio2: 0.0,
    silanolAffinity: 1.0,
    alphaHbd: 0.0,
    betaHba: 0.0,
    piStar: -0.1,
    aromaticity: 0.0,
    bpC: 36,
  },
  Toluene: {
    id: 'Toluene',
    shortName: 'Toluene',
    epsSio2: 0.23,
    silanolAffinity: 1.35,
    alphaHbd: 0.0,
    betaHba: 0.11,
    piStar: 0.54,
    aromaticity: 1.0,
    bpC: 111,
  },
  DCM: {
    id: 'DCM',
    shortName: 'DCM',
    epsSio2: 0.36,
    silanolAffinity: 1.55,
    alphaHbd: 0.13,
    betaHba: 0.1,
    piStar: 0.82,
    aromaticity: 0.0,
    bpC: 40,
  },
  Et2O: {
    id: 'Et2O',
    shortName: 'Et₂O',
    epsSio2: 0.46,
    silanolAffinity: 1.85,
    alphaHbd: 0.0,
    betaHba: 0.47,
    piStar: 0.27,
    aromaticity: 0.0,
    bpC: 35,
  },
  MTBE: {
    id: 'MTBE',
    shortName: 'MTBE',
    epsSio2: 0.44,
    silanolAffinity: 1.9,
    alphaHbd: 0.0,
    betaHba: 0.49,
    piStar: 0.27,
    aromaticity: 0.0,
    bpC: 55,
  },
  EtOAc: {
    id: 'EtOAc',
    shortName: 'EtOAc',
    epsSio2: 0.69,
    silanolAffinity: 1.95,
    alphaHbd: 0.0,
    betaHba: 0.45,
    piStar: 0.55,
    aromaticity: 0.0,
    bpC: 77,
  },
  Acetone: {
    id: 'Acetone',
    shortName: 'Acetone',
    epsSio2: 0.75,
    silanolAffinity: 2.6,
    alphaHbd: 0.08,
    betaHba: 0.48,
    piStar: 0.71,
    aromaticity: 0.0,
    bpC: 56,
  },
  MeCN: {
    id: 'MeCN',
    shortName: 'MeCN',
    epsSio2: 0.79,
    silanolAffinity: 3.1,
    alphaHbd: 0.19,
    betaHba: 0.4,
    piStar: 0.75,
    aromaticity: 0.0,
    bpC: 82,
  },
  MeOH: {
    id: 'MeOH',
    shortName: 'MeOH',
    epsSio2: 1.04,
    silanolAffinity: 21.5,
    alphaHbd: 0.93,
    betaHba: 0.66,
    piStar: 0.6,
    aromaticity: 0.0,
    bpC: 65,
  },
  H2O: {
    id: 'H2O',
    shortName: 'H₂O',
    epsSio2: 1.0,
    silanolAffinity: 16.0,
    alphaHbd: 1.17,
    betaHba: 0.47,
    piStar: 1.09,
    aromaticity: 0.0,
    bpC: 100,
  },
};

export const MODIFIER_SPECS: Record<ModifierId, ModifierDescriptor> = {
  none: {
    id: 'none',
    label: '',
    shortSuffix: '',
    kind: 'none',
    volPct: 0,
    meohContributionPct: 0,
    molarity: 0,
    pkaRef: 7.0,
    strengthDelta: 0,
    neutralizingCapacity: 0,
  },
  et3n_1: {
    id: 'et3n_1',
    label: '1% Et₃N',
    shortSuffix: '+ Et₃N',
    kind: 'base_et3n',
    volPct: 1,
    meohContributionPct: 0,
    molarity: 0.072,
    pkaRef: 10.75,
    strengthDelta: 0.02,
    neutralizingCapacity: 0.46,
  },
  nh3_meoh_1: {
    id: 'nh3_meoh_1',
    label: '1% (2M NH₃ in MeOH)',
    shortSuffix: 'NH₃-MeOH',
    kind: 'base_nh3',
    volPct: 1,
    meohContributionPct: 1,
    molarity: 0.02,
    pkaRef: 9.25,
    strengthDelta: 0.005,
    neutralizingCapacity: 0.72,
  },
  nh3_meoh_2: {
    id: 'nh3_meoh_2',
    label: '2% (2M NH₃ in MeOH)',
    shortSuffix: 'NH₃',
    kind: 'base_nh3',
    volPct: 2,
    meohContributionPct: 2,
    molarity: 0.04,
    pkaRef: 9.25,
    strengthDelta: 0.015,
    neutralizingCapacity: 0.95,
  },
  nh3_meoh_4: {
    id: 'nh3_meoh_4',
    label: '4% (2M NH₃ in MeOH)',
    shortSuffix: '4% NH₃',
    kind: 'base_nh3',
    volPct: 4,
    meohContributionPct: 4,
    molarity: 0.08,
    pkaRef: 9.25,
    strengthDelta: 0.02,
    neutralizingCapacity: 1.35,
  },
  acoh_1: {
    id: 'acoh_1',
    label: '1% AcOH',
    shortSuffix: '+ AcOH',
    kind: 'acid_acoh',
    volPct: 1,
    meohContributionPct: 0,
    molarity: 0.175,
    pkaRef: 4.76,
    strengthDelta: 0.025,
    neutralizingCapacity: 0.95,
  },
  tfa_01: {
    id: 'tfa_01',
    label: '0.1% TFA',
    shortSuffix: '+ TFA',
    kind: 'acid_tfa',
    volPct: 0.1,
    meohContributionPct: 0,
    molarity: 0.013,
    pkaRef: 0.3,
    strengthDelta: 0.03,
    neutralizingCapacity: 0.6,
  },
};

/**
 * Checks chemical compatibility & bench viability of a binary solvent + modifier combination.
 * Enforces immiscibility (e.g. MeOH/Hexanes), reactive pair blocks (NH3 + EtOAc/Acetone),
 * acid+base modifier self-neutralization, and silica stripping limits.
 */
export function validateEluentCompatibility(
  spec: Pick<
    DynamicEluentSpec,
    'strongSolvent' | 'weakSolvent' | 'ternaryCoSolvent' | 'strongPct' | 'modifierId' | 'stationaryPhase'
  >,
  stationaryPhasePref: TlcStationaryPhasePreference = 'auto'
): { valid: boolean; reason?: string } {
  const mod = MODIFIER_SPECS[spec.modifierId];
  const ter = spec.ternaryCoSolvent;
  if (ter) {
    if (ter.pct <= 0 || spec.strongPct + ter.pct + mod.volPct > 100) {
      return { valid: false, reason: 'Ternary component percentages exceed 100%' };
    }
    if (ter.solvent === spec.strongSolvent || ter.solvent === spec.weakSolvent) {
      return { valid: false, reason: 'Duplicate ternary solvent component' };
    }
  }
  if (spec.stationaryPhase === 'SiO2') {
    const isAlkaneWeak = spec.weakSolvent === 'Hexanes' || spec.weakSolvent === 'Pentane';
    const hasMeohStrong = spec.strongSolvent === 'MeOH' || ter?.solvent === 'MeOH';
    if (isAlkaneWeak && hasMeohStrong) {
      // MeOH + Hexanes is immiscible unless bridged by >= 25% intermediate polar ester/ketone/DCM co-solvent
      const bridgePct =
        spec.strongSolvent === 'MeOH' && ter && (ter.solvent === 'EtOAc' || ter.solvent === 'Acetone' || ter.solvent === 'DCM' || ter.solvent === 'MTBE')
          ? ter.pct
          : ter?.solvent === 'MeOH' && (spec.strongSolvent === 'EtOAc' || spec.strongSolvent === 'Acetone' || spec.strongSolvent === 'DCM' || spec.strongSolvent === 'MTBE')
          ? spec.strongPct
          : 0;
      if (bridgePct < 25) {
        return { valid: false, reason: 'MeOH and Hexanes/Pentane are immiscible without >= 25% bridging co-solvent' };
      }
    }
    if (
      mod.kind === 'base_nh3' &&
      (spec.strongSolvent === 'EtOAc' ||
        spec.strongSolvent === 'Acetone' ||
        ter?.solvent === 'EtOAc' ||
        ter?.solvent === 'Acetone')
    ) {
      return { valid: false, reason: '2M NH₃/MeOH reacts with EtOAc (aminolysis) or Acetone' };
    }
    if (mod.kind === 'acid_tfa') {
      return { valid: false, reason: '0.1% TFA modifier reserved for C18 reverse phase' };
    }
    const meohStrong = spec.strongSolvent === 'MeOH' ? spec.strongPct : 0;
    const meohTer = ter?.solvent === 'MeOH' ? ter.pct : 0;
    const totalMeoh =
      meohStrong +
      meohTer +
      (spec.strongSolvent === 'DCM' ||
      spec.weakSolvent === 'DCM' ||
      spec.weakSolvent === 'Toluene' ||
      ter?.solvent === 'DCM'
        ? mod.meohContributionPct
        : 0);
    if (totalMeoh > 18) {
      return { valid: false, reason: '>18% MeOH risks dissolving SiO₂ plate binder' };
    }
    if (
      (stationaryPhasePref === 'Al2O3_basic' || stationaryPhasePref === 'Al2O3_neutral') &&
      mod.kind !== 'none'
    ) {
      return { valid: false, reason: 'Al₂O₃ runs without acid/base modifiers' };
    }
  } else {
    if (spec.weakSolvent !== 'H2O') {
      return { valid: false, reason: 'C18 reverse phase uses aqueous co-solvent blends' };
    }
    if (mod.kind !== 'none' && mod.kind !== 'acid_tfa') {
      return { valid: false, reason: 'C18 RP uses neat or 0.1% TFA aqueous gradients' };
    }
  }
  return { valid: true };
}

/**
 * Computes mixture eluent strength, Kamlet-Taft / Abraham selectivity vectors, and Geiss beta-front ceiling
 * from neat solvent physical constants via multi-site competitive Langmuir silanol saturation.
 */
export function computeMixtureDescriptors(
  spec: Pick<
    DynamicEluentSpec,
    'strongSolvent' | 'weakSolvent' | 'ternaryCoSolvent' | 'strongPct' | 'modifierId' | 'stationaryPhase'
  >
): MixturePhysicalDescriptors {
  const mod = MODIFIER_SPECS[spec.modifierId];
  const strong = NEAT_SOLVENTS[spec.strongSolvent];
  const weak = NEAT_SOLVENTS[spec.weakSolvent];
  const ter = spec.ternaryCoSolvent ? NEAT_SOLVENTS[spec.ternaryCoSolvent.solvent] : null;

  if (spec.stationaryPhase === 'C18') {
    const orgFrac = Math.max(0.05, Math.min(0.95, spec.strongPct / 100));
    const strength = Math.round((orgFrac + (mod.kind === 'acid_tfa' ? 0.03 : 0)) * 1000) / 1000;
    return {
      strength,
      alphaMix: orgFrac * strong.alphaHbd + (1 - orgFrac) * weak.alphaHbd,
      betaMix: orgFrac * strong.betaHba + (1 - orgFrac) * weak.betaHba,
      piStarMix: orgFrac * strong.piStar + (1 - orgFrac) * weak.piStar,
      aromaticMix: 0,
      alcoholPct: spec.strongSolvent === 'MeOH' ? spec.strongPct : 0,
      organicPct: spec.strongPct,
      modifierKind: mod.kind,
      modifierCapacity: mod.neutralizingCapacity,
      modifierMolarity: mod.molarity,
    };
  }

  // Normal-phase SiO2/Al2O3 binary or ternary + modifier composition
  // When modifier is 2M NH3/MeOH, its MeOH carrier directly contributes to total alcohol fraction!
  const effectiveStrongPct =
    spec.strongSolvent === 'MeOH'
      ? Math.min(25, spec.strongPct + mod.meohContributionPct)
      : spec.strongPct;

  const vTer = ter && spec.ternaryCoSolvent ? Math.max(0, Math.min(1, spec.ternaryCoSolvent.pct / 100)) : 0;
  const vB = Math.max(0, Math.min(1 - vTer, effectiveStrongPct / 100));
  const vA = Math.max(0, 1 - vB - vTer);

  // Multi-site competitive Langmuir silanol adsorption (exact generalization of binary K_rel)
  const kA = Math.max(0.5, weak.silanolAffinity);
  const kB = Math.max(kA, strong.silanolAffinity);
  const kT = ter ? Math.max(kA, ter.silanolAffinity) : kA;
  const kBar = Math.max(1e-6, vA * kA + vB * kB + vTer * kT);
  const fA = (vA * kA) / kBar;
  const fB = (vB * kB) / kBar;
  const fTer = (vTer * kT) / kBar;

  const baseStrength =
    fA * weak.epsSio2 + fB * strong.epsSio2 + (ter ? fTer * ter.epsSio2 : 0);
  const strength = Math.round(Math.max(0, Math.min(0.94, baseStrength + mod.strengthDelta)) * 1000) / 1000;

  // Solute-solvent interaction mix: blend bulk volume fraction (60%) with surface enrichment (40%)
  const wA = 0.6 * vA + 0.4 * fA;
  const wB = 0.6 * vB + 0.4 * fB;
  const wTer = 0.6 * vTer + 0.4 * fTer;

  let alphaMix = wA * weak.alphaHbd + wB * strong.alphaHbd + (ter ? wTer * ter.alphaHbd : 0);
  let betaMix = wA * weak.betaHba + wB * strong.betaHba + (ter ? wTer * ter.betaHba : 0);
  const piStarMix = wA * weak.piStar + wB * strong.piStar + (ter ? wTer * ter.piStar : 0);
  const aromaticMix =
    vA * weak.aromaticity + vB * strong.aromaticity + (ter ? vTer * ter.aromaticity : 0);

  // Unbranched MeOH modifier also adds protic alpha/beta competition when paired with aprotic solvents
  if (spec.strongSolvent !== 'MeOH' && mod.meohContributionPct > 0) {
    const mFrac = mod.meohContributionPct / 100;
    alphaMix += mFrac * 0.8;
    betaMix += mFrac * 0.5;
  }
  if (mod.kind === 'base_et3n') {
    betaMix = Math.max(betaMix, 0.25);
  } else if (mod.kind === 'acid_acoh') {
    alphaMix += 0.12;
  }

  const alcoholPct =
    (spec.strongSolvent === 'MeOH' ? effectiveStrongPct : mod.meohContributionPct) +
    (spec.ternaryCoSolvent?.solvent === 'MeOH' ? spec.ternaryCoSolvent.pct : 0);

  // Geiss secondary solvent-front (beta-front) demixing ceiling on dry SiO2 when polar alcohol/modifier demixes
  let betaFrontCeiling: number | undefined;
  if (alcoholPct > 0 && spec.weakSolvent !== 'EtOAc') {
    const effPolarModPct =
      alcoholPct + (mod.kind === 'acid_acoh' ? 2.5 : mod.kind === 'base_nh3' ? 1.5 : 0);
    betaFrontCeiling = Math.round(
      Math.min(0.93, 0.78 + 0.16 * (effPolarModPct / (effPolarModPct + 2.2))) * 1000
    ) / 1000;
  }

  return {
    strength,
    alphaMix: Math.round(alphaMix * 1000) / 1000,
    betaMix: Math.round(betaMix * 1000) / 1000,
    piStarMix: Math.round(piStarMix * 1000) / 1000,
    aromaticMix: Math.round(aromaticMix * 1000) / 1000,
    alcoholPct,
    ...(betaFrontCeiling !== undefined ? { betaFrontCeiling } : {}),
    modifierKind: mod.kind,
    modifierCapacity: mod.neutralizingCapacity,
    modifierMolarity: mod.molarity,
  };
}

/** Formats clean human-readable 50 mL TLC chamber recipe, ratio, and labels directly from composition */
export function composeSolventSystem(spec: DynamicEluentSpec): TlcSolventSystemDef {
  const mod = MODIFIER_SPECS[spec.modifierId];
  const strong = NEAT_SOLVENTS[spec.strongSolvent];
  const weak = NEAT_SOLVENTS[spec.weakSolvent];
  const ter = spec.ternaryCoSolvent ? NEAT_SOLVENTS[spec.ternaryCoSolvent.solvent] : null;
  const desc = computeMixtureDescriptors(spec);

  const f1 = (v: number) => {
    const r = Math.round(v * 10) / 10;
    return Number.isInteger(r) ? `${r}.0` : `${r}`;
  };

  let name = spec.nameOverride || '';
  let shortLabel = spec.shortLabelOverride || '';
  let ratio = spec.ratioOverride || '';
  let chamberPrep50mL = '';

  if (spec.stationaryPhase === 'C18') {
    const orgVol = (spec.strongPct / 100) * 50;
    const aqVol = 50 - orgVol;
    if (!name) {
      name =
        mod.kind === 'acid_tfa'
          ? `${spec.strongPct}% ${strong.shortName} / H₂O + 0.1% TFA (C18 RP)`
          : `${spec.strongPct}% ${strong.shortName} / H₂O (C18 RP)`;
    }
    if (!shortLabel) {
      shortLabel =
        mod.kind === 'acid_tfa'
          ? `${spec.strongPct}% ${strong.shortName}/H₂O + TFA (C18)`
          : `${spec.strongPct}% ${strong.shortName}/H₂O (C18)`;
    }
    if (!ratio) {
      ratio =
        mod.kind === 'acid_tfa'
          ? `${spec.strongPct}:${100 - spec.strongPct}:0.1 ${strong.shortName} / H₂O / TFA on C18`
          : `${spec.strongPct}:${100 - spec.strongPct} v/v ${strong.shortName} / H₂O on C18 Silica`;
    }
    chamberPrep50mL =
      mod.kind === 'acid_tfa'
        ? `${f1(orgVol)} mL ${strong.shortName} + ${f1(aqVol)} mL H₂O + 50.0 µL TFA (C18 plate)`
        : `${f1(orgVol)} mL ${strong.shortName} + ${f1(aqVol)} mL H₂O (C18 plate)`;
  } else if (ter && spec.ternaryCoSolvent) {
    const modPct = mod.volPct;
    const terPct = spec.ternaryCoSolvent.pct;
    const weakPct = Math.max(0, 100 - spec.strongPct - terPct - modPct);
    const strongVol = (spec.strongPct / 100) * 50;
    const terVol = (terPct / 100) * 50;
    const weakVol = (weakPct / 100) * 50;
    const modVol = (modPct / 100) * 50;
    const modToken = mod.kind === 'base_nh3' ? '(2M NH₃ in MeOH)' : mod.id === 'acoh_1' ? 'AcOH' : 'Et₃N';

    if (!name) {
      name = `${spec.strongPct}% ${strong.shortName} / ${terPct}% ${ter.shortName} / ${spec.weakSolvent}${mod.label ? ` + ${mod.label}` : ''}`;
    }
    if (!shortLabel) {
      shortLabel = `${spec.strongPct}/${terPct}/${weakPct} ${strong.shortName}/${ter.shortName}/${weak.shortName}${mod.shortSuffix ? ` ${mod.shortSuffix}` : ''}`;
    }
    if (!ratio) {
      ratio =
        modPct > 0
          ? `${spec.strongPct}:${terPct}:${weakPct}:${modPct} v/v/v/v ${strong.shortName} / ${ter.shortName} / ${spec.weakSolvent} / ${modToken}`
          : `${spec.strongPct}:${terPct}:${weakPct} v/v/v ${strong.shortName} / ${ter.shortName} / ${spec.weakSolvent}`;
    }
    const parts: string[] = [];
    if (strongVol > 0) parts.push(`${f1(strongVol)} mL ${strong.shortName}`);
    if (terVol > 0) parts.push(`${f1(terVol)} mL ${ter.shortName}`);
    if (weakVol > 0) parts.push(`${f1(weakVol)} mL ${spec.weakSolvent}`);
    if (modVol > 0) parts.push(`${f1(modVol)} mL ${modToken}`);
    chamberPrep50mL = parts.join(' + ');
  } else if (mod.kind === 'base_nh3') {
    const meohNeatPct = Math.max(0, spec.strongPct);
    const nh3Pct = mod.volPct;
    const weakPct = Math.max(0, 100 - meohNeatPct - nh3Pct);
    const totalMeohPct = meohNeatPct + nh3Pct;
    const weakVol = (weakPct / 100) * 50;
    const meohVol = (meohNeatPct / 100) * 50;
    const nh3Vol = (nh3Pct / 100) * 50;
    const wkName = weak.shortName;

    if (!name) {
      name =
        meohNeatPct === 0
          ? `${wkName} / (2M NH₃ in MeOH) (${weakPct}:${nh3Pct})`
          : `${wkName} / MeOH / (2M NH₃ in MeOH) (${weakPct}:${meohNeatPct}:${nh3Pct})`;
    }
    if (!shortLabel) {
      shortLabel =
        meohNeatPct === 0
          ? `${weakPct}:${nh3Pct} ${wkName}/NH₃-MeOH`
          : `${weakPct}:${meohNeatPct}:${nh3Pct} ${wkName}/MeOH/NH₃`;
    }
    if (!ratio) {
      ratio =
        meohNeatPct === 0
          ? `${weakPct}:${nh3Pct} v/v ${wkName} / (2M NH₃ in MeOH)`
          : `${weakPct}:${meohNeatPct}:${nh3Pct} v/v/v ${wkName} / MeOH / (2M NH₃ in MeOH)`;
    }
    chamberPrep50mL =
      meohVol > 0
        ? `${f1(weakVol)} mL ${wkName} + ${f1(meohVol)} mL MeOH + ${f1(nh3Vol)} mL (2M NH₃ in MeOH)`
        : `${f1(weakVol)} mL ${wkName} + ${f1(nh3Vol)} mL (2M NH₃ in MeOH)`;
    void totalMeohPct;
  } else {
    const modPct = mod.volPct;
    const modVol = (modPct / 100) * 50;
    const weakPct = Math.max(0, 100 - spec.strongPct - modPct);
    const strongVol = (spec.strongPct / 100) * 50;
    const weakVol = (weakPct / 100) * 50;

    if (!name) {
      if (spec.strongPct === 0 && mod.kind === 'none') {
        name = `100% ${spec.weakSolvent}`;
      } else if (spec.strongPct === 100 && mod.kind === 'none') {
        name = `100% ${strong.id}`;
      } else {
        name = `${spec.strongPct}% ${strong.shortName} / ${spec.weakSolvent}${mod.label ? ` + ${mod.label}` : ''}`;
      }
    }
    if (!shortLabel) {
      if (spec.strongPct === 0 && mod.kind === 'none') {
        shortLabel = `100% ${spec.weakSolvent}`;
      } else if (spec.strongPct === 100 && mod.kind === 'none') {
        shortLabel = `100% ${strong.shortName}`;
      } else {
        shortLabel = `${spec.strongPct}% ${strong.shortName}/${weak.shortName}${mod.shortSuffix ? ` ${mod.shortSuffix}` : ''}`;
      }
    }
    if (!ratio) {
      if (spec.strongPct === 0 && mod.kind === 'none') {
        ratio = `Neat ${spec.weakSolvent}`;
      } else if (spec.strongPct === 100 && mod.kind === 'none') {
        ratio = `Neat ${spec.strongSolvent}`;
      } else if (modPct > 0) {
        ratio = `${spec.strongPct}:${weakPct}:${modPct} v/v/v ${strong.shortName} / ${spec.weakSolvent} / ${mod.id === 'acoh_1' ? 'AcOH' : 'Et₃N'}`;
      } else {
        ratio = `${spec.strongPct}:${weakPct} v/v ${strong.shortName} / ${spec.weakSolvent}`;
      }
    }

    const parts: string[] = [];
    if (strongVol > 0) parts.push(`${f1(strongVol)} mL ${strong.shortName}`);
    if (weakVol > 0) parts.push(`${f1(weakVol)} mL ${spec.weakSolvent}`);
    if (modVol > 0) parts.push(`${f1(modVol)} mL ${mod.id === 'acoh_1' ? 'AcOH' : 'Et₃N'}`);
    chamberPrep50mL = parts.join(' + ');
  }

  let polarityClass: TlcSolventSystemDef['polarityClass'];
  if (spec.stationaryPhase === 'C18') polarityClass = 'Reverse Phase (C18)';
  else if (mod.kind === 'base_et3n' || mod.kind === 'base_nh3') polarityClass = 'Basic Polar';
  else if (mod.kind === 'acid_acoh') polarityClass = 'Acidic Polar';
  else if (desc.strength < 0.25) polarityClass = 'Non-Polar';
  else if (desc.strength < 0.42) polarityClass = 'Low-Med Polarity';
  else if (desc.strength < 0.65) polarityClass = 'Medium Polarity';
  else polarityClass = 'Polar';

  const bestFor =
    spec.bestForOverride ||
    (spec.family === 'prisma_ternary'
      ? 'Nyiredy PRISMA selectivity-triangle blend — breaks co-eluting regioisomers & HBA/dipolar overlaps'
      : spec.strongSolvent === 'MTBE'
      ? 'Pure ether HBA selectivity (x_e vertex) — resists alcoholysis/hydrolysis without Et₂O volatility'
      : spec.strongSolvent === 'Toluene' || spec.weakSolvent === 'Toluene' || spec.ternaryCoSolvent?.solvent === 'Toluene'
      ? 'Aromatic π-π competition — sharper spots for indoles, benzimidazoles & polyaromatics'
      : spec.strongSolvent === 'Acetone'
      ? 'Aprotic H-bond acceptor selectivity when EtOAc/Hex co-elutes or smears HBD spots'
      : mod.kind === 'base_nh3'
      ? 'Controlled NH₃/MeOH silanol neutralization — sharpest release of protonated azoles & amines'
      : mod.kind === 'base_et3n'
      ? 'Et₃N silanol deactivation for basic heterocycles and amines'
      : mod.kind === 'acid_acoh'
      ? 'AcOH suppresses carboxylate dimerization and silica tailing'
      : `Empirically balanced ${Math.round(desc.strength * 100)}% eluent strength blend`);

  return {
    id: spec.id,
    name,
    shortLabel,
    ratio,
    chamberPrep50mL,
    stationaryPhase: spec.stationaryPhase,
    preferenceTier: spec.preferenceTier,
    family: spec.family,
    strength: desc.strength,
    alcoholPct: desc.alcoholPct,
    ...(desc.organicPct != null ? { organicPct: desc.organicPct } : {}),
    ...(mod.kind === 'base_et3n' || mod.kind === 'base_nh3' ? { baseModifier: mod.label } : {}),
    ...(mod.kind === 'acid_acoh' || mod.kind === 'acid_tfa' ? { acidModifier: mod.label } : {}),
    polarityClass,
    bestFor,
    descriptors: desc,
    ...(spec.isSynthesized ? { isSynthesized: true } : {}),
    ...(spec.synthesisNote ? { synthesisNote: spec.synthesisNote } : {}),
    composition: {
      strongSolvent: spec.strongSolvent,
      weakSolvent: spec.weakSolvent,
      ...(spec.ternaryCoSolvent ? { ternaryCoSolvent: { ...spec.ternaryCoSolvent } } : {}),
      strongPct: spec.strongPct,
      modifierId: spec.modifierId,
    },
  };
}

/** Canonical baseline specification entries composed via the physical solvent model */
export const CORE_ELUENT_SPECS: DynamicEluentSpec[] = [
  {
    id: 'hexanes_100',
    strongSolvent: 'EtOAc',
    weakSolvent: 'Hexanes',
    strongPct: 0,
    modifierId: 'none',
    stationaryPhase: 'SiO2',
    family: 'etoac_hex',
    preferenceTier: 'primary',
    ratioOverride: 'Neat Hexanes',
    bestForOverride: 'Very lipophilic hydrocarbons, aryl halides & silanes that fly to the front in 10% EtOAc',
  },
  {
    id: 'etoac_hex_2',
    strongSolvent: 'EtOAc',
    weakSolvent: 'Hexanes',
    strongPct: 2,
    modifierId: 'none',
    stationaryPhase: 'SiO2',
    family: 'etoac_hex',
    preferenceTier: 'primary',
    ratioOverride: '1:49 v/v EtOAc / Hexanes',
    bestForOverride: 'Very fast nonpolar biaryls, silyl ethers & halides crowded at the front in 10% EtOAc',
  },
  {
    id: 'etoac_hex_5',
    strongSolvent: 'EtOAc',
    weakSolvent: 'Hexanes',
    strongPct: 5,
    modifierId: 'none',
    stationaryPhase: 'SiO2',
    family: 'etoac_hex',
    preferenceTier: 'primary',
    ratioOverride: '1:19 v/v EtOAc / Hexanes',
    bestForOverride: 'Nonpolar aromatics, Boc/MOM/Bn intermediates & esters that run >0.85 Rf in 10–25% EtOAc',
  },
  {
    id: 'etoac_hex_10',
    strongSolvent: 'EtOAc',
    weakSolvent: 'Hexanes',
    strongPct: 10,
    modifierId: 'none',
    stationaryPhase: 'SiO2',
    family: 'etoac_hex',
    preferenceTier: 'primary',
    ratioOverride: '1:9 v/v EtOAc / Hexanes',
    bestForOverride: 'Lipophilic arenes, halides, simple esters, nonpolar ketones',
  },
  {
    id: 'etoac_hex_25',
    strongSolvent: 'EtOAc',
    weakSolvent: 'Hexanes',
    strongPct: 25,
    modifierId: 'none',
    stationaryPhase: 'SiO2',
    family: 'etoac_hex',
    preferenceTier: 'primary',
    ratioOverride: '1:3 v/v EtOAc / Hexanes',
    bestForOverride: 'Aldehydes, ketones, indoles, moderately lipophilic adducts',
  },
  {
    id: 'etoac_hex_50',
    strongSolvent: 'EtOAc',
    weakSolvent: 'Hexanes',
    strongPct: 50,
    modifierId: 'none',
    stationaryPhase: 'SiO2',
    family: 'etoac_hex',
    preferenceTier: 'primary',
    ratioOverride: '1:1 v/v EtOAc / Hexanes',
    bestForOverride: 'Workhorse neutral organics, amides, mono-heterocycles',
  },
  {
    id: 'etoac_hex_80',
    strongSolvent: 'EtOAc',
    weakSolvent: 'Hexanes',
    strongPct: 80,
    modifierId: 'none',
    stationaryPhase: 'SiO2',
    family: 'etoac_hex',
    preferenceTier: 'primary',
    ratioOverride: '4:1 v/v EtOAc / Hexanes',
    bestForOverride: 'Polar carbonyls, sulfones, neutral heterocycles',
  },
  {
    id: 'etoac_100',
    strongSolvent: 'EtOAc',
    weakSolvent: 'Hexanes',
    strongPct: 100,
    modifierId: 'none',
    stationaryPhase: 'SiO2',
    family: 'etoac_hex',
    preferenceTier: 'primary',
    ratioOverride: 'Neat Ethyl Acetate',
    bestForOverride: 'Strongly retained neutral products without MeOH alcoholysis risk',
  },
  {
    id: 'meoh_dcm_3',
    strongSolvent: 'MeOH',
    weakSolvent: 'DCM',
    strongPct: 3,
    modifierId: 'none',
    stationaryPhase: 'SiO2',
    family: 'meoh_dcm',
    preferenceTier: 'primary',
    ratioOverride: '3:97 v/v MeOH / DCM',
    bestForOverride: 'Secondary amides, alcohols, benzimidazoles, clean sharp spots',
  },
  {
    id: 'meoh_dcm_7',
    strongSolvent: 'MeOH',
    weakSolvent: 'DCM',
    strongPct: 7,
    modifierId: 'none',
    stationaryPhase: 'SiO2',
    family: 'meoh_dcm',
    preferenceTier: 'primary',
    ratioOverride: '7:93 v/v MeOH / DCM',
    bestForOverride: 'Imidazoles, ureas, poly-heterocycles, polar cascade adducts',
  },
  {
    id: 'meoh_dcm_12',
    strongSolvent: 'MeOH',
    weakSolvent: 'DCM',
    strongPct: 12,
    modifierId: 'none',
    stationaryPhase: 'SiO2',
    family: 'meoh_dcm',
    preferenceTier: 'primary',
    ratioOverride: '12:88 v/v MeOH / DCM',
    bestForOverride: 'Very polar multi-heterocycle / polyol / bis-amide targets',
  },
  {
    id: 'etoac_hex_30_et3n',
    strongSolvent: 'EtOAc',
    weakSolvent: 'Hexanes',
    strongPct: 30,
    modifierId: 'et3n_1',
    stationaryPhase: 'SiO2',
    family: 'basic_mod',
    preferenceTier: 'primary',
    bestForOverride: 'Lipophilic-to-medium basic amines, anilines, pyridines & imines that streak in neutral EtOAc/Hex',
  },
  {
    id: 'etoac_hex_60_et3n',
    strongSolvent: 'EtOAc',
    weakSolvent: 'Hexanes',
    strongPct: 60,
    modifierId: 'et3n_1',
    stationaryPhase: 'SiO2',
    family: 'basic_mod',
    preferenceTier: 'primary',
    bestForOverride: 'Medium-polarity basic heterocycles, tertiary amines & amino-esters without MeOH',
  },
  {
    id: 'meoh_dcm_5_et3n',
    strongSolvent: 'MeOH',
    weakSolvent: 'DCM',
    strongPct: 5,
    modifierId: 'et3n_1',
    stationaryPhase: 'SiO2',
    family: 'basic_mod',
    preferenceTier: 'primary',
    bestForOverride: 'Medium-polar basic amines & azoles where 12% MeOH elutes too close to the front',
  },
  {
    id: 'nh3_meoh_dcm_1',
    strongSolvent: 'MeOH',
    weakSolvent: 'DCM',
    strongPct: 0,
    modifierId: 'nh3_meoh_1',
    stationaryPhase: 'SiO2',
    family: 'basic_mod',
    preferenceTier: 'primary',
    bestForOverride: 'Lipophilic tertiary/secondary amines that run too high in 5% MeOH — NH₃ keeps them from streaking',
  },
  {
    id: 'nh3_meoh_dcm_2',
    strongSolvent: 'MeOH',
    weakSolvent: 'DCM',
    strongPct: 0,
    modifierId: 'nh3_meoh_2',
    stationaryPhase: 'SiO2',
    family: 'basic_mod',
    preferenceTier: 'primary',
    bestForOverride: 'Medium-polar amines & azoles that need only a little MeOH, with NH₃ against streaking',
  },
  {
    id: 'nh3_meoh_dcm_5',
    strongSolvent: 'MeOH',
    weakSolvent: 'DCM',
    strongPct: 3,
    modifierId: 'nh3_meoh_2',
    stationaryPhase: 'SiO2',
    family: 'basic_mod',
    preferenceTier: 'primary',
    bestForOverride: '5% total MeOH with controlled NH₃ — prevents amine/azole tailing without excess base',
  },
  {
    id: 'nh3_meoh_dcm_10',
    strongSolvent: 'MeOH',
    weakSolvent: 'DCM',
    strongPct: 10,
    modifierId: 'nh3_meoh_2',
    stationaryPhase: 'SiO2',
    family: 'basic_mod',
    preferenceTier: 'primary',
    bestForOverride: '12% total MeOH with 2% (2M NH₃/MeOH) — matches 12% MeOH ceiling for polar amines, guanidines & diamines',
  },
  {
    id: 'meoh_dcm_et3n',
    strongSolvent: 'MeOH',
    weakSolvent: 'DCM',
    strongPct: 12,
    modifierId: 'et3n_1',
    stationaryPhase: 'SiO2',
    family: 'basic_mod',
    preferenceTier: 'primary',
    bestForOverride: '12% MeOH/DCM with silanol deactivation by Et₃N — basic amines, amidines & N-rich heterocycles',
  },
  {
    id: 'etoac_hex_30_acoh',
    strongSolvent: 'EtOAc',
    weakSolvent: 'Hexanes',
    strongPct: 30,
    modifierId: 'acoh_1',
    stationaryPhase: 'SiO2',
    family: 'acid_mod',
    preferenceTier: 'primary',
    bestForOverride: 'Nonpolar-to-medium carboxylic acids (benzoic, phenylacetic, Boc-amino acids) without front run-out',
  },
  {
    id: 'etoac_hex_60_acoh',
    strongSolvent: 'EtOAc',
    weakSolvent: 'Hexanes',
    strongPct: 60,
    modifierId: 'acoh_1',
    stationaryPhase: 'SiO2',
    family: 'acid_mod',
    preferenceTier: 'primary',
    bestForOverride: 'Medium-polarity carboxylic acids & carboxylate reaction wells without MeOH esterification risk',
  },
  {
    id: 'meoh_dcm_3_acoh',
    strongSolvent: 'MeOH',
    weakSolvent: 'DCM',
    strongPct: 3,
    modifierId: 'acoh_1',
    stationaryPhase: 'SiO2',
    family: 'acid_mod',
    preferenceTier: 'primary',
    bestForOverride: 'Polar carboxylic acids where 8% MeOH / DCM elutes too high',
  },
  {
    id: 'meoh_dcm_acoh',
    strongSolvent: 'MeOH',
    weakSolvent: 'DCM',
    strongPct: 8,
    modifierId: 'acoh_1',
    stationaryPhase: 'SiO2',
    family: 'acid_mod',
    preferenceTier: 'primary',
    bestForOverride: 'Carboxylic acids & acidic heterocycles to prevent silica tailing',
  },
  // Secondary complementary systems
  {
    id: 'acetone_hex_25',
    strongSolvent: 'Acetone',
    weakSolvent: 'Hexanes',
    strongPct: 25,
    modifierId: 'none',
    stationaryPhase: 'SiO2',
    family: 'acetone_hex',
    preferenceTier: 'secondary',
    ratioOverride: '1:3 v/v Acetone / Hexanes',
    bestForOverride: 'Orthogonal H-bond acceptor selectivity when EtOAc/Hex spots co-elute',
  },
  {
    id: 'acetone_hex_50',
    strongSolvent: 'Acetone',
    weakSolvent: 'Hexanes',
    strongPct: 50,
    modifierId: 'none',
    stationaryPhase: 'SiO2',
    family: 'acetone_hex',
    preferenceTier: 'secondary',
    ratioOverride: '1:1 v/v Acetone / Hexanes',
    bestForOverride: 'Polar alcohols, amides & heterocycles — often sharper than EtOAc/Hex',
  },
  {
    id: 'meoh_etoac_5',
    strongSolvent: 'MeOH',
    weakSolvent: 'EtOAc',
    strongPct: 5,
    modifierId: 'none',
    stationaryPhase: 'SiO2',
    family: 'meoh_etoac',
    preferenceTier: 'secondary',
    ratioOverride: '1:19 v/v MeOH / EtOAc',
    bestForOverride: 'DCM-free polar eluent for multi-H-bond acceptors, nucleosides & azoles',
  },
  {
    id: 'meoh_etoac_10',
    strongSolvent: 'MeOH',
    weakSolvent: 'EtOAc',
    strongPct: 10,
    modifierId: 'none',
    stationaryPhase: 'SiO2',
    family: 'meoh_etoac',
    preferenceTier: 'secondary',
    ratioOverride: '1:9 v/v MeOH / EtOAc',
    bestForOverride: 'Very polar neutral polyols/bis-amides without chlorinated solvents',
  },
  {
    id: 'meoh_toluene_5',
    strongSolvent: 'MeOH',
    weakSolvent: 'Toluene',
    strongPct: 5,
    modifierId: 'none',
    stationaryPhase: 'SiO2',
    family: 'meoh_toluene',
    preferenceTier: 'secondary',
    ratioOverride: '1:19 v/v MeOH / Toluene',
    bestForOverride: 'Aromatic π-π selectivity — separates indoles, benzimidazoles & regioisomers cleanly',
  },
  {
    id: 'meoh_toluene_10',
    strongSolvent: 'MeOH',
    weakSolvent: 'Toluene',
    strongPct: 10,
    modifierId: 'none',
    stationaryPhase: 'SiO2',
    family: 'meoh_toluene',
    preferenceTier: 'secondary',
    ratioOverride: '1:9 v/v MeOH / Toluene',
    bestForOverride: 'Polar aromatic heterocycles that streak or overlap in MeOH/DCM',
  },
  {
    id: 'etoac_dcm_20',
    strongSolvent: 'EtOAc',
    weakSolvent: 'DCM',
    strongPct: 20,
    modifierId: 'none',
    stationaryPhase: 'SiO2',
    family: 'etoac_dcm',
    preferenceTier: 'secondary',
    ratioOverride: '1:4 v/v EtOAc / DCM',
    bestForOverride: 'Aprotic medium polarity for poorly hexane-soluble heterocycles',
  },
  {
    id: 'et2o_pentane_40',
    strongSolvent: 'Et2O',
    weakSolvent: 'Pentane',
    strongPct: 40,
    modifierId: 'none',
    stationaryPhase: 'SiO2',
    family: 'ether_pentane',
    preferenceTier: 'secondary',
    ratioOverride: '2:3 v/v Et₂O / Pentane',
    bestForOverride: 'Volatile nonpolar products, aldehydes, enones & low-MW intermediates',
  },
  {
    id: 'mtbe_hex_25',
    strongSolvent: 'MTBE',
    weakSolvent: 'Hexanes',
    strongPct: 25,
    modifierId: 'none',
    stationaryPhase: 'SiO2',
    family: 'mtbe_hex',
    preferenceTier: 'secondary',
    ratioOverride: '1:3 v/v MTBE / Hexanes',
    bestForOverride: 'Pure ether HBA selectivity (x_e vertex) — ester/acyl-tolerant alternative to EtOAc/Et₂O',
  },
  {
    id: 'mtbe_hex_50',
    strongSolvent: 'MTBE',
    weakSolvent: 'Hexanes',
    strongPct: 50,
    modifierId: 'none',
    stationaryPhase: 'SiO2',
    family: 'mtbe_hex',
    preferenceTier: 'secondary',
    ratioOverride: '1:1 v/v MTBE / Hexanes',
    bestForOverride: 'Ether HBA selectivity for HBD amides/alcohols where EtOAc/Hex co-elutes with carbonyls',
  },
  {
    id: 'c18_mecn_15',
    strongSolvent: 'MeCN',
    weakSolvent: 'H2O',
    strongPct: 15,
    modifierId: 'none',
    stationaryPhase: 'C18',
    family: 'c18_rp',
    preferenceTier: 'secondary',
    ratioOverride: '3:17 v/v MeCN / H₂O on C18 Silica',
    bestForOverride: 'Very polar water-soluble products, guanidines & zwitterions on C18',
  },
  {
    id: 'c18_mecn_30',
    strongSolvent: 'MeCN',
    weakSolvent: 'H2O',
    strongPct: 30,
    modifierId: 'none',
    stationaryPhase: 'C18',
    family: 'c18_rp',
    preferenceTier: 'secondary',
    ratioOverride: '3:7 v/v MeCN / H₂O on C18 Silica',
    bestForOverride: 'Highly polar water-soluble products, guanidines & zwitterions pinned on SiO₂',
  },
  {
    id: 'c18_mecn_45_tfa',
    strongSolvent: 'MeCN',
    weakSolvent: 'H2O',
    strongPct: 45,
    modifierId: 'tfa_01',
    stationaryPhase: 'C18',
    family: 'c18_rp',
    preferenceTier: 'secondary',
    bestForOverride: 'Sharp LC-MS-matched C18 spots for amines, heterocycles & medium-polarity acids',
  },
  {
    id: 'c18_mecn_60',
    strongSolvent: 'MeCN',
    weakSolvent: 'H2O',
    strongPct: 60,
    modifierId: 'none',
    stationaryPhase: 'C18',
    family: 'c18_rp',
    preferenceTier: 'secondary',
    ratioOverride: '3:2 v/v MeCN / H₂O on C18 Silica',
    bestForOverride: 'General med-chem reverse-phase separation orthogonal to normal-phase SiO₂',
  },
  {
    id: 'c18_mecn_85',
    strongSolvent: 'MeCN',
    weakSolvent: 'H2O',
    strongPct: 85,
    modifierId: 'none',
    stationaryPhase: 'C18',
    family: 'c18_rp',
    preferenceTier: 'secondary',
    ratioOverride: '17:3 v/v MeCN / H₂O on C18 Silica',
    bestForOverride: 'Lipophilic products (cLogP > 3) verified by orthogonal reverse-phase C18',
  },
  {
    id: 'c18_meoh_50_tfa',
    strongSolvent: 'MeOH',
    weakSolvent: 'H2O',
    strongPct: 50,
    modifierId: 'tfa_01',
    stationaryPhase: 'C18',
    family: 'c18_rp',
    preferenceTier: 'secondary',
    bestForOverride: 'Sharp LC-MS-matched C18 spots for basic amines, guanidines & carboxylic acids',
  },
];

/**
 * Generates clean intermediate and specialized bench-ready eluent candidates
 * from physical neat solvent + modifier rules (respecting miscibility & chemical stability).
 */
export function generateExtendedDynamicSpecs(context?: {
  hasStrongWellAcid?: boolean;
  needsBasicMod?: boolean;
  needsAcidMod?: boolean;
  aromaticHeavyPlate?: boolean;
}): DynamicEluentSpec[] {
  const candidates: DynamicEluentSpec[] = [
    // Intermediate EtOAc / Hexanes rungs (clean chemist steps)
    {
      id: 'etoac_hex_15',
      strongSolvent: 'EtOAc',
      weakSolvent: 'Hexanes',
      strongPct: 15,
      modifierId: 'none',
      stationaryPhase: 'SiO2',
      family: 'etoac_hex',
      preferenceTier: 'primary',
    },
    {
      id: 'etoac_hex_35',
      strongSolvent: 'EtOAc',
      weakSolvent: 'Hexanes',
      strongPct: 35,
      modifierId: 'none',
      stationaryPhase: 'SiO2',
      family: 'etoac_hex',
      preferenceTier: 'primary',
    },
    {
      id: 'etoac_hex_65',
      strongSolvent: 'EtOAc',
      weakSolvent: 'Hexanes',
      strongPct: 65,
      modifierId: 'none',
      stationaryPhase: 'SiO2',
      family: 'etoac_hex',
      preferenceTier: 'primary',
    },
    // Intermediate MeOH / DCM rungs
    {
      id: 'meoh_dcm_2',
      strongSolvent: 'MeOH',
      weakSolvent: 'DCM',
      strongPct: 2,
      modifierId: 'none',
      stationaryPhase: 'SiO2',
      family: 'meoh_dcm',
      preferenceTier: 'primary',
    },
    {
      id: 'meoh_dcm_5',
      strongSolvent: 'MeOH',
      weakSolvent: 'DCM',
      strongPct: 5,
      modifierId: 'none',
      stationaryPhase: 'SiO2',
      family: 'meoh_dcm',
      preferenceTier: 'primary',
    },
    {
      id: 'meoh_dcm_10',
      strongSolvent: 'MeOH',
      weakSolvent: 'DCM',
      strongPct: 10,
      modifierId: 'none',
      stationaryPhase: 'SiO2',
      family: 'meoh_dcm',
      preferenceTier: 'primary',
    },
    // Toluene aromatic pi-pi sharpening rungs (clean intermediate + basic-modified options)
    {
      id: 'meoh_toluene_3',
      strongSolvent: 'MeOH',
      weakSolvent: 'Toluene',
      strongPct: 3,
      modifierId: 'none',
      stationaryPhase: 'SiO2',
      family: 'meoh_toluene',
      preferenceTier: 'secondary',
    },
    {
      id: 'etoac_toluene_25',
      strongSolvent: 'EtOAc',
      weakSolvent: 'Toluene',
      strongPct: 25,
      modifierId: 'none',
      stationaryPhase: 'SiO2',
      family: 'meoh_toluene',
      preferenceTier: 'secondary',
      bestForOverride: 'Aromatic π-π selectivity in aprotic EtOAc/Toluene — sharp spots for indoles & heteroarenes',
    },
    {
      id: 'acetone_hex_35',
      strongSolvent: 'Acetone',
      weakSolvent: 'Hexanes',
      strongPct: 35,
      modifierId: 'none',
      stationaryPhase: 'SiO2',
      family: 'acetone_hex',
      preferenceTier: 'secondary',
    },
    {
      id: 'etoac_dcm_40',
      strongSolvent: 'EtOAc',
      weakSolvent: 'DCM',
      strongPct: 40,
      modifierId: 'none',
      stationaryPhase: 'SiO2',
      family: 'etoac_dcm',
      preferenceTier: 'secondary',
    },
  ];

  if (context?.needsBasicMod || context?.hasStrongWellAcid) {
    candidates.push(
      {
        id: 'etoac_hex_15_et3n',
        strongSolvent: 'EtOAc',
        weakSolvent: 'Hexanes',
        strongPct: 15,
        modifierId: 'et3n_1',
        stationaryPhase: 'SiO2',
        family: 'basic_mod',
        preferenceTier: 'primary',
      },
      {
        id: 'etoac_hex_45_et3n',
        strongSolvent: 'EtOAc',
        weakSolvent: 'Hexanes',
        strongPct: 45,
        modifierId: 'et3n_1',
        stationaryPhase: 'SiO2',
        family: 'basic_mod',
        preferenceTier: 'primary',
      },
      {
        id: 'meoh_dcm_2_et3n',
        strongSolvent: 'MeOH',
        weakSolvent: 'DCM',
        strongPct: 2,
        modifierId: 'et3n_1',
        stationaryPhase: 'SiO2',
        family: 'basic_mod',
        preferenceTier: 'primary',
      },
      {
        id: 'meoh_dcm_8_et3n',
        strongSolvent: 'MeOH',
        weakSolvent: 'DCM',
        strongPct: 8,
        modifierId: 'et3n_1',
        stationaryPhase: 'SiO2',
        family: 'basic_mod',
        preferenceTier: 'primary',
      },
      {
        id: 'nh3_meoh_dcm_8',
        strongSolvent: 'MeOH',
        weakSolvent: 'DCM',
        strongPct: 6,
        modifierId: 'nh3_meoh_2',
        stationaryPhase: 'SiO2',
        family: 'basic_mod',
        preferenceTier: 'primary',
      },
      {
        id: 'meoh_toluene_5_et3n',
        strongSolvent: 'MeOH',
        weakSolvent: 'Toluene',
        strongPct: 5,
        modifierId: 'et3n_1',
        stationaryPhase: 'SiO2',
        family: 'meoh_toluene',
        preferenceTier: 'secondary',
        bestForOverride: 'Toluene aromatic π-sharpening + 1% Et₃N for basic benzimidazoles & indoles',
      }
    );
  }

  if (context?.hasStrongWellAcid) {
    // High-capacity 4% (2M NH3 in MeOH) rescue ternary blends for TsOH/MsOH/TfOH wells
    candidates.push(
      {
        id: 'nh3_meoh_dcm_high_6',
        strongSolvent: 'MeOH',
        weakSolvent: 'DCM',
        strongPct: 2,
        modifierId: 'nh3_meoh_4',
        stationaryPhase: 'SiO2',
        family: 'basic_mod',
        preferenceTier: 'primary',
        bestForOverride: 'High-capacity 4% (2M NH₃/MeOH) neutralizes stoichiometric TsOH/MsOH salts cleanly at 6% total MeOH',
      },
      {
        id: 'nh3_meoh_dcm_high_12',
        strongSolvent: 'MeOH',
        weakSolvent: 'DCM',
        strongPct: 8,
        modifierId: 'nh3_meoh_4',
        stationaryPhase: 'SiO2',
        family: 'basic_mod',
        preferenceTier: 'primary',
        bestForOverride: 'High-capacity 4% (2M NH₃/MeOH) at 12% total MeOH for polar bis-azoles & polyamines in TsOH wells',
      }
    );
  }

  if (context?.needsAcidMod) {
    candidates.push(
      {
        id: 'etoac_hex_15_acoh',
        strongSolvent: 'EtOAc',
        weakSolvent: 'Hexanes',
        strongPct: 15,
        modifierId: 'acoh_1',
        stationaryPhase: 'SiO2',
        family: 'acid_mod',
        preferenceTier: 'primary',
      },
      {
        id: 'etoac_hex_45_acoh',
        strongSolvent: 'EtOAc',
        weakSolvent: 'Hexanes',
        strongPct: 45,
        modifierId: 'acoh_1',
        stationaryPhase: 'SiO2',
        family: 'acid_mod',
        preferenceTier: 'primary',
      },
      {
        id: 'meoh_dcm_5_acoh',
        strongSolvent: 'MeOH',
        weakSolvent: 'DCM',
        strongPct: 5,
        modifierId: 'acoh_1',
        stationaryPhase: 'SiO2',
        family: 'acid_mod',
        preferenceTier: 'primary',
      }
    );
  }

  if (context?.aromaticHeavyPlate && !context?.needsBasicMod) {
    candidates.push({
      id: 'etoac_toluene_40',
      strongSolvent: 'EtOAc',
      weakSolvent: 'Toluene',
      strongPct: 40,
      modifierId: 'none',
      stationaryPhase: 'SiO2',
      family: 'meoh_toluene',
      preferenceTier: 'secondary',
      bestForOverride: 'Aprotic aromatic π-π selectivity — tightens trailing polyaromatic heterocycles',
    });
  }

  return candidates.filter((c) => validateEluentCompatibility(c).valid);
}

/**
 * Inverts the Langmuir silanol-saturation mixing law to solve for the strong-solvent volume %
 * needed to reach a target empirical elution strength `targetStrength` on SiO2.
 */
export function invertLangmuirForPct(
  strongSolvent: NeatSolventId,
  weakSolvent: NeatSolventId,
  modifierId: ModifierId,
  targetStrength: number
): number | null {
  const strong = NEAT_SOLVENTS[strongSolvent];
  const weak = NEAT_SOLVENTS[weakSolvent];
  const mod = MODIFIER_SPECS[modifierId];
  const span = strong.epsSio2 - weak.epsSio2;
  if (span <= 0.05) return null;

  const neededBase = targetStrength - mod.strengthDelta;
  if (neededBase <= weak.epsSio2 + 0.01) {
    return strongSolvent === 'MeOH' ? 1 : 2;
  }
  if (neededBase >= strong.epsSio2 - 0.01) {
    return strongSolvent === 'MeOH' ? Math.max(1, 14 - mod.meohContributionPct) : 95;
  }

  const fEff = Math.max(0.01, Math.min(0.98, (neededBase - weak.epsSio2) / span));
  const kRel = Math.max(1.0, strong.silanolAffinity / Math.max(0.5, weak.silanolAffinity));
  const vB = fEff / (kRel - (kRel - 1) * fEff);
  let rawPct = vB * 100;

  if (strongSolvent === 'MeOH') {
    rawPct -= mod.meohContributionPct;
    const maxNeat = Math.max(0, 14 - mod.meohContributionPct);
    const clamped = Math.max(0, Math.min(maxNeat, Math.round(rawPct)));
    return clamped;
  }

  // Clean bench steps: 2% steps below 12%, 5% steps from 15%..95%
  if (rawPct < 12) {
    return Math.max(2, Math.min(12, Math.round(rawPct / 2) * 2));
  }
  return Math.max(15, Math.min(90, Math.round(rawPct / 5) * 5));
}

export interface PlateSynthesisInput {
  targetStrengths: number[];
  aromaticHeavyPlate: boolean;
  hasStrongWellAcid: boolean;
  maxAcidStress: number;
  needsBasicMod: boolean;
  needsAcidMod: boolean;
}

/**
 * Synthesizes plate-specific clean bench solvent ratios directly by inverting the empirical
 * Langmuir elution model around the plate's chemical clusters, acid stress, and aromaticity.
 */
export function synthesizePlateTailoredSpecs(input: PlateSynthesisInput): DynamicEluentSpec[] {
  const out: DynamicEluentSpec[] = [];
  const seen = new Set<string>();

  const pushIfValid = (spec: DynamicEluentSpec) => {
    const key = `${spec.strongSolvent}:${spec.weakSolvent}:${spec.strongPct}:${spec.modifierId}:${spec.stationaryPhase}`;
    if (seen.has(key)) return;
    if (!validateEluentCompatibility(spec).valid) return;
    seen.add(key);
    out.push(spec);
  };

  // Pick optimal basic/acid modifier based on empirical neutralizing capacity vs maxAcidStress
  const basicModId: ModifierId =
    input.hasStrongWellAcid && input.maxAcidStress >= 0.90
      ? 'nh3_meoh_4'
      : input.hasStrongWellAcid || input.needsBasicMod
      ? 'nh3_meoh_2'
      : 'none';

  for (const sTarget of input.targetStrengths) {
    // 1. EtOAc / Hexanes family for nonpolar-to-medium strengths (<= 0.66)
    if (sTarget <= 0.66) {
      const modId: ModifierId = input.needsAcidMod
        ? 'acoh_1'
        : input.needsBasicMod && !input.hasStrongWellAcid
        ? 'et3n_1'
        : 'none';
      const pct = invertLangmuirForPct('EtOAc', 'Hexanes', modId, sTarget);
      if (pct !== null && pct >= 2 && pct <= 90) {
        const modTag = modId === 'none' ? '' : `_${modId.split('_')[0]}`;
        pushIfValid({
          id: `synth_etoac_hex_${pct}${modTag}`,
          strongSolvent: 'EtOAc',
          weakSolvent: 'Hexanes',
          strongPct: pct,
          modifierId: modId,
          stationaryPhase: 'SiO2',
          family: modId === 'acoh_1' ? 'acid_mod' : modId === 'et3n_1' ? 'basic_mod' : 'etoac_hex',
          preferenceTier: 'primary',
          isSynthesized: true,
          synthesisNote: `Synthesized via Langmuir inversion for target ε⁰ ≈ ${sTarget.toFixed(2)}`,
        });
      }
    }

    // 2. MeOH / DCM family (neutral, Et3N, or stoichiometrically matched NH3/MeOH) for medium-to-polar strengths (>= 0.42)
    if (sTarget >= 0.42) {
      const modsToTry: ModifierId[] = [];
      if (input.needsBasicMod || input.hasStrongWellAcid) {
        if (basicModId !== 'none') modsToTry.push(basicModId);
        if (!input.hasStrongWellAcid) modsToTry.push('et3n_1');
      } else if (input.needsAcidMod) {
        modsToTry.push('acoh_1');
      } else {
        modsToTry.push('none');
      }

      for (const modId of modsToTry) {
        const pct = invertLangmuirForPct('MeOH', 'DCM', modId, sTarget);
        if (pct !== null && pct >= 0) {
          const id =
            modId === 'none'
              ? `synth_meoh_dcm_${pct}`
              : modId === 'et3n_1'
              ? `synth_meoh_dcm_${pct}_et3n`
              : modId === 'acoh_1'
              ? `synth_meoh_dcm_${pct}_acoh`
              : `synth_nh3_dcm_${pct}_${MODIFIER_SPECS[modId].volPct}pct`;
          pushIfValid({
            id,
            strongSolvent: 'MeOH',
            weakSolvent: 'DCM',
            strongPct: pct,
            modifierId: modId,
            stationaryPhase: 'SiO2',
            family: modId === 'acoh_1' ? 'acid_mod' : modId === 'none' ? 'meoh_dcm' : 'basic_mod',
            preferenceTier: 'primary',
            isSynthesized: true,
            synthesisNote:
              modId === 'nh3_meoh_4'
                ? `Plate-tuned ${sTarget.toFixed(2)} ε⁰ + 4% NH₃/MeOH (cap 1.35 eq for ${input.maxAcidStress.toFixed(1)} eq acid stress)`
                : `Synthesized via Langmuir inversion for target ε⁰ ≈ ${sTarget.toFixed(2)}`,
          });
        }
      }
    }

    // 3. Aromatic pi-sharpening Toluene blends when plate is rich in aromatic rings
    if (input.aromaticHeavyPlate) {
      if (sTarget >= 0.25 && sTarget <= 0.64 && !input.hasStrongWellAcid) {
        const modTol: ModifierId = input.needsBasicMod ? 'et3n_1' : 'none';
        const tolPct = invertLangmuirForPct('EtOAc', 'Toluene', modTol, sTarget);
        if (tolPct !== null && tolPct >= 10 && tolPct <= 60) {
          pushIfValid({
            id: `synth_etoac_tol_${tolPct}${modTol === 'et3n_1' ? '_et3n' : ''}`,
            strongSolvent: 'EtOAc',
            weakSolvent: 'Toluene',
            strongPct: tolPct,
            modifierId: modTol,
            stationaryPhase: 'SiO2',
            family: 'meoh_toluene',
            preferenceTier: 'secondary',
            isSynthesized: true,
            synthesisNote: `Toluene π-π competition blend synthesized for ε⁰ ≈ ${sTarget.toFixed(2)}`,
          });
        }
      }
      if (sTarget >= 0.45) {
        const modTolMeoh: ModifierId =
          input.hasStrongWellAcid || input.needsBasicMod ? basicModId : 'none';
        const pctTol = invertLangmuirForPct('MeOH', 'Toluene', modTolMeoh, sTarget);
        if (pctTol !== null && pctTol >= 1 && pctTol <= 12) {
          pushIfValid({
            id: `synth_meoh_tol_${pctTol}${modTolMeoh === 'none' ? '' : `_${modTolMeoh}`}`,
            strongSolvent: 'MeOH',
            weakSolvent: 'Toluene',
            strongPct: pctTol,
            modifierId: modTolMeoh,
            stationaryPhase: 'SiO2',
            family: 'meoh_toluene',
            preferenceTier: 'secondary',
            isSynthesized: true,
            synthesisNote: `Aromatic π-π sharpening blend synthesized for ε⁰ ≈ ${sTarget.toFixed(2)}`,
          });
        }
      }
    }
  }

  return out;
}

/**
 * Generates Nyiredy PRISMA selectivity-triangle ternary mobile phases combining orthogonal
 * solvent vertices (ester/ether HBA + dipolar DCM or aromatic Toluene or protic MeOH + alkane carrier)
 * to rescue co-eluting wells that binary eluents cannot separate cleanly.
 */
export function generatePrismaTernarySpecs(input: PlateSynthesisInput): DynamicEluentSpec[] {
  const out: DynamicEluentSpec[] = [];
  const seen = new Set<string>();

  const pushIfValid = (spec: DynamicEluentSpec) => {
    const key = `${spec.strongSolvent}:${spec.ternaryCoSolvent?.solvent ?? ''}:${spec.ternaryCoSolvent?.pct ?? 0}:${spec.weakSolvent}:${spec.strongPct}:${spec.modifierId}`;
    if (seen.has(key)) return;
    if (!validateEluentCompatibility(spec).valid) return;
    seen.add(key);
    out.push(spec);
  };

  const basicModId: ModifierId =
    input.hasStrongWellAcid && input.maxAcidStress >= 0.90
      ? 'nh3_meoh_4'
      : input.hasStrongWellAcid || input.needsBasicMod
      ? 'et3n_1'
      : 'none';

  // Build representative ternary selectivity-triangle vertices matched to plate polarity clusters
  const hasLowMed = input.targetStrengths.some((s) => s <= 0.45);
  const hasMedHigh = input.targetStrengths.some((s) => s >= 0.35 && s <= 0.72);
  const hasHigh = input.targetStrengths.some((s) => s >= 0.52);

  if (hasLowMed) {
    // PRISMA Vertex A: Ester + Dipolar + Alkane (EtOAc / DCM / Hexanes)
    pushIfValid({
      id: 'prisma_etoac_dcm_hex_15_35',
      strongSolvent: 'EtOAc',
      ternaryCoSolvent: { solvent: 'DCM', pct: 35 },
      weakSolvent: 'Hexanes',
      strongPct: 15,
      modifierId: input.needsAcidMod ? 'acoh_1' : basicModId === 'et3n_1' ? 'et3n_1' : 'none',
      stationaryPhase: 'SiO2',
      family: 'prisma_ternary',
      preferenceTier: 'secondary',
      isSynthesized: true,
      synthesisNote: 'PRISMA ternary (Ester + Dipolar DCM + Hexanes) to split dipolar/HBA overlaps',
    });
    // PRISMA Vertex B: Pure Ether HBA + Dipolar + Alkane (MTBE / DCM / Hexanes)
    pushIfValid({
      id: 'prisma_mtbe_dcm_hex_20_30',
      strongSolvent: 'MTBE',
      ternaryCoSolvent: { solvent: 'DCM', pct: 30 },
      weakSolvent: 'Hexanes',
      strongPct: 20,
      modifierId: input.needsAcidMod ? 'acoh_1' : basicModId === 'et3n_1' ? 'et3n_1' : 'none',
      stationaryPhase: 'SiO2',
      family: 'prisma_ternary',
      preferenceTier: 'secondary',
      isSynthesized: true,
      synthesisNote: 'PRISMA ternary (Pure Ether MTBE x_e + Dipolar DCM + Hexanes)',
    });
  }

  if (hasMedHigh) {
    pushIfValid({
      id: 'prisma_etoac_dcm_hex_35_25',
      strongSolvent: 'EtOAc',
      ternaryCoSolvent: { solvent: 'DCM', pct: 25 },
      weakSolvent: 'Hexanes',
      strongPct: 35,
      modifierId: input.needsAcidMod ? 'acoh_1' : basicModId === 'et3n_1' ? 'et3n_1' : 'none',
      stationaryPhase: 'SiO2',
      family: 'prisma_ternary',
      preferenceTier: 'secondary',
      isSynthesized: true,
      synthesisNote: 'PRISMA ternary (35% EtOAc / 25% DCM / Hexanes) for co-eluting mid-polar heterocycles',
    });
    pushIfValid({
      id: 'prisma_acetone_dcm_hex_20_30',
      strongSolvent: 'Acetone',
      ternaryCoSolvent: { solvent: 'DCM', pct: 30 },
      weakSolvent: 'Hexanes',
      strongPct: 20,
      modifierId: input.needsAcidMod ? 'acoh_1' : basicModId === 'et3n_1' ? 'et3n_1' : 'none',
      stationaryPhase: 'SiO2',
      family: 'prisma_ternary',
      preferenceTier: 'secondary',
      isSynthesized: true,
      synthesisNote: 'PRISMA ternary (Carbonyl HBA Acetone + Dipolar DCM + Hexanes)',
    });
    pushIfValid({
      id: 'prisma_mtbe_dcm_hex_40_20',
      strongSolvent: 'MTBE',
      ternaryCoSolvent: { solvent: 'DCM', pct: 20 },
      weakSolvent: 'Hexanes',
      strongPct: 40,
      modifierId: input.needsAcidMod ? 'acoh_1' : basicModId === 'et3n_1' ? 'et3n_1' : 'none',
      stationaryPhase: 'SiO2',
      family: 'prisma_ternary',
      preferenceTier: 'secondary',
      isSynthesized: true,
      synthesisNote: 'PRISMA ternary (40% MTBE / 20% DCM / Hexanes) — aprotic HBA + dipolar selectivity',
    });
  }

  if (input.aromaticHeavyPlate || hasLowMed || hasMedHigh) {
    // PRISMA Vertex C: Ester + Aromatic pi-pi + Alkane (EtOAc / Toluene / Hexanes)
    pushIfValid({
      id: 'prisma_etoac_tol_hex_25_35',
      strongSolvent: 'EtOAc',
      ternaryCoSolvent: { solvent: 'Toluene', pct: 35 },
      weakSolvent: 'Hexanes',
      strongPct: 25,
      modifierId: input.needsAcidMod ? 'acoh_1' : basicModId === 'et3n_1' ? 'et3n_1' : 'none',
      stationaryPhase: 'SiO2',
      family: 'prisma_ternary',
      preferenceTier: 'secondary',
      isSynthesized: true,
      synthesisNote: 'PRISMA ternary (EtOAc + Toluene π-π + Hexanes) — lower viscosity than neat Toluene',
    });
  }

  if (hasHigh || input.needsBasicMod) {
    // PRISMA Vertex D: Homogeneous Protic + Ester + Alkane (MeOH / EtOAc / Hexanes; EtOAc >= 45% keeps MeOH+Hex miscible)
    const modMeohEa: ModifierId = input.needsAcidMod ? 'acoh_1' : input.needsBasicMod ? 'et3n_1' : 'none';
    pushIfValid({
      id: 'prisma_meoh_etoac_hex_4_56',
      strongSolvent: 'MeOH',
      ternaryCoSolvent: { solvent: 'EtOAc', pct: 56 },
      weakSolvent: 'Hexanes',
      strongPct: 4,
      modifierId: modMeohEa,
      stationaryPhase: 'SiO2',
      family: 'prisma_ternary',
      preferenceTier: 'secondary',
      isSynthesized: true,
      synthesisNote: 'PRISMA ternary (4% MeOH / 56% EtOAc / Hexanes) — bridged protic HBD + ester selectivity',
    });
    pushIfValid({
      id: 'prisma_meoh_etoac_hex_8_52',
      strongSolvent: 'MeOH',
      ternaryCoSolvent: { solvent: 'EtOAc', pct: 52 },
      weakSolvent: 'Hexanes',
      strongPct: 8,
      modifierId: modMeohEa,
      stationaryPhase: 'SiO2',
      family: 'prisma_ternary',
      preferenceTier: 'secondary',
      isSynthesized: true,
      synthesisNote: 'PRISMA ternary (8% MeOH / 52% EtOAc / Hexanes) — polar protic selectivity without DCM',
    });
  }

  return out;
}

