// Robowski Studio - SMILES Salt/Counterion Parser & Exact DMSO Acid-Base Equilibrium Solver
import {
  AcidBaseSummary,
  IonizableSite,
  ParsedSubstrate,
  PredictorSubstrateInput,
  WellConditionConfig,
} from './types';
import { detectHydrateStoichiometry } from '../conditions';

interface CounterionDef {
  smilesSet: string[];
  label: string;
  acidEquiv: number; // >0 = adds H+ (acid salt like HCl, TFA); <0 = adds base/removes H+ (e.g. Na+, K+)
  pka: number;
  waterEquiv?: number;
}

const KNOWN_COUNTERIONS: CounterionDef[] = [
  { smilesSet: ['Cl', '[Cl-]'], label: 'HCl', acidEquiv: 1, pka: 1.8 },
  { smilesSet: ['Br', '[Br-]'], label: 'HBr', acidEquiv: 1, pka: 0.9 },
  { smilesSet: ['I', '[I-]'], label: 'HI', acidEquiv: 1, pka: 0.5 },
  {
    smilesSet: ['O=C(O)C(F)(F)F', 'O=C([O-])C(F)(F)F', 'FC(F)(F)C(=O)O', 'FC(F)(F)C(=O)[O-]'],
    label: 'TFA',
    acidEquiv: 1,
    pka: 3.45,
  },
  {
    smilesSet: ['Cc1ccc(S(=O)(=O)O)cc1', 'Cc1ccc(S(=O)(=O)[O-])cc1'],
    label: 'TsOH',
    acidEquiv: 1,
    pka: 0.9,
  },
  {
    smilesSet: ['CS(=O)(=O)O', 'CS(=O)(=O)[O-]'],
    label: 'MsOH',
    acidEquiv: 1,
    pka: 1.6,
  },
  {
    smilesSet: ['O=S(=O)(O)C(F)(F)F', 'O=S(=O)([O-])C(F)(F)F'],
    label: 'TfOH',
    acidEquiv: 1,
    pka: 0.3,
  },
  {
    smilesSet: ['O=S(=O)(O)O'],
    label: 'H2SO4',
    acidEquiv: 2,
    pka: 1.0,
  },
  {
    smilesSet: ['O=S(=O)([O-])O', 'O=S(=O)([O-])[O-]'],
    label: 'Sulfate',
    acidEquiv: 1,
    pka: 2.0,
  },
  {
    smilesSet: ['O=P(O)(O)O', 'O=P([O-])(O)O'],
    label: 'H3PO4',
    acidEquiv: 1,
    pka: 5.0,
  },
  {
    smilesSet: ['CC(=O)O', 'CC(=O)[O-]'],
    label: 'AcOH',
    acidEquiv: 1,
    pka: 12.6,
  },
  {
    smilesSet: ['O=C(O)C(=O)O', 'O=C([O-])C(=O)O', 'O=C([O-])C(=O)[O-]'],
    label: 'Oxalate',
    acidEquiv: 2,
    pka: 6.2,
  },
  {
    smilesSet: ['F[B-](F)(F)F'],
    label: 'HBF4',
    acidEquiv: 1,
    pka: 0.5,
  },
  {
    smilesSet: ['F[P-](F)(F)(F)(F)F'],
    label: 'HPF6',
    acidEquiv: 1,
    pka: 0.5,
  },
  { smilesSet: ['O'], label: 'Hydrate', acidEquiv: 0, pka: 31.4, waterEquiv: 1 },
  { smilesSet: ['[Na+]', '[K+]', '[Li+]', '[Cs+]'], label: 'Alkali salt', acidEquiv: -1, pka: 32 },
  { smilesSet: ['[NH4+]'], label: 'NH4+', acidEquiv: 1, pka: 10.5 },
];

interface SiteRule {
  id: string;
  label: string;
  kind: 'acid' | 'base';
  smarts: string;
  pka: number; // DMSO Bordwell-scale approximate pKa (for base = pKa of BH+)
  priority: number; // higher takes precedence if same atom matches
}

