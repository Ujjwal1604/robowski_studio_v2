import React from 'react';
import { useApp } from '../../context/AppContext';
import { PAL, defaultPlates, getVialTipHtml, getStockTipHtml, getSolventTipHtml } from '../../engine';

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
  const factor = +state.dilutionFactor || 5;

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

  const dp = state.deckPlates || defaultPlates(state.hood);
  const isConfirmed = platesOk();
  const t = run.tipCounts;

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
            <h2>Deck · {left ? 'Left' : 'Right'} hood</h2>
            <p className="sub" style={{ margin: 0 }}>
              Positions are assigned automatically. Bars show how full each bottle will be (of 20
              mL).
            </p>
          </div>

          <div className="seg" role="group" aria-label="Hood">
            <button
              type="button"
              className={left ? 'on' : ''}
              onClick={() => {
                setPath('hood', 'left');
                setPath('deckPlates', null);
              }}
            >
              Left hood
            </button>
            <button
              type="button"
              className={!left ? 'on' : ''}
              onClick={() => {
                setPath('hood', 'right');
                setPath('deckPlates', null);
              }}
            >
              Right hood
            </button>
          </div>
        </div>

        {!run.deck.positions_fit && (
          <div className="issue bad" style={{ marginTop: '12px' }}>
            <span>{run.deck.positions_message}</span>
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
                              (100 * run.solventRecommendedMl) / 100
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

              // Bottle Plate (2x4 = 8 wells)
              return (
                <div key={pn} className="plate">
                  <div className="pt">plate{pn} · Bottle 20 mL (2×4)</div>
                  <div className="wells8">
                    {Array.from({ length: 8 }, (_, c) => {
                      if (isSolventPlate && c === run.deck.solvent_container) {
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
                                  (100 * run.solventRecommendedMl) / 20
                                )}%`,
                              }}
                            />
                            <span>solv</span>
                          </div>
                        );
                      }

                      const stock = byPos[`${pn}:${c}`];
                      if (!stock) return <div key={c} className="well e" />;
                      const pct = Math.min(100, (100 * stock.ml) / 20);
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
                          <span>{displayKey}</span>
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

      {/* 2. Plate numbers configuration card */}
      <div className="card" style={{ marginBottom: '20px' }}>
        <h2>Plate numbers</h2>
        <p className="sub">
          Which deck plates hold the stocks and the solvent. Change these if your deck differs; the Excel follows.
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
              onChange={(e) =>
                setPath('deckPlates', { ...dp, solventKind: e.target.value as 'jar' | 'bottle' })
              }
            >
              <option value="jar">Jar 100 mL</option>
              <option value="bottle">Bottle 20 mL</option>
            </select>
          </div>

          <div className="fld">
            <label className="lbl">Solvent plate</label>
            <select
              value={run.deck.solvent_plate}
              onChange={(e) =>
                setPath('deckPlates', { ...dp, solventPlate: +e.target.value })
              }
            >
              {[3, 4, 5, 6, 7].map((p) => (
                <option key={p} value={p}>
                  {p}
                </option>
              ))}
            </select>
          </div>

          <div className="fld">
            <label className="lbl">Solvent position</label>
            <select
              value={run.deck.solvent_container}
              onChange={(e) =>
                setPath('deckPlates', { ...dp, solventPos: +e.target.value })
              }
            >
              {[0, 1, 2, 3, 4, 5, 6, 7].map((p) => (
                <option key={p} value={p}>
                  {p}
                </option>
              ))}
            </select>
          </div>
        </div>

        <div style={{ marginTop: '14px' }}>
          <span className="lbl">Bottle plates for stocks (filled in this order)</span>
          <div className="seg" role="group" aria-label="Stock plates">
            {[3, 4, 5, 6].map((p) => {
              const curPlates = dp.stockPlates || [3, 4, 5, 6];
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

      {/* 3 & 4: Load list + Tips to load side-by-side */}
      <div className="grid eq">
        {/* Load List Card */}
        <div className="card" style={{ minWidth: 0 }}>
          <h2>Load list</h2>
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

        {/* Tips to load Card */}
        <div className="card" style={{ minWidth: 0 }}>
          <h2>Tips to load</h2>
          <p className="sub">Count how many you need, then refill racks before you start.</p>
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

          <label className="chk" style={{ marginTop: '12px', display: 'flex', gap: '8px', cursor: 'pointer' }}>
            <input
              type="checkbox"
              checked={!!state.stockVolumeCheck}
              onChange={(e) => setPath('stockVolumeCheck', e.target.checked)}
            />
            <span>
              Check stock volumes (one 300 µL tip per stock
              {t.stockCheck ? `, ${t.stockCheckTips} here` : ''})
            </span>
          </label>

          <label className="chk" style={{ marginTop: '6px', display: 'flex', gap: '8px', cursor: 'pointer' }}>
            <input
              type="checkbox"
              checked={!!state.newTipEveryTransfer}
              onChange={(e) => setPath('newTipEveryTransfer', e.target.checked)}
            />
            <span>New tip after every pipetting</span>
          </label>

          <div className="hint" style={{ marginTop: '8px' }}>
            A new tip is taken only when the tip size or the substance changes, unless the box above
            is ticked.
          </div>
        </div>
      </div>
    </div>
  );
};
