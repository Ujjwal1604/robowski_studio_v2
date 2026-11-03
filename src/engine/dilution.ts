// Robowski Studio - Dilution Engine & Run Calculation
import {
  Issue,
  RecipeItem,
  Reagent,
  RunResult,
  RunRow,
  StockDetail,
} from '../types';
import {
  BOTTLE_CAPACITY_ML,
  COLORS,
  JAR_CAPACITY_ML,
  MAX_REACTION_SLOTS,
  PLATE_CAPACITY,
  ROBOT_LIQUID_MODES,
  ROBOT_SOLVENTS,
  SOLVENT_DENSITIES,
  SUPPORTED_SOLVENTS,
  canonicalSolvent,
  num,
  round,
  truthy,
} from './constants';
import { targetCombinations } from './combinations';
import { assignDeckPositions, calculateTipCounts, estimateRuntime } from './deckTiming';

export function flaskPrep(v: number, flasks?: number[]): number {
  const fl = (flasks && flasks.length ? flasks : [2, 5, 10, 20, 50, 100]).slice().sort((a, b) => a - b);
  const hit = fl.find((f) => f + 1e-9 >= v);
  if (hit) return hit;
  const big = fl[fl.length - 1];
  return Math.ceil(v / big - 1e-9) * big;
}

export function flaskLabel(v: number, flasks?: number[]): string {
  const fl = (flasks && flasks.length ? flasks : [2, 5, 10, 20, 50, 100]).slice().sort((a, b) => a - b);
  const big = fl[fl.length - 1];
  return fl.some((f) => Math.abs(f - v) < 1e-9) ? `${v} mL flask` : `${Math.round(v / big)} × ${big} mL flasks`;
}