// Site rules in DMSO (Bordwell DMSO pKa table values)
const SITE_RULES: SiteRule[] = [
  // Strong / moderate bases (conjugate acid pKa in DMSO)
  {
    id: 'site_guanidine',
    label: 'Guanidine',
    kind: 'base',
    smarts: '[NX3;H2,H1,H0;!$(N-C=O)]-[CX3](=[NX2;H1,H0;!$(N-C=O)])-[NX3;H2,H1,H0;!$(N-C=O)]',
    pka: 13.6,
    priority: 10,
  },
  {
    id: 'site_amidine',
    label: 'Amidine / DBU-like',
    kind: 'base',
    smarts: '[#6]-[CX3](=[NX2;H1,H0])-[NX3;H2,H1,H0;!$(N-C=O)]',
    pka: 13.5,
    priority: 9,
  },
  {
    id: 'site_aliph_amine_prim_sec',
    label: 'Aliphatic amine (1°/2°)',
    kind: 'base',
    smarts: '[NX3;H2,H1;$(N-[#6;X4]);!$(N-C=[O,S,N]);!$(N-S=O);!$(N-c);!$(N-N)]',
    pka: 10.5,
    priority: 7,
  },
  {
    id: 'site_aliph_amine_tert',
    label: 'Aliphatic amine (3°)',
    kind: 'base',
    smarts: '[NX3;H0;$(N([#6;X4])([#6;X4])[#6;X4]);!$(N-C=[O,S,N]);!$(N-c);!$(N-N)]',
    pka: 9.2,
    priority: 6,
  },
  {
    id: 'site_aniline',
    label: 'Aniline / arylamine',
    kind: 'base',
    smarts: '[NX3;H2,H1;$(N-c);!$(N-C=[O,S,N]);!$(N-S=O)]',
    pka: 3.6,
    priority: 5,
  },
  {
    id: 'site_pyridine',
    label: 'Pyridine / azine N',
    kind: 'base',
    smarts: '[nX2;r6;H0]',
    pka: 3.4,
    priority: 4,
  },
  {
    id: 'site_imidazole',
    label: 'Imidazole N',
    kind: 'base',
    smarts: '[nX2;r5;H0;$(n:c:n)]',
    pka: 7.0,
    priority: 5,
  },

  // Acids & Carbon acids (pKa in DMSO)
  {
    id: 'site_sulfonic_acid',
    label: 'Sulfonic acid',
    kind: 'acid',
    smarts: '[SX4](=[OX1])(=[OX1])[OX2H1]',
    pka: 0.9,
    priority: 10,
  },
  {
    id: 'site_carboxylic_acid',
    label: 'Carboxylic acid',
    kind: 'acid',
    smarts: '[CX3](=[OX1])[OX2H1]',
    pka: 12.3,
    priority: 9,
  },
  {
    id: 'site_malononitrile_ch',
    label: 'Malononitrile CH2',
    kind: 'acid',
    smarts: '[CX4;H2,H1;$(C(C#N)C#N)]',
    pka: 11.1,
    priority: 9,
  },
  {
    id: 'site_diketone_ch',
    label: '1,3-Diketone CH2',
    kind: 'acid',
    smarts: '[CX4;H2,H1;$(C(C(=O)[#6])C(=O)[#6])]',
    pka: 13.3,
    priority: 8,
  },
  {
    id: 'site_betaketoester_ch',
    label: 'β-Keto ester / cyanoacetate CH2',
    kind: 'acid',
    smarts: '[CX4;H2,H1;$(C(C(=O)[#6])C(=O)[OX2]),$(C(C#N)C(=O)[OX2,NX3]),$(C(C#N)C(=O)[#6])]',
    pka: 14.2,
    priority: 7,
  },
  {
    id: 'site_malonate_ch',
    label: 'Malonate diester CH2',
    kind: 'acid',
    smarts: '[CX4;H2,H1;$(C(C(=O)[OX2])C(=O)[OX2])]',
    pka: 16.4,
    priority: 6,
  },
  {
    id: 'site_thiol',
    label: 'Thiol',
    kind: 'acid',
    smarts: '[SX2H1]',
    pka: 17.0,
    priority: 6,
  },
  {
    id: 'site_phenol',
    label: 'Phenol',
    kind: 'acid',
    smarts: '[OX2H1;$(O-c)]',
    pka: 18.0,
    priority: 5,
  },
  {
    id: 'site_nitroalkane_ch',
    label: 'Nitroalkane α-CH',
    kind: 'acid',
    smarts: '[CX4;H3,H2,H1;$(C-[NX3+](=O)[O-])]',
    pka: 17.2,
    priority: 6,
  },
  {
    id: 'site_azole_nh',
    label: 'Azole NH (imidazole / benzimidazole / pyrazole)',
    kind: 'acid',
    smarts: '[nX3H1;r5;$([nH]c[n,c]),$([nH]n)]',
    pka: 16.8,
    priority: 5,
  },
  {
    id: 'site_indole_nh',
    label: 'Indole / pyrrole NH',
    kind: 'acid',
    smarts: '[nX3H1;r5]',
    pka: 21.0,
    priority: 4,
  },
];

