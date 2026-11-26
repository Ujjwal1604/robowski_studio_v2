import { describe, it, expect, beforeAll } from 'vitest';
import {
  predictWellReactions,
  parseSubstrateAndSalts,
  analyzeTlcVisibility,
  hasAntiBredtDoubleBond,
  hasImpossibleBridgedAromaticRing,
  PredictorSubstrateInput,
  WellConditionConfig,
} from '../src/engine/predictor';

let rdkit: any;
beforeAll(async () => {
  const mod: any = await import('@rdkit/rdkit');
  rdkit = await (mod.default || mod)();
});

const S = (code: string, smiles: string, eq = 1): PredictorSubstrateInput => ({
  id: code,
  code,
  name: code,
  smiles,
  equivalents: eq,
  concentrationMm: 50 * eq,
});

const COND = (o: Partial<WellConditionConfig> = {}): WellConditionConfig => ({
  medium: 'auto',
  additiveName: '',
  additiveEquiv: 0,
  additivePka: 0,
  temperatureC: 60,
  waterPct: 2,
  solvent: 'DMSO',
  equivBasis: 'limiting',
  ...o,
});

describe('RDKit graph intelligence: local pKa shifts, Hammett electronics, ortho sterics, anti-Bredt', () => {
  it('applies substituent-aware DMSO pKa shifts on substituted anilines, phenols, and carboxylic acids', () => {
    const nitroAniline = parseSubstrateAndSalts(rdkit, S('A', 'Nc1ccc([N+](=O)[O-])cc1'));
    const plainAniline = parseSubstrateAndSalts(rdkit, S('B', 'Nc1ccccc1'));
    const methoxyAniline = parseSubstrateAndSalts(rdkit, S('C', 'COc1ccc(N)cc1'));

    const pkaNitro = nitroAniline.sites.find((s) => s.id === 'site_aniline')!.pka;
    const pkaPlain = plainAniline.sites.find((s) => s.id === 'site_aniline')!.pka;
    const pkaMethoxy = methoxyAniline.sites.find((s) => s.id === 'site_aniline')!.pka;

    expect(pkaNitro).toBeLessThan(pkaPlain - 1.5);
    expect(pkaMethoxy).toBeGreaterThan(pkaPlain + 0.4);

    const nitroPhenol = parseSubstrateAndSalts(rdkit, S('D', 'Oc1ccc([N+](=O)[O-])cc1'));
    const plainPhenol = parseSubstrateAndSalts(rdkit, S('E', 'Oc1ccccc1'));
    expect(nitroPhenol.sites.find((s) => s.id === 'site_phenol')!.pka).toBeLessThan(
      plainPhenol.sites.find((s) => s.id === 'site_phenol')!.pka - 3.0
    );

    const chloroAcetic = parseSubstrateAndSalts(rdkit, S('F', 'O=C(O)CCl'));
    const acetic = parseSubstrateAndSalts(rdkit, S('G', 'CC(=O)O'));
    expect(chloroAcetic.sites.find((s) => s.id === 'site_carboxylic_acid')!.pka).toBeLessThan(
      acetic.sites.find((s) => s.id === 'site_carboxylic_acid')!.pka - 2.0
    );
  });

  it('ranks electron-rich aniline above electron-poor 4-nitroaniline and penalizes 2,6-dimethylaniline ortho crowding', () => {
    const cond = COND({ temperatureC: 60 });
    const meo = predictWellReactions(rdkit, [S('A', 'O=Cc1ccccc1'), S('B', 'COc1ccc(N)cc1')], cond, {
      includeSpeculative: true,
    });
    const plain = predictWellReactions(rdkit, [S('A', 'O=Cc1ccccc1'), S('B', 'Nc1ccccc1')], cond, {
      includeSpeculative: true,
    });
    const nitro = predictWellReactions(
      rdkit,
      [S('A', 'O=Cc1ccccc1'), S('B', 'Nc1ccc([N+](=O)[O-])cc1')],
      cond,
      { includeSpeculative: true }
    );
    const orthoCrowd = predictWellReactions(
      rdkit,
      [S('A', 'O=Cc1ccccc1'), S('B', 'Cc1cccc(C)c1N')],
      cond,
      { includeSpeculative: true }
    );

    const imineScore = (res: ReturnType<typeof predictWellReactions>) =>
      res.species.find((s) => s.bestChain.some((st) => st.ruleId === 'DH_imine'))!.score;

    expect(imineScore(meo)).toBeGreaterThan(imineScore(plain));
    expect(imineScore(plain)).toBeGreaterThan(imineScore(nitro));
    expect(imineScore(plain)).toBeGreaterThan(imineScore(orthoCrowd));
  });

  it('rejects anti-Bredt bridgehead double bonds while permitting normal bridged/fused alkenes', () => {
    // Bicyclo[2.2.1]hept-1-ene (bridgehead double bond) -> anti-Bredt!
    expect(hasAntiBredtDoubleBond(rdkit, 'C1=C2CCC(C1)C2')).toBe(true);
    // Norbornene (non-bridgehead double bond) -> valid!
    expect(hasAntiBredtDoubleBond(rdkit, 'C1=CC2CCC1C2')).toBe(false);
    // 2-Cyclopenten-1-one and indene -> valid!
    expect(hasAntiBredtDoubleBond(rdkit, 'O=C1CCC=C1')).toBe(false);
    expect(hasAntiBredtDoubleBond(rdkit, 'C1=Cc2ccccc2C1')).toBe(false);
  });

  it('rejects impossible short-tether meta/para-bridged aromatic cages while permitting ortho/peri-fused aromatics', () => {
    // 1,3-bridged pyrrole cage (exact impossible topology from #13 in user screenshot) -> REJECT!
    expect(
      hasImpossibleBridgedAromaticRing(
        rdkit,
        'OC1(C(Cl)(Cl)Cl)c2cc(c[nH]2)C(c2c[nH]cn2)N1c1ccc2[nH]cnc2c1'
      )
    ).toBe(true);
    // Short 1,3-bridged benzene (meta-cyclophane with 3-atom bridge) -> REJECT!
    expect(hasImpossibleBridgedAromaticRing(rdkit, 'c1cc2CCCc(c1)c2')).toBe(true);
    // Legitimate ortho-fused & peri-fused aromatics -> PERMIT!
    expect(hasImpossibleBridgedAromaticRing(rdkit, 'c1ccc2[nH]ccc2c1')).toBe(false); // indole
    expect(hasImpossibleBridgedAromaticRing(rdkit, 'c1ccc2[nH]cnc2c1')).toBe(false); // benzimidazole
    expect(hasImpossibleBridgedAromaticRing(rdkit, 'c1ccc2c(c1)[nH]c1ccccc21')).toBe(false); // carbazole
    expect(hasImpossibleBridgedAromaticRing(rdkit, 'C1Cc2cccc3cccc1c23')).toBe(false); // acenaphthene
  });

  it('predicts trichloroacetyl amidation (CHCl3 leaving group), downgrades deactivated pyrrole EA, and forbids bridged pyrrole hemiaminal', () => {
    const res = predictWellReactions(
      rdkit,
      [
        S('A', 'O=Cc1c[nH]cn1'), // 1H-imidazole-4-carbaldehyde
        S('B', 'Nc1ccc2[nH]cnc2c1'), // 5-aminobenzimidazole
        S('C', 'O=C(C(Cl)(Cl)Cl)c1ccc[nH]1'), // 2-(trichloroacetyl)pyrrole
      ],
      COND({ medium: 'acid', additiveName: 'TsOH', additiveEquiv: 0.2, additivePka: 0.9, temperatureC: 60 }),
      { includeSpeculative: true }
    );

    // 1. No species may contain an impossible bridged aromatic cage
    for (const sp of res.species) {
      expect(hasImpossibleBridgedAromaticRing(rdkit, sp.smiles)).toBe(false);
    }

    // 2. Real trichloroacetyl amidation product: N-(1H-benzimidazol-5-yl)-1H-pyrrole-2-carboxamide (C12H10N4O)
    const amide = res.species.find((s) => s.formula === 'C12H10N4O');
    expect(amide).toBeDefined();
    expect(amide!.score).toBeGreaterThanOrEqual(0.45);
    expect(amide!.status).toBe('sink');

    // 3. Deactivated 2-(trichloroacetyl)pyrrole Mannich product (C17H13Cl3N6O) must be downgraded below Medium (< 0.28)
    const mannich = res.species.find((s) => s.formula === 'C17H13Cl3N6O');
    if (mannich) {
      expect(mannich.score).toBeLessThan(0.28);
    }
  });
});

