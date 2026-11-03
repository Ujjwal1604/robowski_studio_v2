import { RunResult, RunState } from '../types';

function esc(str: any): string {
  return String(str == null ? '' : str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export function getVialTipHtml(
  p: number,
  k: number,
  ri: number,
  run: RunResult | null,
  state: RunState,
  triMeta: any[] = [],
  blockSet?: Set<number>
): string {
  if (!run) return '';
  const rowLetters = ['A', 'B', 'C', 'D', 'E', 'F'];
  const rIdx = Math.floor(k / 9);
  const cIdx = (k % 9) + 1;
  const coord = rIdx >= 0 && rIdx < 6 ? `${rowLetters[rIdx]}${cIdx}` : `W${k + 1}`;
  const bad = blockSet ? blockSet.has(ri) : (run.issues || []).some((x) => x.severity === 'block' && x.row === ri);
  const tri = state.mode === 'triplet';
  const rowData = run.rows?.[ri];

  let out = `<div style="font-size:12px; line-height:1.45; min-width:220px; max-width:320px;">`;
  out += `<div style="display:flex; justify-content:space-between; align-items:baseline; gap:8px; border-bottom:1px solid rgba(255,255,255,0.18); padding-bottom:4px; margin-bottom:6px;">`;
  out += `  <strong style="font-size:13px; color:var(--fg);">Reaction ${ri + 1}</strong>`;
  out += `  <span style="opacity:0.8; font-family:'IBM Plex Mono',monospace; font-size:11px;">plate ${p} · well ${k} (${coord})</span>`;
  out += `</div>`;

  if (bad) {
    const issues = (run.issues || []).filter((it: any) => it.row === ri);
    out += `<div style="color:var(--bad, #f87171); background:rgba(239,68,68,0.15); border-radius:4px; padding:4px 6px; margin-bottom:6px; font-size:11px;">`;
    out += `  <strong>⚠️ Issue:</strong> ${issues.length ? issues.map((x: any) => esc(x.message)).join('; ') : 'Flagged vial'}`;
    out += `</div>`;
  }

  if (tri && triMeta[ri]) {
    const tm = triMeta[ri];
    if (tm.blank) {
      out += `<div style="opacity:0.75; font-style:italic; margin-bottom:4px;">Blank well (no reagents)</div>`;
      out += `</div>`;
      return out;
    }
    out += `<div style="margin-bottom:6px; font-size:11px;">`;
    out += `  <span>Group: <strong>${esc(tm.group || '—')}</strong></span>`;
    if (tm.cond) {
      out += ` · <span>Condition: <code style="font-family:'IBM Plex Mono',monospace;">${esc(tm.cond)}</code></span>`;
    }
    out += `</div>`;
  }

  if (rowData && Array.isArray(rowData.recipe)) {
    const active = rowData.recipe.filter(
      (rec: any) => rec.transfer_volume > 0 || rec.target_concentration > 0
    );
    if (active.length > 0) {
      out += `<div style="margin-bottom:4px; font-weight:600; font-size:11px; opacity:0.85;">Reagents & Volumes:</div>`;
      out += `<div style="display:flex; flex-direction:column; gap:3px;">`;
      active.forEach((rec: any) => {
        const concText =
          state.mode === 'equivalence'
            ? `${rec.value} eq (${rec.target_concentration.toFixed(1)} mM)`
            : `${rec.target_concentration.toFixed(1)} mM`;
        out += `<div style="display:flex; justify-content:space-between; align-items:center; gap:8px;">`;
        out += `  <span style="display:inline-flex; align-items:center; gap:5px;">`;
        out += `    <span style="width:7px; height:7px; border-radius:50%; background:${rec.color}; display:inline-block; flex-shrink:0;"></span>`;
        out += `    <strong>${esc(rec.code)}</strong>${rec.name && rec.name !== rec.code ? ` <span style="opacity:0.75; font-size:10px;">${esc(rec.name)}</span>` : ''}`;
        out += `  </span>`;
        out += `  <span style="font-family:'IBM Plex Mono',monospace; font-size:11px; white-space:nowrap;">`;
        out += `    ${concText} · ${rec.transfer_volume.toFixed(1)} µL`;
        out += `  </span>`;
        out += `</div>`;
      });
      out += `</div>`;
    }

    const solvVol = rowData['vol#solvent'] != null ? rowData['vol#solvent'] : 0;
    out += `<div style="margin-top:6px; padding-top:4px; border-top:1px dashed rgba(255,255,255,0.18); display:flex; flex-direction:column; gap:2px; font-size:11px;">`;
    out += `  <div style="display:flex; justify-content:space-between; opacity:0.85;">`;
    out += `    <span>Solvent (${esc(state.reactionSolvent || 'solvent')}):</span>`;
    out += `    <span style="font-family:'IBM Plex Mono',monospace;">${solvVol.toFixed(1)} µL</span>`;
    out += `  </div>`;
    out += `  <div style="display:flex; justify-content:space-between; font-weight:600; margin-top:2px;">`;
    out += `    <span>Total Reaction:</span>`;
    out += `    <span style="font-family:'IBM Plex Mono',monospace;">${(run.vialVolume || 200).toFixed(1)} µL</span>`;
    out += `  </div>`;
    out += `</div>`;
  }

  out += `</div>`;
  return out;
}

export function getStockTipHtml(stock: any, pn: number, c: number, displayKey: string): string {
  const s = stock.rawStock || stock || {};
  let out = `<div style="font-size:12px; line-height:1.45; min-width:200px; max-width:300px;">`;
  out += `<div style="display:flex; justify-content:space-between; align-items:baseline; gap:8px; border-bottom:1px solid rgba(255,255,255,0.18); padding-bottom:4px; margin-bottom:6px;">`;
  out += `  <strong style="font-size:13px; color:var(--fg);">Stock ${esc(displayKey)}</strong>`;
  out += `  <span style="opacity:0.8; font-family:'IBM Plex Mono',monospace; font-size:11px;">plate ${pn} · well ${c}</span>`;
  out += `</div>`;
  out += `<div style="margin-bottom:4px;"><strong>${esc(s.source_name || s.source_reagent || stock.key)}</strong></div>`;
  out += `<div style="display:flex; flex-direction:column; gap:2px; font-size:11px;">`;
  out += `  <div style="display:flex; justify-content:space-between;">`;
  out += `    <span style="opacity:0.8;">Concentration:</span>`;
  out += `    <span style="font-family:'IBM Plex Mono',monospace; font-weight:600;">${s.concentration_mM ?? '—'} mM (${s.dilution_label || 'Direct'})</span>`;
  out += `  </div>`;
  out += `  <div style="display:flex; justify-content:space-between;">`;
  out += `    <span style="opacity:0.8;">Prepared Volume:</span>`;
  out += `    <span style="font-family:'IBM Plex Mono',monospace; font-weight:600;">${(stock.ml || s.recommended_volume_ml || 0).toFixed(2)} mL / 20 mL</span>`;
  out += `  </div>`;
  out += `  <div style="display:flex; justify-content:space-between;">`;
  out += `    <span style="opacity:0.8;">Robot Consumption:</span>`;
  out += `    <span style="font-family:'IBM Plex Mono',monospace;">${(((s.consumption_uL || 0)) / 1000).toFixed(2)} mL</span>`;
  out += `  </div>`;
  out += `  <div style="display:flex; justify-content:space-between;">`;
  out += `    <span style="opacity:0.8;">Solvent:</span>`;
  out += `    <span>${esc(s.solvent || 'solvent')}</span>`;
  out += `  </div>`;
  if (s.mass_g != null && s.mass_g > 0) {
    out += `  <div style="display:flex; justify-content:space-between;">`;
    out += `    <span style="opacity:0.8;">Mass required:</span>`;
    out += `    <span style="font-family:'IBM Plex Mono',monospace;">${s.mass_g.toFixed(3)} g</span>`;
    out += `  </div>`;
  }
  out += `</div>`;
  out += `</div>`;
  return out;
}

export function getSolventTipHtml(run: RunResult, state: RunState, pn: number, kind: string): string {
  let out = `<div style="font-size:12px; line-height:1.45; min-width:190px; max-width:300px;">`;
  out += `<div style="display:flex; justify-content:space-between; align-items:baseline; gap:8px; border-bottom:1px solid rgba(255,255,255,0.18); padding-bottom:4px; margin-bottom:6px;">`;
  out += `  <strong style="font-size:13px; color:var(--fg);">Reaction Solvent</strong>`;
  out += `  <span style="opacity:0.8; font-family:'IBM Plex Mono',monospace; font-size:11px;">plate ${pn} · ${kind === 'jar' ? '100 mL Jar' : '20 mL Bottle'}</span>`;
  out += `</div>`;
  out += `<div style="margin-bottom:4px;"><strong>${esc(state.reactionSolvent || 'solvent')}</strong></div>`;
  out += `<div style="display:flex; flex-direction:column; gap:2px; font-size:11px;">`;
  out += `  <div style="display:flex; justify-content:space-between;">`;
  out += `    <span style="opacity:0.8;">Recommended Fill:</span>`;
  out += `    <span style="font-family:'IBM Plex Mono',monospace; font-weight:600;">${run.solventRecommendedMl.toFixed(1)} mL</span>`;
  out += `  </div>`;
  out += `  <div style="display:flex; justify-content:space-between;">`;
  out += `    <span style="opacity:0.8;">Required for Vials:</span>`;
  out += `    <span style="font-family:'IBM Plex Mono',monospace;">${((run.solventConsumptionMl || 0)).toFixed(1)} mL</span>`;
  out += `  </div>`;
  out += `</div>`;
  out += `</div>`;
  return out;
}
