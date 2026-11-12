import { describe, it, expect, vi } from 'vitest';
import { extractSlideData, drawSlideOnCanvas } from '../src/engine/slideGenerator';
import { RunState } from '../src/types';

describe('Group Meeting Slide Generator', () => {
  const sampleState: RunState = {
    id: 'run_test_1',
    name: 'Suzuki-Miyaura Biaryl Screen',
    mode: 'concentration',
    hood: 'left',
    vialVolume: 200,
    threshold: 5,
    dilutionFactor: 10,
    reactionSolvent: 'DMF',
    leftoverMl: 2,
    flasksText: '',
    randomize: false,
    randomSeed: 42,
    solventAfter: 0,
    deckPlates: null,
    stockVolumeCheck: true,
    newTipEveryTransfer: true,
    reagents: [
      {
        code: 'AA',
        name: '4-bromotoluene',
        molarMass: 171.04,
        density: '',
        stock: 50,
        solvent: 'DMF',
        min: 10,
        step: 10,
        max: 30,
        smiles: 'Cc1ccc(Br)cc1',
      },
      {
        code: 'BB',
        name: 'phenylboronic acid',
        molarMass: 121.93,
        density: '',
        stock: 50,
        solvent: 'DMF',
        min: 10,
        step: 10,
        max: 30,
        smiles: 'OB(O)c1ccccc1',
      },
    ],
    eln: {
      reactionClass: 'Suzuki-Miyaura Coupling',
      objective: 'Optimize base and ligand for high-yield biaryl synthesis',
      wells: {
        '0-0': {
          wellIndex: 0,
          plateIndex: 0,
          status: 'hit',
          conversion: 95,
          yield: 89,
          notes: 'Clean product formation, minimal homocoupling',
        },
      },
    },
  };

  it('extracts experimental design, matrix parameters, and hits for presentation slide', () => {
    const slide = extractSlideData(sampleState, undefined, 'Dr. Smith');
    expect(slide.runName).toBe('Suzuki-Miyaura Biaryl Screen');
    expect(slide.presenter).toBe('Dr. Smith');
    expect(slide.designSummary.reactionSolvent).toBe('DMF');
    expect(slide.designSummary.vialVolumeUls).toBe(200);
    expect(slide.designSummary.thresholdUls).toBe(5);
    expect(slide.reagents).toHaveLength(2);
    expect(slide.reagents[0].code).toBe('AA');
    expect(slide.reagents[0].smiles).toBe('Cc1ccc(Br)cc1');
    expect(slide.stats.total).toBeGreaterThan(0);
    expect(slide.bullets).toHaveLength(3);
  });

  it('generates a 16:9 canvas slide with full HD resolution', () => {
    const slide = extractSlideData(sampleState);
    const mockCtx: any = {
      fillRect: vi.fn(),
      fillText: vi.fn(),
      beginPath: vi.fn(),
      moveTo: vi.fn(),
      lineTo: vi.fn(),
      quadraticCurveTo: vi.fn(),
      arc: vi.fn(),
      fill: vi.fn(),
      stroke: vi.fn(),
      closePath: vi.fn(),
      measureText: vi.fn().mockReturnValue({ width: 50 }),
      createLinearGradient: vi.fn().mockReturnValue({ addColorStop: vi.fn() }),
    };
    const mockCanvas: any = {
      width: 0,
      height: 0,
      getContext: vi.fn().mockReturnValue(mockCtx),
    };

    drawSlideOnCanvas(mockCanvas, slide, { theme: 'dark' });

    expect(mockCanvas.width).toBe(1920);
    expect(mockCanvas.height).toBe(1080);
    expect(mockCtx.fillRect).toHaveBeenCalled();
    expect(mockCtx.fillText).toHaveBeenCalled();
  });

  it('supports comparative multi-run slide mode', () => {
    const slide1 = extractSlideData(sampleState);
    const slide2 = extractSlideData({
      ...sampleState,
      id: 'run_test_2',
      name: 'Amide Coupling Campaign',
      reactionSolvent: 'ethanol',
    });

    const mockCtx: any = {
      fillRect: vi.fn(),
      fillText: vi.fn(),
      beginPath: vi.fn(),
      moveTo: vi.fn(),
      lineTo: vi.fn(),
      quadraticCurveTo: vi.fn(),
      arc: vi.fn(),
      fill: vi.fn(),
      stroke: vi.fn(),
      closePath: vi.fn(),
      measureText: vi.fn().mockReturnValue({ width: 50 }),
      createLinearGradient: vi.fn().mockReturnValue({ addColorStop: vi.fn() }),
    };
    const mockCanvas: any = {
      width: 0,
      height: 0,
      getContext: vi.fn().mockReturnValue(mockCtx),
    };

    drawSlideOnCanvas(mockCanvas, slide1, {
      theme: 'light',
      comparativeData: [slide1, slide2],
    });

    expect(mockCanvas.width).toBe(1920);
    expect(mockCanvas.height).toBe(1080);
  });

  it('correctly maps 9 triplet formulations and 54-well plate layout in triplet mode', () => {
    const tripletState: RunState = {
      ...sampleState,
      id: 'run_triplet_1',
      name: 'Nickel Biaryl Cross-Coupling Triplet Screen',
      mode: 'triplet',
      reagents: [
        { code: 'A', name: '4-bromotoluene', molarMass: 171.04, stock: 50, solvent: 'DMF' },
        { code: 'B', name: 'phenylboronic acid', molarMass: 121.93, stock: 50, solvent: 'DMF' },
        { code: 'C', name: 'Ni(cod)2', molarMass: 275.06, stock: 50, solvent: 'DMF' },
        { code: 'D', name: 'Pd(OAc)2', molarMass: 224.51, stock: 50, solvent: 'DMF' },
        { code: 'E', name: 'CuI', molarMass: 190.45, stock: 50, solvent: 'DMF' },
        { code: 'F', name: 'bpy ligand', molarMass: 156.18, stock: 50, solvent: 'DMF' },
        { code: 'Ac', name: 'K3PO4 base', molarMass: 212.27, stock: 50, solvent: 'DMF' },
        { code: 'Ba', name: 'Cs2CO3 base', molarMass: 325.82, stock: 50, solvent: 'DMF' },
      ],
      tri: {
        base: 50,
        ratios: [[2, 1, 1], [1, 2, 1], [1, 1, 2]],
        adds: [
          { code: 'Ac', equiv: 0.5 },
          { code: 'Ba', equiv: 0.5 },
        ],
        groups: [
          { id: 'g1', name: 'T1', members: ['A', 'B', 'C'] },
          { id: 'g2', name: 'T2', members: ['A', 'B', 'D'] },
          { id: 'g3', name: 'T3', members: ['A', 'B', 'E'] },
          { id: 'g4', name: 'T4', members: ['A', 'C', 'D'] },
          { id: 'g5', name: 'T5', members: ['A', 'C', 'E'] },
          { id: 'g6', name: 'T6', members: ['A', 'D', 'E'] },
          { id: 'g7', name: 'T7', members: ['B', 'C', 'D'] },
          { id: 'g8', name: 'T8', members: ['B', 'C', 'E'] },
          { id: 'g9', name: 'T9', members: ['B', 'D', 'E'] },
        ],
        plates: [
          {
            sections: ['g1', 'g2', 'g3', 'g4', 'g5', 'g6', 'g7', 'g8', 'g9'],
          },
        ],
      },
    };

    const slide = extractSlideData(tripletState);
    expect(slide.mode).toBe('triplet');
    expect(slide.plateLayout.wells).toHaveLength(54);
    expect(slide.tripletDetails).toBeDefined();
    expect(slide.tripletDetails?.totalTriplets).toBe(9);
    expect(slide.tripletDetails?.groups).toHaveLength(9);
    expect(slide.tripletDetails?.groups[0].name).toBe('T1');
    expect(slide.tripletDetails?.groups[0].wellRange).toBe('A1–B3');
    expect(slide.tripletDetails?.groups[8].name).toBe('T9');

    // Verify well A1 mapping: Section 0 (T1), ratio 2:1:1, additive +Ac
    const wellA1 = slide.plateLayout.wells[0];
    expect(wellA1.well).toBe('A1');
    expect(wellA1.sectionName).toBe('T1');
    expect(wellA1.ratioLabel).toBe('2:1:1');
    expect(wellA1.additiveLabel).toBe('+Ac');

    // Verify well B1 mapping: Section 0 (T1), ratio 2:1:1, additive +Ba
    const wellB1 = slide.plateLayout.wells[9];
    expect(wellB1.well).toBe('B1');
    expect(wellB1.sectionName).toBe('T1');
    expect(wellB1.ratioLabel).toBe('2:1:1');
    expect(wellB1.additiveLabel).toBe('+Ba');
  });
});
