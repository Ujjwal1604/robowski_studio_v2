import { describe, it, expect } from 'vitest';
import { EXPERIMENT_PRESETS, applyPresetToState } from '../src/engine/presets';
import { exampleState, dataFor } from '../src/context/runPayload';
import { buildRun } from '../src/engine/dilution';

describe('Experiment Presets', () => {
  it('has valid presets registered', () => {
    expect(EXPERIMENT_PRESETS.length).toBeGreaterThanOrEqual(3);
    const ids = EXPERIMENT_PRESETS.map((p) => p.id);
    expect(ids).toContain('suzuki_miyaura');
    expect(ids).toContain('photoredox_cn');
    expect(ids).toContain('stoichiometry_screen');
  });

  EXPERIMENT_PRESETS.forEach((preset) => {
    it(`builds and runs successfully for preset "${preset.name}"`, () => {
      const base = exampleState();
      const st = applyPresetToState(preset.id, base);
      expect(st.reagents.length).toBeGreaterThanOrEqual(2);

      const payload = dataFor(st);
      const run = buildRun(payload);
      expect(run).toBeDefined();
      expect(run.reactions).toBe(preset.reactions);
      expect(run.blockingIssues).toBe(0);
      expect(run.plates).toBeGreaterThanOrEqual(1);
    });
  });
});