describe('RDKit TLC visibility & stain guidance', () => {
  it('flags UV-invisible aliphatic amines and aldehydes with specific stain recommendations', () => {
    const amineVis = analyzeTlcVisibility(rdkit, 'NC1CCCCC1'); // cyclohexylamine
    expect(amineVis.uv254).toBe('none');
    expect(amineVis.stains.some((s) => s.stain === 'Ninhydrin')).toBe(true);
    expect(amineVis.stainTip).toContain('Ninhydrin');

    const aldVis = analyzeTlcVisibility(rdkit, 'CCCCCC=O'); // hexanal
    expect(aldVis.uv254).toBe('none');
    expect(aldVis.stains.some((s) => s.stain === '2,4-DNP')).toBe(true);
    expect(aldVis.stains.some((s) => s.stain === 'KMnO₄')).toBe(true);

    const aromVis = analyzeTlcVisibility(rdkit, 'O=Cc1ccccc1');
    expect(aromVis.uv254).toBe('strong');

    const quinVis = analyzeTlcVisibility(rdkit, 'O=Cc1ccc2ccccc2n1');
    expect(quinVis.uv254).toBe('strong');
    expect(quinVis.uv366Likely).toBe(true);
  });

  it('emits uv_invisible_product alert when a major predicted product has no UV-254 chromophore', () => {
    const res = predictWellReactions(
      rdkit,
      [S('A', 'CC(=O)OC(=O)C'), S('B', 'NC1CCCCC1')], // acetic anhydride + cyclohexylamine -> N-cyclohexylacetamide (UV-invisible!)
      COND({ temperatureC: 25 })
    );
    const amide = res.species.find((s) => s.formula === 'C8H15NO');
    expect(amide).toBeDefined();
    expect(amide!.tlcVisibility?.uv254).toBe('none');
    expect(res.alerts.some((a) => a.kind === 'uv_invisible_product')).toBe(true);
  });
});