// Neutralize protonated N / deprotonated O sites on the organic parent so SMARTS match clean connectivity
const NEUTRALIZATION_SMARTS: Array<[string, number]> = [
  ['[NX4;H3;+1:1]>>[NX3;H2;+0:1]', 1],
  ['[NX4;H2;+1:1]>>[NX3;H1;+0:1]', 1],
  ['[NX4;H1;+1:1]>>[NX3;H0;+0:1]', 1],
  ['[nX3;H1;+1:1]>>[nX2;H0;+0:1]', 1],
  ['[NX3;H2;+1:1]=[CX3:2]>>[NX2;H1;+0:1]=[CX3:2]', 1],
  ['[NX3;H1;+1:1]=[CX3:2]>>[NX2;H0;+0:1]=[CX3:2]', 1],
  ['[OX1;-1:1][CX3:2](=[OX1:3])>>[OX2H1;+0:1][CX3:2](=[OX1:3])', -1],
];

let cachedSiteQueries: Array<{ rule: SiteRule; qmol: any }> | null = null;
let cachedNeutRxns: Array<{ rxn: any; hDelta: number }> | null = null;

function ensureSiteQueries(rdkit: any) {
  if (cachedSiteQueries) return cachedSiteQueries;
  cachedSiteQueries = [];
  for (const rule of SITE_RULES) {
    try {
      const qmol = rdkit.get_qmol(rule.smarts);
      if (qmol) cachedSiteQueries.push({ rule, qmol });
    } catch {
      // skip unsupported query pattern
    }
  }
  return cachedSiteQueries;
}

function ensureNeutRxns(rdkit: any) {
  if (cachedNeutRxns) return cachedNeutRxns;
  cachedNeutRxns = [];
  for (const [sma, hDelta] of NEUTRALIZATION_SMARTS) {
    try {
      const rxn = rdkit.get_rxn(sma);
      if (rxn) cachedNeutRxns.push({ rxn, hDelta });
    } catch {
      // skip
    }
  }
  return cachedNeutRxns;
}

export function extractFormulaFromInchi(inchi: string): string {
  if (!inchi) return '';
  const parts = inchi.split('/');
  // InChI=1S/<formula>/...
  return parts.length >= 2 && /^[A-Z]/.test(parts[1]) ? parts[1] : '';
}

function canonicalSingle(rdkit: any, smi: string): string | null {
  let mol: any = null;
  try {
    mol = rdkit.get_mol(smi);
    if (!mol || !mol.is_valid()) return null;
    // Strip stereo markers for v1 canonicalization by re-parsing stereo-free smiles if needed
    const can = mol.get_smiles();
    return can;
  } catch {
    return null;
  } finally {
    try {
      mol?.delete?.();
    } catch {}
  }
}

