// Robowski Studio - General N-Component Priority-Search Reaction Prediction Engine
import {
  ChemicalAlert,
  PredictedSpecies,
  PredictionOptions,
  PredictorSubstrateInput,
  StepEvent,
  WellConditionConfig,
  WellPredictionResult,
} from './types';
import {
  extractFormulaFromInchi,
  parseSubstrateAndSalts,
  solveAcidBaseEquilibrium,
  stripStereoFromSmiles,
} from './saltAndSites';
import { REACTION_RULES, ReactionRuleDef } from './rules';
import {
  computeRingSizesFromMol,
  conditionGate,
  estimateElectronicFactor,
  estimateStericFactor,
  evaluateNewRingFactor,
  scoreChain,
  temperatureGate,
} from './scoring';

const PROTON_MASS = 1.00727647;
const NA_MASS = 22.989218;

// Extra tautomer rule so pre-formed or imine intermediates can access enamine reactivity
const TAUTOMER_RULES: ReactionRuleDef[] = [
  {
    id: 'TAUT_imine_to_enamine',
    stepLabel: 'Tautomer',
    name: 'Imine–enamine tautomerization',
    description: 'Prototropic shift converts α-CH imine into nucleophilic enamine',
    smarts: '[CX4;H3,H2,H1:1][CX3:2]=[NX2;H1,H0:3]>>[C:1]=[C:2][NH1:3]',
    intramolecular: false,
    numReactants: 1,
    acidFactor: 0.9,
    baseFactor: 0.9,
    neutralFactor: 0.85,
    t50: 20,
    width: 15,
    prior: 0.92,
    reversible: true,
    kClass: 'neutral',
    thermoBonus: 0.0,
    confidenceClass: 'A',
  },
  {
    id: 'TAUT_beta_gamma_enone',
    stepLabel: 'Tautomer',
    name: 'β,γ- to α,β-Enone isomerization',
    description: 'Base/acid-mediated dienolization conjugates an unconjugated β,γ-enone into a Michael-active α,β-enone',
    smarts: '[CX3:1]=[CX3:2]-[CX4;H2,H1:3]-[CX3:4]=[OX1:5]>>[C:1]-[C:2]=[C:3]-[C:4]=[O:5]',
    intramolecular: false,
    numReactants: 1,
    acidFactor: 0.85,
    baseFactor: 0.95,
    neutralFactor: 0.55,
    t50: 25,
    width: 18,
    prior: 0.85,
    reversible: true,
    kClass: 'favorable',
    thermoBonus: 0.02,
    confidenceClass: 'A',
  },
];

interface CompiledRuleEntry {
  rxn: any;
  templates: any[]; // 1 or 2 RDKit QMols for fast ApplicabilityIndex
}

let compiledRuleCache: WeakMap<object, Map<string, CompiledRuleEntry | null>> = new WeakMap();
let chelatorQueriesCache: WeakMap<object, Array<{ label: string; qmol: any }>> = new WeakMap();
let michaelQueryCache: WeakMap<object, any> = new WeakMap();

function splitTopLevelDot(s: string): string[] {
  const out: string[] = [];
  let d = 0;
  let sq = 0;
  let start = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === '[') sq++;
    else if (c === ']') sq--;
    else if (sq === 0) {
      if (c === '(') d++;
      else if (c === ')') d--;
      else if (c === '.' && d === 0) {
        out.push(s.slice(start, i));
        start = i + 1;
      }
    }
  }
  out.push(s.slice(start));
  return out;
}

function getCompiledRule(rdkit: any, rule: ReactionRuleDef): CompiledRuleEntry | null {
  let map = compiledRuleCache.get(rdkit);
  if (!map) {
    map = new Map();
    compiledRuleCache.set(rdkit, map);
  }
  if (map.has(rule.id)) return map.get(rule.id) || null;
  try {
    const rxn = rdkit.get_rxn(rule.smarts);
    if (!rxn) {
      map.set(rule.id, null);
      return null;
    }
    let lhs = rule.smarts.split('>>')[0];
    if (rule.intramolecular && lhs.startsWith('(') && lhs.endsWith(')')) {
      lhs = lhs.slice(1, -1);
    }
    const parts = splitTopLevelDot(lhs);
    const templates: any[] = [];
    for (const p of parts) {
      const clean = p.replace(/:\d+(?=\])/g, '');
      const q = rdkit.get_qmol(clean);
      if (q) templates.push(q);
    }
    const entry = { rxn, templates };
    map.set(rule.id, entry);
    return entry;
  } catch {
    map.set(rule.id, null);
    return null;
  }
}

