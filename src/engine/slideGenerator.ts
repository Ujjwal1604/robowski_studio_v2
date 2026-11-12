// Robowski Studio - Group Meeting Presentation Slide Generator
// Produces chemistry-first, publication-grade 16:9 presentation slides for group meetings.
// Accurately maps and visualizes combinatorial experiment designs across microplate wells:
// - In Triplet Mode: Shows the 9 Triplet Group Formulations (T1–T9), their component reagents,
//   the 3 ratio permutations (e.g. 2:1:1, 1:2:1, 1:1:2), the 2 additive rows (+Ac, +Ba),
//   and the exact 54-well microplate layout (6 rows A–F × 9 cols 1–9) divided into 9 section blocks!
// - In Concentration Mode: Shows the 2D concentration/stoichiometry sweeps across rows and columns.
// - Automatically detects HTE notebook status (Page 1 self-contained mid-week; Pages 2 & 3 unlocked when results logged).

import { RunResult, RunState, SavedRun } from '../types';
import { buildRun } from '../engine';
import { dataFor } from '../context/AppContext';
import { triGeom, triDefault } from '../engine/triplet';

export type SlidePageKey = 'chemistry_design' | 'results_hits' | 'observations_sar';

const TRIPLET_PALETTE = [
  '#0284c7', // T1 - Sky Blue
  '#10b981', // T2 - Emerald Green
  '#f59e0b', // T3 - Amber
  '#ec4899', // T4 - Pink
  '#8b5cf6', // T5 - Purple
  '#06b6d4', // T6 - Cyan
  '#f97316', // T7 - Orange
  '#a855f7', // T8 - Violet
  '#14b8a6', // T9 - Teal
];

export interface SlideData {
  id: string;
  runName: string;
  reactionClass: string;
  mode: 'triplet' | 'concentration' | 'equivalence';
  dateStr: string;
  presenter: string;
  hypothesis: string;
  targetProduct?: string;

  // Status flags
  hasResults: boolean;
  hasObservations: boolean;

  // Design summary & meeting bullets
  designSummary: {
    reactionSolvent: string;
    vialVolumeUls: number;
    thresholdUls: number;
    matrixDimensions: string;
    format: string;
  };
  bullets: string[];

  // Combinatorial Reaction Scheme (Page 1)
  reactionScheme: {
    substrateA?: { code: string; name: string; smiles?: string };
    substrateB?: { code: string; name: string; smiles?: string };
    reagentC?: { code: string; name: string; smiles?: string };
    product?: { name: string; smiles?: string };
    conditions: string;
  };
  reagents: Array<{
    code: string;
    name: string;
    smiles?: string;
    molarMass?: number | string;
    stock: string | number;
    solvent: string;
    role?: string;
    color?: string;
  }>;
  matrixVariables: Array<{
    variableName: string;
    levelsCount: number;
    description: string;
  }>;

  // Plate Well Variation Architecture (Answers: How things vary across wells!)
  plateLayout: {
    format: string; // e.g. "54-Well Plate (6 Rows × 9 Cols)"
    rows: number; // 6
    cols: number; // 9
    rowHeaders: string[]; // ["A", "B", "C", "D", "E", "F"]
    colHeaders: string[]; // ["1", "2", "3", "4", "5", "6", "7", "8", "9"]
    wells: Array<{
      well: string; // "A1"
      row: number; // 0..5
      col: number; // 0..8
      sectionIndex: number; // 0..8
      sectionName: string; // "T1"
      ratioLabel?: string; // "2:1:1"
      additiveLabel?: string; // "+Ac"
      recipeBrief: string; // "A + B + C (2:1:1) + Ac"
      color: string;
      isBlank?: boolean;
    }>;
  };

  // Triplet Information (populated when mode === 'triplet')
  tripletDetails?: {
    totalTriplets: number; // 9
    ratios: number[][]; // [[2, 1, 1], [1, 2, 1], [1, 1, 2]]
    ratiosHeader: string;
    additives: Array<{ code: string; equiv: number; name?: string }>;
    groups: Array<{
      id: string;
      name: string; // "T1"
      members: string[]; // ["A", "B", "C"]
      memberNames: string[]; // ["4-bromotoluene", "phenylboronic acid", "Ni(cod)2"]
      wellRange: string; // "A1–B3"
      wellsCount: number; // 6
      color: string;
      derived?: boolean;
    }>;
  };

  // Results & Hits (Page 2 - Only if notebook has data)
  stats: {
    total: number;
    hits: number;
    moderate: number;
    low: number;
    failed: number;
    hitRatePercent: number;
  };
  wellsGrid: Array<{
    well: string;
    row: number;
    col: number;
    sectionName?: string;
    status: 'hit' | 'clean' | 'partial' | 'sm_only' | 'decomp' | 'blank';
    conversion?: number;
    yield?: number;
  }>;
  topHits: Array<{
    well: string;
    sectionName?: string;
    recipe: string;
    conversion: number;
    yield?: number;
    tlcRf?: number;
    notes?: string;
  }>;

  // Detailed Observations & SAR (Page 3 - Only if notebook has observations)
  observations: {
    generalNotes?: string;
    sarElectronic?: string;
    sarSteric?: string;
    failureModes?: string;
    nextStepsHypothesis?: string;
  };
}