export function stripStereoFromSmiles(rdkit: any, smi: string): string {
  // Remove @, /, \ safely via RDKit Mol JSON or simple regex fallback on valid canonical SMILES
  const noStereo = smi.replace(/@+/g, '').replace(/[/\\]/g, '');
  return canonicalSingle(rdkit, noStereo) || smi;
}

export function neutralizeFragment(
  rdkit: any,
  smi: string
): { neutralSmiles: string; protonAdjust: number } {
  const rxns = ensureNeutRxns(rdkit);
  let cur = smi;
  let protonAdjust = 0;

  for (let pass = 0; pass < 4; pass++) {
    let changed = false;
    for (const { rxn, hDelta } of rxns) {
      let mol: any = null;
      let ml: any = null;
      let out: any = null;
      try {
        mol = rdkit.get_mol(cur);
        if (!mol || !mol.is_valid()) break;
        ml = new rdkit.MolList();
        ml.append(mol);
        out = rxn.run_reactants(ml, 1);
        if (out && out.size() > 0) {
          const prodList = out.get(0);
          if (prodList && prodList.size() > 0) {
            const p = prodList.next();
            const psmi = p?.get_smiles?.();
            p?.delete?.();
            if (psmi && psmi !== cur) {
              const san = canonicalSingle(rdkit, psmi);
              if (san) {
                cur = san;
                protonAdjust += hDelta;
                changed = true;
                break;
              }
            }
          }
        }
      } catch {
        // ignore
      } finally {
        try {
          out?.delete?.();
          ml?.delete?.();
          mol?.delete?.();
        } catch {}
      }
    }
    if (!changed) break;
  }
  return { neutralSmiles: cur, protonAdjust };
}

function buildCounterionLookup(rdkit: any): Map<string, CounterionDef> {
  const map = new Map<string, CounterionDef>();
  for (const def of KNOWN_COUNTERIONS) {
    for (const raw of def.smilesSet) {
      const can = canonicalSingle(rdkit, raw) || raw;
      map.set(can, def);
      map.set(raw, def);
    }
  }
  return map;
}

let cachedCounterions: Map<string, CounterionDef> | null = null;

