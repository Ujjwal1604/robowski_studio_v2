import React from 'react';
import { AlertTriangle, CheckCircle2, Clock, FlaskConical, Gauge, XCircle } from 'lucide-react';
import { useApp } from '../../context/AppContext';
import {
  PAL,
  BOTTLE_CAPACITY_ML,
  BOTTLE_MAX_ML,
  JAR_CAPACITY_ML,
  defaultPlates,
  formatDuration,
  getVialTipHtml,
  getStockTipHtml,
  getSolventTipHtml,
  robotProfileForHood,
} from '../../engine';

export const DeckView: React.FC = () => {
  const {
    state,
    setPath,
    run,
    err,
    platesOk,
    confirmPlates,
    unconfirmPlates,
    setVialFocus,
    setVisited,
    setView,
    setPage,
    triMeta,
    setOf,
  } = useApp();

  const nf = (v: any, d = 2) =>
    Number.isFinite(+v) ? (+v).toLocaleString('en-US', { maximumFractionDigits: d }) : '-';

  const rcol = (i: number) => PAL[i % PAL.length];

  if (!run) {
    return (
      <div className="wrap">
        <div className="card">
          <div className="issue bad">
            <span>{err || 'No run computed yet. Fill in run parameters on Setup.'}</span>
          </div>
        </div>
      </div>
    );
  }

  const left = state.hood === 'left';
  const profile = robotProfileForHood(state.hood);
  const factor = +state.dilutionFactor || 5;
  const autoHeight = state.autoLiquidHeight !== false && !state.stockVolumeCheck;
  const pipettingStrategy = state.pipettingStrategy || 'by_solvent';
  const substanceDelaySec = Math.max(0, Number(state.substanceDelaySec) || 0);

  const codeColor = (code: string) => {
    const i = state.reagents.findIndex((r) => r.code === code);
    return rcol(i < 0 ? 0 : i);
  };

  const byPos: Record<string, { key: string; ml: number; color: string; rawStock: any }> = {};
  Object.entries(run.stocks).forEach(([k, s]) => {
    byPos[`${s.breadboard_plate_id}:${s.container_id}`] = {
      key: k,
      ml: s.recommended_volume_ml,
      color: codeColor(s.source_reagent),
      rawStock: s,
    };
  });

  const blockSet = new Set(
    run.issues.filter((x) => x.severity === 'block' && x.row != null).map((x) => x.row as number)
  );

  const robotProfileWarnings = run.issues.filter(
    (x) =>
      x.type === 'roboski1-lc0' ||
      x.type === 'dead-volume-shortage' ||
      x.type === 'use-40ml-bottle' ||
      x.type === 'oversize-stock'
  );

  const dp = state.deckPlates || defaultPlates(state.hood);
  const isConfirmed = platesOk();
  const t = run.tipCounts;
  const rt = run.runtime;
  const preFlight = run.preFlight || [];

  return (
    <div className="wrap">
      {/* 1. Deck Hood Header & Visualizer */}
      <div className="card" style={{ marginBottom: '20px' }}>
        <div
          style={{
            display: 'flex',
            justifyContent: 'space-between',
            gap: '12px',
            flexWrap: 'wrap',
            alignItems: 'center',
          }}
        >
          <div>
            <h2>
              Deck · {profile.label}
            </h2>
            <p className="sub" style={{ margin: '2px 0 0 0' }}>
              {profile.notes} Bars show bottle fill (20 mL standard, 40 mL tall bottle when &gt; 20
              mL).
            </p>
            <div
              className="mono"
              style={{
                marginTop: '6px',
                fontSize: '11.5px',
                color: 'var(--mut)',
              }}
            >
              Arduino {profile.arduinoPort} · Balance {profile.balancePort} · Trash (
              {profile.trashXy[0]}, {profile.trashXy[1]}) · Park ({profile.idleXy[0]},{' '}
              {profile.idleXy[1]}) · Breadboard: plate0–2 vials · plate3–5 bottles · plate6–7 jars
            </div>
          </div>

          <div className="seg" role="group" aria-label="Active robot profile">
            <button
              type="button"
              className={left ? 'on' : ''}
              onClick={() => {
                setPath('hood', 'left');
                setPath('deckPlates', null);
              }}
            >
              Robowski#2 (Left)
            </button>
            <button
              type="button"
              className={!left ? 'on' : ''}
              onClick={() => {
                setPath('hood', 'right');
                setPath('deckPlates', null);
              }}
            >
              Roboski#1 (Right)
            </button>
          </div>
        </div>

        {!run.deck.positions_fit && (
          <div className="issue bad" style={{ marginTop: '12px' }}>
            <span>{run.deck.positions_message}</span>
          </div>
        )}

        {robotProfileWarnings.length > 0 && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '8px', marginTop: '12px' }}>
            {robotProfileWarnings.map((w, idx) => (
              <div
                key={`${w.code}-${idx}`}
                className={`issue ${w.severity === 'block' ? 'bad' : 'warn'}`}
              >
                <AlertTriangle size={15} style={{ flexShrink: 0, marginTop: '1px' }} />
                <span>{w.message}</span>
              </div>
            ))}
          </div>
        )}

        {/* Deck Stock Plates & Solvent Visualizer */}
        <div className="hood" style={{ marginTop: '16px' }}>
          <div className="plates">
            {[...new Set([...run.deck.plates, run.deck.solvent_plate])].sort().map((pn) => {
              const isSolventPlate = pn === run.deck.solvent_plate;
              if (run.deck.solvent_kind === 'jar' && isSolventPlate) {
                return (
                  <div key={pn} className="plate">
                    <div className="pt">plate{pn} · Jar 100 mL (1×2)</div>
                    <div className="wells8" style={{ gridTemplateColumns: 'repeat(2, 1fr)' }}>
                      <div
                        className="well"
                        style={{ background: 'var(--fill)', border: '3px solid var(--fg2)' }}
                        data-tip={getSolventTipHtml(run, state, pn, 'jar')}
                      >
                        <div
                          className="bar"
                          style={{
                            height: `${Math.min(
                              100,
                              (100 * run.solventRecommendedMl) / JAR_CAPACITY_ML
                            )}%`,
                          }}
                        />
                        <span>solvent</span>
                      </div>
                      <div className="well e" />
                    </div>
                  </div>
                );
              }

              // Bottle Plate (2x4 = 8 wells; supports 20 mL or 40 mL tall bottles)
              return (
                <div key={pn} className="plate">
                  <div className="pt">plate{pn} · Bottle 20/40 mL (2×4)</div>
                  <div className="wells8">
                    {Array.from({ length: 8 }, (_, c) => {
                      if (isSolventPlate && c === run.deck.solvent_container) {
                        const solvCap =
                          run.solventRecommendedMl > BOTTLE_CAPACITY_ML
                            ? BOTTLE_MAX_ML
                            : BOTTLE_CAPACITY_ML;
                        return (
                          <div
                            key={c}
                            className="well"
                            style={{ background: 'var(--fill)', border: '3px solid var(--fg2)' }}
                            data-tip={getSolventTipHtml(run, state, pn, 'bottle')}
                          >
                            <div
                              className="bar"
                              style={{
                                height: `${Math.min(
                                  100,
                                  (100 * run.solventRecommendedMl) / solvCap
                                )}%`,
                              }}
                            />
                            <span>
                              solv
                              {solvCap === BOTTLE_MAX_ML ? ' (40mL)' : ''}
                            </span>
                          </div>
                        );
                      }

                      const stock = byPos[`${pn}:${c}`];
                      if (!stock) return <div key={c} className="well e" />;
                      const use40 = stock.ml > BOTTLE_CAPACITY_ML;
                      const cap = use40 ? BOTTLE_MAX_ML : BOTTLE_CAPACITY_ML;
                      const pct = Math.min(100, (100 * stock.ml) / cap);
                      const displayKey = stock.key
                        .replace('_N2', '×' + +(factor ** 2).toPrecision(4))
                        .replace('_N', '×' + +factor.toPrecision(4));

                      return (
                        <div
                          key={c}
                          className="well"
                          style={{ background: 'var(--fill)', border: `3px solid ${stock.color}` }}
                          data-tip={getStockTipHtml(stock, pn, c, displayKey)}
                        >
                          <div className="bar" style={{ height: `${pct}%` }} />
                          <span>
                            {displayKey}
                            {use40 ? ' · 40mL' : ''}
                          </span>
                        </div>
                      );
                    })}
                  </div>
                </div>
              );
            })}
          </div>
        </div>

        {/* 54-Vial Plates Visualizer */}
        <div className="plates" style={{ marginTop: '16px' }}>
          {[0, 1, 2].map((p) => {
            const used = p < run.plates;
            if (!used) {
              return (
                <div key={p} className="plate off">
                  <div className="pt">plate{p} · 54-vial plate (not needed)</div>
                  <div className="wells54">
                    {Array.from({ length: 54 }, (_, i) => (
                      <div key={i} className="v54 x" />
                    ))}
                  </div>
                </div>
              );
            }

            const n = Math.min(54, run.reactions - p * 54);
            const tri = state.mode === 'triplet';
            let usedCount = 0;

            const wells = Array.from({ length: 54 }, (_, k) => {
              const ri = p * 54 + k;
              const blankW = k < n && tri && triMeta[ri] && triMeta[ri].blank;
              const on = k < n && !blankW;
              if (on) usedCount++;
              const bad = on && blockSet.has(ri);
              const setIdx = on && !bad && !tri ? setOf[run.rows[ri]?.combo_index] || 0 : 0;
              const multi = (state.sets?.length || 0) > 1;

              return (
                <div
                  key={k}
                  className={`v54 ${on ? (bad ? 'b' : 'u') : 'x'}`}
                  style={
                    on && !bad && !tri && multi
                      ? { borderColor: rcol(setIdx), borderWidth: '3px' }
                      : undefined
                  }
                  data-tip={on ? getVialTipHtml(p, k, ri, run, state, triMeta, blockSet) : undefined}
                  onClick={() => {
                    if (on) {
                      setVialFocus({
                        label: `plate ${p}, vial ${k}`,
                        rows: new Set([ri]),
                      });
                      setVisited((v) => ({ ...v, combos: true }));
                      setView('combos');
                      setPage(Math.floor(ri / 50));
                      window.scrollTo(0, 0);
                    }
                  }}
                />
              );
            });

            return (
              <div key={p} className="plate">
                <div className="pt">
                  plate{p} · {usedCount} of 54 vials used (filled by the robot)
                </div>
                <div className="wells54">{wells}</div>
              </div>
            );
          })}
        </div>

        {run.plates > 3 && (
          <div className="hint" style={{ marginTop: '12px' }}>
            This run needs {run.plates} plates; the deck holds 3 at once, so load the next plates
            after the first batch finishes.
          </div>
        )}
      </div>

      {/* 2. Pre-Flight Check (synced with main_auto_liquid_height.py) */}
      {preFlight.length > 0 && (
        <div className="card" style={{ marginBottom: '20px' }}>
          <div
            style={{
              display: 'flex',
              justifyContent: 'space-between',
              alignItems: 'center',
              gap: '12px',
              flexWrap: 'wrap',
              marginBottom: '10px',
            }}
          >
            <div>
              <h2 style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                <Gauge size={18} />
                Pre-Flight Liquid Check
              </h2>
              <p className="sub" style={{ margin: '2px 0 0 0' }}>
                Matches <span className="mono">main_auto_liquid_height.py</span> container math:
                verifies every bottle and jar has enough liquid above its dead volume (1.0 mL per
                bottle, 7.4 mL per 100 mL jar) and predicts starting liquid height.
              </p>
            </div>
            <button
              type="button"
              className="btn sm"
              onClick={() => {
                setVisited((v) => ({ ...v, robot: true }));
                setView('robot');
                window.scrollTo(0, 0);
              }}
            >
              Open Live Robot Monitor →
            </button>
          </div>

          <div style={{ overflowX: 'auto' }}>
            <table
              style={{
                width: '100%',
                borderCollapse: 'collapse',
                fontSize: '12.5px',
              }}
            >
              <thead>
                <tr
                  style={{
                    borderBottom: '1px solid var(--line)',
                    textAlign: 'left',
                    color: 'var(--mut)',
                    fontSize: '11.5px',
                  }}
                >
                  <th style={{ padding: '8px 10px 8px 0' }}>Liquid</th>
                  <th style={{ padding: '8px 10px' }}>Position</th>
                  <th style={{ padding: '8px 10px' }}>Container</th>
                  <th style={{ padding: '8px 10px', textAlign: 'right' }}>Fill</th>
                  <th style={{ padding: '8px 10px', textAlign: 'right' }}>Needed + Dead</th>
                  <th style={{ padding: '8px 10px', textAlign: 'right' }}>Start Surface Z</th>
                  <th style={{ padding: '8px 0 8px 10px' }}>Check</th>
                </tr>
              </thead>
              <tbody>
                {preFlight.map((row) => {
                  const notRequired = row.neededUl <= 0;
                  const statusColor = notRequired
                    ? 'var(--mut)'
                    : row.status === 'ok'
                    ? 'var(--ok)'
                    : row.status === 'warn'
                    ? 'var(--warn)'
                    : 'var(--bad)';
                  const statusLabel = notRequired
                    ? 'Not needed'
                    : row.status === 'ok'
                    ? 'Ready'
                    : row.status === 'warn'
                    ? row.marginUl < 0
                      ? 'Low liquid'
                      : 'Use 40 mL bottle'
                    : 'Over max / invalid';
                  return (
                    <tr
                      key={`${row.substance}-${row.plate}-${row.containerId}`}
                      style={{
                        borderBottom: '1px solid var(--line2)',
                        opacity: notRequired ? 0.72 : 1,
                      }}
                    >
                      <td style={{ padding: '8px 10px 8px 0', fontWeight: 600 }}>
                        {row.isSolvent ? `${row.solvent} (solvent)` : row.substance}
                      </td>
                      <td className="mono" style={{ padding: '8px 10px', color: 'var(--fg2)' }}>
                        {notRequired ? '—' : `plate${row.plate} · pos ${row.containerId}`}
                      </td>
                      <td style={{ padding: '8px 10px', color: 'var(--fg2)' }}>
                        {row.bottleSizeLabel}
                      </td>
                      <td className="mono" style={{ padding: '8px 10px', textAlign: 'right' }}>
                        {notRequired ? '0 mL' : `${nf(row.preparedUl / 1000, 1)} mL`}
                      </td>
                      <td className="mono" style={{ padding: '8px 10px', textAlign: 'right' }}>
                        {notRequired ? (
                          <span style={{ color: 'var(--mut)' }}>0 mL (not required)</span>
                        ) : (
                          <>
                            {nf((row.neededUl + row.deadVolumeUl) / 1000, 2)} mL
                            <span style={{ color: 'var(--mut)', fontSize: '11px' }}>
                              {' '}
                              ({nf(row.deadVolumeUl / 1000, 1)} dead)
                            </span>
                          </>
                        )}
                      </td>
                      <td className="mono" style={{ padding: '8px 10px', textAlign: 'right' }}>
                        {notRequired ? (
                          <span style={{ color: 'var(--mut)' }}>—</span>
                        ) : (
                          <>
                            {row.surfaceHeightZ}
                            <span style={{ color: 'var(--mut)', fontSize: '11px' }}>
                              {' '}
                              ({row.mmAboveBottom} mm)
                            </span>
                          </>
                        )}
                      </td>
                      <td style={{ padding: '8px 0 8px 10px' }}>
                        <span
                          style={{
                            display: 'inline-flex',
                            alignItems: 'center',
                            gap: '5px',
                            color: statusColor,
                            fontWeight: 600,
                          }}
                          title={row.summary}
                        >
                          {row.status === 'ok' ? (
                            <CheckCircle2 size={14} />
                          ) : row.status === 'warn' ? (
                            <AlertTriangle size={14} />
                          ) : (
                            <XCircle size={14} />
                          )}
                          <span>{statusLabel}</span>
                        </span>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* 3. Plate numbers configuration card */}
      <div className="card" style={{ marginBottom: '20px' }}>
        <h2>Plate numbers</h2>
        <p className="sub">
          Which deck plates hold the stocks and the solvent. On both hoods,{' '}
          <span className="mono">plate3–5</span> are 8-bottle holders and{' '}
          <span className="mono">plate6–7</span> are 2-jar holders.
        </p>

        {/* Plate confirmation banner */}
        <div
          style={{
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
            gap: '14px',
            flexWrap: 'wrap',
            padding: '12px 14px',
            background: isConfirmed ? 'var(--accbg)' : 'var(--soft)',
            border: `1px solid ${isConfirmed ? 'var(--acc)' : 'var(--line)'}`,
            borderRadius: '8px',
            marginBottom: '16px',
          }}
        >
          <div>
            <div style={{ fontWeight: 600, display: 'flex', alignItems: 'center', gap: '8px' }}>
              {isConfirmed ? (
                <>
                  <span style={{ color: 'var(--ok)' }}>✓</span>
                  Plate positions confirmed for this run
                </>
              ) : (
                'Confirm plate layout'
              )}
            </div>
            <div className="hint" style={{ margin: 0 }}>
              {isConfirmed
                ? 'Robowski has locked these plate positions for robot export.'
                : 'Review where stock bottles and solvent sit on the robot deck.'}
            </div>
          </div>

          <button
            type="button"
            className={`btn ${isConfirmed ? '' : 'pri'}`}
            onClick={isConfirmed ? unconfirmPlates : confirmPlates}
          >
            {isConfirmed ? 'Change positions' : 'Confirm deck layout'}
          </button>
        </div>

        <div className="row">
          <div className="fld">
            <label className="lbl">Solvent container</label>
            <select
              value={run.deck.solvent_kind}
              onChange={(e) => {
                const kind = e.target.value as 'jar' | 'bottle';
                const nextPlate =
                  kind === 'jar'
                    ? run.deck.solvent_plate >= 6
                      ? run.deck.solvent_plate
                      : 6
                    : run.deck.solvent_plate <= 5
                    ? run.deck.solvent_plate
                    : 3;
                setPath('deckPlates', {
                  ...dp,
                  solventKind: kind,
                  solventPlate: nextPlate,
                  solventPos: kind === 'jar' ? Math.min(1, dp.solventPos || 0) : dp.solventPos || 0,
                });
              }}
            >
              <option value="jar">Jar 100 mL (plate6–7)</option>
              <option value="bottle">Bottle 20/40 mL (plate3–5)</option>
            </select>
          </div>

          <div className="fld">
            <label className="lbl">Solvent plate</label>
            <select
              value={run.deck.solvent_plate}
              onChange={(e) => {
                const nextPlate = +e.target.value;
                const nextKind: 'jar' | 'bottle' = nextPlate >= 6 ? 'jar' : 'bottle';
                const nextPos =
                  nextKind === 'jar'
                    ? Math.min(1, dp.solventPos || 0)
                    : Math.min(7, dp.solventPos || 0);
                setPath('deckPlates', {
                  ...dp,
                  solventPlate: nextPlate,
                  solventKind: nextKind,
                  solventPos: nextPos,
                });
              }}
            >
              {[3, 4, 5, 6, 7].map((p) => (
                <option key={p} value={p}>
                  plate{p} ({p >= 6 ? 'jar' : 'bottle'})
                </option>
              ))}
            </select>
          </div>

          <div className="fld">
            <label className="lbl">Solvent position</label>
            <select
              className="f"
              value={run.deck.solvent_container}
              onChange={(e) =>
                setPath('deckPlates', { ...dp, solventPos: +e.target.value })
              }
            >
              {(run.deck.solvent_kind === 'jar' ? [0, 1] : [0, 1, 2, 3, 4, 5, 6, 7]).map((p) => (
                <option key={p} value={p}>
                  pos {p}
                </option>
              ))}
            </select>
          </div>
        </div>

        <div style={{ marginTop: '14px' }}>
          <span className="lbl">Bottle plates for stocks (filled in this order)</span>
          <div className="seg" role="group" aria-label="Stock plates">
            {[3, 4, 5, 6].map((p) => {
              const curPlates = dp.stockPlates || [3, 4, 5];
              const on = run.deck.plates.includes(p);
              return (
                <button
                  key={p}
                  type="button"
                  className={on ? 'on' : ''}
                  onClick={() => {
                    const next = curPlates.includes(p)
                      ? curPlates.filter((x: number) => x !== p)
                      : [...curPlates, p].sort();
                    if (next.length > 0) {
                      setPath('deckPlates', { ...dp, stockPlates: next });
                    }
                  }}
                >
                  plate{p}
                </button>
              );
            })}
          </div>
        </div>
      </div>

      {/* 4 & 5: Load list + Tips & Execution Timing side-by-side */}
      <div className="grid eq">
        {/* Load List Card */}
        <div className="card" style={{ minWidth: 0 }}>
          <h2 style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
            <FlaskConical size={18} />
            Load list
          </h2>
          <p className="sub">
            What goes where, and how to prepare it. Volume is rounded up to a volumetric flask and
            includes {state.leftoverMl} mL leftover.
          </p>
          <div className="list">
            {/* Solvent Row */}
            <div>
              <span className="rdot" style={{ background: 'var(--fg2)', minWidth: '46px' }}>
                solv
              </span>
              <span className="mono" style={{ minWidth: '110px' }}>
                {run.deck.solvent_location}
              </span>
              <b className="mono" style={{ minWidth: '80px' }}>
                {nf(run.solventRecommendedMl, 1)} mL
              </b>
              <span style={{ flex: '1 1 260px', color: 'var(--fg2)', minWidth: 0 }}>
                {state.reactionSolvent || 'solvent'}
              </span>
            </div>

            {/* Stocks on Deck */}
            {Object.entries(run.stocks).map(([k, s]) => {
              const c = codeColor(s.source_reagent);
              let prep = '';
              if (s.dilution_level === 0) {
                prep =
                  s.mass_g != null
                    ? `Prepare ${nf(s.prep_volume_ml, 1)} mL (${s.flask_label}): weigh ${nf(
                        s.mass_g * 1000,
                        1
                      )} mg${
                        s.chemical_volume_ml
                          ? ` (or ${nf(s.chemical_volume_ml * 1000, 0)} µL liquid)`
                          : ''
                      } in ${s.solvent}`
                    : `Prepare ${nf(s.prep_volume_ml, 1)} mL (${s.flask_label}) at ${nf(
                        s.concentration_mM,
                        1
                      )} mM in ${s.solvent}`;
              } else {
                const parent =
                  s.parent_stock_key ||
                  (s.dilution_level === 1 ? s.source_reagent : k.replace(/_N2$/, '_N'));
                const srcVol = s.parent_source_volume_ml ?? s.base_stock_volume_ml;
                prep = `Dilute by hand: ${nf(srcVol, 2)} mL of ${parent} stock + ${nf(
                  s.diluent_volume_ml,
                  2
                )} mL ${s.solvent} → ${nf(s.concentration_mM, 1)} mM`;
              }

              return (
                <div key={k}>
                  <span className="rdot" style={{ background: c, minWidth: '46px' }}>
                    {k}
                  </span>
                  <span className="mono" style={{ minWidth: '110px' }}>
                    plate{s.breadboard_plate_id} · pos {s.container_id}
                  </span>
                  <b className="mono" style={{ minWidth: '80px' }}>
                    {nf(s.prep_volume_ml, 0)} mL
                  </b>
                  <span style={{ flex: '1 1 260px', color: 'var(--fg2)', minWidth: 0 }}>
                    {prep}
                  </span>
                </div>
              );
            })}

            {/* Source Only Stocks */}
            {(run.sourceOnlyStocks || []).map((s) => (
              <div key={s.substance}>
                <span
                  className="rdot"
                  style={{ background: codeColor(s.source_reagent), minWidth: '46px' }}
                >
                  {s.substance}
                </span>
                <span className="mono" style={{ minWidth: '110px' }}>
                  not on deck
                </span>
                <b className="mono" style={{ minWidth: '80px' }}>
                  {nf(s.prep_volume_ml, 0)} mL
                </b>
                <span style={{ flex: '1 1 260px', color: 'var(--fg2)' }}>
                  Source stock for hand dilutions only
                </span>
              </div>
            ))}
          </div>
        </div>

        {/* Tips & Robot Run Settings Card */}
        <div className="card" style={{ minWidth: 0 }}>
          <h2 style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
            <Clock size={18} />
            Tips &amp; robot timing
          </h2>
          <p className="sub">
            Count how many tips to load and match how <span className="mono">main_auto_liquid_height.py</span>{' '}
            will execute this run.
          </p>

          {/* Runtime headline */}
          <div
            style={{
              padding: '10px 12px',
              borderRadius: '8px',
              background: 'var(--soft)',
              border: '1px solid var(--line)',
              marginBottom: '12px',
              display: 'flex',
              justifyContent: 'space-between',
              alignItems: 'baseline',
              flexWrap: 'wrap',
              gap: '8px',
            }}
          >
            <div>
              <div style={{ fontSize: '11.5px', color: 'var(--mut)' }}>Estimated robot run time</div>
              <div className="mono" style={{ fontSize: '20px', fontWeight: 700 }}>
                {rt.label}
              </div>
            </div>
            <div className="mono" style={{ fontSize: '12px', color: 'var(--fg2)', textAlign: 'right' }}>
              Range {formatDuration(rt.lowSeconds)} – {formatDuration(rt.highSeconds)}
              <br />
              {rt.transfers} transfers · {rt.tipChanges} tip changes
              {rt.delaySeconds ? ` · +${formatDuration(rt.delaySeconds)} waits` : ''}
            </div>
          </div>

          {([50, 300, 1000] as const).map((size) => (
            <div
              key={size}
              style={{
                display: 'flex',
                justifyContent: 'space-between',
                gap: '10px',
                alignItems: 'baseline',
                padding: '8px 0',
                borderTop: '1px solid var(--line2)',
              }}
            >
              <span>{size} µL tips</span>
              <span>
                <b className="mono" style={{ fontSize: '18px' }}>
                  {t[size]}
                </b>{' '}
                <span className="hint">
                  {t.racks[size]} rack{t.racks[size] === 1 ? '' : 's'} of 96
                </span>
              </span>
            </div>
          ))}

          {/* Execution mode controls synced with main_auto_liquid_height.py */}
          <div style={{ marginTop: '14px', paddingTop: '12px', borderTop: '1px solid var(--line2)' }}>
            <label className="chk" style={{ display: 'flex', gap: '8px', cursor: 'pointer' }}>
              <input
                type="checkbox"
                checked={autoHeight}
                onChange={(e) => {
                  const useAuto = e.target.checked;
                  setPath('autoLiquidHeight', useAuto);
                  setPath('stockVolumeCheck', !useAuto);
                }}
              />
              <span>
                Auto liquid height (<span className="mono">main_auto_liquid_height.py</span> — 0
                probe tips)
              </span>
            </label>

            {!autoHeight && (
              <div className="hint" style={{ marginTop: '4px', marginLeft: '22px' }}>
                Legacy liquid-level probing active: uses {t.stockCheckTips} extra 300 µL tip
                {t.stockCheckTips === 1 ? '' : 's'} to measure each bottle before starting.
              </div>
            )}

            <label
              className="chk"
              style={{ marginTop: '8px', display: 'flex', gap: '8px', cursor: 'pointer' }}
            >
              <input
                type="checkbox"
                checked={!!state.newTipEveryTransfer}
                onChange={(e) => setPath('newTipEveryTransfer', e.target.checked)}
              />
              <span>New tip after every pipetting</span>
            </label>

            <div
              style={{
                display: 'grid',
                gridTemplateColumns: '1fr auto',
                gap: '12px',
                alignItems: 'end',
                marginTop: '12px',
              }}
            >
              <div>
                <span className="lbl">Pipetting order</span>
                <div className="seg" role="group" aria-label="Pipetting order">
                  <button
                    type="button"
                    className={pipettingStrategy === 'by_solvent' ? 'on' : ''}
                    onClick={() => setPath('pipettingStrategy', 'by_solvent')}
                    title="Default in main_auto_liquid_height.py: finish one reagent across all vials before switching"
                  >
                    By reagent
                  </button>
                  <button
                    type="button"
                    className={pipettingStrategy === 'by_vial' ? 'on' : ''}
                    onClick={() => setPath('pipettingStrategy', 'by_vial')}
                    title="Complete all reagents inside each vial before moving to the next vial (uses more tips)"
                  >
                    Vial by vial
                  </button>
                </div>
              </div>

              <div className="fld" style={{ margin: 0, width: '135px' }}>
                <label className="lbl" htmlFor="substance-delay-sec">
                  Wait / reagent (s)
                </label>
                <input
                  id="substance-delay-sec"
                  type="number"
                  min={0}
                  max={7200}
                  step={10}
                  className="mono"
                  value={substanceDelaySec}
                  onChange={(e) =>
                    setPath('substanceDelaySec', Math.max(0, Number(e.target.value) || 0))
                  }
                />
              </div>
            </div>

            <div className="hint" style={{ marginTop: '8px' }}>
              &ldquo;By reagent&rdquo; matches Robowski&apos;s default and reuses one tip per
              reagent &amp; tip size. &ldquo;Wait / reagent&rdquo; models{' '}
              <span className="mono">ask_time_delays</span> pauses between reagent additions.
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};