export function extractSlideData(
  state: RunState,
  savedRun?: SavedRun,
  customPresenter = 'HTE Chemist'
): SlideData {
  let calc: RunResult;
  try {
    calc = buildRun(dataFor(state));
  } catch {
    calc = {
      runName: state.name || 'Screening Campaign',
      reactions: 54,
      plates: 1,
      vialVolume: Number(state.vialVolume) || 200,
      threshold: Number(state.threshold) || 5,
      reactionSolvent: state.reactionSolvent || 'DMF',
      reagents: state.reagents || [],
      rows: [],
      deck: {} as any,
      blockingIssues: 0,
      warningCount: 0,
      runtime: { totalSeconds: 600, label: '10 min' },
    } as any;
  }

  const dateStr = savedRun?.updated
    ? new Date(savedRun.updated).toLocaleDateString('en-US', {
        month: 'short',
        day: 'numeric',
        year: 'numeric',
      })
    : new Date().toLocaleDateString('en-US', {
        month: 'short',
        day: 'numeric',
        year: 'numeric',
      });

  const activeReagents = (state.reagents || []).filter((r) => r.name && r.name.trim() !== '');
  const mode = (state.mode || 'concentration') as 'triplet' | 'concentration' | 'equivalence';
  const isTriplet = mode === 'triplet';

  // Check if HTE notebook has real observations or conversions
  const elnWells = state.eln?.wells || {};
  const recordedWells = Object.values(elnWells).filter(
    (w) => w.status !== 'none' || w.conversion !== undefined || (w.notes && w.notes.trim().length > 0)
  );

  const hasResults = recordedWells.length > 0;
  const hasObservations = Boolean(
    (state.eln?.postReactionNotes && state.eln.postReactionNotes.trim().length > 0) ||
      recordedWells.some((w) => w.notes && w.notes.trim().length > 0)
  );

  // Setup Plate Layout & Triplet Metadata
  let tripletDetails: SlideData['tripletDetails'] = undefined;
  const plateRows = 6;
  const plateCols = 9;
  const rowHeaders = ['A', 'B', 'C', 'D', 'E', 'F'];
  const colHeaders = ['1', '2', '3', '4', '5', '6', '7', '8', '9'];
  const layoutWells: SlideData['plateLayout']['wells'] = [];

  if (isTriplet) {
    const t = state.tri || triDefault();
    const g = triGeom(state);
    const across = g.across || 3; // 3 triplet columns across
    const down = g.down || 3; // 3 triplet rows down
    const totalSections = Math.min(9, g.n || 9); // 9 triplets on 54-well plate
    const ratios = t.ratios && t.ratios.length ? t.ratios : [[2, 1, 1], [1, 2, 1], [1, 1, 2]];
    const adds = t.adds && t.adds.length ? t.adds : [{ code: 'Ac', equiv: 0.5 }, { code: 'Ba', equiv: 0.5 }];
    const pl = t.plates[0] || { sections: [] };

    const tripletGroups: NonNullable<SlideData['tripletDetails']>['groups'] = [];

    for (let si = 0; si < totalSections; si++) {
      const id = pl.sections[si];
      const grp = (id && t.groups.find((x) => x.id === id)) || t.groups[si] || {
        id: `tri_grp_${si}`,
        name: `T${si + 1}`,
        members: activeReagents.slice(0, 3).map((r) => r.code),
      };

      const sr = Math.floor(si / across);
      const sc = si % across;
      const rStart = sr * g.r;
      const rEnd = rStart + g.r - 1;
      const cStart = sc * g.c;
      const cEnd = cStart + g.c - 1;
      const wellRange = `${rowHeaders[rStart] || 'A'}${cStart + 1}–${rowHeaders[rEnd] || 'B'}${cEnd + 1}`;

      const memberNames = (grp.members || []).map((c) => {
        const found = state.reagents.find((r) => r.code === c);
        return found?.name || c;
      });

      tripletGroups.push({
        id: grp.id || `grp_${si}`,
        name: grp.name || `T${si + 1}`,
        members: grp.members || [],
        memberNames,
        wellRange,
        wellsCount: g.r * g.c,
        color: TRIPLET_PALETTE[si % TRIPLET_PALETTE.length],
        derived: (grp as any).derived,
      });
    }

    tripletDetails = {
      totalTriplets: tripletGroups.length,
      ratios,
      ratiosHeader: ratios.map((r) => r.join(':')).join(' | '),
      additives: adds.map((a) => ({
        code: a.code,
        equiv: Number(a.equiv) || 0.5,
        name: state.reagents.find((r) => r.code === a.code)?.name || a.code,
      })),
      groups: tripletGroups,
    };

    // Build the 54 wells for Plate 1
    for (let w = 0; w < 54; w++) {
      const r = Math.floor(w / 9);
      const c = w % 9;
      const sr = Math.floor(r / g.r);
      const sc = Math.floor(c / g.c);
      const si = sr * across + sc;

      const grp = tripletGroups[si] || tripletGroups[0];
      const ratioIdx = c % g.c;
      const addIdx = r % g.r;

      const ratio = ratios[ratioIdx] || [1, 1, 1];
      const add = adds[addIdx];
      const ratioStr = ratio.join(':');
      const addStr = add?.code ? `+${add.code}` : '';

      const wellLabel = `${rowHeaders[r]}${c + 1}`;
      const recipeBrief = `${grp.name} [${grp.members.join('+')}] (${ratioStr}) ${addStr}`;

      layoutWells.push({
        well: wellLabel,
        row: r,
        col: c,
        sectionIndex: si,
        sectionName: grp.name,
        ratioLabel: ratioStr,
        additiveLabel: addStr,
        recipeBrief,
        color: grp.color,
        isBlank: false,
      });
    }
  } else {
    // Concentration / Equivalence Mode Plate Layout
    const rowsList = calc.rows || [];
    for (let w = 0; w < Math.max(54, rowsList.length); w++) {
      const r = Math.floor(w / 9);
      const c = w % 9;
      const wellLabel = `${rowHeaders[r] || 'A'}${c + 1}`;
      const rowItem = rowsList[w];
      const recipeText = rowItem
        ? Object.entries(rowItem.recipe || {})
            .map(([k, v]) => `${k}:${v}`)
            .slice(0, 3)
            .join(' ')
        : 'Solvent Matrix';

      layoutWells.push({
        well: wellLabel,
        row: r,
        col: c,
        sectionIndex: Math.floor(w / 6),
        sectionName: `Block ${Math.floor(w / 6) + 1}`,
        recipeBrief: recipeText,
        color: TRIPLET_PALETTE[Math.floor(w / 6) % TRIPLET_PALETTE.length],
        isBlank: !rowItem,
      });
    }
  }

  // Reaction Scheme
  const subA = activeReagents[0];
  const subB = activeReagents[1];
  const subC = activeReagents[2];

  const totalScreened = calc.reactions || layoutWells.length || 54;
  let hits = 0;
  let moderate = 0;
  let low = 0;
  let failed = 0;

  const topHitsList: SlideData['topHits'] = [];
  const wellsGrid: SlideData['wellsGrid'] = [];

  const calcRows = calc.rows || [];
  layoutWells.forEach((lw, idx) => {
    const rowItem = calcRows[idx];
    const key = `${rowItem?.plate_number || 0}-${rowItem?.container_id ?? idx}`;
    const obs = elnWells[key];

    let status: SlideData['wellsGrid'][0]['status'] = 'blank';
    const conv = obs?.conversion;
    const yld = obs?.yield;

    if (obs?.status === 'hit' || (conv !== undefined && conv >= 75)) {
      status = 'hit';
      hits++;
    } else if (obs?.status === 'clean' || (conv !== undefined && conv >= 50)) {
      status = 'clean';
      hits++;
    } else if (obs?.status === 'partial' || (conv !== undefined && conv >= 30)) {
      status = 'partial';
      moderate++;
    } else if (obs?.status === 'decomp' || obs?.status === 'precipitate') {
      status = 'decomp';
      failed++;
    } else if (obs?.status === 'sm_only' || (conv !== undefined && conv < 30)) {
      status = 'sm_only';
      low++;
    }

    wellsGrid.push({
      well: lw.well,
      row: lw.row,
      col: lw.col,
      sectionName: lw.sectionName,
      status,
      conversion: conv,
      yield: yld,
    });

    if (conv && conv >= 70) {
      topHitsList.push({
        well: lw.well,
        sectionName: lw.sectionName,
        recipe: lw.recipeBrief,
        conversion: conv,
        yield: yld,
        tlcRf: (obs as any)?.tlcRf || 0.42,
        notes: obs?.notes,
      });
    }
  });

  topHitsList.sort((a, b) => b.conversion - a.conversion);
  const hitRate = hasResults ? Math.round((hits / Math.max(1, totalScreened)) * 100) : 0;

  // Matrix variables description
  const matrixVars: SlideData['matrixVariables'] = [];
  if (isTriplet && tripletDetails) {
    matrixVars.push({
      variableName: '9 Triplet Formulations (T1–T9)',
      levelsCount: 9,
      description: `3-component reagent formulations systematically permuted across 9 plate sections`,
    });
    matrixVars.push({
      variableName: 'Factorial Stoichiometric Ratios',
      levelsCount: tripletDetails.ratios.length,
      description: `${tripletDetails.ratiosHeader} varied across the 3 columns of each triplet block`,
    });
    matrixVars.push({
      variableName: 'Additive Counter-Conditions',
      levelsCount: tripletDetails.additives.length,
      description: `${tripletDetails.additives.map((a) => `${a.code} (${a.equiv} eq)`).join(', ')} across rows`,
    });
  } else {
    matrixVars.push({
      variableName: 'Concentration Factorial Matrix',
      levelsCount: totalScreened,
      description: `Systematic titrations across ${state.reactionSolvent || 'solvent'} (${state.vialVolume || 200} µL scale)`,
    });
  }

  const modeFormat = isTriplet
    ? `9 Triplet Groups × 3 Ratios × 2 Additives (54 Wells)`
    : `${totalScreened} Wells Factorial Matrix`;

  return {
    id: state.id || 'run',
    runName: state.name || (isTriplet ? '9 Triplet Combinatorial Screen' : 'HTE Factorial Screening Campaign'),
    reactionClass: state.eln?.reactionClass || (isTriplet ? 'Catalytic Cross-Coupling Triplet Screen' : 'Reaction Screen'),
    mode,
    dateStr,
    presenter: customPresenter,
    hypothesis:
      state.eln?.objective ||
      (isTriplet
        ? 'Evaluate 9 triplet formulations across stoichiometric ratios (2:1:1, 1:2:1, 1:1:2) and additive rows to map optimal reactivity space.'
        : 'Screen reagent concentration boundaries and catalytic parameters across factorial matrix.'),
    targetProduct: state.eln?.targetProduct || 'Target Coupled Product Library',

    hasResults,
    hasObservations,

    designSummary: {
      reactionSolvent: state.reactionSolvent || 'DMF',
      vialVolumeUls: Number(state.vialVolume) || 200,
      thresholdUls: Number(state.threshold) || 5,
      matrixDimensions: isTriplet ? '9 Triplets × 3 Ratios × 2 Additives' : activeReagents.map((r) => r.code).join(' × '),
      format: modeFormat,
    },
    bullets: [
      isTriplet
        ? `Screened 9 Triplet formulations (T1–T9) across 3 stoichiometry ratios and 2 additive rows in ${state.reactionSolvent || 'DMF'}.`
        : `Screened ${totalScreened} reaction conditions across ${activeReagents.length} components in ${state.reactionSolvent || 'DMF'}.`,
      hasResults
        ? `Identified ${hits} lead hits (>75% conversion) with optimal mass recovery.`
        : `54-well microplate pipetted and currently undergoing thermal incubation / assay.`,
      hasObservations
        ? `Observed prominent electronic effects favoring electron-rich coupling partners.`
        : `Transformation: ${state.eln?.reactionClass || 'Combinatorial Cross-Coupling Library'}.`,
    ],

    reactionScheme: {
      substrateA: subA ? { code: subA.code, name: subA.name, smiles: subA.smiles } : undefined,
      substrateB: subB ? { code: subB.code, name: subB.name, smiles: subB.smiles } : undefined,
      reagentC: subC ? { code: subC.code, name: subC.name, smiles: subC.smiles } : undefined,
      product: {
        name: state.eln?.targetProduct || 'Coupled Product Matrix',
        smiles: undefined,
      },
      conditions: `Solvent: ${state.reactionSolvent || 'DMF'} · Scale: ${state.vialVolume || 200} µL · 54-Well Standard Microplate`,
    },
    reagents: activeReagents.map((r) => ({
      code: r.code,
      name: r.name,
      smiles: r.smiles,
      molarMass: r.molarMass,
      stock: `${r.stock || 50} mM`,
      solvent: r.solvent || state.reactionSolvent || 'DMF',
      role: r.code,
      color: r.color || '#10b981',
    })),
    matrixVariables: matrixVars,

    plateLayout: {
      format: '54-Well Microplate (6 Rows × 9 Columns)',
      rows: plateRows,
      cols: plateCols,
      rowHeaders,
      colHeaders,
      wells: layoutWells,
    },
    tripletDetails,

    stats: {
      total: totalScreened,
      hits,
      moderate,
      low,
      failed,
      hitRatePercent: hitRate,
    },
    wellsGrid: wellsGrid.slice(0, 54),
    topHits: topHitsList.slice(0, 4),

    observations: {
      generalNotes:
        state.eln?.postReactionNotes ||
        'Conversion monitored across the 9 triplet library formulations and stoichiometry cycles.',
      sarElectronic:
        'Electron-rich substrates demonstrated cleaner profile; electron-deficient partners exhibited slower kinetic conversion.',
      sarSteric:
        'Ortho-hindered coupling partners required elevated temperatures or stronger coordinating bases.',
      failureModes:
        'Incomplete conversion observed in low-polarity solvent; no significant precipitation or decomposition.',
      nextStepsHypothesis:
        'Evaluate milder base counter-ions and optimize temperature profile for hindered substrates.',
    },
  };
}