export function buildRun(data: any): RunResult {
  const reagents: Reagent[] = (data.reagents || []).map((r: any) => ({ ...r }));
  const flasks = (data.flaskSizes || []).map(Number).filter((x: number) => x > 0);
  if (reagents.length < 2 || reagents.length > 12) {
    throw new Error('Use between 2 and 12 reagents.');
  }
  const mode = data.mode || 'concentration';
  const vial = num(data.vialVolume, 500);
  const threshold = num(data.threshold ?? data.directLimit, 50);
  const factor = num(data.dilutionFactor, 5);
  const leftover = num(data.leftoverMl, 2);

  if (vial <= 0 || threshold < 0 || factor < 2 || leftover < 0) {
    throw new Error(
      'Vial volume must be positive, threshold non-negative, dilution factor at least 2, and leftover non-negative.'
    );
  }

  const hood: 'left' | 'right' = data.hood || 'left';
  const reactionSolvent = canonicalSolvent(data.reactionSolvent || data.solvent || 'water');
  if (!SUPPORTED_SOLVENTS.includes(reactionSolvent)) {
    throw new Error(`Unsupported reaction solvent: ${reactionSolvent}.`);
  }

  const { indexed, seed } = targetCombinations({ ...data, reagents });
  const blankSet = new Set(Array.isArray(data.blankRows) ? data.blankRows : []);
  const rows: RunRow[] = [];
  const stocks: Record<string, StockDetail> = {};
  const issues: Issue[] = [];
  const transferCountByReagent: Record<string, number> = {};
  const reagentByCode: Record<string, Reagent> = {};
  let activeTransfers = 0;

  if (!ROBOT_SOLVENTS.has(reactionSolvent)) {
    issues.push({
      severity: 'block',
      type: 'unsupported-solvent',
      code: 'solvent',
      message: `Reaction solvent ${reactionSolvent} has no confirmed matching liquid-class entry in the current robot repository.`,
    });
  }

  for (let i = 0; i < reagents.length; i++) {
    const r = reagents[i];
    const code = String(r.code || r.name || `R${i + 1}`).trim();
    if (!code) throw new Error(`Reagent ${i + 1} needs a code.`);
    if (!/^[A-Za-z0-9_-]{1,24}$/.test(code)) {
      throw new Error(`Reagent code '${code}' can only contain letters, numbers, underscores and hyphens.`);
    }
    if (/_N2?$/i.test(code)) {
      throw new Error(`Reagent code '${code}' ends in _N or _N2, which is reserved for generated dilution stock names.`);
    }
    if (code.toLowerCase() === 'solvent') {
      throw new Error("A reagent code cannot be 'solvent'; that name is reserved for the reaction diluent.");
    }
    if (Object.keys(reagentByCode).some((existing) => existing.toLowerCase() === code.toLowerCase())) {
      throw new Error(`Reagent codes must be unique (case-insensitive): ${code}.`);
    }

    const stock = num(r.stock, 100);
    if (stock <= 0) throw new Error(`Stock concentration for ${code} must be greater than zero.`);
    const stockSolvent = canonicalSolvent(r.solvent || reactionSolvent);
    if (!SUPPORTED_SOLVENTS.includes(stockSolvent)) {
      throw new Error(`${code}: unsupported stock solvent ${stockSolvent}.`);
    }

    r.code = code;
    r.color = r.color || COLORS[i % COLORS.length];
    r.stock = stock;
    r.solvent = stockSolvent;

    if (!ROBOT_SOLVENTS.has(stockSolvent)) {
      issues.push({
        severity: 'block',
        type: 'unsupported-solvent',
        code,
        message: `${code}: ${stockSolvent} is present in an imported legacy generator but is not in the confirmed robot liquid-class list. Choose a supported solvent before robot export.`,
      });
    }

    if (!(ROBOT_LIQUID_MODES[stockSolvent] || []).includes(r.pipettingMode || 'empty')) {
      issues.push({
        severity: 'block',
        type: 'unsupported-pipetting-mode',
        code,
        message: `${code}: pipetting mode '${r.pipettingMode || 'empty'}' is not supported for ${stockSolvent} by the current repository liquid-class table.`,
      });
    }

    r.molarMass = num(r.molarMass, 0);
    r.density = num(r.density, 0);
    r.liquidDensity = num(r.liquidDensity, SOLVENT_DENSITIES[stockSolvent] || 1);
    r.prepareVolumeMl = Math.max(0, num(r.prepareVolumeMl, 0));
    reagentByCode[code] = r;
    transferCountByReagent[code] = 0;
  }

  for (let idx = 0; idx < indexed.length; idx++) {
    const { globalIndex, values } = indexed[idx];
    const comboIndex = globalIndex;
    const recipe: RecipeItem[] = [];
    const row: any = {
      local_index: idx % PLATE_CAPACITY,
      global_index: globalIndex,
      combo_index: comboIndex,
      label: (data.rowLabels || [])[globalIndex] || null,
    };

    for (let i = 0; i < reagents.length; i++) {
      const r = reagents[i];
      const code = r.code;
      const rawTarget = values[i];
      const equivalence = mode === 'equivalence' && i > 0 ? rawTarget : null;
      const target = mode === 'equivalence' && i > 0 ? values[0] * rawTarget : rawTarget;
      const baseVol = (target * vial) / (r.stock as number);
      let dilution = 0;
      let transfer = baseVol;

      if (baseVol > 0 && baseVol < threshold) {
        dilution = 1;
        transfer = baseVol * factor;
        if (transfer < threshold) {
          dilution = 2;
          transfer = baseVol * factor * factor;
        }
      }

      const key = dilution === 0 ? code : dilution === 1 ? `${code}_N` : `${code}_N2`;
      const stockConc = (r.stock as number) / factor ** dilution;
      const rec: RecipeItem = {
        code,
        name: r.name || code,
        color: r.color || COLORS[i % COLORS.length],
        target_concentration: round(target),
        value: round(rawTarget),
        equivalence,
        base_volume: baseVol,
        transfer_volume: target > 0 ? transfer : 0,
        stock_key: target > 0 ? key : null,
        dilution_level: target > 0 ? dilution : 0,
        stock_concentration: target > 0 ? stockConc : (r.stock as number),
        solvent: r.solvent,
        molarMass: r.molarMass as number,
        chemicalDensity: r.density as number,
        liquidDensity: r.liquidDensity as number,
      };
      recipe.push(rec);

      if (target > 0) {
        if (!stocks[key]) {
          stocks[key] = {
            substance: key,
            source_reagent: code,
            source_name: r.name || code,
            solvent: r.solvent,
            density: r.liquidDensity as number,
            chemicalDensity: (r.density as number) > 0 ? (r.density as number) : null,
            molarMass: r.molarMass as number,
            base_stock_concentration: r.stock as number,
            concentration_mM: stockConc,
            dilution_level: dilution,
            dilution_label: dilution === 0 ? 'Direct' : `${factor ** dilution}×`,
            pipetting_mode: r.pipettingMode || 'empty',
            consumption_uL: 0,
            reagent_color: rec.color,
            leftover_mL: leftover,
            direct_consumption_ml: 0,
            additional_dilution_source_ml: 0,
            required_mL: 0,
            recommended_volume_ml: 0,
            recommended_volume_uL: 0,
            prep_volume_ml: 0,
            flask_label: '',
            mass_g: null,
            chemical_volume_ml: null,
            breadboard_plate_id: 0,
            container_id: 0,
          };
        }
        const s = stocks[key];
        s.consumption_uL += rec.transfer_volume;
        row[`vol#${key}`] = round(rec.transfer_volume, 6);

        if (rec.transfer_volume >= 0.5) {
          activeTransfers++;
          transferCountByReagent[code]++;
        }
        if (rec.transfer_volume > 0 && rec.transfer_volume < 0.5) {
          issues.push({
            severity: 'block',
            type: 'subminimum',
            code,
            row: idx,
            globalIndex,
            message: `Reaction ${globalIndex + 1}: ${key} transfer is ${rec.transfer_volume.toFixed(
              3
            )} µL, below the robot's 0.5 µL hard minimum. The robot skips transfers below 0.5 µL.`,
          });
        }
        if (rec.transfer_volume > 1000) {
          issues.push({
            severity: rec.transfer_volume >= 2000 ? 'block' : 'warning',
            type: 'large-transfer',
            code,
            row: idx,
            globalIndex,
            message: `Reaction ${globalIndex + 1}: ${key} transfer is ${rec.transfer_volume.toFixed(
              1
            )} µL. The legacy generator checks below 1000 µL; the robot supports 1000 µL tips only below 2000 µL.`,
          });
        }
        if (dilution === 2 && transfer < threshold) {
          issues.push({
            severity: 'warning',
            type: 'n3-needed',
            code,
            row: idx,
            globalIndex,
            message: `Reaction ${globalIndex + 1}: ${key} is still only ${transfer.toFixed(
              3
            )} µL after a ${factor ** 2}× dilution. An N³ dilution (or a separate low-concentration run) may be needed.`,
          });
        }
      } else {
        row[`vol#${code}`] = 0;
      }
    }

    const solventVolume = blankSet.has(globalIndex)
      ? 0
      : vial - recipe.reduce((sum, rec) => sum + rec.transfer_volume, 0);
    row['vol#solvent'] = round(solventVolume, 6);

    if (solventVolume < -1e-8) {
      issues.push({
        severity: 'block',
        type: 'negative-solvent',
        row: idx,
        globalIndex,
        codes: recipe.filter((rec) => rec.transfer_volume > 0).map((rec) => rec.code),
        message: `Reaction ${globalIndex + 1}: solvent is negative (${solventVolume.toFixed(
          2
        )} µL). Reduce stock transfer volumes, change the concentration/equivalence range, or increase vial volume.`,
      });
    }
    if (solventVolume > 0 && solventVolume < 0.5) {
      issues.push({
        severity: 'block',
        type: 'subminimum',
        code: 'solvent',
        row: idx,
        globalIndex,
        message: `Reaction ${globalIndex + 1}: solvent transfer is ${solventVolume.toFixed(
          3
        )} µL, below the robot's 0.5 µL hard minimum.`,
      });
    }
    if (solventVolume >= 0.5 && solventVolume < threshold) {
      issues.push({
        severity: 'block',
        type: 'low-solvent',
        code: 'solvent',
        row: idx,
        globalIndex,
        message: `Reaction ${globalIndex + 1}: solvent transfer is only ${solventVolume.toFixed(
          1
        )} µL, below the ${threshold} µL pipetting threshold. Raise the vial volume, lower the amounts, or lower the threshold.`,
      });
    }

    row.recipe = recipe;
    row.plate_number = Math.floor(idx / PLATE_CAPACITY);
    row.container_id = idx % PLATE_CAPACITY;
    rows.push(row);
  }

  // Ensure intermediate parent dilution stocks exist in the cascade
  let addedIntermediate = true;
  while (addedIntermediate) {
    addedIntermediate = false;
    for (const s of Object.values(stocks)) {
      if (s.dilution_level > 1) {
        const parentLvl = s.dilution_level - 1;
        const parentKey = parentLvl === 1 ? `${s.source_reagent}_N` : `${s.source_reagent}_N${parentLvl}`;
        if (!stocks[parentKey]) {
          const r = reagents.find((rg) => rg.code === s.source_reagent);
          if (r) {
            const parentConc = (r.stock as number) / (factor ** parentLvl);
            stocks[parentKey] = {
              substance: parentKey,
              source_reagent: s.source_reagent,
              source_name: r.name || s.source_reagent,
              solvent: r.solvent,
              density: r.liquidDensity as number,
              chemicalDensity: (r.density as number) > 0 ? (r.density as number) : null,
              molarMass: r.molarMass as number,
              base_stock_concentration: r.stock as number,
              concentration_mM: parentConc,
              dilution_level: parentLvl,
              dilution_label: `${factor ** parentLvl}×`,
              pipetting_mode: r.pipettingMode || 'empty',
              consumption_uL: 0,
              reagent_color: s.reagent_color,
              leftover_mL: leftover,
              direct_consumption_ml: 0,
              additional_dilution_source_ml: 0,
              required_mL: 0,
              recommended_volume_ml: 0,
              recommended_volume_uL: 0,
              prep_volume_ml: 0,
              flask_label: '',
              mass_g: null,
              chemical_volume_ml: null,
              breadboard_plate_id: 0,
              container_id: 0,
            };
            addedIntermediate = true;
          }
        }
      }
    }
  }

  const reagentOrder = Object.fromEntries(reagents.map((r, i) => [r.code, i]));
  const sortedEntries = Object.entries(stocks).sort(
    (a, b) =>
      (reagentOrder[a[1].source_reagent] ?? 99) - (reagentOrder[b[1].source_reagent] ?? 99) ||
      a[1].dilution_level - b[1].dilution_level
  );
  for (const k of Object.keys(stocks)) delete stocks[k];
  for (const [k, s] of sortedEntries) stocks[k] = s;

  for (const [, s] of Object.entries(stocks)) {
    s.consumption_uL = round(s.consumption_uL, 6);
    s.direct_consumption_ml = s.consumption_uL / 1000;
    s.additional_dilution_source_ml = 0;
    s.required_mL = s.direct_consumption_ml;
    s.recommended_volume_ml = round(s.required_mL + leftover, 6);
    s.recommended_volume_uL = round(s.recommended_volume_ml * 1000, 3);
  }

  // Find max dilution level in stocks
  const maxDilutionLevel = Math.max(0, ...Object.values(stocks).map((s) => s.dilution_level || 0));

  // Cascade from highest dilution level down to level 1:
  // Each level k is prepared from level k-1 using 1:factor dilution (e.g. 5x).
  // The volume needed from the parent is added to the parent's additional_dilution_source_ml.
  const sourceOnlyNeeds: Record<string, number> = Object.fromEntries(reagents.map((r) => [r.code, 0]));

  for (let lvl = maxDilutionLevel; lvl >= 1; lvl--) {
    for (const [key, s] of Object.entries(stocks)) {
      if (s.dilution_level === lvl) {
        s.required_mL = round(s.direct_consumption_ml + s.additional_dilution_source_ml, 6);
        s.recommended_volume_ml = round(s.required_mL + leftover, 6);
        s.recommended_volume_uL = round(s.recommended_volume_ml * 1000, 3);
        s.prep_volume_ml = flaskPrep(s.recommended_volume_ml, flasks);
        s.flask_label = flaskLabel(s.prep_volume_ml, flasks);
        s.leftover_mL = round(s.prep_volume_ml - s.required_mL, 6);

        // Immediate parent stock
        const parentKey = lvl === 1 ? s.source_reagent : `${s.source_reagent}_N${lvl > 2 ? lvl - 1 : ''}`;
        s.parent_stock_key = parentKey;

        // Volume taken from parent solution: prep_volume / factor
        const sourceFromParent = round(s.prep_volume_ml / factor, 6);
        s.parent_source_volume_ml = sourceFromParent;
        s.base_stock_volume_ml = sourceFromParent; // Kept for backward compatibility
        s.diluent_volume_ml = round(s.prep_volume_ml - sourceFromParent, 6);

        // Pass required volume to parent stock
        if (stocks[parentKey]) {
          stocks[parentKey].additional_dilution_source_ml = round(
            stocks[parentKey].additional_dilution_source_ml + sourceFromParent,
            6
          );
        } else if (lvl === 1) {
          sourceOnlyNeeds[s.source_reagent] = round(
            (sourceOnlyNeeds[s.source_reagent] || 0) + sourceFromParent,
            6
          );
        }
      }
    }
  }

  // Now process Level 0 stocks
  const sourceOnlyStocks: StockDetail[] = [];
  for (const r of reagents) {
    const direct = stocks[r.code];
    const extra = sourceOnlyNeeds[r.code] || 0;
    if (direct) {
      direct.required_mL = round(direct.direct_consumption_ml + direct.additional_dilution_source_ml, 6);
      direct.recommended_volume_ml = round(direct.required_mL + leftover, 6);
      direct.recommended_volume_uL = round(direct.recommended_volume_ml * 1000, 3);
      const explicit = num(r.prepareVolumeMl, 0);
      direct.prep_volume_ml = explicit || flaskPrep(direct.recommended_volume_ml, flasks);
      direct.flask_label = flaskLabel(direct.prep_volume_ml, flasks);
      direct.leftover_mL = round(direct.prep_volume_ml - direct.required_mL, 6);
      direct.mass_g = direct.molarMass > 0 ? (direct.prep_volume_ml * direct.base_stock_concentration * direct.molarMass) / 1e6 : null;
      direct.chemical_volume_ml = direct.mass_g != null && num(direct.chemicalDensity) > 0 ? direct.mass_g / (direct.chemicalDensity as number) : null;
      direct.parent_stock_key = undefined;
      direct.parent_source_volume_ml = null;
      direct.base_stock_volume_ml = null;
      direct.diluent_volume_ml = null;
    } else if (extra > 0) {
      const recommended = round(extra + leftover, 6);
      const prep = num(r.prepareVolumeMl, 0) || flaskPrep(recommended, flasks);
      const mass = (r.molarMass as number) > 0 ? (prep * (r.stock as number) * (r.molarMass as number)) / 1e6 : null;
      const chemicalVolume = mass != null && num(r.density) > 0 ? mass / (r.density as number) : null;
      sourceOnlyStocks.push({
        substance: r.code,
        source_reagent: r.code,
        source_name: r.name || r.code,
        solvent: r.solvent,
        density: r.liquidDensity as number,
        molarMass: r.molarMass as number,
        chemicalDensity: r.density as number,
        base_stock_concentration: r.stock as number,
        concentration_mM: r.stock as number,
        dilution_level: 0,
        dilution_label: 'Source stock for hand dilutions',
        consumption_uL: 0,
        direct_consumption_ml: 0,
        additional_dilution_source_ml: round(extra, 6),
        required_mL: round(extra, 6),
        recommended_volume_ml: recommended,
        recommended_volume_uL: round(recommended * 1000, 3),
        leftover_mL: round(prep - extra, 6),
        flask_label: flaskLabel(prep, flasks),
        prep_volume_ml: prep,
        mass_g: mass,
        chemical_volume_ml: chemicalVolume,
        base_stock_volume_ml: null,
        parent_source_volume_ml: null,
        diluent_volume_ml: null,
        source_only: true,
        reagent_color: r.color as string,
        pipetting_mode: 'empty',
        breadboard_plate_id: 0,
        container_id: 0,
      });
    }
  }

  // Warnings check for underprepared or oversize stocks
  for (const [key, s] of Object.entries(stocks)) {
    if (s.prep_volume_ml + 1e-9 < s.recommended_volume_ml && s.dilution_level === 0) {
      issues.push({
        severity: 'warning',
        type: 'underprepared-stock',
        code: key,
        message: `${key}: selected preparation volume ${s.prep_volume_ml.toFixed(
          2
        )} mL is below the ${s.recommended_volume_ml.toFixed(2)} mL recommendation.`,
      });
    }
    if (s.prep_volume_ml > BOTTLE_CAPACITY_ML) {
      issues.push({
        severity: 'warning',
        type: 'oversize-stock',
        code: key,
        message: `${key}: the ${s.prep_volume_ml.toFixed(
          0
        )} mL flask volume is above a ${BOTTLE_CAPACITY_ML} mL bottle's nominal capacity.`,
      });
    }
  }

  const solventConsumptionMl =
    rows.reduce((sum, row) => sum + Math.max(0, num(row['vol#solvent'])), 0) / 1000;
  const solventRecommendedMl = round(solventConsumptionMl + leftover, 6);
  const deck = assignDeckPositions(hood, stocks, data.deckPlates);

  if (!deck.positions_fit) {
    issues.push({ severity: 'block', type: 'deck-capacity', message: deck.positions_message });
  }
  if (deck.solvent_kind === 'bottle' && solventRecommendedMl > BOTTLE_CAPACITY_ML) {
    issues.push({
      severity: 'warning',
      type: 'oversize-solvent',
      code: 'solvent',
      message: `Solvent: ${solventRecommendedMl.toFixed(
        1
      )} mL including leftover is more than a ${BOTTLE_CAPACITY_ML} mL solvent bottle holds. Use fewer vials per run, a smaller leftover, or the solvent jar.`,
    });
  }
  if (deck.solvent_kind === 'jar' && solventRecommendedMl > JAR_CAPACITY_ML) {
    issues.push({
      severity: 'warning',
      type: 'oversize-solvent',
      code: 'solvent',
      message: `Solvent: ${solventRecommendedMl.toFixed(
        1
      )} mL including leftover is more than a ${JAR_CAPACITY_ML} mL solvent jar holds. Use fewer vials per run or a smaller leftover.`,
    });
  }

  const stockCheck = truthy(data.stockVolumeCheck ?? true);
  const newTip = truthy(data.newTipEveryTransfer ?? data.newTip ?? false);
  const tipCounts = calculateTipCounts(rows, stocks, stockCheck, newTip);
  const runtime = estimateRuntime(rows, tipCounts, stockCheck, newTip);

  if (Math.ceil(rows.length / PLATE_CAPACITY) > MAX_REACTION_SLOTS) {
    issues.push({
      severity: 'warning',
      type: 'requires-reload',
      message: `This run needs ${Math.ceil(
        rows.length / PLATE_CAPACITY
      )} reaction plates, but only ${MAX_REACTION_SLOTS} reaction-plate slots are available at once. Plan separate loading batches.`,
    });
  }

  const seen = new Set<string>();
  const unique: Issue[] = [];
  for (const issue of issues) {
    const sig = [issue.type, issue.code, issue.globalIndex, issue.message].join('|');
    if (!seen.has(sig)) {
      seen.add(sig);
      unique.push(issue);
    }
  }

  const blockingIssues = unique.filter((x) => x.severity === 'block').length;
  const warningCount = unique.filter((x) => x.severity === 'warning').length;
  const worstAddition = rows.reduce(
    (max, row: any) =>
      Math.max(
        max,
        Object.entries(row)
          .filter(([k]) => k.startsWith('vol#') && k !== 'vol#solvent')
          .reduce((sum, [, v]) => sum + num(v), 0)
      ),
    0
  );
  const stockMultiplier = vial > 0 ? Math.max(1.1, (worstAddition / vial) * 1.15) : 1.25;

  return {
    runName: data.runName || 'Untitled HTE run',
    modeLabel: data.modeLabel || null,
    descMeta: {
      product: data.product || {},
      additives: data.additiveCodes || [],
      chem: Object.fromEntries(
        reagents.map((r) => [
          r.code,
          { name: r.name || r.code, iupac: r.iupac || '', smiles: r.smiles || '' },
        ])
      ),
    },
    solventAfter: Math.max(0, Math.min(reagents.length, Math.floor(num(data.solventAfter, 0)))),
    mode,
    hood,
    reactionSolvent,
    vialVolume: vial,
    threshold,
    dilutionFactor: factor,
    leftoverMl: leftover,
    randomize: truthy(data.randomize ?? true),
    randomSeed: seed,
    rows,
    stocks,
    issues: unique,
    blockingIssues,
    warningCount,
    autoFix: {
      stockMultiplier: round(stockMultiplier, 2),
      reason:
        'First-pass suggestion based on the largest total stock addition. Recalculate after applying; dilution thresholds can change the result.',
    },
    reactions: rows.length,
    plates: Math.ceil(rows.length / PLATE_CAPACITY),
    slotsUsedThisLoad: Math.min(Math.ceil(rows.length / PLATE_CAPACITY), MAX_REACTION_SLOTS),
    requiresReload: Math.ceil(rows.length / PLATE_CAPACITY) > MAX_REACTION_SLOTS,
    activeTransfers,
    tipCounts,
    runtime,
    deck,
    reagents,
    sourceOnlyStocks,
    totalStockConsumptionMl: round(
      Object.values(stocks).reduce((sum, s) => sum + s.direct_consumption_ml, 0),
      3
    ),
    solventConsumptionMl: round(solventConsumptionMl, 3),
    solventRecommendedMl: round(solventRecommendedMl, 3),
    maxPlates: Math.floor(num(data.maxPlates, 3)),
  };
}
