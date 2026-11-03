// Robowski Studio - Self-Contained .robowski Experiment Archive
// Bundles full reaction state, robot XLSX, hood bench sheet, and high-res TLC plate photos into one portable file.
import { RunState, RunResult, TlcSet } from '../../types';
import { utf8, zipStore } from './zipStore';
import { unzipStore } from './unzipStore';
import { workbookBytes } from './xlsx';
import { benchSheetHtml, deckSteps, stockSteps } from './benchSheet';
import { stockCsv, loadCsv } from './csv';
import { tlcLaneCsv } from '../tlcLanes';
import { localDate } from '../constants';

export interface RobowskiArchiveManifest {
  format: 'robowski-archive';
  version: number;
  generated_at: string;
  run_name: string;
  run_id: string;
  modalities: {
    recipe: 'complete';
    robot_workbook: 'ready';
    hood_bench_sheet: 'ready';
    tlc: 'ready' | 'pending';
  };
  tlc_status: 'ready' | 'pending';
  tlc_warning: string | null;
  summary: {
    reactions: number;
    plates: number;
    mode: string;
    hood: string;
    vial_volume_uL: number;
    solvent: string;
  };
}

export interface ArchiveTlcImageBlob {
  uid: string;
  key: string;
  name: string;
  blob: Blob;
}

export interface ParsedRobowskiArchive {
  manifest: RobowskiArchiveManifest;
  state: RunState;
  tlcSets: any[];
  tlcImages: ArchiveTlcImageBlob[];
  tlcStatus: 'ready' | 'pending';
  tlcWarning: string | null;
}

/**
 * Serializes a complete experiment run and its TLC data into a .robowski ZIP package.
 */
export async function buildRobowskiArchive(
  state: RunState,
  run: RunResult,
  tlcSets: TlcSet[],
  imageBlobs: ArchiveTlcImageBlob[]
): Promise<Uint8Array> {
  const hasImages = imageBlobs.length > 0;
  const tlcStatus: 'ready' | 'pending' = hasImages ? 'ready' : 'pending';
  const tlcWarning =
    tlcStatus === 'pending'
      ? 'TLC analytical data is not uploaded yet. Reaction was planned/pipetted, but plate photos have not been attached.'
      : null;

  const manifest: RobowskiArchiveManifest = {
    format: 'robowski-archive',
    version: 1,
    generated_at: new Date().toISOString(),
    run_name: state.name || 'Untitled Run',
    run_id: state.id || '',
    modalities: {
      recipe: 'complete',
      robot_workbook: 'ready',
      hood_bench_sheet: 'ready',
      tlc: tlcStatus,
    },
    tlc_status: tlcStatus,
    tlc_warning: tlcWarning,
    summary: {
      reactions: run.reactions,
      plates: run.plates,
      mode: state.mode,
      hood: state.hood,
      vial_volume_uL: run.vialVolume,
      solvent: run.reactionSolvent,
    },
  };

  // Strip non-serializable ImageBitmap instances from TLC sets
  const serializableSets = tlcSets.map((s) => ({
    uid: s.uid,
    name: s.name,
    cfg: s.cfg,
    cfgName: s.cfgName,
    cfgText: s.cfgText,
    frameW: s.frameW,
    frontPx: s.frontPx,
    frontAuto: s.frontAuto,
    imgMeta: Object.entries(s.imgs || {}).map(([k, im]) => ({
      key: k,
      name: im.name,
    })),
  }));

  const wbBytes = workbookBytes({}, run);
  const benchHtml = benchSheetHtml(run, localDate());
  const stCsv = stockCsv(run, stockSteps(run));
  const dkCsv = loadCsv(deckSteps(run));
  const tlcMap = tlcLaneCsv(run);

  const files: Record<string, string | Uint8Array> = {
    'manifest.json': JSON.stringify(manifest, null, 2),
    'run_state.json': JSON.stringify(state, null, 2),
    'robot_instructions.xlsx': wbBytes,
    'bench_sheet.html': benchHtml,
    'deck_load_checklist.csv': dkCsv,
    'stock_preparation.csv': stCsv,
    'tlc/lanes_mapping.csv': tlcMap,
    'tlc/sets_config.json': JSON.stringify(serializableSets, null, 2),
  };

  // Add raw plate images to /tlc/images/
  for (const img of imageBlobs) {
    const safeName = img.name.replace(/[^a-zA-Z0-9._-]/g, '_');
    const path = `tlc/images/${img.uid}__${img.key}__${safeName}`;
    const ab = await img.blob.arrayBuffer();
    files[path] = new Uint8Array(ab);
  }

  return zipStore(files);
}

/**
 * Parses and extracts a .robowski archive package.
 */
export async function parseRobowskiArchive(
  bytes: Uint8Array | ArrayBuffer
): Promise<ParsedRobowskiArchive> {
  const files = await unzipStore(bytes);

  const manifestRaw = files['manifest.json'];
  if (!manifestRaw) {
    throw new Error('Invalid archive: missing manifest.json');
  }

  const manifestText = new TextDecoder().decode(manifestRaw);
  const manifest = JSON.parse(manifestText) as RobowskiArchiveManifest;

  if (manifest.format !== 'robowski-archive') {
    throw new Error('File is not a valid Robowski Studio archive package.');
  }

  const stateRaw = files['run_state.json'];
  if (!stateRaw) {
    throw new Error('Invalid archive: missing run_state.json');
  }
  const stateText = new TextDecoder().decode(stateRaw);
  const state = JSON.parse(stateText) as RunState;

  // Read TLC sets configuration
  let tlcSets: any[] = [];
  if (files['tlc/sets_config.json']) {
    try {
      const setsText = new TextDecoder().decode(files['tlc/sets_config.json']);
      tlcSets = JSON.parse(setsText);
    } catch {
      tlcSets = [];
    }
  }

  // Extract images from /tlc/images/
  const tlcImages: ArchiveTlcImageBlob[] = [];
  for (const [path, data] of Object.entries(files)) {
    if (path.startsWith('tlc/images/')) {
      const parts = path.slice('tlc/images/'.length).split('__');
      if (parts.length >= 3) {
        const uid = parts[0];
        const key = parts[1];
        const name = parts.slice(2).join('__');
        const blob = new Blob([data as any], { type: 'image/png' });
        tlcImages.push({ uid, key, name, blob });
      }
    }
  }

  const tlcStatus = manifest.tlc_status || (tlcImages.length > 0 ? 'ready' : 'pending');
  const tlcWarning = manifest.tlc_warning || (tlcStatus === 'pending' ? 'TLC data not uploaded yet' : null);

  return {
    manifest,
    state,
    tlcSets,
    tlcImages,
    tlcStatus,
    tlcWarning,
  };
}