function getChelatorQueries(rdkit: any): Array<{ label: string; qmol: any }> {
  let cached = chelatorQueriesCache.get(rdkit);
  if (cached) return cached;
  const defs: Array<[string, string]> = [
    ['N,N-bidentate azine-imine', '[nX2;r6]:[c;r6]-[CX3]=[NX2]'],
    ['N,N-bidentate azine-amine/guanidine', '[nX2;r6]:[c;r6]-[CX4]-[NX3]'],
    ['2,2′-Bipyridyl / phenanthroline motif', '[nX2;r6]:[c;r6]-[c;r6]:[nX2;r6]'],
    ['1,3-Dicarbonyl chelator', '[OX1]=[CX3]-[CX4,CX3]-[CX3]=[OX1]'],
    ['Salicylaldimine (N,O) motif', '[OX2H1][c]:[c]-[CX3]=[NX2]'],
  ];
  cached = [];
  for (const [label, sma] of defs) {
    try {
      const q = rdkit.get_qmol(sma);
      if (q) cached.push({ label, qmol: q });
    } catch {}
  }
  chelatorQueriesCache.set(rdkit, cached);
  return cached;
}

function getMichaelQuery(rdkit: any): any | null {
  if (michaelQueryCache.has(rdkit)) return michaelQueryCache.get(rdkit);
  try {
    const q = rdkit.get_qmol('[CX3]=[CX3]-[CX3]=[OX1],[CX3]=[CX3]-[CX2]#[NX1],[CX3]=[CX3]-[NX3+](=O)[O-]');
    michaelQueryCache.set(rdkit, q || null);
    return q || null;
  } catch {
    michaelQueryCache.set(rdkit, null);
    return null;
  }
}

interface MolMeta {
  smiles: string;
  formula: string;
  exactMass: number;
  amw: number;
  clogP: number;
  tpsa: number;
  numRings: number;
  numAromaticRings: number;
  numHeavyAtoms: number;
  ringSizes: number[];
}

interface InternalSpecies {
  key: string;
  meta: MolMeta;
  inventory: number[];
  fragmentUses: number;
  isSubstrate: boolean;
  isSmallFragment: boolean;
  releasedFragmentName?: string;
  chain: StepEvent[];
  altChains: StepEvent[][];
  priorityScore: number; // greedy frontier priority before final sink/transient adjustment
  cumulativeThermo: number;
  expanded: boolean;
  tautomerHops: number;
  alerts: ChemicalAlert[];
  tplMatchMap: Map<string, boolean[]>; // rule.id -> [matchesTpl0, matchesTpl1?]
}

function computeSpeciesTemplateMatches(
  rdkit: any,
  smi: string,
  activeRuleStates: Array<{ rule: ReactionRuleDef; entry: CompiledRuleEntry }>
): Map<string, boolean[]> {
  const result = new Map<string, boolean[]>();
  let mol: any = null;
  try {
    mol = rdkit.get_mol(smi);
    if (!mol || !mol.is_valid()) return result;
    for (const { rule, entry } of activeRuleStates) {
      const flags = entry.templates.map((q) => {
        try {
          const m = mol.get_substruct_match(q);
          return Boolean(m && m !== '{}');
        } catch {
          return true;
        }
      });
      result.set(rule.id, flags);
    }
  } catch {
  } finally {
    try {
      mol?.delete?.();
    } catch {}
  }
  return result;
}

function inspectMol(rdkit: any, smi: string, cache: Map<string, MolMeta | null>): MolMeta | null {
  if (cache.has(smi)) return cache.get(smi) || null;
  let mol: any = null;
  try {
    mol = rdkit.get_mol(smi);
    if (!mol || !mol.is_valid()) {
      cache.set(smi, null);
      return null;
    }
    const rawCan = mol.get_smiles();
    mol.delete();
    mol = null;

    const cleanSmi = stripStereoFromSmiles(rdkit, rawCan);
    if (cache.has(cleanSmi)) {
      const hit = cache.get(cleanSmi) || null;
      cache.set(smi, hit);
      return hit;
    }

    mol = rdkit.get_mol(cleanSmi);
    if (!mol || !mol.is_valid()) {
      cache.set(smi, null);
      return null;
    }
    const desc = JSON.parse(mol.get_descriptors());
    const inchi = mol.get_inchi();
    const formula = extractFormulaFromInchi(inchi);
    const ringSizes = computeRingSizesFromMol(mol);
    const meta: MolMeta = {
      smiles: cleanSmi,
      formula,
      exactMass: Number(desc.exactmw) || 0,
      amw: Number(desc.amw) || 0,
      clogP: Number(desc.CrippenClogP) || 0,
      tpsa: Number(desc.tpsa) || 0,
      numRings: Number(desc.NumRings) || 0,
      numAromaticRings: Number(desc.NumAromaticRings) || 0,
      numHeavyAtoms: Number(desc.NumHeavyAtoms) || 0,
      ringSizes,
    };
    cache.set(smi, meta);
    cache.set(cleanSmi, meta);
    return meta;
  } catch {
    cache.set(smi, null);
    return null;
  } finally {
    try {
      mol?.delete?.();
    } catch {}
  }
}