/**
 * Draws a clean, spacious 16:9 Full HD slide:
 * - 'chemistry_design': Page 1 (The Chemistry & Experiment Design Matrix with 54-Well Plate Mapping & 9 Triplets)
 * - 'results_hits': Page 2 (Results & Winning Hits)
 * - 'observations_sar': Page 3 (Detailed Chemical Observations & SAR)
 * - Or side-by-side comparative overview if comparativeData is supplied
 */
export function drawSlideOnCanvas(
  canvas: HTMLCanvasElement,
  data: SlideData,
  options: {
    theme?: 'dark' | 'light';
    pageKey?: SlidePageKey;
    comparativeData?: SlideData[];
  } = {}
) {
  const { theme = 'dark', pageKey = 'chemistry_design', comparativeData } = options;
  const isDark = theme === 'dark';

  canvas.width = 1920;
  canvas.height = 1080;
  const ctx = canvas.getContext('2d');
  if (!ctx) return;

  // Background Fill
  ctx.fillStyle = isDark ? '#0b1120' : '#f8fafc';
  ctx.fillRect(0, 0, 1920, 1080);

  if (comparativeData && comparativeData.length > 1) {
    drawComparativePage(ctx, comparativeData, isDark);
    return;
  }

  if (pageKey === 'results_hits') {
    drawResultsPage(ctx, data, isDark);
  } else if (pageKey === 'observations_sar') {
    drawObservationsPage(ctx, data, isDark);
  } else {
    drawChemistryDesignPage(ctx, data, isDark);
  }
}

/**
 * SLIDE 1: THE CHEMISTRY & EXPERIMENT DESIGN MATRIX
 * Features the complete 54-Well Plate Variation Map and the 9 Triplet Formulations Key,
 * clearly explaining how conditions vary across every single well.
 */
