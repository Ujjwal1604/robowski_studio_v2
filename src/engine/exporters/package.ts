// Robowski Studio - ZIP Bundle Package
import { RunResult } from '../../types';
import { utf8, zipStore } from './zipStore';
import { workbookBytes } from './xlsx';
import { benchSheetHtml, deckSteps, stockSteps } from './benchSheet';
import { stockCsv, loadCsv } from './csv';
import { notebookCardSvg, runCardSvg, runManifest } from './runCard';
import { tlcLaneCsv } from '../tlcLanes';

export function packageBytes(run: RunResult, pngBytes: Uint8Array | null = null): Uint8Array {
  const wb = workbookBytes({}, run);
  const stSteps = stockSteps(run);
  const dkSteps = deckSteps(run);
  const files: Record<string, string | Uint8Array> = {
    'robowski_run.xlsx': wb,
    'bench_sheet.html': utf8(benchSheetHtml(run)),
    'stock_preparation.csv': utf8(stockCsv(run, stSteps)),
    'deck_load_checklist.csv': utf8(loadCsv(dkSteps)),
    'tlc_lane_map.csv': utf8(tlcLaneCsv(run)),
    'notebook_card.svg': utf8(notebookCardSvg(run)),
    'run_card.svg': runCardSvg(run),
  };
  if (pngBytes) files['run_card.png'] = pngBytes;
  files['manifest.json'] = utf8(JSON.stringify(runManifest(run), null, 2));
  return zipStore(files);
}