export function parseSubstrateAndSalts(
  rdkit: any,
  input: PredictorSubstrateInput
): ParsedSubstrate {
  const raw = (input.smiles || '').trim();
  const eqInit = Math.max(0, Number(input.equivalents) || 1);
  const concInit = Number(input.concentrationMm) > 0 ? Number(input.concentrationMm) : 50 * eqInit;
  const baseFail = (error: string): ParsedSubstrate => ({
    id: input.id,
    code: input.code,
    name: input.name,
    rawSmiles: raw,
    neutralSmiles: '',
    equivalents: eqInit,
    concentrationMm: concInit,
    saltDetected: null,
    saltAcidEquiv: 0,
    hydrateWaterEquiv: 0,
    sites: [],
    exactMass: 0,
    formula: '',
    valid: false,
    error,
  });

  if (!raw) return baseFail('No SMILES provided.');

  let mol: any = null;
  try {
    mol = rdkit.get_mol(raw);
    if (!mol || !mol.is_valid()) {
      return baseFail('Invalid SMILES string.');
    }
    const canFull = mol.get_smiles();
    mol.delete();
    mol = null;

    if (!cachedCounterions) cachedCounterions = buildCounterionLookup(rdkit);

    const frags = canFull.split('.').filter(Boolean);
    const organicFrags: Array<{ smi: string; heavy: number }> = [];
    const saltLabels: string[] = [];
    let counterionAcidPerMol = 0;
    let waterPerMol = 0;

    if (frags.length > 1) {
      for (const f of frags) {
        const fCan = canonicalSingle(rdkit, f) || f;
        const hit = cachedCounterions.get(fCan) || cachedCounterions.get(f);
        if (hit) {
          if (hit.waterEquiv) {
            waterPerMol += hit.waterEquiv;
            saltLabels.push(hit.label);
          } else {
            counterionAcidPerMol += hit.acidEquiv;
            saltLabels.push(hit.label);
          }
        } else {
          let fm: any = null;
          let heavy = 1;
          try {
            fm = rdkit.get_mol(fCan);
            if (fm && fm.is_valid()) {
              const desc = JSON.parse(fm.get_descriptors());
              heavy = Number(desc.NumHeavyAtoms) || 1;
            }
          } catch {
          } finally {
            try {
              fm?.delete?.();
            } catch {}
          }
          organicFrags.push({ smi: fCan, heavy });
        }
      }
    } else if (frags.length === 1) {
      organicFrags.push({ smi: frags[0], heavy: 1 });
    }

    // Pick largest organic fragment if salt counterion was unrecognized or multi-frag
    organicFrags.sort((a, b) => b.heavy - a.heavy);
    const mainFrag = organicFrags[0]?.smi || frags[0];
    const { neutralSmiles, protonAdjust } = neutralizeFragment(rdkit, mainFrag);
    const cleanSmiles = stripStereoFromSmiles(rdkit, neutralSmiles);

    // Total salt protons per mole: trust counterion count if present, else neutralized proton count
    const saltHPerMol =
      counterionAcidPerMol !== 0 ? counterionAcidPerMol : protonAdjust !== 0 ? protonAdjust : 0;

    const eq = Math.max(0, Number(input.equivalents) || 1);
    const parentMol = rdkit.get_mol(cleanSmiles);
    if (!parentMol || !parentMol.is_valid()) {
      parentMol?.delete?.();
      return baseFail('Could not parse parent structure after salt normalization.');
    }

    const desc = JSON.parse(parentMol.get_descriptors());
    const exactMass = Number(desc.exactmw) || 0;
    const inchi = parentMol.get_inchi();
    const formula = extractFormulaFromInchi(inchi);

    // Detect ionizable sites
    const siteQueries = ensureSiteQueries(rdkit);
    const matchedAtomOwners = new Map<number, { rule: SiteRule; matchIdx: number }>();
    const rawMatches: Array<{ rule: SiteRule; atoms: number[] }> = [];

    for (const { rule, qmol } of siteQueries) {
      try {
        const json = parentMol.get_substruct_matches(qmol);
        const matches: Array<{ atoms: number[] }> = JSON.parse(json || '[]');
        for (const m of matches) {
          if (!m.atoms || !m.atoms.length) continue;
          const anchor = m.atoms[0];
          const prev = matchedAtomOwners.get(anchor);
          if (!prev || rule.priority > prev.rule.priority) {
            matchedAtomOwners.set(anchor, { rule, matchIdx: rawMatches.length });
          }
          rawMatches.push({ rule, atoms: m.atoms });
        }
      } catch {
        // ignore match failure
      }
    }

    // Deduplicate sites on the same anchor atom, grouping identical site types
    const siteByRule = new Map<string, IonizableSite>();
    const seenAnchors = new Set<string>();
    for (const m of rawMatches) {
      const anchor = m.atoms[0];
      const owner = matchedAtomOwners.get(anchor);
      if (!owner || owner.rule.id !== m.rule.id) continue;
      const anchorKey = `${m.rule.id}:${anchor}`;
      if (seenAnchors.has(anchorKey)) continue;
      seenAnchors.add(anchorKey);

      const prev = siteByRule.get(m.rule.id);
      if (prev) {
        prev.count += 1;
        prev.atomIndices.push(...m.atoms);
      } else {
        siteByRule.set(m.rule.id, {
          id: m.rule.id,
          substrateCode: input.code,
          label: m.rule.label,
          kind: m.rule.kind,
          pka: m.rule.pka,
          atomIndices: [...m.atoms],
          count: 1,
          freeFraction: 1,
          protonatedFraction: 0,
        });
      }
    }

    parentMol.delete();

    const nameHydrateDet = detectHydrateStoichiometry(undefined, input.name, input.iupac);
    const resolvedWaterPerMol = Math.max(waterPerMol, nameHydrateDet.waterEquivPerMol);
    const nonWaterLabels = saltLabels.filter((lbl) => lbl !== 'Hydrate');

    let saltDesc: string | null = null;
    const descParts: string[] = [];
    if (nonWaterLabels.length > 0) {
      const counts = new Map<string, number>();
      for (const lbl of nonWaterLabels) counts.set(lbl, (counts.get(lbl) || 0) + 1);
      descParts.push(
        ...Array.from(counts.entries()).map(([lbl, n]) => (n > 1 ? `${n} eq ${lbl}` : lbl))
      );
    } else if (protonAdjust > 0) {
      descParts.push(`Protonated cation (+${protonAdjust} H⁺)`);
    }
    if (resolvedWaterPerMol > 0) {
      descParts.push(
        resolvedWaterPerMol === 1 ? 'Hydrate (1 H₂O)' : `Hydrate (${resolvedWaterPerMol} H₂O)`
      );
    }
    if (descParts.length > 0) {
      saltDesc = descParts.join(' + ');
    }

    return {
      id: input.id,
      code: input.code,
      name: input.name || cleanSmiles,
      rawSmiles: raw,
      neutralSmiles: cleanSmiles,
      equivalents: eq,
      concentrationMm: Number(input.concentrationMm) > 0 ? Number(input.concentrationMm) : 50 * eq,
      saltDetected: saltDesc,
      saltAcidEquiv: saltHPerMol * eq,
      hydrateWaterEquiv: resolvedWaterPerMol * eq,
      sites: Array.from(siteByRule.values()),
      exactMass,
      formula,
      valid: true,
    };
  } catch (e: any) {
    return baseFail(e?.message || 'Failed to parse SMILES.');
  } finally {
    try {
      mol?.delete?.();
    } catch {}
  }
}

