import { describe, it, expect } from 'vitest';
import { TLC_SOLVENT_LIBRARY } from '../src/engine/predictor/tlcSolventAdvisor';

describe('TLC solvent library tiers', () => {
  it('every ratio rung of a workhorse family (EtOAc/Hex, MeOH/DCM, with Et3N/NH3/AcOH) has the same tier', () => {
    // "Prefer workhorse eluents" must pick the family, not a particular ratio rung. A rung that is
    // secondary only because of how it was entered makes the two preference modes disagree about ratios.
    for (const fam of ['etoac_hex', 'meoh_dcm', 'basic_mod', 'acid_mod']) {
      const rungs = TLC_SOLVENT_LIBRARY.filter((s) => s.stationaryPhase === 'SiO2' && s.family === fam);
      expect(rungs.length).toBeGreaterThan(0);
      expect(new Set(rungs.map((s) => s.preferenceTier)), fam).toEqual(new Set(['primary']));
    }
  });
});
