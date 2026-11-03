import { describe, it, expect } from 'vitest';
import { buildRobowskiArchive, parseRobowskiArchive } from '../src/engine/exporters/robowskiArchive';
import { unzipStore } from '../src/engine/exporters/unzipStore';
import { zipStore, utf8 } from '../src/engine/exporters/zipStore';
import { buildRun } from '../src/engine/dilution';
import { exampleState } from '../src/context/runPayload';

describe('.robowski Experiment Archive & Extensibility', () => {
  it('correctly creates and reads an uncompressed ZIP with unzipStore', async () => {
    const original = {
      'test.txt': utf8('Hello Robowski Studio'),
      'folder/data.json': utf8(JSON.stringify({ value: 42, active: true })),
    };

    const zipBytes = zipStore(original);
    expect(zipBytes[0]).toBe(0x50);
    expect(zipBytes[1]).toBe(0x4b);

    const extracted = await unzipStore(zipBytes);
    expect(extracted['test.txt']).toBeDefined();
    expect(new TextDecoder().decode(extracted['test.txt'])).toBe('Hello Robowski Studio');

    expect(extracted['folder/data.json']).toBeDefined();
    const parsedJson = JSON.parse(new TextDecoder().decode(extracted['folder/data.json']));
    expect(parsedJson.value).toBe(42);
    expect(parsedJson.active).toBe(true);
  });

  it('packages a run without TLC images and sets status to pending with warning', async () => {
    const state = exampleState();
    state.name = 'Catalyst Screen Pre-Run';
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

    const archiveBytes = await buildRobowskiArchive(state, run, [], []);
    expect(archiveBytes).toBeInstanceOf(Uint8Array);
    expect(archiveBytes.length).toBeGreaterThan(500);

    const parsed = await parseRobowskiArchive(archiveBytes);
    expect(parsed.manifest.format).toBe('robowski-archive');
    expect(parsed.manifest.version).toBe(1);
    expect(parsed.manifest.run_name).toBe('Catalyst Screen Pre-Run');
    expect(parsed.tlcStatus).toBe('pending');
    expect(parsed.tlcWarning).toContain('TLC analytical data is not uploaded yet');
    expect(parsed.manifest.modalities.recipe).toBe('complete');
    expect(parsed.manifest.modalities.robot_workbook).toBe('ready');
    expect(parsed.manifest.modalities.tlc).toBe('pending');
    expect(parsed.tlcImages.length).toBe(0);
  });

  it('packages a run with high-resolution TLC images and restores them intact', async () => {
    const state = exampleState();
    state.name = 'Catalyst Screen Complete';
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

    const mockImageBlob = new Blob(['PNG_MOCK_IMAGE_DATA_UV254'], { type: 'image/png' });
    const imageBlobs = [
      {
        uid: 'set_123',
        key: 'UV254',
        name: 'plate1_254nm.png',
        blob: mockImageBlob,
      },
    ];

    const mockTlcSets = [
      {
        uid: 'set_123',
        name: 'Hexane:EtOAc 4:1',
        cfg: null,
        cfgName: 'lanes.csv',
        frameW: 540,
        frontPx: 420,
        imgs: {
          UV254: { name: 'plate1_254nm.png', bmp: {} as any },
        },
      },
    ];

    const archiveBytes = await buildRobowskiArchive(state, run, mockTlcSets as any, imageBlobs);
    const parsed = await parseRobowskiArchive(archiveBytes);

    expect(parsed.tlcStatus).toBe('ready');
    expect(parsed.tlcWarning).toBeNull();
    expect(parsed.manifest.modalities.tlc).toBe('ready');
    expect(parsed.tlcImages.length).toBe(1);
    expect(parsed.tlcImages[0].uid).toBe('set_123');
    expect(parsed.tlcImages[0].key).toBe('UV254');
    expect(parsed.tlcImages[0].name).toBe('plate1_254nm.png');

    const imageText = await parsed.tlcImages[0].blob.text();
    expect(imageText).toBe('PNG_MOCK_IMAGE_DATA_UV254');
  });
});