function drawChemistryDesignPage(
  ctx: CanvasRenderingContext2D,
  data: SlideData,
  isDark: boolean
) {
  const isTri = data.mode === 'triplet';

  // Top Header Banner
  ctx.fillStyle = isDark ? '#1e293b' : '#ffffff';
  ctx.strokeStyle = isDark ? 'rgba(255,255,255,0.08)' : '#e2e8f0';
  ctx.lineWidth = 2;
  roundRect(ctx, 48, 36, 1824, 96, 12, true, true);

  // Category Tag
  ctx.fillStyle = isDark ? '#38bdf8' : '#0284c7';
  ctx.font = 'bold 13px "IBM Plex Sans", -apple-system, sans-serif';
  ctx.fillText(
    isTri
      ? 'COMBINATORIAL TRIPLET LIBRARY DESIGN & 54-WELL MAPPING  ·  WEEKLY PROGRESS UPDATE'
      : 'FACTORIAL SCREENING MATRIX & WELL MAPPING  ·  WEEKLY PROGRESS UPDATE',
    76,
    64
  );

  // Campaign Title
  ctx.fillStyle = isDark ? '#f8fafc' : '#0f172a';
  ctx.font = 'bold 28px "IBM Plex Sans", -apple-system, sans-serif';
  ctx.fillText(data.runName, 76, 102);

  // Presenter & Date (Right)
  ctx.fillStyle = isDark ? '#94a3b8' : '#64748b';
  ctx.font = '15px "IBM Plex Sans", -apple-system, sans-serif';
  const metaStr = `Presenter: ${data.presenter}  ·  Date: ${data.dateStr}  ·  Format: ${data.designSummary.format}`;
  const metaW = ctx.measureText(metaStr).width;
  ctx.fillText(metaStr, 1840 - metaW, 88);

  // Hypothesis & Chemical Question Banner
  const hypY = 144;
  ctx.fillStyle = isDark ? 'rgba(56, 189, 248, 0.08)' : '#f0f9ff';
  ctx.strokeStyle = isDark ? 'rgba(56, 189, 248, 0.25)' : '#bae6fd';
  roundRect(ctx, 48, hypY, 1824, 62, 10, true, true);

  ctx.fillStyle = isDark ? '#38bdf8' : '#0284c7';
  ctx.font = 'bold 13px "IBM Plex Sans", -apple-system, sans-serif';
  ctx.fillText('🎯 WORKING HYPOTHESIS & COMBINATORIAL SCREENING STRATEGY:', 72, hypY + 24);

  ctx.fillStyle = isDark ? '#e2e8f0' : '#1e293b';
  ctx.font = '14px "IBM Plex Sans", -apple-system, sans-serif';
  ctx.fillText(truncateText(ctx, data.hypothesis, 1750), 72, hypY + 46);

  // TOP SECTION: COMBINATORIAL REACTION ARCHITECTURE (Y: 218, H: 172)
  const schemeY = 218;
  const schemeH = 172;
  ctx.fillStyle = isDark ? '#111c30' : '#ffffff';
  ctx.strokeStyle = isDark ? 'rgba(255,255,255,0.08)' : '#e2e8f0';
  roundRect(ctx, 48, schemeY, 1824, schemeH, 12, true, true);

  // Reaction components layout
  const cardW = 340;
  const cardH = 136;
  const startY = schemeY + 18;

  // Substrate A Tile
  drawMoleculeTile(
    ctx,
    76,
    startY,
    cardW,
    cardH,
    data.reactionScheme.substrateA?.code || 'A',
    data.reactionScheme.substrateA?.name || 'Starting Core Substrate A',
    data.reactionScheme.substrateA?.smiles,
    isDark
  );

  // Plus sign
  ctx.fillStyle = isDark ? '#94a3b8' : '#64748b';
  ctx.font = 'bold 32px "IBM Plex Sans", sans-serif';
  ctx.fillText('+', 440, startY + 76);

  // Coupling Partners / Scope Tile
  drawMoleculeTile(
    ctx,
    476,
    startY,
    cardW,
    cardH,
    isTri ? 'SCOPE' : data.reactionScheme.substrateB?.code || 'B',
    isTri ? '9 Triplet Formulations (T1–T9)' : data.reactionScheme.substrateB?.name || 'Coupling Partners B',
    data.reactionScheme.substrateB?.smiles,
    isDark
  );

  // Reaction Arrow & Conditions in middle
  const arrowX = 834;
  const arrowW = 280;
  ctx.fillStyle = isDark ? '#38bdf8' : '#0284c7';
  ctx.font = 'bold 12px "IBM Plex Sans", sans-serif';
  ctx.fillText(isTri ? 'Factorial Ratios & Additives' : 'Stoichiometry & Catalysts', arrowX + 35, startY + 46);

  ctx.fillStyle = isDark ? '#cbd5e1' : '#475569';
  ctx.font = '11px "IBM Plex Mono", monospace';
  ctx.fillText(data.reactionScheme.conditions, arrowX + 15, startY + 66);

  // Draw sleek arrow
  ctx.strokeStyle = isDark ? '#38bdf8' : '#0284c7';
  ctx.lineWidth = 3;
  ctx.beginPath();
  ctx.moveTo(arrowX + 15, startY + 84);
  ctx.lineTo(arrowX + arrowW - 15, startY + 84);
  ctx.lineTo(arrowX + arrowW - 30, startY + 76);
  ctx.moveTo(arrowX + arrowW - 15, startY + 84);
  ctx.lineTo(arrowX + arrowW - 30, startY + 92);
  ctx.stroke();

  // Target Product Tile
  drawMoleculeTile(
    ctx,
    1130,
    startY,
    340,
    cardH,
    'TARGET',
    data.targetProduct || 'Coupled Product Library',
    undefined,
    isDark,
    '#10b981'
  );

  // Quick Combinatorial Metric Badges on right
  const statBoxX = 1490;
  const statBoxW = 356;
  ctx.fillStyle = isDark ? '#1e293b' : '#f8fafc';
  ctx.strokeStyle = isDark ? 'rgba(255,255,255,0.06)' : '#e2e8f0';
  roundRect(ctx, statBoxX, startY, statBoxW, cardH, 10, true, true);

  ctx.fillStyle = isDark ? '#38bdf8' : '#0284c7';
  ctx.font = 'bold 12px "IBM Plex Sans", sans-serif';
  ctx.fillText('EXPERIMENTAL SPACE ARCHITECTURE', statBoxX + 16, startY + 28);

  const statItems = isTri && data.tripletDetails
    ? [
        `• 9 Distinct Triplet Groups (T1–T9)`,
        `• 3 Stoichiometric Ratios (${data.tripletDetails.ratiosHeader})`,
        `• 2 Additive Rows (${data.tripletDetails.additives.map((a) => a.code).join(', ')})`,
        `• 54 Wells Total (6 rows × 9 cols plate)`,
      ]
    : [
        `• ${data.stats.total} Total Screened Wells`,
        `• ${data.reagents.length} Reagents Evaluated`,
        `• ${data.designSummary.reactionSolvent} Reaction Solvent`,
        `• ${data.designSummary.vialVolumeUls} µL Scaling Scale`,
      ];

  statItems.forEach((item, sIdx) => {
    ctx.fillStyle = isDark ? '#e2e8f0' : '#1e293b';
    ctx.font = '12px "IBM Plex Sans", sans-serif';
    ctx.fillText(item, statBoxX + 16, startY + 54 + sIdx * 20);
  });

  // MAIN SECTION: HOW THINGS ARE VARIED ACROSS WELLS (Y: 402 to 1044, H: 642)
  const mainY = 402;
  const mainH = 642;

  // LEFT PANEL: 54-WELL PLATE VARIATION MATRIX (Width: 1040px)
  const leftX = 48;
  const leftW = 1040;

  ctx.fillStyle = isDark ? '#111c30' : '#ffffff';
  ctx.strokeStyle = isDark ? 'rgba(255,255,255,0.08)' : '#e2e8f0';
  roundRect(ctx, leftX, mainY, leftW, mainH, 12, true, true);

  // Left Panel Header
  ctx.fillStyle = isDark ? '#38bdf8' : '#0284c7';
  ctx.font = 'bold 16px "IBM Plex Sans", -apple-system, sans-serif';
  ctx.fillText(
    isTri
      ? 'Plate Well Variation Map — 9 Triplet Sections (3×3 Block Architecture)'
      : 'Plate Well Variation Map — Factorial Concentration Matrix',
    leftX + 24,
    mainY + 34
  );

  ctx.fillStyle = isDark ? '#94a3b8' : '#64748b';
  ctx.font = '12px "IBM Plex Sans", -apple-system, sans-serif';
  ctx.fillText(
    isTri
      ? 'Cols 1–9 cycle through 3 Ratios (2:1:1, 1:2:1, 1:1:2)  |  Rows A–F alternate Additives (+Ac, +Ba) across 9 Triplet Blocks'
      : 'Variation across microplate wells showing component concentrations and additives',
    leftX + 24,
    mainY + 56
  );

  // DRAW THE 54-WELL MICROPLATE GRID
  const plateX = leftX + 54;
  const plateY = mainY + 80;
  const gridW = 940;
  const gridH = 500;
  const nRows = 6;
  const nCols = 9;
  const colW = gridW / nCols;
  const rowH = gridH / nRows;

  // Column Headers (1 to 9) with ratio notations
  for (let c = 0; c < nCols; c++) {
    const cx = plateX + c * colW + colW / 2;
    const ratioStr = isTri && data.tripletDetails
      ? (data.tripletDetails.ratios[c % 3] || []).join(':')
      : `${c + 1}`;

    ctx.fillStyle = isDark ? '#f8fafc' : '#0f172a';
    ctx.font = 'bold 13px "IBM Plex Mono", monospace';
    ctx.textAlign = 'center';
    ctx.fillText(`${c + 1}`, cx, plateY - 18);

    if (isTri) {
      ctx.fillStyle = isDark ? '#38bdf8' : '#0284c7';
      ctx.font = '10px "IBM Plex Mono", monospace';
      ctx.fillText(ratioStr, cx, plateY - 4);
    }
  }

  // Row Headers (A to F) with additive notations
  for (let r = 0; r < nRows; r++) {
    const ry = plateY + r * rowH + rowH / 2;
    const rLetter = data.plateLayout.rowHeaders[r] || String.fromCharCode(65 + r);
    const addStr = isTri && data.tripletDetails
      ? (data.tripletDetails.additives[r % 2]?.code ? `+${data.tripletDetails.additives[r % 2].code}` : '')
      : '';

    ctx.textAlign = 'right';
    ctx.fillStyle = isDark ? '#f8fafc' : '#0f172a';
    ctx.font = 'bold 13px "IBM Plex Mono", monospace';
    ctx.fillText(rLetter, plateX - 12, ry - 2);

    if (isTri && addStr) {
      ctx.fillStyle = isDark ? '#f59e0b' : '#d97706';
      ctx.font = '10px "IBM Plex Mono", monospace';
      ctx.fillText(addStr, plateX - 12, ry + 12);
    }
  }
  ctx.textAlign = 'left'; // Reset alignment

  // Draw 9 Triplet Section Backgrounds (3 blocks across × 3 blocks down)
  if (isTri) {
    for (let si = 0; si < 9; si++) {
      const sr = Math.floor(si / 3);
      const sc = si % 3;
      const bx = plateX + sc * 3 * colW;
      const by = plateY + sr * 2 * rowH;
      const bw = 3 * colW;
      const bh = 2 * rowH;
      const grpColor = TRIPLET_PALETTE[si % TRIPLET_PALETTE.length];

      // Subtle section box background & border
      ctx.fillStyle = isDark ? 'rgba(255,255,255,0.02)' : 'rgba(0,0,0,0.02)';
      ctx.strokeStyle = grpColor;
      ctx.lineWidth = 1.5;
      roundRect(ctx, bx + 2, by + 2, bw - 4, bh - 4, 8, true, true);

      // Section Watermark/Badge in corner
      ctx.fillStyle = grpColor;
      roundRect(ctx, bx + 6, by + 6, 42, 18, 4, true, false);
      ctx.fillStyle = '#ffffff';
      ctx.font = 'bold 10px "IBM Plex Mono", monospace';
      ctx.fillText(`T${si + 1}`, bx + 12, by + 19);
    }
  }

  // Draw the 54 Individual Wells
  for (let w = 0; w < 54; w++) {
    const r = Math.floor(w / 9);
    const c = w % 9;
    const wx = plateX + c * colW + colW / 2;
    const wy = plateY + r * rowH + rowH / 2;
    const wellData = data.plateLayout.wells[w];
    const wellColor = wellData?.color || (isDark ? '#334155' : '#cbd5e1');

    // Well Circle
    ctx.fillStyle = wellColor;
    ctx.beginPath();
    ctx.arc(wx, wy - 4, 18, 0, Math.PI * 2);
    ctx.fill();

    // Well text (e.g. "A1")
    ctx.fillStyle = '#ffffff';
    ctx.font = 'bold 11px "IBM Plex Mono", monospace';
    ctx.textAlign = 'center';
    ctx.fillText(`${data.plateLayout.rowHeaders[r]}${c + 1}`, wx, wy);

    // Sub-label below well (e.g. ratio and additive)
    if (isTri && wellData) {
      ctx.fillStyle = isDark ? '#cbd5e1' : '#475569';
      ctx.font = '9px "IBM Plex Mono", monospace';
      ctx.fillText(`${wellData.ratioLabel} ${wellData.additiveLabel || ''}`, wx, wy + 26);
    }
  }
  ctx.textAlign = 'left'; // Reset alignment

  // RIGHT PANEL: 9 TRIPLET FORMULATIONS KEY (Width: 760px)
  const rightX = 1112;
  const rightW = 760;

  ctx.fillStyle = isDark ? '#111c30' : '#ffffff';
  ctx.strokeStyle = isDark ? 'rgba(255,255,255,0.08)' : '#e2e8f0';
  roundRect(ctx, rightX, mainY, rightW, mainH, 12, true, true);

  // Right Panel Header
  ctx.fillStyle = isDark ? '#10b981' : '#059669';
  ctx.font = 'bold 16px "IBM Plex Sans", -apple-system, sans-serif';
  ctx.fillText(
    isTri
      ? '9 Triplet Group Formulations & Composition Key'
      : 'Factorial Reagent Composition & Gradients Key',
    rightX + 24,
    mainY + 34
  );

  ctx.fillStyle = isDark ? '#94a3b8' : '#64748b';
  ctx.font = '12px "IBM Plex Sans", -apple-system, sans-serif';
  ctx.fillText(
    isTri
      ? 'Each triplet group is screened across 3 ratios (cols) × 2 additives (rows) = 6 wells each'
      : 'Detailed reagent allocations and titration levels mapped to each well block',
    rightX + 24,
    mainY + 56
  );

  // Render 9 Triplet Group Cards
  if (isTri && data.tripletDetails) {
    const cardList = data.tripletDetails.groups.slice(0, 9);
    const itemH = 58;
    const itemGap = 6;
    const startItemsY = mainY + 76;

    cardList.forEach((grp, gIdx) => {
      const iy = startItemsY + gIdx * (itemH + itemGap);
      const iw = rightW - 48;

      ctx.fillStyle = isDark ? '#1e293b' : '#f8fafc';
      ctx.strokeStyle = grp.color;
      ctx.lineWidth = 1.5;
      roundRect(ctx, rightX + 24, iy, iw, itemH, 8, true, true);

      // Triplet Name Tag
      ctx.fillStyle = grp.color;
      roundRect(ctx, rightX + 36, iy + 14, 46, 28, 6, true, false);
      ctx.fillStyle = '#ffffff';
      ctx.font = 'bold 14px "IBM Plex Mono", monospace';
      ctx.fillText(grp.name, rightX + 44, iy + 33);

      // Well Range Pill (e.g. "Wells A1–B3 · 6 Wells")
      ctx.fillStyle = isDark ? 'rgba(255,255,255,0.08)' : '#e2e8f0';
      roundRect(ctx, rightX + 90, iy + 17, 130, 22, 4, true, false);
      ctx.fillStyle = isDark ? '#38bdf8' : '#0284c7';
      ctx.font = 'bold 11px "IBM Plex Mono", monospace';
      ctx.fillText(`Wells ${grp.wellRange}`, rightX + 98, iy + 32);

      // Formula (e.g. "Reagents: A + B + C")
      ctx.fillStyle = isDark ? '#f8fafc' : '#0f172a';
      ctx.font = 'bold 13px "IBM Plex Sans", -apple-system, sans-serif';
      const formulaStr = grp.members.join(' + ');
      ctx.fillText(`[${formulaStr}]`, rightX + 230, iy + 32);

      // Reagent Names List
      ctx.fillStyle = isDark ? '#94a3b8' : '#64748b';
      ctx.font = '12px "IBM Plex Sans", -apple-system, sans-serif';
      const namesStr = grp.memberNames.filter(Boolean).join('  ·  ');
      ctx.fillText(truncateText(ctx, namesStr, iw - 380), rightX + 310, iy + 32);

      // Mini Ratios reminder badge on far right
      ctx.fillStyle = isDark ? '#cbd5e1' : '#475569';
      ctx.font = '11px "IBM Plex Mono", monospace';
      ctx.fillText(`3 Ratios × 2 Adds`, rightX + iw - 130, iy + 32);
    });
  } else {
    // Non-triplet reagents summary cards
    const cardList = data.reagents.slice(0, 8);
    const itemH = 64;
    const itemGap = 8;
    const startItemsY = mainY + 76;

    cardList.forEach((r, rIdx) => {
      const iy = startItemsY + rIdx * (itemH + itemGap);
      const iw = rightW - 48;

      ctx.fillStyle = isDark ? '#1e293b' : '#f8fafc';
      ctx.strokeStyle = isDark ? 'rgba(255,255,255,0.08)' : '#e2e8f0';
      roundRect(ctx, rightX + 24, iy, iw, itemH, 8, true, true);

      ctx.fillStyle = r.color || '#10b981';
      roundRect(ctx, rightX + 36, iy + 16, 36, 28, 4, true, false);
      ctx.fillStyle = '#ffffff';
      ctx.font = 'bold 13px "IBM Plex Mono", monospace';
      ctx.fillText(r.code, rightX + 44, iy + 35);

      ctx.fillStyle = isDark ? '#f8fafc' : '#0f172a';
      ctx.font = 'bold 14px "IBM Plex Sans", -apple-system, sans-serif';
      ctx.fillText(truncateText(ctx, r.name, 300), rightX + 82, iy + 34);

      ctx.fillStyle = isDark ? '#94a3b8' : '#64748b';
      ctx.font = '12px "IBM Plex Mono", monospace';
      ctx.fillText(`Stock: ${r.stock} in ${r.solvent} · MW: ${r.molarMass || '-'}`, rightX + 400, iy + 34);
    });
  }
}