function detectMolAlerts(rdkit: any, smi: string): ChemicalAlert[] {
  const alerts: ChemicalAlert[] = [];
  let mol: any = null;
  try {
    mol = rdkit.get_mol(smi);
    if (!mol || !mol.is_valid()) return alerts;
    for (const { label, qmol } of getChelatorQueries(rdkit)) {
      try {
        const m = mol.get_substruct_match(qmol);
        if (m && m !== '{}') {
          alerts.push({
            kind: 'chelator_motif',
            severity: 'info',
            message: `Chelator motif: ${label}`,
          });
          break;
        }
      } catch {}
    }
    const mq = getMichaelQuery(rdkit);
    if (mq) {
      try {
        const m = mol.get_substruct_match(mq);
        if (m && m !== '{}') {
          alerts.push({
            kind: 'michael_acceptor',
            severity: 'info',
            message: 'Contains electrophilic Michael acceptor',
          });
        }
      } catch {}
    }
  } catch {
  } finally {
    try {
      mol?.delete?.();
    } catch {}
  }
  return alerts;
}

function runRxnSingle(
  rdkit: any,
  rxn: any,
  reactantSmiles: string[],
  maxProducts = 16
): string[][] {
  const mols: any[] = [];
  let ml: any = null;
  let out: any = null;
  const results: string[][] = [];
  try {
    ml = new rdkit.MolList();
    for (const smi of reactantSmiles) {
      const m = rdkit.get_mol(smi);
      if (!m || !m.is_valid()) {
        m?.delete?.();
        return results;
      }
      mols.push(m);
      ml.append(m);
    }
    out = rxn.run_reactants(ml, maxProducts);
    if (!out) return results;
    const nSets = Math.min(maxProducts, out.size());
    for (let i = 0; i < nSets; i++) {
      const plist = out.get(i);
      if (!plist) continue;
      const pCount = plist.size();
      const setSmis: string[] = [];
      let ok = true;
      for (let j = 0; j < pCount; j++) {
        const p = plist.next();
        if (!p) {
          ok = false;
          continue;
        }
        try {
          const smi = p.get_smiles();
          if (smi) setSmis.push(smi);
          else ok = false;
        } catch {
          ok = false;
        } finally {
          try {
            p.delete();
          } catch {}
        }
      }
      try {
        plist.delete?.();
      } catch {}
      if (ok && setSmis.length > 0) results.push(setSmis);
    }
  } catch {
    return results;
  } finally {
    try {
      out?.delete?.();
    } catch {}
    try {
      ml?.delete?.();
    } catch {}
    for (const m of mols) {
      try {
        m.delete();
      } catch {}
    }
  }
  return results;
}

function classifyFragmentName(smi: string): string {
  const map: Record<string, string> = {
    N: 'NH₃',
    CO: 'MeOH',
    CCO: 'EtOH',
    'CC(C)O': 'i-PrOH',
    'CC(C)(C)O': 't-BuOH',
    O: 'H₂O',
    CS: 'MeSH',
    CCS: 'EtSH',
  };
  return map[smi] || smi;
}

function estimateSubstrateFreeFraction(
  rule: ReactionRuleDef,
  substrateSites: Array<{ kind: string; label: string; freeFraction: number }>
): number {
  if (!rule.reactiveSiteKind || rule.reactiveSiteKind === 'none' || rule.reactiveSiteKind === 'electrophile') {
    return 1.0;
  }
  if (rule.reactiveSiteKind === 'amine_nuc') {
    const baseSites = substrateSites.filter((s) => s.kind === 'base');
    if (baseSites.length === 0) return 1.0;
    // Use the highest free fraction among nucleophilic nitrogen bases (not pure pyridine if amine is also present)
    const nucBases = baseSites.filter((s) => !/Pyridine/i.test(s.label));
    const list = nucBases.length > 0 ? nucBases : baseSites;
    const maxFree = Math.max(...list.map((s) => s.freeFraction));
    // Even small free equilibrium fraction (e.g. 0.05) drives heated reactions slowly
    return Math.max(0.12, Math.min(1.0, Math.pow(maxFree, 0.4)));
  }
  if (rule.reactiveSiteKind === 'carbon_acid') {
    // Carbon acids work either neutrally (enolic) or via catalytic anion fraction
    const acidSites = substrateSites.filter((s) => s.kind === 'acid');
    if (acidSites.length === 0) return 1.0;
    const maxAnion = Math.max(...acidSites.map((s) => s.freeFraction));
    // Catalytic deprotonation (0.008 for diethyl malonate in DBU) is plenty for catalysis
    return Math.max(0.75, Math.min(1.05, 0.75 + 0.3 * Math.pow(maxAnion, 0.25)));
  }
  return 1.0;
}

