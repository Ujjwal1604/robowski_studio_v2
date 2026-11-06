import { describe, it, expect } from 'vitest';
import { parseWellQuery } from '../src/components/ui/CommandPalette';
import { wellLabel, tlcLane, containerOfLane } from '../src/engine/tlcLanes';

describe('Well Coordinate Direct Jump Parser', () => {
  it('parses standard uppercase well coordinates (A1, B4, F9)', () => {
    const a1 = parseWellQuery('A1');
    expect(a1).not.toBeNull();
    expect(a1?.wellIndex).toBe(0);
    expect(a1?.label).toBe('A1');
    expect(a1?.rowLetter).toBe('A');
    expect(a1?.colNum).toBe(1);
    expect(a1?.reactionNumber).toBe(1);

    const b4 = parseWellQuery('B4');
    expect(b4).not.toBeNull();
    // Row B is idx 1, Col 4 is idx 3: 1 * 9 + 3 = 12
    expect(b4?.wellIndex).toBe(12);
    expect(b4?.label).toBe('B4');
    expect(b4?.reactionNumber).toBe(13);

    const f9 = parseWellQuery('F9');
    expect(f9).not.toBeNull();
    // Row F is idx 5, Col 9 is idx 8: 5 * 9 + 8 = 53
    expect(f9?.wellIndex).toBe(53);
    expect(f9?.label).toBe('F9');
    expect(f9?.reactionNumber).toBe(54);
  });

  it('handles lowercase coordinates (a1, b4, f9)', () => {
    const a1 = parseWellQuery('a1');
    expect(a1?.wellIndex).toBe(0);
    expect(a1?.label).toBe('A1');

    const b4 = parseWellQuery('b4');
    expect(b4?.wellIndex).toBe(12);
    expect(b4?.label).toBe('B4');

    const f9 = parseWellQuery('f9');
    expect(f9?.wellIndex).toBe(53);
    expect(f9?.label).toBe('F9');
  });

  it('handles spaced and padded coordinates (A 1, A-1, a01, B 04, F09)', () => {
    const a1Spaced = parseWellQuery('A 1');
    expect(a1Spaced?.wellIndex).toBe(0);
    expect(a1Spaced?.label).toBe('A1');

    const a1Padded = parseWellQuery('a01');
    expect(a1Padded?.wellIndex).toBe(0);
    expect(a1Padded?.label).toBe('A1');

    const b4Hyphen = parseWellQuery('B-4');
    expect(b4Hyphen?.wellIndex).toBe(12);

    const f9Padded = parseWellQuery('F09');
    expect(f9Padded?.wellIndex).toBe(53);
    expect(f9Padded?.label).toBe('F9');
  });

  it('handles "well" prefix (well A1, well b4, Well F9)', () => {
    const w1 = parseWellQuery('well A1');
    expect(w1?.wellIndex).toBe(0);

    const w2 = parseWellQuery('well b4');
    expect(w2?.wellIndex).toBe(12);

    const w3 = parseWellQuery('Well F9');
    expect(w3?.wellIndex).toBe(53);
  });

  it('handles plate-specific prefixes (Plate 1 A1, P1 A1, Plate 2 B4, P2 C3)', () => {
    const p1 = parseWellQuery('Plate 1 A1');
    expect(p1?.plateIndex).toBe(0);
    expect(p1?.wellIndex).toBe(0);
    expect(p1?.globalIndex).toBe(0);
    expect(p1?.reactionNumber).toBe(1);

    const p2 = parseWellQuery('Plate 2 B4');
    expect(p2?.plateIndex).toBe(1);
    expect(p2?.wellIndex).toBe(12);
    expect(p2?.globalIndex).toBe(54 + 12);
    expect(p2?.reactionNumber).toBe(67);

    const p2Short = parseWellQuery('P2 C3');
    expect(p2Short?.plateIndex).toBe(1);
    expect(p2Short?.label).toBe('C3');
  });

  it('handles reaction numbering queries (Reaction 1, rxn 13, r25, #10)', () => {
    const rxn1 = parseWellQuery('Reaction 1');
    expect(rxn1?.globalIndex).toBe(0);
    expect(rxn1?.wellIndex).toBe(0);
    expect(rxn1?.label).toBe('A1');

    const rxn13 = parseWellQuery('rxn 13');
    expect(rxn13?.globalIndex).toBe(12);
    expect(rxn13?.wellIndex).toBe(12);
    expect(rxn13?.label).toBe('B4');

    const rxnHash = parseWellQuery('#54');
    expect(rxnHash?.globalIndex).toBe(53);
    expect(rxnHash?.wellIndex).toBe(53);
    expect(rxnHash?.label).toBe('F9');
  });

  it('handles lane queries (lane 0, lane 27)', () => {
    const lane0 = parseWellQuery('lane 0');
    expect(lane0).not.toBeNull();
    expect(lane0?.laneIndex).toBe(0);
    expect(lane0?.label).toBe('A1');

    const lane1 = parseWellQuery('lane 1');
    expect(lane1).not.toBeNull();
    // In TLC column-major order: lane 1 is container 9 (B1)
    expect(lane1?.wellIndex).toBe(9);
    expect(lane1?.label).toBe('B1');
  });

  it('rejects invalid coordinates gracefully', () => {
    expect(parseWellQuery('')).toBeNull();
    expect(parseWellQuery('G1')).toBeNull(); // Row G does not exist on 6x9 plate
    expect(parseWellQuery('A0')).toBeNull(); // Col 0 does not exist
    expect(parseWellQuery('A10')).toBeNull(); // Col 10 does not exist
    expect(parseWellQuery('Z99')).toBeNull();
    expect(parseWellQuery('not a well')).toBeNull();
  });
});