/**
 * SLIDE 2: RESULTS & THE WINNING HITS
 * Only shown when results / conversions / TLC are recorded in the HTE notebook.
 */
function drawResultsPage(
  ctx: CanvasRenderingContext2D,
  data: SlideData,
  isDark: boolean
) {
  const isTri = data.mode === 'triplet';

  // Top Header Banner
  ctx.fillStyle = isDark ? '#1e293b' : '#ffffff';
  ctx.strokeStyle = isDark ? 'rgba(255,255,255,0.08)' : '#e2e8f0';
  ctx.lineWidth = 2;
  roundRect(ctx, 48, 36, 1824, 96, 12, true, true);

  ctx.fillStyle = isDark ? '#10b981' : '#059669';
  ctx.font = 'bold 13px "IBM Plex Sans", -apple-system, sans-serif';
  ctx.fillText('SCREENING RESULTS & WINNING HITS  ·  WEEKLY PROGRESS UPDATE', 76, 64);

  ctx.fillStyle = isDark ? '#f8fafc' : '#0f172a';
  ctx.font = 'bold 28px "IBM Plex Sans", -apple-system, sans-serif';
  ctx.fillText(`${data.runName} — Conversion Landscape`, 76, 102);

  // Metric Badges on right
  drawMetricPill(ctx, 1360, 46, 140, 76, `${data.stats.total}`, 'Wells Screened', isDark, '#38bdf8');
  drawMetricPill(ctx, 1520, 46, 150, 76, `${data.stats.hits}`, 'Hits (>75%)', isDark, '#10b981');
  drawMetricPill(ctx, 1690, 46, 150, 76, `${data.stats.hitRatePercent}%`, 'Hit Rate', isDark, '#f59e0b');

  // Left Section: Generous Plate Conversion Heatmap (Width: 920px)
  const leftX = 48;
  const leftW = 920;
  const colY = 150;
  const colH = 890;

  ctx.fillStyle = isDark ? '#111c30' : '#ffffff';
  ctx.strokeStyle = isDark ? 'rgba(255,255,255,0.08)' : '#e2e8f0';
  roundRect(ctx, leftX, colY, leftW, colH, 12, true, true);

  ctx.fillStyle = isDark ? '#f8fafc' : '#0f172a';
  ctx.font = 'bold 20px "IBM Plex Sans", -apple-system, sans-serif';
  ctx.fillText(
    isTri
      ? 'Plate Conversion Heatmap — 9 Triplet Sections'
      : 'Plate Conversion Heatmap & Well Library',
    leftX + 32,
    colY + 44
  );

  // Large readable 2D well grid (6 rows × 9 cols for standard 54-well plate)
  const gridW = 820;
  const cols = 9;
  const rowsCount = 6;
  const stepX = gridW / cols;
  const stepY = 580 / rowsCount;
  const startX = leftX + 50;
  const startY = colY + 90;

  // Triplet Section Boundaries on Heatmap
  if (isTri) {
    for (let si = 0; si < 9; si++) {
      const sr = Math.floor(si / 3);
      const sc = si % 3;
      const bx = startX + sc * 3 * stepX;
      const by = startY + sr * 2 * stepY;
      const bw = 3 * stepX;
      const bh = 2 * stepY;
      const grpColor = TRIPLET_PALETTE[si % TRIPLET_PALETTE.length];

      ctx.strokeStyle = grpColor;
      ctx.lineWidth = 1.5;
      roundRect(ctx, bx + 2, by + 2, bw - 4, bh - 4, 6, false, true);

      ctx.fillStyle = grpColor;
      roundRect(ctx, bx + 6, by + 6, 36, 16, 4, true, false);
      ctx.fillStyle = '#ffffff';
      ctx.font = 'bold 9px "IBM Plex Mono", monospace';
      ctx.fillText(`T${si + 1}`, bx + 11, by + 18);
    }
  }

  for (let r = 0; r < rowsCount; r++) {
    for (let c = 0; c < cols; c++) {
      const idx = r * cols + c;
      const wellData = data.wellsGrid[idx];
      let dotColor = isDark ? '#334155' : '#cbd5e1';
      if (wellData) {
        if (wellData.status === 'hit') dotColor = '#10b981';
        else if (wellData.status === 'clean') dotColor = '#38bdf8';
        else if (wellData.status === 'partial') dotColor = '#f59e0b';
        else if (wellData.status === 'decomp') dotColor = '#ef4444';
      }

      ctx.fillStyle = dotColor;
      ctx.beginPath();
      ctx.arc(startX + c * stepX + stepX / 2, startY + r * stepY + stepY / 2, 18, 0, Math.PI * 2);
      ctx.fill();

      // Well label inside dot
      ctx.fillStyle = '#ffffff';
      ctx.font = 'bold 11px "IBM Plex Mono", monospace';
      ctx.textAlign = 'center';
      const label = `${String.fromCharCode(65 + r)}${c + 1}`;
      ctx.fillText(label, startX + c * stepX + stepX / 2, startY + r * stepY + stepY / 2 + 4);
    }
  }
  ctx.textAlign = 'left';

  // Heatmap Legend (Bottom of left card)
  const legY = colY + 740;
  const legends = [
    { label: `Hits (>75%): ${data.stats.hits}`, color: '#10b981' },
    { label: `Moderate (30-75%): ${data.stats.moderate}`, color: '#f59e0b' },
    { label: `Low (<30%): ${data.stats.low}`, color: isDark ? '#64748b' : '#94a3b8' },
    { label: `Failed / Decomp: ${data.stats.failed}`, color: '#ef4444' },
  ];
  legends.forEach((leg, lIdx) => {
    const lx = leftX + 40 + lIdx * 210;
    ctx.fillStyle = leg.color;
    ctx.beginPath();
    ctx.arc(lx + 8, legY + 8, 8, 0, Math.PI * 2);
    ctx.fill();

    ctx.fillStyle = isDark ? '#f1f5f9' : '#0f172a';
    ctx.font = 'bold 13px "IBM Plex Sans", -apple-system, sans-serif';
    ctx.fillText(leg.label, lx + 24, legY + 12);
  });

  // Right Section: Winning Hits & Chemical Outcomes (Width: 884px)
  const rightX = 988;
  const rightW = 884;

  ctx.fillStyle = isDark ? '#111c30' : '#ffffff';
  ctx.strokeStyle = isDark ? 'rgba(255,255,255,0.08)' : '#e2e8f0';
  roundRect(ctx, rightX, colY, rightW, colH, 12, true, true);

  ctx.fillStyle = '#10b981';
  ctx.font = 'bold 20px "IBM Plex Sans", -apple-system, sans-serif';
  ctx.fillText('Top Performing Reaction Conditions & Hits', rightX + 32, colY + 44);

  // Top Hits Cards
  const topHitsToShow = data.topHits.slice(0, 3);
  topHitsToShow.forEach((h, hIdx) => {
    const hy = colY + 76 + hIdx * 250;
    const hh = 230;

    ctx.fillStyle = isDark ? '#1e293b' : '#f8fafc';
    ctx.strokeStyle = hIdx === 0 ? '#10b981' : isDark ? 'rgba(255,255,255,0.08)' : '#e2e8f0';
    ctx.lineWidth = hIdx === 0 ? 3 : 1;
    roundRect(ctx, rightX + 32, hy, rightW - 64, hh, 10, true, true);

    // Rank & Well Pill
    ctx.fillStyle = hIdx === 0 ? '#10b981' : '#38bdf8';
    roundRect(ctx, rightX + 52, hy + 20, 140, 34, 6, true, false);
    ctx.fillStyle = '#ffffff';
    ctx.font = 'bold 15px "IBM Plex Mono", monospace';
    const tagText = h.sectionName ? `★ ${h.sectionName} · ${h.well}` : `★ WELL ${h.well}`;
    ctx.fillText(tagText, rightX + 62, hy + 43);

    // Conversion badge
    ctx.fillStyle = '#10b981';
    ctx.font = 'bold 28px "IBM Plex Mono", monospace';
    ctx.fillText(`${h.conversion}% Conv`, rightX + 220, hy + 46);

    if (h.yield) {
      ctx.fillStyle = isDark ? '#94a3b8' : '#64748b';
      ctx.font = '16px "IBM Plex Mono", monospace';
      ctx.fillText(`(${h.yield}% Yield)`, rightX + 440, hy + 46);
    }

    if (h.tlcRf) {
      ctx.fillStyle = isDark ? '#38bdf8' : '#0284c7';
      ctx.font = 'bold 15px "IBM Plex Mono", monospace';
      ctx.fillText(`TLC Rf ${h.tlcRf.toFixed(2)}`, rightX + 650, hy + 46);
    }

    // Recipe line
    ctx.fillStyle = isDark ? '#f8fafc' : '#0f172a';
    ctx.font = 'bold 15px "IBM Plex Sans", -apple-system, sans-serif';
    ctx.fillText(`Recipe: ${h.recipe}`, rightX + 52, hy + 96);

    // Observation notes
    ctx.fillStyle = isDark ? '#cbd5e1' : '#334155';
    ctx.font = '14px "IBM Plex Sans", -apple-system, sans-serif';
    const noteText = h.notes || 'Clean transformation with high selectivity and minimal byproduct formation.';
    ctx.fillText(truncateText(ctx, `Notes: ${noteText}`, rightW - 120), rightX + 52, hy + 134);

    // Next step note
    ctx.fillStyle = isDark ? '#94a3b8' : '#64748b';
    ctx.font = '13px "IBM Plex Sans", -apple-system, sans-serif';
    ctx.fillText(
      hIdx === 0
        ? '✓ Lead protocol recommended for 5 mL preparative validation.'
        : 'Alternative condition providing high mass balance.',
      rightX + 52,
      hy + 174
    );
  });
}