/**
 * Exact numerical proton-balance solver in DMSO.
 * Solves H_bound(pH) + [H+]_free(pH) = H_total_initial via bisection.
 */
export function solveAcidBaseEquilibrium(
  substrates: ParsedSubstrate[],
  cond: WellConditionConfig
): AcidBaseSummary {
  const validSubs = substrates.filter((s) => s.valid);
  const posEqs = validSubs.map((s) => s.equivalents).filter((e) => e > 0);
  const basisScale =
    cond.equivBasis === 'total'
      ? posEqs.reduce((a, b) => a + b, 0) || 1
      : posEqs.length
      ? Math.min(...posEqs)
      : 1;

  const addedEq = Math.max(0, Number(cond.additiveEquiv) || 0) * basisScale;
  const isAcidAdd = cond.medium === 'acid';
  const isBaseAdd = cond.medium === 'base';

  const acidAddEq = isAcidAdd ? addedEq : 0;
  const acidAddPka = Number.isFinite(cond.additivePka) ? cond.additivePka : 0.9; // TsOH

  const baseAddEq = isBaseAdd ? addedEq : 0;
  const baseAddPka = Number.isFinite(cond.additivePka) ? cond.additivePka : 13.9; // DBU

  const totalSaltH = validSubs.reduce((acc, s) => acc + s.saltAcidEquiv, 0);

  // Collect all ionizable groups in equivalents
  const acids: Array<{ eq: number; pka: number; site?: IonizableSite }> = [];
  const bases: Array<{ eq: number; pka: number; site?: IonizableSite }> = [];

  for (const s of validSubs) {
    for (const site of s.sites) {
      const siteEq = s.equivalents * site.count;
      if (siteEq <= 0) continue;
      if (site.kind === 'acid') acids.push({ eq: siteEq, pka: site.pka, site });
      else bases.push({ eq: siteEq, pka: site.pka, site });
    }
  }

  if (acidAddEq > 0) acids.push({ eq: acidAddEq, pka: acidAddPka });
  if (totalSaltH > 0) acids.push({ eq: totalSaltH, pka: 1.8 }); // HCl/TFA salt protons
  if (baseAddEq > 0) bases.push({ eq: baseAddEq, pka: baseAddPka });

  // Reference: every acid HA starts protonated (1 H+), every base B starts neutral (0 H+).
  // If salt counterion was alkali (-1 eq), subtract cleanly.
  const totalInitialProtons = acids.reduce((acc, a) => acc + a.eq, 0);

  // Reference concentration ~50 mM => 0.05 M normalized to 1 eq = 1.0
  // Free [H+] in equiv units = 10^(-pH) / 0.05 (bounded safely)
  const concRefM = 0.05;
  const boundProtonsAtPh = (ph: number): number => {
    let h = 0;
    for (const a of acids) {
      const exp = Math.max(-40, Math.min(40, ph - a.pka));
      h += a.eq / (1 + Math.pow(10, exp));
    }
    for (const b of bases) {
      const exp = Math.max(-40, Math.min(40, ph - b.pka));
      h += b.eq / (1 + Math.pow(10, exp));
    }
    // Solvent autoprotolysis / free H+ contribution (~pKa DMSO 35)
    const freeH = Math.min(50, Math.pow(10, -ph) / concRefM);
    const freeOH = Math.min(50, Math.pow(10, ph - 32) / concRefM);
    return h + freeH - freeOH;
  };

  // Bisection solve on pH in [-4, 34]
  let lo = -4;
  let hi = 34;
  for (let i = 0; i < 65; i++) {
    const mid = 0.5 * (lo + hi);
    if (boundProtonsAtPh(mid) > totalInitialProtons) {
      lo = mid;
    } else {
      hi = mid;
    }
  }
  const ph = 0.5 * (lo + hi);

  // Assign exact protonation / free fractions back onto every substrate site
  for (const s of validSubs) {
    for (const site of s.sites) {
      const exp = Math.max(-40, Math.min(40, ph - site.pka));
      const fProtonated = 1 / (1 + Math.pow(10, exp));
      const fDeprotonated = 1 - fProtonated;
      if (site.kind === 'base') {
        site.protonatedFraction = fProtonated; // BH+
        site.freeFraction = fDeprotonated; // free unprotonated nucleophile B
      } else {
        site.protonatedFraction = fProtonated; // HA
        site.freeFraction = fDeprotonated; // deprotonated anion A-
      }
    }
  }

  // Free acid = unconsumed protons on strong acid additive + free [H+]
  let freeAcidEq = 0;
  if (acidAddEq > 0) {
    freeAcidEq += acidAddEq / (1 + Math.pow(10, Math.max(-40, Math.min(40, ph - acidAddPka))));
  }
  if (totalSaltH > 0) {
    freeAcidEq += totalSaltH / (1 + Math.pow(10, Math.max(-40, Math.min(40, ph - 1.8))));
  }
  freeAcidEq += Math.min(5, Math.pow(10, -ph) / concRefM);
  // Also count unbound protons sitting on weak bases whose conjugate pKa <= 4?
  // Note: pyridinium/anilinium (pKa ~3.5) still act as Brønsted acids for imine/carbonyl catalysis at 80-120 °C,
  // whereas guanidinium (pKa 13.6) & alkylammonium (10.5) lock up protons tightly!
  let softBrAcidEq = 0;
  for (const b of bases) {
    if (b.site && b.pka < 5.0) {
      const fProt = 1 / (1 + Math.pow(10, Math.max(-40, Math.min(40, ph - b.pka))));
      softBrAcidEq += b.eq * fProt * 0.35;
    }
  }

  // Free base = unprotonated strong base additive + unprotonated strong substrate bases (pKa >= 9)
  let freeBaseEq = 0;
  if (baseAddEq > 0) {
    freeBaseEq += baseAddEq * (1 - 1 / (1 + Math.pow(10, Math.max(-40, Math.min(40, ph - baseAddPka)))));
  }
  let freeSubstrateStrongBaseEq = 0;
  for (const b of bases) {
    if (b.site && b.pka >= 9.0) {
      freeSubstrateStrongBaseEq += b.site.freeFraction * b.eq;
    }
  }

  const effectiveAcid = freeAcidEq + softBrAcidEq;
  const effectiveBase = freeBaseEq + freeSubstrateStrongBaseEq * 0.4;
  freeAcidEq = effectiveAcid;

  let effectiveMedium: AcidBaseSummary['effectiveMedium'] = 'neutral';
  if (effectiveAcid >= 0.08 * basisScale) {
    effectiveMedium = 'free_acid';
  } else if (baseAddEq > 0 && freeBaseEq >= 0.05 * basisScale) {
    effectiveMedium = 'basic';
  } else if (acidAddEq + totalSaltH > 0 && effectiveAcid < 0.08 * basisScale) {
    effectiveMedium = 'buffered';
  } else if (freeSubstrateStrongBaseEq >= 0.25 * basisScale) {
    effectiveMedium = 'buffered';
  }

  // Smooth catalysis blends (0..1)
  // Notice even in a buffered guanidine well (pH ~13.6 in DMSO), there is moderate general-base catalysis
  // and very weak acid catalysis (zero strong-acid cleavage!).
  const acidStrengthFromPh = 1 / (1 + Math.pow(10, (ph - 5.5) * 0.7));
  const acidBlend =
    effectiveMedium === 'free_acid'
      ? Math.min(1, Math.max(0.45, acidStrengthFromPh))
      : Math.min(0.18, acidStrengthFromPh);

  const baseStrengthFromPh = 1 / (1 + Math.pow(10, (11.5 - ph) * 0.55));
  const baseBlend =
    effectiveMedium === 'basic'
      ? Math.min(1, Math.max(0.65, baseStrengthFromPh))
      : effectiveMedium === 'buffered'
      ? Math.min(0.65, Math.max(0.2, baseStrengthFromPh))
      : Math.min(0.25, baseStrengthFromPh);

  const neutralBlend = Math.max(0.35, 1 - 0.5 * Math.abs(acidBlend - baseBlend));

  const notes: string[] = [];
  if (totalSaltH > 0) {
    notes.push(`Salt counterions contribute +${totalSaltH.toFixed(2)} eq H⁺ to the proton budget.`);
  }
  if ((acidAddEq > 0 || totalSaltH > 0) && effectiveMedium === 'buffered') {
    notes.push(
      'Strong basic substrates absorb the added acid, leaving a buffered well (acid-only steps like t-Bu cleavage are suppressed).'
    );
  }
  if (effectiveMedium === 'free_acid') {
    notes.push(
      `Free acid remains (~${freeAcidEq.toFixed(2)} eq unbuffered H⁺); Brønsted acid catalysis is active.`
    );
  }
  if (effectiveMedium === 'basic') {
    notes.push(
      `Free strong base active (~${freeBaseEq.toFixed(2)} eq); base-promoted additions and SN2/SNAr are favored.`
    );
  }

  return {
    effectiveMedium,
    effectivePhDmso: Math.round(ph * 100) / 100,
    totalAddedAcidEq: Math.round((acidAddEq + totalSaltH) * 1000) / 1000,
    totalAddedBaseEq: Math.round(baseAddEq * 1000) / 1000,
    freeAcidEq: Math.round(freeAcidEq * 1000) / 1000,
    freeBaseEq: Math.round(freeBaseEq * 1000) / 1000,
    acidBlend: Math.round(acidBlend * 1000) / 1000,
    baseBlend: Math.round(baseBlend * 1000) / 1000,
    neutralBlend: Math.round(neutralBlend * 1000) / 1000,
    notes,
  };
}
