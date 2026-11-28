import { describe, expect, it } from 'vitest';
import {
  RobotSimulator,
  buildPlannedReactionSteps,
  getDeckSlotXY,
} from '../src/engine/robotSimulator';

describe('RobotSimulator 1-to-1 Virtual Deck & Accident Detection', () => {
  it('blocks motion before Connect & Home and blocks homing with a tip attached', () => {
    const sim = new RobotSimulator(null, 'left');

    // Disconnected move is blocked
    const unhomed = sim.executeCommand('move_to_container', { plate_id: 3, container_id: 0 });
    expect(unhomed.ok).toBe(false);
    expect(sim.getSnapshot().accidents.some((a) => a.category === 'unhomed_move')).toBe(true);

    // Connect & Home works cleanly
    const home = sim.executeCommand('init_hardware');
    expect(home.ok).toBe(true);
    expect(sim.getHardwareSnapshot().homed).toBe(true);

    // Pick tip, then try to home -> blocked as prevented crash
    expect(sim.executeCommand('pick_tip', { tip_type: '300ul' }).ok).toBe(true);
    const homeWithTip = sim.executeCommand('home_xy');
    expect(homeWithTip.ok).toBe(false);
    expect(sim.getSnapshot().accidents.some((a) => a.category === 'home_with_tip')).toBe(true);

    // Drop tip -> now homing succeeds
    expect(sim.executeCommand('discard_tip').ok).toBe(true);
    expect(sim.executeCommand('home_xy').ok).toBe(true);
  });

  it('catches sideways XY crash at low Z and Z bottom-crash inside a bottle', () => {
    const sim = new RobotSimulator(null, 'left');
    sim.executeCommand('init_hardware');
    sim.executeCommand('move_to_container', { plate_id: 3, container_id: 0 });

    // Lower Z into bottle (bottle floor = 2180)
    expect(sim.executeCommand('move_z', { z: 1600 }).ok).toBe(true);

    // Sideways XY jog while tip is down inside bottle -> CRASH prevented
    const sideCrash = sim.executeCommand('move_xy_rel', { dx: 15, dy: 0 });
    expect(sideCrash.ok).toBe(false);
    expect(sim.getSnapshot().accidents.some((a) => a.category === 'xy_crash')).toBe(true);

    // Lower Z past bottle bottom (2180) -> CRASH prevented
    const floorCrash = sim.executeCommand('move_z', { z: 2195 });
    expect(floorCrash.ok).toBe(false);
    expect(sim.getSnapshot().accidents.some((a) => a.category === 'z_crash')).toBe(true);
  });

  it('catches dry aspiration, container overflow, tip mismatch, and cross-contamination', () => {
    const sim = new RobotSimulator(null, 'left');
    sim.executeCommand('init_hardware');

    // Unknown solvent rejected
    const badSolv = sim.executeCommand('single_transfer', {
      src_plate: 3,
      src_slot: 0,
      dst_plate: 0,
      dst_slot: 0,
      volume_ul: 100,
      solvent: 'unknown_magic',
      tip_type: 'auto',
      src_z: 1950,
      dst_z: 2100,
    });
    expect(badSolv.ok).toBe(false);

    // Tip capacity overflow (200 uL in 50 uL tip) rejected
    const badTip = sim.executeCommand('single_transfer', {
      src_plate: 3,
      src_slot: 0,
      dst_plate: 0,
      dst_slot: 0,
      volume_ul: 200,
      solvent: 'ethanol',
      tip_type: '50ul',
      src_z: 1950,
      dst_z: 2100,
    });
    expect(badTip.ok).toBe(false);
    expect(sim.getSnapshot().accidents.some((a) => a.category === 'tip_mismatch')).toBe(true);

    // Dry aspiration: empty bottle plate3 slot 5 has 0 uL
    sim.executeCommand('single_transfer', {
      src_plate: 3,
      src_slot: 5,
      dst_plate: 0,
      dst_slot: 0,
      volume_ul: 100,
      solvent: 'ethanol',
      tip_type: '300ul',
      src_z: 1950,
      dst_z: 2100,
      pick_tip: true,
      drop_tip: false,
    });
    expect(sim.getSnapshot().accidents.some((a) => a.category === 'dry_aspiration')).toBe(true);

    // Cross-contamination: reuse same tip on a different source bottle (plate3 slot 0)
    sim.executeCommand('single_transfer', {
      src_plate: 3,
      src_slot: 0,
      dst_plate: 0,
      dst_slot: 0,
      volume_ul: 100,
      solvent: 'ethanol',
      tip_type: '300ul',
      src_z: 1950,
      dst_z: 2100,
      pick_tip: false,
      drop_tip: true,
    });
    expect(sim.getSnapshot().accidents.some((a) => a.category === 'cross_contamination')).toBe(true);

    // Container overflow: dispense 1000 uL twice into a 2 mL vial (1800 uL safe cap)
    sim.executeCommand('single_transfer', {
      src_plate: 6,
      src_slot: 0,
      dst_plate: 0,
      dst_slot: 1,
      volume_ul: 1000,
      solvent: 'ethanol',
      tip_type: '1000ul',
      src_z: 1850,
      dst_z: 2100,
    });
    sim.executeCommand('single_transfer', {
      src_plate: 6,
      src_slot: 0,
      dst_plate: 0,
      dst_slot: 1,
      volume_ul: 1000,
      solvent: 'ethanol',
      tip_type: '1000ul',
      src_z: 1850,
      dst_z: 2100,
    });
    expect(sim.getSnapshot().accidents.some((a) => a.category === 'overflow')).toBe(true);
  });

  it('tracks custom 3-corner 96-well preset geometry and warns on 1000 uL tips', () => {
    const sim = new RobotSimulator(null, 'left');
    sim.executeCommand('init_hardware');

    const saveRes = sim.executeCommand('save_plate_preset', {
      name: '96-well Assay',
      plate_slot: 1,
      rows: 8,
      cols: 12,
      corner_a1: [-130, -325],
      corner_top_right: [-31, -325],
      corner_bottom_left: [-130, -388],
      default_z: 1950,
    });
    expect(saveRes.ok).toBe(true);
    const preset = sim.getHardwareSnapshot().platePresets![0];
    expect(getDeckSlotXY(1, 95, preset)).toEqual([-31, -388]);

    // Dipping 1000 uL tip into 96-well plate raises a warning
    sim.executeCommand('single_transfer', {
      src_plate: 6,
      src_slot: 0,
      dst_plate: 1,
      dst_slot: 0,
      dst_preset_id: preset.id,
      volume_ul: 350,
      solvent: 'ethanol',
      tip_type: '1000ul',
      src_z: 1850,
      dst_z: 1950,
    });
    expect(sim.getSnapshot().accidents.some((a) => a.title.includes('1000 µL tip in narrow 96-well'))).toBe(true);
  });

  it('halts immediately on Software Stop and requires Clear Alarm before moving', () => {
    const sim = new RobotSimulator(null, 'left');
    sim.executeCommand('init_hardware');

    const stopRes = sim.requestEmergencyStop();
    expect(stopRes.ok).toBe(true);
    expect(sim.getSnapshot().emergencyStopped).toBe(true);

    const blocked = sim.executeCommand('move_idle');
    expect(blocked.ok).toBe(false);

    expect(sim.executeCommand('kill_alarm').ok).toBe(true);
    expect(sim.executeCommand('move_idle').ok).toBe(true);
  });

  it('sorts planned reaction steps largest-volume-first per plate/reagent and switches tips cleanly across 1000/300/50 uL tiers', () => {
    const mockRun: any = {
      reactionSolvent: 'DMSO',
      solventConsumptionMl: 0,
      solventRecommendedMl: 0,
      deck: {
        solvent_plate: 6,
        solvent_container: 0,
        solvent_kind: 'jar',
      },
      stocks: {
        A: {
          substance: 'A',
          breadboard_plate_id: 3,
          container_id: 0,
          solvent: 'DMSO',
          prep_volume_ml: 15,
          source_only: false,
        },
      },
      rows: [
        // Deliberately unsorted: small -> medium -> >300 uL -> >1000 uL
        { plate_number: 0, container_id: 0, 'vol#A': 30, 'vol#solvent': 0 },
        { plate_number: 0, container_id: 1, 'vol#A': 200, 'vol#solvent': 0 },
        { plate_number: 0, container_id: 2, 'vol#A': 311.11, 'vol#solvent': 0 },
        { plate_number: 0, container_id: 3, 'vol#A': 1200, 'vol#solvent': 0 },
      ],
    };

    const steps = buildPlannedReactionSteps(mockRun);
    // 1200 splits into 600 + 600 (1000ul), then 311.11 (1000ul), then 200 (300ul), then 30 (50ul)
    expect(steps.map((s) => s.tipType)).toEqual(['1000ul', '1000ul', '1000ul', '300ul', '50ul']);
    expect(steps.map((s) => s.volumeUl)).toEqual([600, 600, 311.11, 200, 30]);
    expect(steps.map((s) => s.pickTip)).toEqual([true, false, false, true, true]);
    expect(steps.map((s) => s.dropTip)).toEqual([false, false, true, true, true]);

    // Execute every step through RobotSimulator without any tip-mismatch halt
    const sim = new RobotSimulator(mockRun, 'left');
    sim.executeCommand('init_hardware');
    for (const s of steps) {
      const res = sim.executeSingleTransferStep({
        src_plate: s.srcPlate,
        src_slot: s.srcSlot,
        dst_plate: s.dstPlate,
        dst_slot: s.dstSlot,
        volume_ul: s.volumeUl,
        solvent: s.solvent,
        tip_type: s.tipType,
        src_z: s.srcZ,
        dst_z: s.dstZ,
        pick_tip: s.pickTip,
        drop_tip: s.dropTip,
      });
      expect(res.ok).toBe(true);
    }
    expect(sim.getSnapshot().accidents.filter((a) => a.severity === 'crash')).toHaveLength(0);
    expect(sim.getHardwareSnapshot().currentTip).toBe('');
  });
});
