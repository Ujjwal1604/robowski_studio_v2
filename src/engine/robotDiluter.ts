// Robowski Studio - Post-Reaction Plate Dilution Planner (synced strictly with zeus-pipetter/diluter.py)
import { CONTAINER_GEOMETRY, JAR_CAPACITY_ML, PLATE_CAPACITY, VIAL_CAPACITY_UL } from './constants';
import { formatDuration, tipSize } from './deckTiming';

export const DILUTER_SOLVENTS = [
  'ethanol',
  'water',
  'DMF',
  'Dioxane',
  'DCE',
  'TolueneMix',
  'glycerin',
  'serum',
] as const;

export interface DiluterPlanInput {
  /** Number of vials on the reaction plate (1..54) */
  vialCount: number;
  /** Initial crude reaction volume in Plate A vials (µL) */
  crudeVolumeUl: number;
  /** First dilution stage A -> B */
  solvent0: string;
  solvent0JarPlate: 6 | 7;
  solvent0JarPos: 0 | 1;
  /** volumes[0]: solvent added to Plate A before transfer (µL, 0 to skip) */
  volSolventToA: number;
  /** volumes[1]: aliquot transferred from Plate A -> Plate B (µL) */
  volAToB: number;
  /** volumes[2]: diluting solvent added into Plate B (µL) */
  volSolventToB: number;
  /** Optional second dilution stage B -> C */
  enableSecondStage: boolean;
  solvent1: string;
  solvent1JarPlate: 6 | 7;
  solvent1JarPos: 0 | 1;
  /** volumes[3]: extra solvent added to Plate B before B->C transfer (µL, usually 0) */
  volSolventToBExtra: number;
  /** volumes[4]: aliquot transferred from Plate B -> Plate C (µL) */
  volBToC: number;
  /** volumes[5]: diluting solvent added into Plate C (µL) */
  volSolventToC: number;
}

export interface DiluterStepSummary {
  stage: 'A->B' | 'B->C';
  stepId: 0 | 1 | 2;
  label: string;
  volumeUl: number;
  active: boolean;
  tipType: '50ul' | '300ul' | '1000ul' | null;
  tipsNeeded: number;
  totalVolumeMl: number;
  estimatedSeconds: number;
}

export interface DiluterPlanResult {
  volumesArray: [number, number, number, number, number, number];
  pythonVolumesLine: string;
  plateAFinalUl: number;
  plateBFinalUl: number;
  plateCFinalUl: number;
  factorA: number;
  factorAB: number;
  factorBC: number;
  totalFactorB: number;
  totalFactorC: number;
  solvent0TotalMl: number;
  solvent0WithDeadMl: number;
  solvent1TotalMl: number;
  solvent1WithDeadMl: number;
  tips: { 50: number; 300: number; 1000: number };
  estimatedSeconds: number;
  estimatedLabel: string;
  steps: DiluterStepSummary[];
  warnings: string[];
  ok: boolean;
}

