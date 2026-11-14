import { describe, it, expect } from 'vitest';
import {
  tlcStorageKey,
  parseTlcStorageKey,
  getTlcPlateSlice,
  updateTlcPlateSlice,
  tlcSetPlateImageCount,
  tlcSetPlateHasImages,
  tlcSetHasAnyImages,
  getAllTlcImageKeysForSet,
  serializeTlcSet,
  deserializeTlcSetMeta,
  resolveTlcSetForPlate,
  LANE_FRAME_WIDTH,
} from '../src/engine';
import { buildRobowskiArchive, parseRobowskiArchive } from '../src/engine/exporters/robowskiArchive';
import { buildRun } from '../src/engine/dilution';
import { exampleState } from '../src/context/runPayload';
import type { TlcConfig, TlcSet } from '../src/types';

function makeLaneCfg(tag: number): TlcConfig {
  return {
    rows: 6,
    cols: 9,
    order: 'column',
    originFrac: 0.1,
    frontFrac: 0.9,
    lanes: [
      {
        id: 0,
        row: 0,
        col: 0,
        centerX: 100 + tag,
        centerY: 200 + tag,
        angleDeg: 0,
        width: 14,
        length: 300,
      },
    ],
  };
}

function makeBaseSet(uid = 'set_mp_1'): TlcSet {
  return {
    uid,
    name: '80% EtOAc / 20% Hexanes',
    cfg: makeLaneCfg(0),
    cfgName: 'plate1.csv',
    frameW: LANE_FRAME_WIDTH,
    frontPx: 420,
    frontAuto: {},
    originPx: 40,
    originAuto: {},
    imgs: {
      UV254: { name: 'p1_254.png', bmp: { width: 1000, height: 800 } as ImageBitmap },
    },
    prof: {},
  };
}

