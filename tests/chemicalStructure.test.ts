import { describe, it, expect } from 'vitest';
import SmilesDrawer from 'smiles-drawer';
import { parseLibrarySpreadsheet } from '../src/context/importers';
import { normalize, exampleState } from '../src/context/runPayload';
import { LibraryReagent } from '../src/types';

describe('Chemical Structures & SMILES Integration', () => {
  it('parses valid SMILES strings into molecular AST trees via SmilesDrawer', () => {
    const testCases = [
      'c1ccccc1', // Benzene
      'CC(=O)O', // Acetic acid
      'CCOC(=O)CC(=O)C', // Ethyl acetoacetate
      'Cc1ccc(C(=O)O)cc1', // p-toluic acid
      'CN1C=NC2=C1C(=O)N(C(=O)N2C)C', // Caffeine
    ];

    testCases.forEach((smiles) => {
      let parsed = false;
      let errorOccurred = false;
      SmilesDrawer.parse(
        smiles,
        (tree: any) => {
          expect(tree).toBeDefined();
          expect(tree.atom).toBeDefined();
          parsed = true;
        },
        () => {
          errorOccurred = true;
        }
      );
      expect(parsed).toBe(true);
      expect(errorOccurred).toBe(false);
    });
  });

  it('detects invalid SMILES and triggers the error callback cleanly', () => {
    let errorCalled = false;
    let successCalled = false;
    SmilesDrawer.parse(
      'NotAValidSmilesString!!!',
      () => {
        successCalled = true;
      },
      () => {
        errorCalled = true;
      }
    );
    expect(errorCalled).toBe(true);
    expect(successCalled).toBe(false);
  });

  it('parses SMILES and IUPAC columns from reagent library CSV data', async () => {
    const csvContent = [
      'name,molar_mass_g_mol,density_g_mL,stock_solvent,stock_mM,cas,smiles,iupac_name',
      'Benzaldehyde,106.12,1.04,ethanol,500,100-52-7,c1ccccc1C=O,benzaldehyde',
      'Aniline,93.13,1.02,ethanol,500,62-53-3,Nc1ccccc1,aniline',
      'p-Anisaldehyde,136.15,1.12,ethanol,500,123-11-5,COc1ccc(C=O)cc1,4-methoxybenzaldehyde',
    ].join('\n');

    const file = new File([csvContent], 'test_reagents.csv', { type: 'text/csv' });
    const existingLib: LibraryReagent[] = [];

    const res = await parseLibrarySpreadsheet(file, existingLib);
    expect(res).not.toBeNull();
    expect(res!.added).toBe(3);

    const benzaldehyde = res!.nextLib.find((r) => r.name === 'Benzaldehyde');
    expect(benzaldehyde).toBeDefined();
    expect(benzaldehyde!.smiles).toBe('c1ccccc1C=O');
    expect(benzaldehyde!.iupac).toBe('benzaldehyde');
    expect(benzaldehyde!.molarMass).toBeCloseTo(106.12);

    const anisaldehyde = res!.nextLib.find((r) => r.name === 'p-Anisaldehyde');
    expect(anisaldehyde).toBeDefined();
    expect(anisaldehyde!.smiles).toBe('COc1ccc(C=O)cc1');
    expect(anisaldehyde!.iupac).toBe('4-methoxybenzaldehyde');
  });

  it('preserves reagent SMILES and IUPAC properties across run normalization', () => {
    const state = exampleState();
    state.reagents[0].smiles = 'c1ccccc1C=O';
    state.reagents[0].iupac = 'benzaldehyde';
    state.reagents[1].smiles = 'CC(=O)O';
    state.reagents[1].iupac = 'acetic acid';

    const normalized = normalize(state);
    expect(normalized.reagents[0].smiles).toBe('c1ccccc1C=O');
    expect(normalized.reagents[0].iupac).toBe('benzaldehyde');
    expect(normalized.reagents[1].smiles).toBe('CC(=O)O');
    expect(normalized.reagents[1].iupac).toBe('acetic acid');
  });
});
