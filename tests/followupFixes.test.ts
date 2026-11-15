import { describe, it, expect, beforeAll } from 'vitest';
import {
  predictWellReactions,
  PredictorSubstrateInput,
  WellConditionConfig,
  TLC_SOLVENT_LIBRARY,
  profileMoleculeForTlc,
  predictTlcRf,
} from '../src/engine/predictor';

let rdkit: any;
beforeAll(async () => {
  const mod: any = await import('@rdkit/rdkit');
  rdkit = await (mod.default || mod)();
});

const S = (code: string, smiles: string, eq = 1): PredictorSubstrateInput => ({
  id: code, code, name: code, smiles, equivalents: eq, concentrationMm: 50 * eq,
});
const COND = (o: Partial<WellConditionConfig> = {}): WellConditionConfig => ({
  medium: 'auto', additiveName: '', additiveEquiv: 0, additivePka: 0, temperatureC: 25, waterPct: 2,
  solvent: 'DMSO', equivBasis: 'limiting', ...o,
});
const smilesOf = (res: any) => res.species.map((s: any) => s.smiles);

describe('reaction rule fixes', () => {
  it('forms hydrazones and oximes (N-N / N-O nucleophiles)', () => {
    const hz = predictWellReactions(rdkit, [S('A', 'O=Cc1ccccc1'), S('B', 'NN')], COND());
    expect(smilesOf(hz).some((x: string) => /C=NN/.test(x) || /NN=C/.test(x))).toBe(true);
    const ox = predictWellReactions(rdkit, [S('A', 'O=Cc1ccccc1'), S('B', 'NO')], COND());
    expect(smilesOf(ox).some((x: string) => /C=NO|ON=C/.test(x))).toBe(true);
    const ah = predictWellReactions(rdkit, [S('A', 'O=Cc1ccccc1'), S('B', 'NNC(=O)c1ccccc1')], COND());
    expect(smilesOf(ah)).toContain('O=C(NN=Cc1ccccc1)c1ccccc1');
  });

  it('does not turn a plain aldehyde + amide into a hydrazone-type product', () => {
    const r = predictWellReactions(rdkit, [S('A', 'O=Cc1ccccc1'), S('B', 'NC(C)=O')], COND());
    expect(r.species.length).toBe(0);
  });

  it('unactivated aryl chloride + amine is no longer a confident prediction', () => {
    const r = predictWellReactions(
      rdkit,
      [S('A', 'Clc1ccccc1'), S('B', 'C1CCNCC1')],
      COND({ medium: 'base', additiveName: 'DBU', additiveEquiv: 1, additivePka: 13.9, temperatureC: 80 })
    );
    for (const sp of r.species) expect(['Speculative']).toContain(sp.tier);
  });

  it('primary amine carbinolamine gives the imine, a secondary amine can still give an enamine', () => {
    const p = predictWellReactions(rdkit, [S('A', 'CC=O'), S('B', 'Nc1ccccc1')], COND());
    expect(smilesOf(p)).toContain('CC=Nc1ccccc1');
    const q = predictWellReactions(rdkit, [S('A', 'CC=O'), S('B', 'C1CCNCC1')], COND());
    expect(smilesOf(q).some((x: string) => /C=CN/.test(x))).toBe(true);
  });
});

describe('TLC advisor fixes', () => {
  const sys = () => TLC_SOLVENT_LIBRARY.find((s) => s.id === 'etoac_hex_25')!;

  it('nitro groups, enamines and N-oxides are not counted as basic amines; real amines still are', () => {
    for (const smi of ['CC(C)[N+](=O)[O-]', 'OC(c1ccccc1)C[N+](=O)[O-]', 'C=CN1CCCC1', 'C[N+](C)(C)[O-]']) {
      expect(profileMoleculeForTlc(rdkit, smi).aliphAmineCount).toBe(0);
    }
    for (const smi of ['CCN', 'C1CCNCC1', 'NC(=N)N', 'NN']) {
      expect(profileMoleculeForTlc(rdkit, smi).aliphAmineCount).toBeGreaterThan(0);
    }
    const nitro = predictTlcRf(profileMoleculeForTlc(rdkit, 'OC(c1ccccc1)C[N+](=O)[O-]'), sys());
    expect(nitro.tailing).toBe(false);
  });

  it('marks compounds without a chromophore as not UV active', () => {
    expect(profileMoleculeForTlc(rdkit, 'CC(C)(C)OC(=O)CC(=O)OC(C)(C)C').uvActive).toBe(false);
    expect(profileMoleculeForTlc(rdkit, 'CCCCN').uvActive).toBe(false);
    expect(profileMoleculeForTlc(rdkit, 'c1ccccc1C=O').uvActive).toBe(true);
    expect(profileMoleculeForTlc(rdkit, 'CC=CC(C)=O').uvActive).toBe(true);
  });
});