function hasLowestClass(chain: StepEvent[], allRulesById: Map<string, ReactionRuleDef>): 'A' | 'B' | 'C' {
  let cls: 'A' | 'B' | 'C' = 'A';
  for (const st of chain) {
    const r = allRulesById.get(st.ruleId);
    if (!r) continue;
    if (r.confidenceClass === 'C') return 'C';
    if (r.confidenceClass === 'B') cls = 'B';
  }
  return cls;
}

/**
 * Predicts reaction network and ranked products for ANY 1..N substrates under the specified condition.
 */
export function predictWellReactions(
  rdkit: any,
  substrateInputs: PredictorSubstrateInput[],
  condition: WellConditionConfig,
  options: PredictionOptions = {}
): WellPredictionResult {
  const t0 = typeof performance !== 'undefined' ? performance.now() : Date.now();
  const maxDepth = options.maxDepth ?? 5;
  const maxExpansions = options.maxExpansions ?? 85;
  const maxSpecies = options.maxSpecies ?? 150;
  const minFrontierScore = options.minFrontierScore ?? 0.022;
  const maxMw = options.maxMw ?? 750;
  const includeTautomers = options.includeTautomers ?? true;

  // 1. Parse salts & ionizable sites
  const parsedSubs = substrateInputs.map((s) => parseSubstrateAndSalts(rdkit, s));
  const activeSubs = parsedSubs.filter((s) => s.valid && s.equivalents > 0);

  // Add any hydrate water into effective waterPct
  const hydrateEq = activeSubs.reduce((acc, s) => acc + s.hydrateWaterEquiv, 0);
  const effectiveCondition: WellConditionConfig = {
    ...condition,
    waterPct: (Number(condition.waterPct) || 0) + hydrateEq * 0.5,
  };

  // 2. Solve exact DMSO proton balance
  const acidBase = solveAcidBaseEquilibrium(activeSubs, effectiveCondition);

  const allRules = includeTautomers ? [...REACTION_RULES, ...TAUTOMER_RULES] : [...REACTION_RULES];
  const rulesById = new Map(allRules.map((r) => [r.id, r]));

  // Pre-filter active rules by condition & temperature gates BEFORE building species applicability index
  const activeRuleStates = allRules
    .map((rule) => {
      const cGate = conditionGate(rule, acidBase, effectiveCondition);
      const tGate = temperatureGate(rule, effectiveCondition.temperatureC);
      const entry = cGate * tGate >= 0.02 ? getCompiledRule(rdkit, rule) : null;
      return entry ? { rule, cGate, tGate, entry } : null;
    })
    .filter((x): x is { rule: ReactionRuleDef; cGate: number; tGate: number; entry: CompiledRuleEntry } => x !== null);

  const molCache = new Map<string, MolMeta | null>();
  const tplMatchMemo = new Map<string, Map<string, boolean[]>>();
  const getTplMatch = (smi: string) => {
    let hit = tplMatchMemo.get(smi);
    if (!hit) {
      hit = computeSpeciesTemplateMatches(rdkit, smi, activeRuleStates);
      tplMatchMemo.set(smi, hit);
    }
    return hit;
  };

  // Maximum stoichiometric copy limits per substrate
  // Single-substrate reactions (e.g. disulfide formation) allow 2 copies; otherwise floor(eq + 0.25)
  const maxCopies = activeSubs.map((s) => {
    if (activeSubs.length === 1) return Math.max(2, Math.round(s.equivalents));
    return Math.min(3, Math.max(1, Math.floor(s.equivalents + 0.25)));
  });

  // Deduplicate identical neutral starting substrates into inventory slots
  const speciesMap = new Map<string, InternalSpecies>();
  const siteInfoBySmiles = new Map<string, Array<{ kind: string; label: string; freeFraction: number }>>();

  activeSubs.forEach((sub, idx) => {
    const meta = inspectMol(rdkit, sub.neutralSmiles, molCache);
    if (!meta) return;
    siteInfoBySmiles.set(
      meta.smiles,
      sub.sites.map((st) => ({ kind: st.kind, label: st.label, freeFraction: st.freeFraction }))
    );

    const existing = speciesMap.get(meta.smiles);
    if (existing) {
      existing.inventory[idx] = (existing.inventory[idx] || 0) + 1;
      maxCopies[idx] = Math.max(maxCopies[idx], existing.inventory[idx] + 1);
    } else {
      const inv = new Array(activeSubs.length).fill(0);
      inv[idx] = 1;
      speciesMap.set(meta.smiles, {
        key: meta.smiles,
        meta,
        inventory: inv,
        fragmentUses: 0,
        isSubstrate: true,
        isSmallFragment: false,
        chain: [],
        altChains: [],
        priorityScore: 1.0,
        cumulativeThermo: 0,
        expanded: false,
        tautomerHops: 0,
        alerts: [],
        tplMatchMap: getTplMatch(meta.smiles),
      });
    }
  });

  const releasedGases = new Set<string>();
  const releasedFragmentKeys = new Set<string>();

  // 3. Best-First Priority Expansion Loop
  let expansions = 0;

  while (expansions < maxExpansions && speciesMap.size < maxSpecies) {
    // Pick highest-priority unexpanded species under maxDepth
    let bestCandidate: InternalSpecies | null = null;
    for (const sp of speciesMap.values()) {
      if (sp.expanded) continue;
      if (sp.chain.length >= maxDepth) continue;
      if (sp.priorityScore < minFrontierScore) continue;
      if (!bestCandidate || sp.priorityScore > bestCandidate.priorityScore) {
        bestCandidate = sp;
      }
    }
    if (!bestCandidate) break;

    bestCandidate.expanded = true;
    expansions++;

    const currentPool = Array.from(speciesMap.values());

    for (const { rule, cGate, tGate, entry } of activeRuleStates) {
      const rxn = entry.rxn;
      if (rule.stepLabel === 'Tautomer' && bestCandidate.tautomerHops >= 1) continue;
      if (rule.requireSingleSub && bestCandidate.chain.length > 0) continue;

      const candFlags = bestCandidate.tplMatchMap.get(rule.id) || [];

      let partnerLists: InternalSpecies[][] = [];
      if (rule.numReactants === 1) {
        // Unimolecular or intramolecular: candidate must match ALL templates inside the same molecule
        if (candFlags.length === 0 || candFlags.every(Boolean)) {
          partnerLists = [[bestCandidate]];
        }
      } else {
        const candIsT0 = Boolean(candFlags[0]);
        const candIsT1 = Boolean(candFlags[1]);
        if (!candIsT0 && !candIsT1) continue;

        for (const partner of currentPool) {
          if (bestCandidate.isSmallFragment && partner.isSmallFragment) continue;
          if (bestCandidate.fragmentUses + partner.fragmentUses > 1) continue;

          // Stoichiometric pre-check
          let over = false;
          for (let k = 0; k < activeSubs.length; k++) {
            if (bestCandidate.inventory[k] + partner.inventory[k] > maxCopies[k]) {
              over = true;
              break;
            }
          }
          if (over) continue;

          const pFlags = partner.tplMatchMap.get(rule.id) || [];
          const pIsT0 = Boolean(pFlags[0]);
          const pIsT1 = Boolean(pFlags[1]);

          if (partner.key === bestCandidate.key) {
            if (candIsT0 && candIsT1) partnerLists.push([bestCandidate, partner]);
          } else {
            if (candIsT0 && pIsT1) partnerLists.push([bestCandidate, partner]);
            if (pIsT0 && candIsT1) partnerLists.push([partner, bestCandidate]);
          }
        }
      }

      if (partnerLists.length === 0) continue;

      for (const pair of partnerLists) {
        if (speciesMap.size >= maxSpecies) break;

        // Re-check combined inventory for unimolecular vs bimolecular
        const combinedInv = new Array(activeSubs.length).fill(0);
        let overLimit = false;
        for (let k = 0; k < activeSubs.length; k++) {
          combinedInv[k] = pair.reduce((acc, p) => acc + p.inventory[k], 0);
          if (combinedInv[k] > maxCopies[k]) {
            overLimit = true;
            break;
          }
        }
        if (overLimit) continue;

        const combinedFragUses =
          pair.reduce((acc, p) => acc + p.fragmentUses + (p.isSmallFragment ? 1 : 0), 0);
        if (combinedFragUses > 1) continue;

        // Avoid repeating the exact same rule consecutively on tautomer / reversible steps
        const lastStep = pair[0].chain[pair[0].chain.length - 1];
        if (rule.stepLabel === 'Tautomer' && lastStep?.stepLabel === 'Tautomer') continue;

        const reactantSmis = pair.map((p) => p.meta.smiles);
        const prodSets = runRxnSingle(rdkit, rxn, reactantSmis, 10);
        if (prodSets.length === 0) continue;

        const stericFactor = estimateStericFactor(rule, reactantSmis, rdkit);
        const elecFactor = estimateElectronicFactor(rule, reactantSmis);

        // Substrate free-fraction factor (when an original substrate is participating directly)
        let fFree = 1.0;
        for (const p of pair) {
          const sites = siteInfoBySmiles.get(p.meta.smiles);
          if (sites && sites.length > 0) {
            fFree = Math.min(fFree, estimateSubstrateFreeFraction(rule, sites));
          }
        }

        const parentRings = pair.map((p) => p.meta.ringSizes);

        for (const prodSmis of prodSets) {
          // Product 0 is primary product; Product 1 (if present & releasesReactiveFragment) is released small fragment
          const mainRaw = prodSmis[0];
          const mainMeta = inspectMol(rdkit, mainRaw, molCache);
          if (!mainMeta) continue;
          if (mainMeta.amw > maxMw || mainMeta.numHeavyAtoms < 2) continue;

          // Skip no-op where product equals one of its parents
          if (pair.some((p) => p.key === mainMeta.smiles)) continue;

          // Intramolecular cyclizations must form at least one new ring
          if (rule.intramolecular && mainMeta.numRings <= pair[0].meta.numRings) continue;

          // Ring-size / strain / effective-molarity check
          const ringEval = evaluateNewRingFactor(parentRings, mainMeta.ringSizes);
          if (ringEval.reject) continue;

          const baseWeight = rule.prior * cGate * tGate * stericFactor * elecFactor * fFree;
          const stepWeight = Math.max(0.01, Math.min(1.12, baseWeight * Math.min(1.28, ringEval.factor)));

          const releasedFragRaw = rule.releasesReactiveFragment && prodSmis[1] ? prodSmis[1] : null;
          let releasedFragMeta: MolMeta | null = null;
          if (releasedFragRaw) {
            releasedFragMeta = inspectMol(rdkit, releasedFragRaw, molCache);
          }

          if (rule.releasesGas) {
            releasedGases.add(rule.releasesGas);
          }

          const stepEvt: StepEvent = {
            ruleId: rule.id,
            stepLabel: rule.stepLabel,
            description: rule.name,
            reactantSmiles: reactantSmis,
            stepWeight: Math.round(stepWeight * 1000) / 1000,
            bottleneckFactor: Math.round(baseWeight * 1000) / 1000,
            conditionFactor: Math.round(cGate * 1000) / 1000,
            tempFactor: Math.round(tGate * 1000) / 1000,
            stericFactor: Math.round(stericFactor * 1000) / 1000,
            ringFactor: Math.round(ringEval.factor * 1000) / 1000,
            electronicFactor: Math.round(elecFactor * 1000) / 1000,
            reversible: rule.reversible,
            releasedFragment: releasedFragMeta ? classifyFragmentName(releasedFragMeta.smiles) : null,
            releasedGas: rule.releasesGas || null,
          };

          // Merge both parents' upstream StepEvents (preserving order, deduplicating shared ancestors)
          const seenSteps = new Set<StepEvent>();
          const mergedParentChain: StepEvent[] = [];
          for (const p of pair) {
            for (const st of p.chain) {
              if (!seenSteps.has(st)) {
                seenSteps.add(st);
                mergedParentChain.push(st);
              }
            }
          }
          const newChain = [...mergedParentChain, stepEvt];
          if (newChain.length > maxDepth) continue;

          const extraRingThermo = ringEval.addedSizes.some((sz) => sz === 5 || sz === 6) ? 0.14 : 0;
          const extraAromThermo =
            mainMeta.numAromaticRings > Math.max(0, ...pair.map((p) => p.meta.numAromaticRings))
              ? 0.16
              : 0;
          const newCumThermo =
            pair.reduce((acc, p) => acc + p.cumulativeThermo, 0) +
            rule.thermoBonus +
            extraRingThermo +
            extraAromThermo;

          // Frontier priority (kept optimistic so multi-step cyclizations aren't pruned before completing!)
          const minStep = Math.min(...newChain.map((s) => s.stepWeight));
          const geom = Math.exp(
            newChain.reduce((acc, s) => acc + Math.log(Math.max(0.02, s.stepWeight)), 0) /
              newChain.length
          );
          const priority =
            Math.pow(minStep, 0.4) *
            Math.pow(geom, 0.6) *
            Math.pow(0.96, Math.max(0, newChain.length - 1)) *
            (0.9 + Math.min(0.25, newCumThermo * 0.35));

          if (priority < minFrontierScore) continue;

          const existing = speciesMap.get(mainMeta.smiles);
          if (existing) {
            if (!existing.isSubstrate && priority > existing.priorityScore + 0.01) {
              existing.altChains.push(existing.chain);
              existing.chain = newChain;
              existing.priorityScore = priority;
              existing.cumulativeThermo = newCumThermo;
              existing.inventory = combinedInv;
              existing.fragmentUses = combinedFragUses;
              existing.expanded = false; // re-expand improved path
            } else if (!existing.isSubstrate && existing.altChains.length < 3) {
              existing.altChains.push(newChain);
            }
          } else {
            speciesMap.set(mainMeta.smiles, {
              key: mainMeta.smiles,
              meta: mainMeta,
              inventory: combinedInv,
              fragmentUses: combinedFragUses,
              isSubstrate: false,
              isSmallFragment: false,
              chain: newChain,
              altChains: [],
              priorityScore: priority,
              cumulativeThermo: newCumThermo,
              expanded: false,
              tautomerHops:
                Math.max(...pair.map((p) => p.tautomerHops)) + (rule.stepLabel === 'Tautomer' ? 1 : 0),
              alerts: [],
              tplMatchMap: getTplMatch(mainMeta.smiles),
            });
          }

          // Keep released small reactive fragment active in the well pool (e.g. MeOH, EtOH, NH3)
          if (
            releasedFragMeta &&
            releasedFragMeta.amw <= 130 &&
            releasedFragMeta.smiles !== 'O' && // water is tracked via waterPct
            !speciesMap.has(releasedFragMeta.smiles)
          ) {
            releasedFragmentKeys.add(releasedFragMeta.smiles);
            speciesMap.set(releasedFragMeta.smiles, {
              key: releasedFragMeta.smiles,
              meta: releasedFragMeta,
              inventory: new Array(activeSubs.length).fill(0),
              fragmentUses: 0,
              isSubstrate: false,
              isSmallFragment: true,
              releasedFragmentName: classifyFragmentName(releasedFragMeta.smiles),
              chain: [stepEvt],
              altChains: [],
              priorityScore: Math.max(0.28, priority * 0.72),
              cumulativeThermo: 0,
              expanded: false,
              tautomerHops: 0,
              alerts: [],
              tplMatchMap: getTplMatch(releasedFragMeta.smiles),
            });
          }
        }
      }
    }
  }

  // 4. Final Classification (Sink vs Transient vs Byproduct) & Competition Adjustment
  const nonSubSpecies = Array.from(speciesMap.values()).filter((s) => !s.isSubstrate);

  // Count how many competing high-scoring sinks each starting substrate feeds into
  const sinksPerSubstrate = new Array(activeSubs.length).fill(0);
  const preliminaryStatus = new Map<string, 'sink' | 'transient' | 'byproduct'>();

  for (const sp of nonSubSpecies) {
    if (sp.isSmallFragment) {
      preliminaryStatus.set(sp.key, 'byproduct');
      continue;
    }
    const last = sp.chain[sp.chain.length - 1];
    const hasRingOrAromaticLock = sp.chain.some(
      (st) => st.ringFactor > 1.15 || st.stepLabel === 'AO' || st.stepLabel === 'PC' || st.stepLabel === 'DC'
    );
    // If the terminal step is reversible AND hasn't reached an irreversible lock (e.g. hemiaminal, uncyclized imine, open aza-Michael), treat as transient
    const isTransient = Boolean(last && last.reversible && !hasRingOrAromaticLock && last.stepLabel !== 'DH');
    // Note: Imine (DH_imine) in dry/acid conditions without cyclization is also reversible equilibrium intermediate!
    const isUncyclizedImine = Boolean(last && last.ruleId === 'DH_imine');
    const finalTransient = isTransient || isUncyclizedImine;

    preliminaryStatus.set(sp.key, finalTransient ? 'transient' : 'sink');
    if (!finalTransient && sp.priorityScore >= 0.45) {
      sp.inventory.forEach((c, idx) => {
        if (c > 0) sinksPerSubstrate[idx]++;
      });
    }
  }

  const finalSpecies: PredictedSpecies[] = [];
  const finalFragments: PredictedSpecies[] = [];

  for (const sp of nonSubSpecies) {
    const status = preliminaryStatus.get(sp.key) || 'sink';
    const lowestCls = hasLowestClass(sp.chain, rulesById);

    // Gentle competition moderation when a substrate splits cleanly across >= 3 distinct sinks
    let maxCompetingSinks = 1;
    sp.inventory.forEach((c, idx) => {
      if (c > 0 && sinksPerSubstrate[idx] > maxCompetingSinks) {
        maxCompetingSinks = sinksPerSubstrate[idx];
      }
    });
    const competitionFactor =
      status === 'sink' && maxCompetingSinks > 2
        ? Math.max(0.78, 1 / (1 + 0.04 * (maxCompetingSinks - 2)))
        : 1.0;

    const scored = scoreChain(
      sp.chain,
      sp.cumulativeThermo,
      status === 'transient',
      lowestCls,
      competitionFactor
    );

    const molAlerts = sp.isSmallFragment ? [] : detectMolAlerts(rdkit, sp.meta.smiles);
    const stepAlerts: ChemicalAlert[] = [];
    for (const st of sp.chain) {
      if (st.releasedGas) {
        stepAlerts.push({
          kind: 'gas_evolution',
          severity: 'warn',
          message: `Generates ${st.releasedGas} gas in sealed well`,
        });
      }
    }

    const mechanismSummary = sp.isSmallFragment
      ? `Released ${sp.releasedFragmentName || sp.meta.smiles} via ${sp.chain[0]?.stepLabel || 'cleavage'}`
      : sp.chain.map((st) => st.stepLabel).join(' → ');

    const item: PredictedSpecies = {
      key: sp.key,
      smiles: sp.meta.smiles,
      formula: sp.meta.formula,
      exactMass: Math.round(sp.meta.exactMass * 10000) / 10000,
      mhPlus: Math.round((sp.meta.exactMass + PROTON_MASS) * 10000) / 10000,
      mNaPlus: Math.round((sp.meta.exactMass + NA_MASS) * 10000) / 10000,
      mHMinus: Math.round((sp.meta.exactMass - PROTON_MASS) * 10000) / 10000,
      clogP: Math.round(sp.meta.clogP * 100) / 100,
      tpsa: Math.round(sp.meta.tpsa * 10) / 10,
      numRings: sp.meta.numRings,
      numAromaticRings: sp.meta.numAromaticRings,
      inventory: sp.inventory,
      fragmentUses: sp.fragmentUses,
      score: sp.isSmallFragment ? Math.min(0.6, scored.score) : scored.score,
      bottleneckScore: scored.bottleneckScore,
      thermoBonus: scored.thermoBoost,
      tier: scored.tier,
      status,
      isSubstrate: false,
      isSmallFragment: sp.isSmallFragment,
      releasedFragmentName: sp.releasedFragmentName,
      stepsCount: sp.chain.length,
      bestChain: sp.chain,
      alternativeChains: sp.altChains,
      mechanismSummary,
      alerts: [...stepAlerts, ...molAlerts],
    };

    if (sp.isSmallFragment) finalFragments.push(item);
    else finalSpecies.push(item);
  }

  finalSpecies.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    return a.stepsCount - b.stepsCount;
  });

  // Aggregate well-level alerts
  const wellAlerts: ChemicalAlert[] = [];
  if (acidBase.effectiveMedium === 'buffered' && acidBase.totalAddedAcidEq > 0) {
    wellAlerts.push({
      kind: 'buffered_well',
      severity: 'info',
      message: 'Added acid consumed by basic substrate(s) — well runs buffered.',
    });
  }
  const salts = parsedSubs.filter((s) => s.saltDetected);
  if (salts.length > 0) {
    wellAlerts.push({
      kind: 'salt_effect',
      severity: 'info',
      message: `Salt detected in SMILES: ${salts.map((s) => `${s.code} (${s.saltDetected})`).join(', ')}`,
    });
  }
  if (releasedGases.size > 0) {
    wellAlerts.push({
      kind: 'gas_evolution',
      severity: 'warn',
      message: `Gas evolution predicted: ${Array.from(releasedGases).join(', ')}`,
    });
  }
  const hasHighOrMed = finalSpecies.some((s) => s.score >= 0.28);
  if (activeSubs.length > 0 && !hasHighOrMed) {
    wellAlerts.push({
      kind: 'blank_likely',
      severity: 'warn',
      message: 'No High/Medium product predicted under these conditions (possible blank / unreacted SM well).',
    });
  }

  const highCount = finalSpecies.filter((s) => s.tier === 'High').length;
  const mediumCount = finalSpecies.filter((s) => s.tier === 'Medium').length;
  const lowCount = finalSpecies.filter((s) => s.tier === 'Low').length;
  const speculativeCount = finalSpecies.filter((s) => s.tier === 'Speculative').length;
  const sinkCount = finalSpecies.filter((s) => s.status === 'sink').length;
  const transientCount = finalSpecies.filter((s) => s.status === 'transient').length;

  const t1 = typeof performance !== 'undefined' ? performance.now() : Date.now();

  return {
    condition: effectiveCondition,
    substrates: parsedSubs,
    acidBase,
    species: options.includeSpeculative
      ? finalSpecies
      : finalSpecies.filter((s) => s.tier !== 'Speculative' || finalSpecies.length <= 8),
    releasedFragments: finalFragments,
    releasedGases: Array.from(releasedGases),
    alerts: wellAlerts,
    stats: {
      highCount,
      mediumCount,
      lowCount,
      speculativeCount,
      sinkCount,
      transientCount,
      expansionsRun: expansions,
      totalSpeciesExplored: speciesMap.size,
      elapsedMs: Math.round(t1 - t0),
    },
  };
}
