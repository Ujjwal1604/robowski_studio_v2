import React, { useState } from 'react';
import { useApp } from '../../context/AppContext';
import { PAL, getVialTipHtml } from '../../engine';
import { PlateHeatmap } from './PlateHeatmap';
import { FixDiffModal } from '../ui/FixDiffModal';

export const CombinationsView: React.FC = () => {
  const {
    state,
    run,
    err,
    page,
    setPage,
    filterBad,
    setFilterBad,
    vialFocus,
    setVialFocus,
    setVisited,
    setView,
    triMeta,
    setOf,
    fixes,
    applyFix,
  } = useApp();

  const [hoverRow, setHoverRow] = useState<number | null>(null);
  const [selectedVial, setSelectedVial] = useState<number | null>(null);
  const [inspectFixIndex, setInspectFixIndex] = useState<number | null>(null);
  const [viewMode, setViewMode] = useState<'table' | 'matrix'>('table');
  const [filterMode, setFilterMode] = useState<
    'all' | 'diluted' | 'high_solvent' | 'low_solvent' | 'bad'
  >('all');
  const [heatmapMetric, setHeatmapMetric] = useState<string>('dilution');
  const [heatmapPlate, setHeatmapPlate] = useState<number>(0);

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
          <button
            type="button"
            className="btn sm"
            onClick={() => {
              setVisited((v) => ({ ...v, setup: true }));
              setView('setup');
            }}
            style={{ marginTop: '12px' }}
          >
            Open Setup
          </button>
        </div>
      </div>
    );
  }

  const tri = state.mode === 'triplet';
  const blockSet = new Set(
    run.issues.filter((x) => x.severity === 'block' && x.row != null).map((x) => x.row as number)
  );

  const allRows = run.rows
    .map((r, i) => ({ r, i, bad: blockSet.has(i) }))
    .filter((x) => !(tri && triMeta[x.i] && triMeta[x.i].blank));

  const vialVol = +state.vialVolume || 500;
  const badN = allRows.filter((x) => x.bad).length;
  const dilutedN = allRows.filter((x) => x.r.recipe.some((rc) => rc.dilution_level > 0)).length;
  const highSolvN = allRows.filter((x) => +x.r['vol#solvent'] >= vialVol * 0.75).length;
  const lowSolvN = allRows.filter((x) => +x.r['vol#solvent'] < vialVol * 0.3).length;

  const list = allRows.filter((x) => {
    if (vialFocus) return vialFocus.rows.has(x.i);
    if (filterMode === 'bad' || filterBad) return x.bad;
    if (filterMode === 'diluted') return x.r.recipe.some((rc) => rc.dilution_level > 0);
    if (filterMode === 'high_solvent') return +x.r['vol#solvent'] >= vialVol * 0.75;
    if (filterMode === 'low_solvent') return +x.r['vol#solvent'] < vialVol * 0.3;
    return true;
  });

  const PS = 50;
  const pages = Math.max(1, Math.ceil(list.length / PS));
  const currentPage = Math.min(page, pages - 1);
  const slice = list.slice(currentPage * PS, currentPage * PS + PS);
  const multi = !tri && (state.sets?.length || 0) > 1;

  const showCol = state.reagents.map(
    (_, i) => !tri || allRows.some((x) => x.r.recipe[i] && x.r.recipe[i].target_concentration > 0)
  );

  const factor = +state.dilutionFactor || 5;
  const activeDetailRow = selectedVial !== null ? selectedVial : hoverRow;

  return (
    <div className="wrap">
      <div className="grid two">
        {/* Left Column: Combinations View (Table or 2D Matrix) */}
        <div className="card" style={{ minWidth: 0 }}>
          {/* Header & View Mode Switcher */}
          <div
            style={{
              display: 'flex',
              justifyContent: 'space-between',
              alignItems: 'center',
              flexWrap: 'wrap',
              gap: '12px',
              marginBottom: '10px',
            }}
          >
            <div>
              <h2 style={{ margin: 0 }}>Combinations</h2>
              <p className="sub" style={{ margin: '2px 0 0' }}>
                {list.length} shown of {allRows.length} conditions across {run.plates} plate
                {run.plates === 1 ? '' : 's'}.
              </p>
            </div>

            <div className="seg" role="group" aria-label="Combinations view mode">
              <button
                type="button"
                className={viewMode === 'table' ? 'on' : ''}
                onClick={() => setViewMode('table')}
              >
                ≡ Table List
              </button>
              <button
                type="button"
                className={viewMode === 'matrix' ? 'on' : ''}
                onClick={() => setViewMode('matrix')}
              >
                ▦ 2D Plate Heatmap
              </button>
            </div>
          </div>

          {/* Quick Filter Bar */}
          <div
            style={{
              display: 'flex',
              gap: '6px',
              flexWrap: 'wrap',
              alignItems: 'center',
              marginBottom: '14px',
            }}
          >
            <span
              style={{
                fontSize: '11px',
                fontWeight: 600,
                color: 'var(--mut)',
                textTransform: 'uppercase',
                letterSpacing: '0.04em',
                marginRight: '2px',
              }}
            >
              Filter:
            </span>
            <button
              type="button"
              className={`btn sm ${filterMode === 'all' && !vialFocus ? 'pri' : ''}`}
              onClick={() => {
                setFilterMode('all');
                setFilterBad(false);
                setVialFocus(null);
                setPage(0);
              }}
            >
              All ({allRows.length})
            </button>
            <button
              type="button"
              className={`btn sm ${filterMode === 'diluted' ? 'pri' : ''}`}
              onClick={() => {
                setFilterMode('diluted');
                setFilterBad(false);
                setVialFocus(null);
                setPage(0);
              }}
            >
              Diluted ({dilutedN})
            </button>
            <button
              type="button"
              className={`btn sm ${filterMode === 'high_solvent' ? 'pri' : ''}`}
              onClick={() => {
                setFilterMode('high_solvent');
                setFilterBad(false);
                setVialFocus(null);
                setPage(0);
              }}
            >
              High Solvent ({highSolvN})
            </button>
            <button
              type="button"
              className={`btn sm ${filterMode === 'low_solvent' ? 'pri' : ''}`}
              onClick={() => {
                setFilterMode('low_solvent');
                setFilterBad(false);
                setVialFocus(null);
                setPage(0);
              }}
            >
              Low Solvent ({lowSolvN})
            </button>
            {badN > 0 && (
              <button
                type="button"
                className={`btn sm ${filterMode === 'bad' ? 'pri' : ''}`}
                style={{
                  color: filterMode === 'bad' ? 'var(--acc-fg)' : 'var(--bad)',
                  borderColor: 'var(--bad)',
                }}
                onClick={() => {
                  setFilterMode('bad');
                  setFilterBad(true);
                  setVialFocus(null);
                  setPage(0);
                }}
              >
                Flagged ({badN})
              </button>
            )}
          </div>

          {vialFocus && (
            <div className="focuschip" style={{ marginBottom: '12px' }}>
              <span className="chip warn">
                Focused on {vialFocus.rows.size} vial{vialFocus.rows.size === 1 ? '' : 's'}:{' '}
                {vialFocus.label}
              </span>
              <button
                type="button"
                className="btn sm"
                onClick={() => {
                  setVialFocus(null);
                  setPage(0);
                }}
              >
                Clear Focus
              </button>
            </div>
          )}

          {/* Render Mode: 2D Plate Matrix Heatmap */}
          {viewMode === 'matrix' ? (
            <PlateHeatmap
              run={run}
              state={state}
              triMeta={triMeta}
              blockSet={blockSet}
              filterMode={filterMode}
              selectedVial={selectedVial}
              onSelectVial={(ri) => {
                setSelectedVial(ri);
                if (ri !== null) {
                  setHoverRow(ri);
                }
              }}
              metric={heatmapMetric}
              onMetricChange={setHeatmapMetric}
              plateIndex={heatmapPlate}
              onPlateChange={setHeatmapPlate}
              onNavigateTlc={(ri) => {
                setVisited((v) => ({ ...v, tlc: true }));
                setView('tlc');
              }}
            />
          ) : (
            /* Render Mode: Flat Table View */
            <>
              <div className="tbl" style={{ maxHeight: '620px', overflowY: 'auto' }}>
                <table>
                  <thead>
                    <tr>
                      <th>#</th>
                      <th>Vial</th>
                      {tri && (
                        <>
                          <th>Group</th>
                          <th>Condition</th>
                        </>
                      )}
                      {multi && <th>Set</th>}
                      {state.reagents.map((r, i) =>
                        !showCol[i] ? null : (
                          <th key={r.code + i}>
                            <span className="rdot" style={{ background: rcol(i) }}>
                              {r.code}
                            </span>{' '}
                            mM
                          </th>
                        )
                      )}
                      <th>solvent µL</th>
                    </tr>
                  </thead>
                  <tbody>
                    {slice.length ? (
                      slice.map(({ r, i, bad }) => (
                        <tr
                          key={i}
                          className={`hov ${bad ? 'badrow' : ''} ${
                            selectedVial === i ? 'selrow' : ''
                          }`}
                          style={
                            selectedVial === i
                              ? { background: 'var(--soft)', outline: '2px solid var(--acc)' }
                              : undefined
                          }
                          onClick={() => setSelectedVial(selectedVial === i ? null : i)}
                          onMouseEnter={() => setHoverRow(i)}
                          onMouseLeave={() => setHoverRow(null)}
                          data-tip={getVialTipHtml(
                            r.plate_number,
                            r.container_id,
                            i,
                            run,
                            state,
                            triMeta,
                            blockSet
                          )}
                        >
                          <td>{r.global_index + 1}</td>
                          <td className="mono">
                            p{r.plate_number}·{r.container_id}
                          </td>
                          {tri && (
                            <>
                              <td>{(triMeta[i] || {}).group || ''}</td>
                              <td className="mono">{(triMeta[i] || {}).cond || ''}</td>
                            </>
                          )}
                          {multi && (
                            <td>
                              <span
                                className="chip mut"
                                style={{
                                  borderLeft: `4px solid ${rcol(setOf[r.combo_index] || 0)}`,
                                }}
                              >
                                {(state.sets?.[setOf[r.combo_index]] || {}).name || ''}
                              </span>
                            </td>
                          )}
                          {r.recipe.map((rc, ci) =>
                            !showCol[ci] ? null : (
                              <td key={ci} className="mono">
                                {nf(rc.target_concentration, 3)}
                                {rc.dilution_level > 0 && (
                                  <span className="tag">{factor ** rc.dilution_level}×</span>
                                )}
                              </td>
                            )
                          )}
                          <td className="mono">{nf(r['vol#solvent'], 1)}</td>
                        </tr>
                      ))
                    ) : (
                      <tr>
                        <td colSpan={9} className="empty-note">
                          No conditions match this filter.
                        </td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </div>

              {/* Pagination Controls */}
              <div className="pager" style={{ marginTop: '12px' }}>
                <button
                  type="button"
                  className="btn sm"
                  disabled={currentPage <= 0}
                  onClick={() => setPage((p) => Math.max(0, p - 1))}
                >
                  Prev
                </button>
                <span className="mono">
                  {currentPage + 1} / {pages}
                </span>
                <button
                  type="button"
                  className="btn sm"
                  disabled={currentPage >= pages - 1}
                  onClick={() => setPage((p) => Math.min(pages - 1, p + 1))}
                >
                  Next
                </button>
              </div>
            </>
          )}

          {/* Selected or Hovered Vial Recipe Inspector */}
          {activeDetailRow !== null && run.rows[activeDetailRow] && (
            <div
              style={{
                marginTop: '14px',
                padding: '12px 16px',
                background: 'var(--soft)',
                border: '1px solid var(--line)',
                borderRadius: '10px',
                fontSize: '13px',
              }}
            >
              <div
                style={{
                  display: 'flex',
                  justifyContent: 'space-between',
                  alignItems: 'baseline',
                  borderBottom: '1px solid var(--line)',
                  paddingBottom: '6px',
                  marginBottom: '8px',
                }}
              >
                <div>
                  <b>Reaction {run.rows[activeDetailRow].global_index + 1}</b> · Plate{' '}
                  {run.rows[activeDetailRow].plate_number + 1} · Container #
                  {run.rows[activeDetailRow].container_id}
                </div>
                {selectedVial === activeDetailRow && (
                  <button
                    type="button"
                    className="btn sm"
                    style={{ height: '22px', padding: '0 8px', fontSize: '11px' }}
                    onClick={() => setSelectedVial(null)}
                  >
                    Deselect
                  </button>
                )}
              </div>
              <div style={{ lineHeight: 1.6, display: 'flex', flexDirection: 'column', gap: '3px' }}>
                {run.rows[activeDetailRow].recipe
                  .filter((rc) => rc.target_concentration > 0)
                  .map((rc, ci) => (
                    <div key={ci} style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                      <span className="rdot" style={{ background: rcol(ci), height: '18px', minWidth: '24px', fontSize: '10px' }}>
                        {rc.code}
                      </span>
                      <span>
                        <b>{rc.code}</b> ({rc.name || rc.code}): {nf(rc.target_concentration, 3)} mM &larr;{' '}
                        <span className="mono">{nf(rc.transfer_volume, 1)} µL</span> of{' '}
                        <code className="mono">{rc.stock_key}</code>
                        {rc.dilution_level > 0 && ` (${factor ** rc.dilution_level}× hand-diluted)`}
                      </span>
                    </div>
                  ))}
                <div style={{ marginTop: '4px', paddingTop: '4px', borderTop: '1px dashed var(--line)' }}>
                  <b>Solvent ({state.reactionSolvent}):</b>{' '}
                  <span className="mono">{nf(run.rows[activeDetailRow]['vol#solvent'], 1)} µL</span>
                  {run.rows[activeDetailRow]['vol#solvent'] < 0 && (
                    <span style={{ color: 'var(--bad)', fontWeight: 600, marginLeft: '6px' }}>
                      ⚠️ negative solvent
                    </span>
                  )}
                </div>
              </div>
            </div>
          )}
        </div>

        {/* Right Column: Stock usage & Attention */}
        <div style={{ minWidth: 0 }}>
          <div className="card" style={{ marginBottom: '20px' }}>
            <h2>Which stock each reagent uses</h2>
            <p className="sub">Share of total volume pipetted. Lighter = more diluted.</p>
            <div className="bars">
              {state.reagents.map((r, i) => {
                const keys = Object.keys(run.stocks).filter(
                  (k) => run.stocks[k].source_reagent === r.code
                );
                const tot =
                  keys.reduce((a, k) => a + run.stocks[k].consumption_uL, 0) || 1;
                return (
                  <div key={r.code + i}>
                    <span className="rdot" style={{ background: rcol(i) }}>
                      {r.code}
                    </span>
                    <div className="b">
                      {keys.map((k) => {
                        const s = run.stocks[k];
                        return (
                          <i
                            key={k}
                            title={`${k}: ${nf(s.consumption_uL, 1)} µL`}
                            style={{
                              width: `${(100 * s.consumption_uL) / tot}%`,
                              background: rcol(i),
                              opacity: 1 - 0.28 * s.dilution_level,
                            }}
                          />
                        );
                      })}
                    </div>
                    <span className="mono">
                      {keys
                        .map((k) =>
                          run.stocks[k].dilution_label === 'Direct'
                            ? 'direct'
                            : run.stocks[k].dilution_label
                        )
                        .join(' · ')}
                    </span>
                  </div>
                );
              })}
            </div>
          </div>

          <div className="card">
            <h2>Needs attention</h2>
            <p className="sub">
              {badN
                ? `${badN} vial${badN === 1 ? ' has' : 's have'} a blocking issue (marked in red).`
                : 'Nothing to fix.'}
            </p>

            {run.issues.length > 0 ? (
              run.issues.map((issue, idx) => (
                <div
                  key={idx}
                  className={`issue ${issue.severity === 'block' ? 'bad' : 'warn'}`}
                >
                  <span>
                    <b>{issue.type}</b>: {issue.message}
                  </span>
                </div>
              ))
            ) : (
              <div className="issue ok">
                <span>All checks pass. Every vial volume is within limits.</span>
              </div>
            )}

            {badN > 0 && (
              <button
                type="button"
                className="btn sm"
                style={{ marginTop: '12px' }}
                onClick={() => {
                  setFilterMode(filterMode === 'bad' ? 'all' : 'bad');
                  setFilterBad((b) => !b);
                  setPage(0);
                }}
              >
                {filterBad || filterMode === 'bad'
                  ? 'Show all conditions'
                  : 'Show only vials with blocking issues'}
              </button>
            )}

            {/* Verified Auto-Fix Suggestions with Diff Modal */}
            {run.blockingIssues > 0 && fixes.length > 0 && (
              <div style={{ marginTop: '14px', borderTop: '1px solid var(--line)', paddingTop: '12px' }}>
                <div style={{ fontSize: '12px', fontWeight: 600, color: 'var(--mut)', marginBottom: '8px' }}>
                  Verified Auto-Fix Solutions:
                </div>
                <div style={{ display: 'flex', gap: '6px', flexWrap: 'wrap' }}>
                  {fixes.map((f, fi) => (
                    <button
                      key={fi}
                      type="button"
                      className="btn sm"
                      onClick={() => setInspectFixIndex(fi)}
                      title="Inspect solution diff and simulated impact before applying"
                    >
                      {f.label}
                    </button>
                  ))}
                </div>
              </div>
            )}
          </div>
        </div>
      </div>

      <FixDiffModal
        fix={inspectFixIndex !== null ? fixes[inspectFixIndex] : null}
        fixIndex={inspectFixIndex}
        currentState={state}
        currentRun={run}
        onApply={(idx) => {
          applyFix(idx);
          setInspectFixIndex(null);
        }}
        onClose={() => setInspectFixIndex(null)}
      />
    </div>
  );
};
