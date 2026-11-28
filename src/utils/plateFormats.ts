import type { RobotPlatePreset } from '../engine/predictor/backendClient';

export const ROW_LETTERS = 'ABCDEFGHIJKLMNOP';

export interface PlateFormatOption {
  id: string;
  name: string;
  plateSlot: 0 | 1 | 2;
  rows: number;
  cols: number;
  defaultZ: number;
  isBuiltIn: boolean;
  preset?: RobotPlatePreset;
}

export interface CornerGeometryCheck {
  valid: boolean;
  colPitchMm: number;
  rowPitchMm: number;
  angleDeg: number;
  oppositeCornerXY: [number, number];
  oppositeLabel: string;
  expectedStandardPitchMm: number | null;
  pitchStatus: 'ok' | 'warn' | 'invalid';
  pitchNote: string;
}

export function rowLetter(rowIdx: number): string {
  return ROW_LETTERS[rowIdx] || `R${rowIdx + 1}`;
}

export function formatWellCode(wellIdx: number, cols: number): string {
  const safeCols = Math.max(1, cols);
  const r = Math.floor(wellIdx / safeCols);
  const c = (wellIdx % safeCols) + 1;
  return `${rowLetter(r)}${c}`;
}

export function buildPlateFormatOptions(
  plateSlot: 0 | 1 | 2,
  presets: RobotPlatePreset[] = []
): PlateFormatOption[] {
  const opts: PlateFormatOption[] = [
    {
      id: 'default_54',
      name: '54-vial rack (6×9 · built-in)',
      plateSlot,
      rows: 6,
      cols: 9,
      defaultZ: 2100,
      isBuiltIn: true,
    },
  ];
  for (const p of presets) {
    if (p.plateSlot === plateSlot) {
      opts.push({
        id: p.id,
        name: `${p.name} (${p.rows}×${p.cols})`,
        plateSlot,
        rows: p.rows,
        cols: p.cols,
        defaultZ: p.defaultZ,
        isBuiltIn: false,
        preset: p,
      });
    }
  }
  return opts;
}

export function resolvePlateFormat(
  plateSlot: 0 | 1 | 2,
  presetId: string,
  presets: RobotPlatePreset[] = []
): PlateFormatOption {
  const list = buildPlateFormatOptions(plateSlot, presets);
  return list.find((o) => o.id === presetId) || list[0];
}