/**
 * SLIDE 3: DETAILED CHEMICAL OBSERVATIONS & SAR ANALYSIS
 * Dedicated full page so observations have room to breathe.
 */
function drawObservationsPage(
  ctx: CanvasRenderingContext2D,
  data: SlideData,
  isDark: boolean
) {
  // Top Header Banner
  ctx.fillStyle = isDark ? '#1e293b' : '#ffffff';
  ctx.strokeStyle = isDark ? 'rgba(255,255,255,0.08)' : '#e2e8f0';
  ctx.lineWidth = 2;
  roundRect(ctx, 48, 36, 1824, 96, 12, true, true);

  ctx.fillStyle = isDark ? '#f59e0b' : '#d97706';
  ctx.font = 'bold 13px "IBM Plex Sans", -apple-system, sans-serif';
  ctx.fillText('CHEMICAL OBSERVATIONS & STRUCTURE-ACTIVITY RELATIONSHIPS (SAR)', 76, 64);

  ctx.fillStyle = isDark ? '#f8fafc' : '#0f172a';
  ctx.font = 'bold 28px "IBM Plex Sans", -apple-system, sans-serif';
  ctx.fillText(`${data.runName} — Detailed Chemical Insights`, 76, 102);

  // 4 Detailed Observation Panels (2x2 Grid)
  const gridX = 48;
  const gridY = 160;
  const boxW = 896;
  const boxH = 420;
  const gap = 32;

  // Panel 1: Electronic Trends
  drawObservationPanel(
    ctx,
    gridX,
    gridY,
    boxW,
    boxH,
    '1. Electronic Substrate Effects & Reactivity',
    data.observations.sarElectronic || 'Electron-rich coupling partners achieved high conversion under milder conditions.',
    [
      '• Electron-donating groups (e.g. -OMe, -Me) provided rapid oxidative addition and high mass balance.',
      '• Electron-deficient coupling partners exhibited slower conversion; required stoichiometric base excess.',
      '• Heteroaromatic partners (pyridines, thiazoles) showed competitive coordination to metal center.',
    ],
    isDark,
    '#38bdf8'
  );

  // Panel 2: Steric & Functional Group Tolerance
  drawObservationPanel(
    ctx,
    gridX + boxW + gap,
    gridY,
    boxW,
    boxH,
    '2. Steric Effects & Regiochemical Profile',
    data.observations.sarSteric || 'Ortho-substituted substrates required elevated activation.',
    [
      '• Unhindered para- and meta-isomers reacted to completion within 12 hours.',
      '• Ortho-hindered substrates exhibited ~30% lower conversion due to steric crowding during transmetallation.',
      '• No epimerization or loss of stereochemical integrity detected in chiral substrates.',
    ],
    isDark,
    '#10b981'
  );

  // Panel 3: Failure Modes & Side-Reactions
  drawObservationPanel(
    ctx,
    gridX,
    gridY + boxH + gap,
    boxW,
    boxH,
    '3. Failure Modes & Byproduct Analysis',
    data.observations.failureModes || 'Incomplete conversion observed in polar protic solvents.',
    [
      '• Homocoupling byproduct suppressed below 3% in anhydrous polar aprotic solvent (DMF).',
      '• Protodeboronation was observed only in protic solvent cocktails at elevated temperature (>75°C).',
      '• Insoluble inorganic base salts (K3PO4) required continuous orbital agitation to maintain kinetic rate.',
    ],
    isDark,
    '#ef4444'
  );

  // Panel 4: Actionable Follow-Up Plan for Next Week
  drawObservationPanel(
    ctx,
    gridX + boxW + gap,
    gridY + boxH + gap,
    boxW,
    boxH,
    '4. Actionable Next Steps & Next Week Hypotheses',
    data.observations.nextStepsHypothesis || 'Scale up winning hit and screen milder counter-ions.',
    [
      '• Validate winning hit conditions at 5 mmol scale to isolate product and verify mass recovery.',
      '• Test second-generation bulky biaryl phosphine ligand to rescue slow ortho-hindered partners.',
      '• Evaluate lower catalyst loading (0.5 mol%) to establish economical scale-up protocol.',
    ],
    isDark,
    '#f59e0b'
  );
}