export function calculateDiluterPlan(input: DiluterPlanInput): DiluterPlanResult {
  const n = Math.max(1, Math.min(PLATE_CAPACITY, Math.round(input.vialCount || 54)));
  const crude = Math.max(0, Number(input.crudeVolumeUl) || 0);
  const v0 = Math.max(0, Number(input.volSolventToA) || 0);
  const v1 = Math.max(0, Number(input.volAToB) || 0);
  const v2 = Math.max(0, Number(input.volSolventToB) || 0);
  const v3 = input.enableSecondStage ? Math.max(0, Number(input.volSolventToBExtra) || 0) : 0;
  const v4 = input.enableSecondStage ? Math.max(0, Number(input.volBToC) || 0) : 0;
  const v5 = input.enableSecondStage ? Math.max(0, Number(input.volSolventToC) || 0) : 0;

  const volumesArray: [number, number, number, number, number, number] = [v0, v1, v2, v3, v4, v5];
  const warnings: string[] = [];

  // Volumes inside each vial during dilution
  const plateAFinalUl = crude + v0;
  const plateBPostFirstUl = v1 + v2;
  const plateBFinalUl = plateBPostFirstUl + v3;
  const plateCFinalUl = v4 + v5;

  if (plateAFinalUl > VIAL_CAPACITY_UL) {
    warnings.push(
      `Plate A vials will reach ${plateAFinalUl.toFixed(0)} µL (exceeds 2000 µL max of a 2 mL vial). Reduce Step 0 solvent to Plate A.`
    );
  }
  if (plateBFinalUl > VIAL_CAPACITY_UL) {
    warnings.push(
      `Plate B vials will reach ${plateBFinalUl.toFixed(0)} µL (exceeds 2000 µL max of a 2 mL vial). Reduce Plate B solvent.`
    );
  }
  if (input.enableSecondStage && plateCFinalUl > VIAL_CAPACITY_UL) {
    warnings.push(
      `Plate C vials will reach ${plateCFinalUl.toFixed(0)} µL (exceeds 2000 µL max of a 2 mL vial). Reduce Plate C solvent.`
    );
  }
  if (v1 > 0 && plateAFinalUl - v1 < CONTAINER_GEOMETRY.vial.deadVolumeUl) {
    warnings.push(
      `Plate A transfer (${v1} µL) leaves less than ${CONTAINER_GEOMETRY.vial.deadVolumeUl} µL dead volume in 2 mL vials.`
    );
  }
  if (input.enableSecondStage && v4 > 0 && plateBFinalUl - v4 < CONTAINER_GEOMETRY.vial.deadVolumeUl) {
    warnings.push(
      `Plate B transfer (${v4} µL) leaves less than ${CONTAINER_GEOMETRY.vial.deadVolumeUl} µL dead volume in 2 mL vials.`
    );
  }

  // Dilution factors
  const factorA = crude > 0 ? plateAFinalUl / crude : 1;
  const factorAB = v1 > 0 ? plateBPostFirstUl / v1 : 1;
  const totalFactorB = factorA * factorAB;

  const factorBExtra = plateBPostFirstUl > 0 ? plateBFinalUl / plateBPostFirstUl : 1;
  const factorBC = input.enableSecondStage && v4 > 0 ? plateCFinalUl / v4 : 1;
  const totalFactorC = totalFactorB * factorBExtra * factorBC;

  const stepsMeta: Array<{
    stage: 'A->B' | 'B->C';
    stepId: 0 | 1 | 2;
    label: string;
    vol: number;
    newTipEveryVial: boolean;
  }> = [
    { stage: 'A->B', stepId: 0, label: `Add ${input.solvent0} to Plate A (quench / pre-dilute)`, vol: v0, newTipEveryVial: false },
    { stage: 'A->B', stepId: 1, label: 'Transfer reaction sample Plate A → Plate B', vol: v1, newTipEveryVial: true },
    { stage: 'A->B', stepId: 2, label: `Add ${input.solvent0} to Plate B`, vol: v2, newTipEveryVial: false },
    { stage: 'B->C', stepId: 0, label: `Add ${input.solvent1} to Plate B (optional)`, vol: v3, newTipEveryVial: false },
    { stage: 'B->C', stepId: 1, label: 'Transfer diluted sample Plate B → Plate C', vol: v4, newTipEveryVial: true },
    { stage: 'B->C', stepId: 2, label: `Add ${input.solvent1} to Plate C`, vol: v5, newTipEveryVial: false },
  ];

  const tips = { 50: 0, 300: 0, 1000: 0 };
  let estimatedSeconds = 0;

  const steps: DiluterStepSummary[] = stepsMeta.map((sm) => {
    const active = sm.vol >= 0.5;
    const ts = active ? tipSize(sm.vol) : null;
    if (active && ts === null) {
      warnings.push(`Step "${sm.label}" volume (${sm.vol} µL) is outside the 0.5–1999 µL tip range.`);
    }
    const tipsNeeded = active && ts ? (sm.newTipEveryVial ? n : 1) : 0;
    if (ts && tipsNeeded > 0) tips[ts] += tipsNeeded;
    const cycles = active && ts ? Math.max(1, Math.ceil(sm.vol / ts - 1e-9)) : 0;
    const secs = active && ts ? tipsNeeded * 30 + n * (13 + (cycles - 1) * 9) : 0;
    estimatedSeconds += secs;

    return {
      stage: sm.stage,
      stepId: sm.stepId,
      label: sm.label,
      volumeUl: sm.vol,
      active,
      tipType: ts ? (`${ts}ul` as '50ul' | '300ul' | '1000ul') : null,
      tipsNeeded,
      totalVolumeMl: Number(((sm.vol * n) / 1000).toFixed(2)),
      estimatedSeconds: Math.round(secs),
    };
  });

  const jarDeadMl = CONTAINER_GEOMETRY.jar.deadVolumeUl / 1000;
  const solvent0TotalMl = Number((((v0 + v2) * n) / 1000).toFixed(2));
  const solvent0WithDeadMl = Number((solvent0TotalMl + (solvent0TotalMl > 0 ? jarDeadMl : 0)).toFixed(2));
  const solvent1TotalMl = Number((((v3 + v5) * n) / 1000).toFixed(2));
  const solvent1WithDeadMl = Number((solvent1TotalMl + (solvent1TotalMl > 0 ? jarDeadMl : 0)).toFixed(2));

  const sameJar =
    input.enableSecondStage &&
    input.solvent0JarPlate === input.solvent1JarPlate &&
    input.solvent0JarPos === input.solvent1JarPos;

  if (sameJar) {
    const combined = Number((solvent0TotalMl + solvent1TotalMl + jarDeadMl).toFixed(2));
    if (combined > JAR_CAPACITY_ML) {
      warnings.push(
        `Shared jar (plate${input.solvent0JarPlate} pos ${input.solvent0JarPos}) needs ${combined.toFixed(1)} mL (exceeds 100 mL jar). Use a second jar position.`
      );
    }
  } else {
    if (solvent0WithDeadMl > JAR_CAPACITY_ML) {
      warnings.push(
        `Stage 1 jar (${input.solvent0}, plate${input.solvent0JarPlate} pos ${input.solvent0JarPos}) needs ${solvent0WithDeadMl.toFixed(1)} mL including dead volume (exceeds 100 mL jar).`
      );
    }
    if (input.enableSecondStage && solvent1WithDeadMl > JAR_CAPACITY_ML) {
      warnings.push(
        `Stage 2 jar (${input.solvent1}, plate${input.solvent1JarPlate} pos ${input.solvent1JarPos}) needs ${solvent1WithDeadMl.toFixed(1)} mL including dead volume (exceeds 100 mL jar).`
      );
    }
  }

  return {
    volumesArray,
    pythonVolumesLine: `volumes = [${volumesArray.join(', ')}]`,
    plateAFinalUl: Math.round(plateAFinalUl),
    plateBFinalUl: Math.round(plateBFinalUl),
    plateCFinalUl: Math.round(plateCFinalUl),
    factorA: Number(factorA.toFixed(2)),
    factorAB: Number(factorAB.toFixed(2)),
    factorBC: Number(factorBC.toFixed(2)),
    totalFactorB: Number(totalFactorB.toFixed(2)),
    totalFactorC: Number(totalFactorC.toFixed(2)),
    solvent0TotalMl,
    solvent0WithDeadMl,
    solvent1TotalMl,
    solvent1WithDeadMl,
    tips,
    estimatedSeconds: Math.round(estimatedSeconds),
    estimatedLabel: formatDuration(estimatedSeconds),
    steps,
    warnings,
    ok: warnings.length === 0,
  };
}