export function analyzeThreeCorners(
  rows: number,
  cols: number,
  a1: [number, number],
  tr: [number, number],
  bl: [number, number]
): CornerGeometryCheck {
  const safeRows = Math.max(1, Math.min(16, Math.round(rows)));
  const safeCols = Math.max(1, Math.min(24, Math.round(cols)));
  const colSpan = Math.hypot(tr[0] - a1[0], tr[1] - a1[1]);
  const rowSpan = Math.hypot(bl[0] - a1[0], bl[1] - a1[1]);
  const colPitchMm = safeCols > 1 ? colSpan / (safeCols - 1) : 0;
  const rowPitchMm = safeRows > 1 ? rowSpan / (safeRows - 1) : 0;

  let angleDeg = 0;
  if (safeCols > 1) {
    const dx = tr[0] - a1[0];
    const dy = tr[1] - a1[1];
    angleDeg =
      Math.abs(dx) >= Math.abs(dy)
        ? (Math.atan2(dy, Math.abs(dx)) * 180) / Math.PI
        : (Math.atan2(dx, Math.abs(dy)) * 180) / Math.PI;
  }

  const oppX = a1[0] + (tr[0] - a1[0]) + (bl[0] - a1[0]);
  const oppY = a1[1] + (tr[1] - a1[1]) + (bl[1] - a1[1]);
  const oppositeLabel = `${rowLetter(safeRows - 1)}${safeCols}`;

  let expectedStandardPitchMm: number | null = null;
  if (safeRows === 8 && safeCols === 12) expectedStandardPitchMm = 9.0;
  else if (safeRows === 4 && safeCols === 6) expectedStandardPitchMm = 19.3;
  else if (safeRows === 6 && safeCols === 8) expectedStandardPitchMm = 13.08;

  const colOk = safeCols <= 1 || (colPitchMm >= 2.0 && colPitchMm <= 80.0);
  const rowOk = safeRows <= 1 || (rowPitchMm >= 2.0 && rowPitchMm <= 80.0);
  const coordsOk =
    [a1[0], a1[1], tr[0], tr[1], bl[0], bl[1]].every(
      (n) => Number.isFinite(n) && n >= -600 && n <= 600
    );

  if (!coordsOk || !colOk || !rowOk) {
    return {
      valid: false,
      colPitchMm,
      rowPitchMm,
      angleDeg,
      oppositeCornerXY: [Number(oppX.toFixed(2)), Number(oppY.toFixed(2))],
      oppositeLabel,
      expectedStandardPitchMm,
      pitchStatus: 'invalid',
      pitchNote:
        'Move to A1, top-right, and bottom-left corners first — well gap must be between 2 and 80 mm.',
    };
  }

  let pitchStatus: 'ok' | 'warn' = 'ok';
  let pitchNote = `Auto-calculated gap: ${colPitchMm.toFixed(2)} mm across × ${rowPitchMm.toFixed(2)} mm down`;
  if (expectedStandardPitchMm !== null) {
    const maxDiff = Math.max(
      Math.abs(colPitchMm - expectedStandardPitchMm),
      Math.abs(rowPitchMm - expectedStandardPitchMm)
    );
    if (maxDiff > 1.0) {
      pitchStatus = 'warn';
      pitchNote = `Standard ${safeRows}×${safeCols} plates are ~${expectedStandardPitchMm} mm, but your corners give ${colPitchMm.toFixed(2)} × ${rowPitchMm.toFixed(2)} mm — double-check corners or dry-run ${oppositeLabel}.`;
    } else {
      pitchNote = `Matches standard ${safeRows}×${safeCols} spacing (~${expectedStandardPitchMm} mm): ${colPitchMm.toFixed(2)} × ${rowPitchMm.toFixed(2)} mm.`;
    }
  } else if (safeRows > 1 && safeCols > 1 && Math.abs(colPitchMm - rowPitchMm) > 2.5) {
    pitchStatus = 'warn';
    pitchNote = `Row gap (${rowPitchMm.toFixed(2)} mm) and column gap (${colPitchMm.toFixed(2)} mm) differ — verify with a dry-run move to ${oppositeLabel}.`;
  }

  return {
    valid: true,
    colPitchMm,
    rowPitchMm,
    angleDeg,
    oppositeCornerXY: [Number(oppX.toFixed(2)), Number(oppY.toFixed(2))],
    oppositeLabel,
    expectedStandardPitchMm,
    pitchStatus,
    pitchNote,
  };
}

/**
 * Generates ordered destination well indices starting at `startDstIdx`
 * in either row-major (A1, A2, ...) or column-major (A1, B1, ...) order.
 */
export function buildDestinationSequence(
  dstRows: number,
  dstCols: number,
  startDstIdx: number,
  fillOrder: 'row' | 'col'
): number[] {
  const total = dstRows * dstCols;
  const ordered: number[] = [];
  if (fillOrder === 'row') {
    for (let i = 0; i < total; i += 1) ordered.push(i);
  } else {
    for (let c = 0; c < dstCols; c += 1) {
      for (let r = 0; r < dstRows; r += 1) {
        ordered.push(r * dstCols + c);
      }
    }
  }
  const startPos = ordered.indexOf(startDstIdx);
  if (startPos <= 0) return ordered;
  return ordered.slice(startPos);
}

export function buildTransferPairs(
  selectedSrcWells: number[],
  srcRows: number,
  srcCols: number,
  dstRows: number,
  dstCols: number,
  useSamePosition: boolean,
  startDstIdx: number,
  fillOrder: 'row' | 'col'
): {
  pairs: Array<[number, number]>;
  overflowCount: number;
} {
  const sameShape = srcRows === dstRows && srcCols === dstCols;
  if (sameShape && useSamePosition) {
    const pairs: Array<[number, number]> = selectedSrcWells.map((w) => [w, w]);
    return { pairs, overflowCount: 0 };
  }
  const seq = buildDestinationSequence(dstRows, dstCols, startDstIdx, fillOrder);
  const count = Math.min(selectedSrcWells.length, seq.length);
  const pairs: Array<[number, number]> = [];
  for (let i = 0; i < count; i += 1) {
    pairs.push([selectedSrcWells[i], seq[i]]);
  }
  return {
    pairs,
    overflowCount: Math.max(0, selectedSrcWells.length - seq.length),
  };
}