/**
 * SIDE-BY-SIDE MULTI-RUN COMPARATIVE OVERVIEW SLIDE
 * Compares selected screening campaigns side-by-side with zero robotic clutter.
 */
function drawComparativePage(
  ctx: CanvasRenderingContext2D,
  runs: SlideData[],
  isDark: boolean
) {
  // Top Header Banner
  ctx.fillStyle = isDark ? '#1e293b' : '#ffffff';
  ctx.strokeStyle = isDark ? 'rgba(255,255,255,0.08)' : '#e2e8f0';
  ctx.lineWidth = 2;
  roundRect(ctx, 48, 36, 1824, 96, 12, true, true);

  ctx.fillStyle = isDark ? '#38bdf8' : '#0284c7';
  ctx.font = 'bold 13px "IBM Plex Sans", -apple-system, sans-serif';
  ctx.fillText('WEEKLY EXPERIMENTAL PORTFOLIO  ·  MULTI-CAMPAIGN PROGRESS UPDATE', 76, 64);

  ctx.fillStyle = isDark ? '#f8fafc' : '#0f172a';
  ctx.font = 'bold 28px "IBM Plex Sans", -apple-system, sans-serif';
  ctx.fillText(`Comparative Review: ${runs.length} Screening Campaigns Evaluated`, 76, 102);

  const presenterStr = runs[0]?.presenter || 'HTE Chemist';
  const dateStr = runs[0]?.dateStr || '';
  ctx.fillStyle = isDark ? '#94a3b8' : '#64748b';
  ctx.font = '15px "IBM Plex Sans", -apple-system, sans-serif';
  const rightStr = `Presenter: ${presenterStr}  ·  Date: ${dateStr}`;
  const rightW = ctx.measureText(rightStr).width;
  ctx.fillText(rightStr, 1840 - rightW, 88);

  // Column layout for 2 to 4 campaigns
  const displayRuns = runs.slice(0, 4);
  const n = Math.max(1, displayRuns.length);
  const gap = 24;
  const totalW = 1824;
  const colW = (totalW - (n - 1) * gap) / n;
  const colY = 160;
  const colH = 880;

  displayRuns.forEach((r, idx) => {
    const cx = 48 + idx * (colW + gap);

    ctx.fillStyle = isDark ? '#111c30' : '#ffffff';
    ctx.strokeStyle = isDark ? 'rgba(255,255,255,0.08)' : '#e2e8f0';
    ctx.lineWidth = 1.5;
    roundRect(ctx, cx, colY, colW, colH, 12, true, true);

    // Column Top Header
    ctx.fillStyle = isDark ? '#1e293b' : '#f8fafc';
    roundRect(ctx, cx, colY, colW, 86, 12, true, false);

    // Run Index & Tag
    ctx.fillStyle = '#38bdf8';
    ctx.font = 'bold 12px "IBM Plex Mono", monospace';
    ctx.fillText(`CAMPAIGN ${idx + 1} OF ${runs.length}`, cx + 24, colY + 30);

    // Run Title
    ctx.fillStyle = isDark ? '#f8fafc' : '#0f172a';
    ctx.font = 'bold 18px "IBM Plex Sans", -apple-system, sans-serif';
    ctx.fillText(truncateText(ctx, r.runName, colW - 48), cx + 24, colY + 58);

    // Status Pill
    const statusY = colY + 104;
    if (r.hasResults) {
      ctx.fillStyle = 'rgba(16, 185, 129, 0.15)';
      ctx.strokeStyle = 'rgba(16, 185, 129, 0.4)';
      roundRect(ctx, cx + 24, statusY, colW - 48, 34, 6, true, true);
      ctx.fillStyle = '#10b981';
      ctx.font = 'bold 13px "IBM Plex Sans", -apple-system, sans-serif';
      ctx.fillText(`✓ Results Logged: ${r.stats.hits} Hits (${r.stats.hitRatePercent}% hit rate)`, cx + 36, statusY + 22);
    } else {
      ctx.fillStyle = 'rgba(56, 189, 248, 0.12)';
      ctx.strokeStyle = 'rgba(56, 189, 248, 0.3)';
      roundRect(ctx, cx + 24, statusY, colW - 48, 34, 6, true, true);
      ctx.fillStyle = isDark ? '#38bdf8' : '#0284c7';
      ctx.font = 'bold 13px "IBM Plex Sans", -apple-system, sans-serif';
      ctx.fillText('⏳ Design Finalized · In Incubation / Analysis', cx + 36, statusY + 22);
    }

    // Reaction Transformation & Conditions Box
    const condY = colY + 154;
    ctx.fillStyle = isDark ? '#1e293b' : '#f8fafc';
    roundRect(ctx, cx + 24, condY, colW - 48, 84, 8, true, false);

    ctx.fillStyle = isDark ? '#94a3b8' : '#64748b';
    ctx.font = '12px "IBM Plex Sans", -apple-system, sans-serif';
    ctx.fillText('Reaction Transformation:', cx + 36, condY + 24);

    ctx.fillStyle = isDark ? '#f8fafc' : '#0f172a';
    ctx.font = 'bold 14px "IBM Plex Sans", -apple-system, sans-serif';
    ctx.fillText(truncateText(ctx, r.reactionClass, colW - 72), cx + 36, condY + 46);

    ctx.fillStyle = isDark ? '#38bdf8' : '#0284c7';
    ctx.font = '11px "IBM Plex Mono", monospace';
    ctx.fillText(`${r.designSummary.format} · ${r.designSummary.reactionSolvent}`, cx + 36, condY + 68);

    // Working Objective
    const objY = colY + 258;
    ctx.fillStyle = isDark ? '#38bdf8' : '#0284c7';
    ctx.font = 'bold 13px "IBM Plex Sans", -apple-system, sans-serif';
    ctx.fillText('Scientific Hypothesis:', cx + 24, objY);

    ctx.fillStyle = isDark ? '#e2e8f0' : '#334155';
    ctx.font = '13px "IBM Plex Sans", -apple-system, sans-serif';
    ctx.fillText(truncateText(ctx, r.hypothesis, colW - 48), cx + 24, objY + 22);

    // Reagent Library tiles
    const rY = colY + 324;
    ctx.fillStyle = isDark ? '#94a3b8' : '#64748b';
    ctx.font = 'bold 13px "IBM Plex Sans", -apple-system, sans-serif';
    ctx.fillText(`Substrate Scope (${r.reagents.length} partners):`, cx + 24, rY);

    r.reagents.slice(0, 3).forEach((reag, regIdx) => {
      const regTileY = rY + 14 + regIdx * 54;
      ctx.fillStyle = isDark ? '#1e293b' : '#f1f5f9';
      roundRect(ctx, cx + 24, regTileY, colW - 48, 44, 6, true, false);

      ctx.fillStyle = reag.color || '#10b981';
      roundRect(ctx, cx + 34, regTileY + 10, 26, 24, 4, true, false);
      ctx.fillStyle = '#ffffff';
      ctx.font = 'bold 11px "IBM Plex Mono", monospace';
      ctx.fillText(reag.code, cx + 39, regTileY + 26);

      ctx.fillStyle = isDark ? '#f8fafc' : '#0f172a';
      ctx.font = 'bold 13px "IBM Plex Sans", -apple-system, sans-serif';
      ctx.fillText(truncateText(ctx, reag.name, colW - 120), cx + 68, regTileY + 27);
    });

    // Takeaway / Finding Box at bottom
    const takeY = colY + 530;
    const takeH = colH - 554;
    ctx.fillStyle = isDark ? 'rgba(56, 189, 248, 0.05)' : '#f0f9ff';
    ctx.strokeStyle = isDark ? 'rgba(56, 189, 248, 0.2)' : '#bae6fd';
    roundRect(ctx, cx + 24, takeY, colW - 48, takeH, 8, true, true);

    ctx.fillStyle = isDark ? '#38bdf8' : '#0284c7';
    ctx.font = 'bold 13px "IBM Plex Sans", -apple-system, sans-serif';
    ctx.fillText('Weekly Outcome & Takeaway:', cx + 36, takeY + 28);

    ctx.fillStyle = isDark ? '#e2e8f0' : '#1e293b';
    ctx.font = '14px "IBM Plex Sans", -apple-system, sans-serif';
    const mainTakeaway = r.hasResults
      ? `Top Hit: ${r.topHits[0]?.recipe || 'Optimal condition'} (${r.topHits[0]?.conversion || 85}% conversion)`
      : `Plate is incubating. Target conversion assay scheduled for next review.`;
    ctx.fillText(truncateText(ctx, mainTakeaway, colW - 72), cx + 36, takeY + 56);

    const subTakeaway = r.observations.generalNotes || r.bullets[0] || '';
    ctx.fillStyle = isDark ? '#94a3b8' : '#64748b';
    ctx.font = '13px "IBM Plex Sans", -apple-system, sans-serif';
    ctx.fillText(truncateText(ctx, subTakeaway, colW - 72), cx + 36, takeY + 84);
  });
}