describe('Multi-Plate TLC Support (Plates 1, 2, 3)', () => {
  it('maps storage keys backwards-compatibly for Plate 1 and uniquely for Plates 2 & 3', () => {
    expect(tlcStorageKey('UV254', 0)).toBe('UV254');
    expect(tlcStorageKey('UV366', 0)).toBe('UV366');
    expect(tlcStorageKey('White', 0)).toBe('White');

    expect(tlcStorageKey('UV254', 1)).toBe('p1_UV254');
    expect(tlcStorageKey('UV366', 2)).toBe('p2_UV366');
    expect(tlcStorageKey('White', 2)).toBe('p2_White');

    // No double underscore so robowskiArchive splits reliably
    expect(tlcStorageKey('UV254', 1)).not.toContain('__');
    expect(tlcStorageKey('UV366', 2)).not.toContain('__');

    expect(parseTlcStorageKey('UV254')).toEqual({ plateIndex: 0, channel: 'UV254' });
    expect(parseTlcStorageKey('p1_UV254')).toEqual({ plateIndex: 1, channel: 'UV254' });
    expect(parseTlcStorageKey('p2_UV366')).toEqual({ plateIndex: 2, channel: 'UV366' });
  });

  it('stores Plates 1, 2, and 3 photos and calibration independently without overwriting Plate 1', () => {
    let set = makeBaseSet();

    // Update Plate 2 (index 1)
    set = updateTlcPlateSlice(set, 1, {
      imgs: {
        UV254: { name: 'p2_254.png', bmp: { width: 1100, height: 800 } as ImageBitmap },
        UV366: { name: 'p2_366.png', bmp: { width: 1100, height: 800 } as ImageBitmap },
      },
      cfg: makeLaneCfg(20),
      cfgName: 'plate2.csv',
      originPx: 48,
      frontPx: 435,
      edgePicks: [{ row: 0, col: 0, well: 'A1', pos: 150, rf: 0.35 }],
    });

    // Update Plate 3 (index 2)
    set = updateTlcPlateSlice(set, 2, {
      imgs: {
        White: { name: 'p3_vis.png', bmp: { width: 1200, height: 800 } as ImageBitmap },
      },
      cfg: makeLaneCfg(40),
      originPx: 52,
      frontPx: 410,
    });

    const p1 = getTlcPlateSlice(set, 0);
    const p2 = getTlcPlateSlice(set, 1);
    const p3 = getTlcPlateSlice(set, 2);

    // Plate 1 intact
    expect(p1.imgs.UV254?.name).toBe('p1_254.png');
    expect(p1.imgs.UV366).toBeUndefined();
    expect(p1.cfg?.lanes[0].centerX).toBe(100);
    expect(p1.originPx).toBe(40);
    expect(p1.frontPx).toBe(420);

    // Plate 2 isolated
    expect(p2.imgs.UV254?.name).toBe('p2_254.png');
    expect(p2.imgs.UV366?.name).toBe('p2_366.png');
    expect(p2.cfg?.lanes[0].centerX).toBe(120);
    expect(p2.originPx).toBe(48);
    expect(p2.frontPx).toBe(435);
    expect(p2.edgePicks).toHaveLength(1);

    // Plate 3 isolated
    expect(p3.imgs.White?.name).toBe('p3_vis.png');
    expect(p3.imgs.UV254).toBeUndefined();
    expect(p3.cfg?.lanes[0].centerX).toBe(140);
    expect(p3.originPx).toBe(52);
    expect(p3.frontPx).toBe(410);

    // Helpers
    expect(tlcSetPlateImageCount(set, 0)).toBe(1);
    expect(tlcSetPlateImageCount(set, 1)).toBe(2);
    expect(tlcSetPlateImageCount(set, 2)).toBe(1);
    expect(tlcSetPlateHasImages(set, 1)).toBe(true);
    expect(tlcSetHasAnyImages(set)).toBe(true);
    expect(getAllTlcImageKeysForSet(set).sort()).toEqual([
      'UV254',
      'p1_UV254',
      'p1_UV366',
      'p2_White',
    ]);
  });

  it('serializes and deserializes per-plate metadata across Plates 1–3', () => {
    let set = makeBaseSet('set_ser');
    set = updateTlcPlateSlice(set, 1, {
      cfg: makeLaneCfg(25),
      cfgName: 'p2_grid.csv',
      originPx: 45,
      frontPx: 412,
      edgeSettings: { edgeFrac: 0.14, ridgeRadius: 0.45 },
      spotProminence: 0.06,
      imgs: {
        UV366: { name: 'p2_366.png', bmp: { width: 900, height: 700 } as ImageBitmap },
      },
    });
    set = updateTlcPlateSlice(set, 2, {
      originPx: 55,
      frontPx: 405,
    });

    const serialized = serializeTlcSet(set, 0.08);
    const jsonClone = JSON.parse(JSON.stringify(serialized));
    const restored = deserializeTlcSetMeta(jsonClone);

    expect(restored.uid).toBe('set_ser');
    expect(restored.originPx).toBe(40);
    expect(restored.frontPx).toBe(420);

    const rP2 = getTlcPlateSlice(restored, 1);
    expect(rP2.cfgName).toBe('p2_grid.csv');
    expect(rP2.cfg?.lanes[0].centerX).toBe(125);
    expect(rP2.originPx).toBe(45);
    expect(rP2.frontPx).toBe(412);
    expect(rP2.edgeSettings).toEqual({ edgeFrac: 0.14, ridgeRadius: 0.45 });
    expect(rP2.spotProminence).toBe(0.06);

    const rP3 = getTlcPlateSlice(restored, 2);
    expect(rP3.originPx).toBe(55);
    expect(rP3.frontPx).toBe(405);
  });

  it('round-trips multi-plate images and configs inside a .robowski archive', async () => {
    const state = exampleState();
    state.name = '3-Plate Screen';
    const run = buildRun({
      vialVolume: 500,
      threshold: 50,
      dilutionFactor: 5,
      reactionSolvent: 'ethanol',
      leftoverMl: 2,
      reagents: [
        { code: 'R1', stock: 100, min: 20, step: 1, max: 20 },
        { code: 'R2', stock: 100, min: 20, step: 1, max: 20 },
      ],
    });

    let set = makeBaseSet('set_arch');
    set = updateTlcPlateSlice(set, 1, {
      cfg: makeLaneCfg(30),
      originPx: 49,
      frontPx: 430,
      imgs: {
        UV254: { name: 'plate2_254.png', bmp: {} as ImageBitmap },
      },
    });
    set = updateTlcPlateSlice(set, 2, {
      cfg: makeLaneCfg(60),
      originPx: 51,
      frontPx: 418,
      imgs: {
        UV366: { name: 'plate3_366.png', bmp: {} as ImageBitmap },
      },
    });

    const imageBlobs = [
      { uid: 'set_arch', key: tlcStorageKey('UV254', 0), name: 'p1_254.png', blob: new Blob(['P1_DATA']) },
      { uid: 'set_arch', key: tlcStorageKey('UV254', 1), name: 'plate2_254.png', blob: new Blob(['P2_DATA']) },
      { uid: 'set_arch', key: tlcStorageKey('UV366', 2), name: 'plate3_366.png', blob: new Blob(['P3_DATA']) },
    ];

    const archiveBytes = await buildRobowskiArchive(state, run, [set], imageBlobs);
    const parsed = await parseRobowskiArchive(archiveBytes);

    expect(parsed.tlcStatus).toBe('ready');
    expect(parsed.tlcImages).toHaveLength(3);

    const byKey = new Map(parsed.tlcImages.map((img) => [img.key, img]));
    expect(await byKey.get('UV254')!.blob.text()).toBe('P1_DATA');
    expect(await byKey.get('p1_UV254')!.blob.text()).toBe('P2_DATA');
    expect(await byKey.get('p2_UV366')!.blob.text()).toBe('P3_DATA');

    const restoredMeta = deserializeTlcSetMeta(parsed.tlcSets[0]);
    expect(getTlcPlateSlice(restoredMeta, 0).originPx).toBe(40);
    expect(getTlcPlateSlice(restoredMeta, 1).originPx).toBe(49);
    expect(getTlcPlateSlice(restoredMeta, 2).originPx).toBe(51);
  });

  it('resolves the matching plate slice or legacy separate-tab plate set cleanly', () => {
    // Case A: Single set holding Plates 1, 2, and 3
    let multiPlateSet = makeBaseSet('set_multi');
    multiPlateSet = updateTlcPlateSlice(multiPlateSet, 1, {
      cfg: makeLaneCfg(10),
      imgs: { UV254: { name: 'p2.png', bmp: { width: 500, height: 400 } as ImageBitmap } },
    });
    multiPlateSet = updateTlcPlateSlice(multiPlateSet, 2, {
      cfg: makeLaneCfg(20),
      imgs: { UV366: { name: 'p3.png', bmp: { width: 500, height: 400 } as ImageBitmap } },
    });

    expect(resolveTlcSetForPlate([multiPlateSet], 0)?.imgs.UV254?.name).toBe('p1_254.png');
    expect(resolveTlcSetForPlate([multiPlateSet], 1)?.imgs.UV254?.name).toBe('p2.png');
    expect(resolveTlcSetForPlate([multiPlateSet], 2)?.imgs.UV366?.name).toBe('p3.png');

    // Case B: Legacy workaround (separate solvent tabs used for Plate 1 vs Plate 2)
    const legacyTab1 = makeBaseSet('legacy_1');
    const legacyTab2: TlcSet = {
      ...makeBaseSet('legacy_2'),
      imgs: { UV254: { name: 'legacy_p2.png', bmp: { width: 500, height: 400 } as ImageBitmap } },
    };
    expect(resolveTlcSetForPlate([legacyTab1, legacyTab2], 0)?.uid).toBe('legacy_1');
    expect(resolveTlcSetForPlate([legacyTab1, legacyTab2], 1)?.uid).toBe('legacy_2');
  });
});
