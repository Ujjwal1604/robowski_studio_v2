import { RunState } from '../types';
import { normalize } from '../context/runPayload';

export interface ExperimentPreset {
  id: string;
  name: string;
  shortLabel: string;
  category: string;
  reactions: number;
  description: string;
  buildState: () => Partial<RunState>;
}

export const EXPERIMENT_PRESETS: ExperimentPreset[] = [
  {
    id: 'suzuki_miyaura',
    name: 'Suzuki-Miyaura C-C Cross-Coupling',
    shortLabel: 'Suzuki (54 vials)',
    category: 'Cross-Coupling',
    reactions: 54,
    description: 'Aryl bromide + phenylboronic acid + base screen. 3 × 3 × 6 = 54 conditions.',
    buildState: () => ({
      name: 'suzuki-miyaura-screen',
      mode: 'concentration',
      hood: 'left',
      vialVolume: 500,
      threshold: 50,
      dilutionFactor: 5,
      reactionSolvent: 'ethanol',
      leftoverMl: 2,
      flasksText: '2, 5, 10, 20, 50, 100',
      randomize: true,
      randomSeed: 20261018,
      solventAfter: 0,
      deckPlates: null,
      stockVolumeCheck: true,
      newTipEveryTransfer: false,
      reagents: [
        {
          code: 'ArBr',
          name: '4-Bromoanisole',
          molarMass: 187.03,
          density: 1.49,
          stock: 200,
          solvent: 'ethanol',
          pipettingMode: 'empty',
        },
        {
          code: 'BorAcid',
          name: 'Phenylboronic acid',
          molarMass: 121.93,
          density: '',
          stock: 250,
          solvent: 'ethanol',
          pipettingMode: 'empty',
        },
        {
          code: 'Base',
          name: 'Potassium phosphate tribasic',
          molarMass: 212.27,
          density: '',
          stock: 300,
          solvent: 'ethanol',
          pipettingMode: 'empty',
        },
      ],
      sets: [
        {
          name: 'Screening Matrix',
          items: [
            { on: true, min: 20, step: 10, max: 40 }, // 20, 30, 40 (3 values)
            { on: true, min: 25, step: 15, max: 55 }, // 25, 40, 55 (3 values)
            { on: true, min: 30, step: 15, max: 105 }, // 30, 45, 60, 75, 90, 105 (6 values) -> 3*3*6 = 54
          ],
        },
      ],
    }),
  },
  {
    id: 'photoredox_cn',
    name: 'Photoredox C-N Cross-Coupling',
    shortLabel: 'Photoredox (48 vials)',
    category: 'Photochemistry',
    reactions: 48,
    description: 'Dual Ni/Ir catalytic C-N arylation of morpholine with aryl halide. 4 × 4 × 3 = 48 conditions.',
    buildState: () => ({
      name: 'photoredox-cn-coupling',
      mode: 'concentration',
      hood: 'left',
      vialVolume: 500,
      threshold: 50,
      dilutionFactor: 5,
      reactionSolvent: 'DMF',
      leftoverMl: 2,
      flasksText: '2, 5, 10, 20, 50',
      randomize: true,
      randomSeed: 20261101,
      solventAfter: 0,
      deckPlates: null,
      stockVolumeCheck: true,
      newTipEveryTransfer: false,
      reagents: [
        {
          code: 'Amine',
          name: 'Morpholine',
          molarMass: 87.12,
          density: 1.0,
          stock: 400,
          solvent: 'DMF',
          pipettingMode: 'empty',
        },
        {
          code: 'ArCl',
          name: '4-Chlorobenzonitrile',
          molarMass: 137.57,
          density: '',
          stock: 400,
          solvent: 'DMF',
          pipettingMode: 'empty',
        },
        {
          code: 'Catalyst',
          name: '[Ir(dF(CF3)ppy)2(dtbbpy)]PF6',
          molarMass: 1121.9,
          density: '',
          stock: 20,
          solvent: 'DMF',
          pipettingMode: 'empty',
        },
      ],
      sets: [
        {
          name: 'Photoredox Matrix',
          items: [
            { on: true, min: 40, step: 20, max: 100 }, // 40, 60, 80, 100 mM (4 values)
            { on: true, min: 40, step: 20, max: 100 }, // 40, 60, 80, 100 mM (4 values)
            { on: true, min: 2, step: 1, max: 4 },      // 2, 3, 4 mM (3 values) -> 4*4*3 = 48
          ],
        },
      ],
    }),
  },
  {
    id: 'stoichiometry_screen',
    name: 'Stoichiometry & Equivalence Screen',
    shortLabel: 'Equivalence Screen (36 vials)',
    category: 'Equivalence Mode',
    reactions: 36,
    description: 'Equivalence mode screen with limiting substrate and excess nucleophile. 3 × 4 × 3 = 36 conditions.',
    buildState: () => ({
      name: 'stoichiometry-screen',
      mode: 'equivalence',
      hood: 'left',
      vialVolume: 800,
      threshold: 50,
      dilutionFactor: 5,
      reactionSolvent: 'MeCN',
      leftoverMl: 2,
      flasksText: '2, 5, 10, 20, 50',
      randomize: true,
      randomSeed: 20261025,
      solventAfter: 0,
      deckPlates: null,
      stockVolumeCheck: true,
      newTipEveryTransfer: false,
      reagents: [
        {
          code: 'Substrate',
          name: 'Substrate Core',
          molarMass: 210.25,
          density: '',
          stock: 200,
          solvent: 'MeCN',
          pipettingMode: 'empty',
        },
        {
          code: 'Nucleophile',
          name: 'Nucleophile Reagent',
          molarMass: 142.18,
          density: 1.05,
          stock: 400,
          solvent: 'MeCN',
          pipettingMode: 'empty',
        },
        {
          code: 'Additive',
          name: 'Lewis Acid Additive',
          molarMass: 160.0,
          density: '',
          stock: 200,
          solvent: 'MeCN',
          pipettingMode: 'empty',
        },
      ],
      sets: [
        {
          name: 'Equivalence Matrix',
          items: [
            { on: true, min: 25, step: 12.5, max: 50 },  // 25, 37.5, 50 mM (3 values)
            { on: true, min: 1.0, step: 0.5, max: 2.5 },  // 1.0, 1.5, 2.0, 2.5 eq (4 values)
            { on: true, min: 0.2, step: 0.2, max: 0.6 },  // 0.2, 0.4, 0.6 eq (3 values) -> 3*4*3 = 36
          ],
        },
      ],
    }),
  },
];

export function applyPresetToState(presetId: string, current: RunState): RunState {
  const preset = EXPERIMENT_PRESETS.find((p) => p.id === presetId);
  if (!preset) return current;
  const partial = preset.buildState();
  const next: RunState = {
    ...current,
    ...partial,
    id: null, // Treat as fresh run
  };
  return normalize(next);
}