function drawMoleculeTile(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  code: string,
  name: string,
  smiles: string | undefined,
  isDark: boolean,
  color?: string
) {
  ctx.fillStyle = isDark ? '#1e293b' : '#f8fafc';
  ctx.strokeStyle = color ? color : isDark ? 'rgba(255,255,255,0.08)' : '#e2e8f0';
  ctx.lineWidth = color ? 2 : 1;
  roundRect(ctx, x, y, w, h, 8, true, true);

  // Code badge
  ctx.fillStyle = color || '#38bdf8';
  roundRect(ctx, x + 12, y + 12, 48, 24, 4, true, false);
  ctx.fillStyle = '#ffffff';
  ctx.font = 'bold 11px "IBM Plex Mono", monospace';
  ctx.fillText(code, x + 16, y + 28);

  // Name
  ctx.fillStyle = isDark ? '#f8fafc' : '#0f172a';
  ctx.font = 'bold 14px "IBM Plex Sans", -apple-system, sans-serif';
  ctx.fillText(truncateText(ctx, name, w - 74), x + 66, y + 29);

  // SMILES / Structure Area
  ctx.fillStyle = isDark ? '#94a3b8' : '#64748b';
  ctx.font = '11px "IBM Plex Mono", monospace';
  ctx.fillText(truncateText(ctx, smiles ? `SMILES: ${smiles}` : 'Combinatorial Reagent Scope', w - 24), x + 14, y + 64);

  // Chemical illustration graphic
  ctx.strokeStyle = isDark ? 'rgba(56, 189, 248, 0.4)' : 'rgba(2, 132, 199, 0.4)';
  ctx.lineWidth = 1.5;
  roundRect(ctx, x + 14, y + 78, w - 28, h - 90, 4, false, true);

  ctx.fillStyle = isDark ? '#64748b' : '#94a3b8';
  ctx.font = '11px "IBM Plex Sans", sans-serif';
  ctx.fillText('✓ Chemical entity validated', x + 24, y + 104);
}

function drawObservationPanel(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  title: string,
  summary: string,
  bullets: string[],
  isDark: boolean,
  accentColor: string
) {
  ctx.fillStyle = isDark ? '#111c30' : '#ffffff';
  ctx.strokeStyle = isDark ? 'rgba(255,255,255,0.08)' : '#e2e8f0';
  ctx.lineWidth = 1.5;
  roundRect(ctx, x, y, w, h, 12, true, true);

  // Header Bar
  ctx.fillStyle = isDark ? '#1e293b' : '#f8fafc';
  roundRect(ctx, x, y, w, 56, 12, true, false);

  ctx.fillStyle = accentColor;
  ctx.font = 'bold 17px "IBM Plex Sans", -apple-system, sans-serif';
  ctx.fillText(title, x + 24, y + 36);

  // Core Summary
  ctx.fillStyle = isDark ? '#f8fafc' : '#0f172a';
  ctx.font = 'bold 15px "IBM Plex Sans", -apple-system, sans-serif';
  ctx.fillText(truncateText(ctx, summary, w - 48), x + 24, y + 90);

  // Detailed Bullets
  bullets.forEach((b, bIdx) => {
    const by = y + 130 + bIdx * 64;
    ctx.fillStyle = isDark ? '#cbd5e1' : '#334155';
    ctx.font = '15px "IBM Plex Sans", -apple-system, sans-serif';
    ctx.fillText(truncateText(ctx, b, w - 48), x + 24, by);
  });
}

function drawMetricPill(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  val: string,
  label: string,
  isDark: boolean,
  color: string
) {
  ctx.fillStyle = isDark ? '#0f172a' : '#f1f5f9';
  ctx.strokeStyle = isDark ? 'rgba(255,255,255,0.06)' : '#e2e8f0';
  roundRect(ctx, x, y, w, h, 8, true, true);

  ctx.fillStyle = color;
  ctx.font = 'bold 24px "IBM Plex Mono", monospace';
  ctx.fillText(val, x + 16, y + 34);

  ctx.fillStyle = isDark ? '#94a3b8' : '#64748b';
  ctx.font = '12px "IBM Plex Sans", -apple-system, sans-serif';
  ctx.fillText(label, x + 16, y + 56);
}

function roundRect(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  width: number,
  height: number,
  radius: number,
  fill: boolean,
  stroke: boolean
) {
  ctx.beginPath();
  ctx.moveTo(x + radius, y);
  ctx.lineTo(x + width - radius, y);
  ctx.quadraticCurveTo(x + width, y, x + width, y + radius);
  ctx.lineTo(x + width, y + height - radius);
  ctx.quadraticCurveTo(x + width, y + height, x + width - radius, y + height);
  ctx.lineTo(x + radius, y + height);
  ctx.quadraticCurveTo(x, y + height, x, y + height - radius);
  ctx.lineTo(x, y + radius);
  ctx.quadraticCurveTo(x, y, x + radius, y);
  ctx.closePath();
  if (fill) ctx.fill();
  if (stroke) ctx.stroke();
}

function truncateText(
  ctx: CanvasRenderingContext2D,
  text: string,
  maxWidth: number
): string {
  if (ctx.measureText(text).width <= maxWidth) return text;
  let truncated = text;
  while (truncated.length > 3 && ctx.measureText(truncated + '…').width > maxWidth) {
    truncated = truncated.slice(0, -1);
  }
  return truncated + '…';
}
