// Robowski Studio - RDKit TLC Spot Visualization & Stain Advisor (UV 254/366 nm + Chemical Stains)
import { countSubstruct } from './molQueries';

export type Uv254Visibility = 'strong' | 'moderate' | 'weak' | 'none';

export interface TlcStainRecommendation {
  stain: 'Ninhydrin' | '2,4-DNP' | 'KMnO₄' | 'p-Anisaldehyde / Vanillin' | 'I₂ chamber';
  colorCue: string;
  reason: string;
}

export interface TlcVisibilityInfo {
  uv254: Uv254Visibility;
  uv366Likely: boolean;
  stains: TlcStainRecommendation[];
  /** Concise single-line cue for cards and TLC advisor overlays */
  shortCue: string;
  /** Helpful lab tip when UV 254 nm is weak or absent */
  stainTip?: string;
}

const visCache = new WeakMap<object, Map<string, TlcVisibilityInfo>>();

const SMA_CONJ_STRONG = [
  '[CX3]=[CX3]-[CX3]=[OX1,NX2]',
  '[CX3]=[CX3]-C#N',
  '[CX3]=[CX3]-[NX3+](=O)[O-]',
  '[CX3]=[CX3]-[CX3]=[CX3]',
];

const SMA_WEAK_UV = [
  '[CX3]=[NX2]',
  '[CX3](=[SX1])[NX3]',
  '[NX2]=[NX2]',
  '[#6]-[NX3+](=O)[O-]',
];

const SMA_UV366_FLUOR = [
  '[c]1[c][c][c]2[c]([c]1)[c,n][c,n][c,n][c,n]2',
  '[c]1[c][c][c]2[c]([c]1)[nH,o,s][c][c]2',
  '[CX3]([NX3])=[CX3]-[CX3]=O',
  'c1ccccc1[CX3]=[CX3]c2ccccc2',
  'c1ccccc1[CX3]=[CX3][CX3](=O)c2ccccc2',
];

const SMA_NINHYDRIN = [
  '[NX3;H2,H1;!$(N-C=[O,S]);!$(N-S=O);!$(N-c);!$([N+])]',
  '[NX3;H2][NX3]',
];

const SMA_DNP = ['[CX3;$([CH1](=O)[#6]),$([CH2]=O),$(C(=O)([#6])[#6])]=O'];

const SMA_KMNO4 = [
  '[CX3]=[CX3]',
  '[CX2]#[CX2]',
  '[CX4][OX2H1]',
  '[CX3;H1](=O)[#6]',
  '[SX2H1]',
  '[NX3;H2,H1]c',
  '[OX2H1]c',
  '[nX3H1;r5]',
];

const SMA_ANISALDEHYDE = [
  '[OX2H1]',
  '[CX3](=O)[#6]',
  '[CX3](=O)[OX2][#6]',
  '[CX3]=[CX3]',
  '[CX4][OX2][CX4]',
];

function anySubstruct(rdkit: any, smiles: string, patterns: string[]): boolean {
  for (const sma of patterns) {
    if (countSubstruct(rdkit, smiles, sma) > 0) return true;
  }
  return false;
}

/**
 * Predicts how a compound will visualize on silica/alumina TLC plates (UV 254 nm, UV 366 nm fluorescence,
 * and specific chemical stains such as Ninhydrin, 2,4-DNP, KMnO4, p-Anisaldehyde/Vanillin, and I2).
 */
export function analyzeTlcVisibility(rdkit: any, smiles: string): TlcVisibilityInfo {
  if (!rdkit || !smiles) {
    return {
      uv254: 'weak',
      uv366Likely: false,
      stains: [{ stain: 'KMnO₄', colorCue: 'yellow on purple', reason: 'general oxidizable check' }],
      shortCue: 'UV 254 nm / KMnO₄',
    };
  }

  let cache = visCache.get(rdkit);
  if (!cache) {
    cache = new Map();
    visCache.set(rdkit, cache);
  }
  const hit = cache.get(smiles);
  if (hit) return hit;

  const aromCount = countSubstruct(rdkit, smiles, '[a]');
  const hasArom = aromCount >= 5;
  const hasStrongConj = anySubstruct(rdkit, smiles, SMA_CONJ_STRONG);
  const hasWeakUv = anySubstruct(rdkit, smiles, SMA_WEAK_UV);
  const hasUv366 = anySubstruct(rdkit, smiles, SMA_UV366_FLUOR) || (aromCount >= 10 && hasStrongConj);

  let uv254: Uv254Visibility = 'none';
  if (hasArom) uv254 = 'strong';
  else if (hasStrongConj) uv254 = 'moderate';
  else if (hasWeakUv) uv254 = 'weak';

  const stains: TlcStainRecommendation[] = [];

  if (anySubstruct(rdkit, smiles, SMA_NINHYDRIN)) {
    stains.push({
      stain: 'Ninhydrin',
      colorCue: 'purple / pink with heat',
      reason: '1°/2° aliphatic amine or hydrazide',
    });
  }
  if (anySubstruct(rdkit, smiles, SMA_DNP)) {
    stains.push({
      stain: '2,4-DNP',
      colorCue: 'yellow / orange',
      reason: 'aldehyde or ketone carbonyl',
    });
  }
  if (anySubstruct(rdkit, smiles, SMA_KMNO4)) {
    stains.push({
      stain: 'KMnO₄',
      colorCue: 'yellow on purple',
      reason: 'alkene, alcohol, thiol, aldehyde, or electron-rich amine/phenol',
    });
  }
  if (stains.length < 2 && anySubstruct(rdkit, smiles, SMA_ANISALDEHYDE)) {
    stains.push({
      stain: 'p-Anisaldehyde / Vanillin',
      colorCue: 'blue / brown / pink with heat',
      reason: 'general stain for alcohols, carbonyls, esters, and alkenes',
    });
  }
  if (stains.length === 0) {
    stains.push({
      stain: 'I₂ chamber',
      colorCue: 'brown (reversible)',
      reason: 'universal check for saturated / weakly reactive organics',
    });
  }

  const topStains = stains
    .slice(0, 2)
    .map((s) => s.stain)
    .join(' or ');

  let shortCue: string;
  let stainTip: string | undefined;

  if (uv254 === 'strong') {
    shortCue = hasUv366 ? 'UV 254 + 366 nm' : 'UV 254 nm';
  } else if (uv254 === 'moderate') {
    shortCue = `UV 254 nm (mod.) · ${stains[0].stain}`;
  } else if (uv254 === 'weak') {
    shortCue = `Weak UV · stain: ${topStains}`;
    stainTip = `Weak under UV 254 nm — confirm spot with ${stains[0].stain} (${stains[0].colorCue}).`;
  } else {
    shortCue = `No UV · stain: ${topStains}`;
    stainTip = `Invisible under UV 254 nm — dip in ${stains[0].stain} (${stains[0].colorCue})${
      stains[1] ? ` or ${stains[1].stain}` : ''
    }.`;
  }

  const info: TlcVisibilityInfo = {
    uv254,
    uv366Likely: hasUv366,
    stains,
    shortCue,
    ...(stainTip ? { stainTip } : {}),
  };

  if (cache.size > 1500) cache.clear();
  cache.set(smiles, info);
  return info;
}
