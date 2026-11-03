// Robowski Studio - High-Contrast Tooltip HTML Generators
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

  let out = `<div style="font-size:12px; line-height:1.45; min-width:240px; max-width:330px; color:#f1f5f3;">`;
  
  // Header row with high-contrast text
  out += `<div style="display:flex; justify-content:space-between; align-items:baseline; gap:8px; border-bottom:1px solid rgba(255,255,255,0.2); padding-bottom:5px; margin-bottom:7px;">`;
  out += `  <strong style="font-size:13px; color:#ffffff; font-weight:700;">Reaction ${ri + 1}</strong>`;
  out += `  <span style="color:#94a3b8; font-family:'IBM Plex Mono',monospace; font-size:11px;">plate ${p} · well ${k} (${coord})</span>`;
  out += `</div>`;

  // High-contrast issue warning box (crisp light-coral on translucent red border)
  if (bad) {
    const issues = (run.issues || []).filter((it: any) => it.row === ri);
    out += `<div style="color:#fca5a5; background:rgba(220,38,38,0.25); border:1px solid rgba(248,113,113,0.5); border-radius:6px; padding:6px 8px; margin-bottom:8px; font-size:11px; line-height:1.4;">`;
    out += `  <strong style="color:#ffffff;">⚠️ Issue:</strong> <span style="color:#fee2e2;">${issues.length ? issues.map((x: any) => esc(x.message)).join('; ') : 'Flagged vial'}</span>`;
    out += `</div>`;
  }

  // Triplet metadata
  if (tri && triMeta[ri]) {
    const tm = triMeta[ri];
    if (tm.blank) {
      out += `<div style="color:#94a3b8; font-style:italic; margin-bottom:4px;">Blank well (no reagents)</div>`;
      out += `</div>`;
      return out;
    }
    out += `<div style="margin-bottom:6px; font-size:11px; color:#cbd5e1;">`;
    out += `  <span>Group: <strong style="color:#ffffff;">${esc(tm.group || '—')}</strong></span>`;
    if (tm.cond) {
      out += ` · <span>Condition: <code style="font-family:'IBM Plex Mono',monospace; color:#38bdf8;">${esc(tm.cond)}</code></span>`;
    }
    out += `</div>`;
  }

  // Reagents & Volumes list
  if (rowData && Array.isArray(rowData.recipe)) {
    const active = rowData.recipe.filter(
      (rec: any) => rec.transfer_volume > 0 || rec.target_concentration > 0
    );
    if (active.length > 0) {
      out += `<div style="margin-bottom:5px; font-weight:600; font-size:11px; color:#cbd5e1; text-transform:uppercase; letter-spacing:0.04em;">Reagents & Volumes:</div>`;
      out += `<div style="display:flex; flex-direction:column; gap:4px;">`;
      active.forEach((rec: any) => {
        const concText =
          state.mode === 'equivalence'
            ? `${rec.value} eq (${rec.target_concentration.toFixed(1)} mM)`
            : `${rec.target_concentration.toFixed(1)} mM`;
        out += `<div style="display:flex; justify-content:space-between; align-items:center; gap:8px;">`;
        out += `  <span style="display:inline-flex; align-items:center; gap:6px;">`;
        out += `    <span style="width:8px; height:8px; border-radius:50%; background:${rec.color}; display:inline-block; flex-shrink:0; box-shadow:0 0 2px rgba(0,0,0,0.5);"></span>`;
        out += `    <strong style="color:#ffffff;">${esc(rec.code)}</strong>${rec.name && rec.name !== rec.code ? ` <span style="color:#cbd5e1; font-size:10px;">${esc(rec.name)}</span>` : ''}`;
        out += `  </span>`;
        out += `  <span style="font-family:'IBM Plex Mono',monospace; font-size:11px; color:#e2e8f0; white-space:nowrap;">`;
        out += `    ${concText} · <strong style="color:#ffffff;">${rec.transfer_volume.toFixed(1)} µL</strong>`;
        out += `  </span>`;
        out += `</div>`;
      });
      out += `</div>`;
    }

    const solvVol = rowData['vol#solvent'] != null ? rowData['vol#solvent'] : 0;
    out += `<div style="margin-top:8px; padding-top:6px; border-top:1px dashed rgba(255,255,255,0.2); display:flex; flex-direction:column; gap:3px; font-size:11px;">`;
    out += `  <div style="display:flex; justify-content:space-between; color:#cbd5e1;">`;
    out += `    <span>Solvent (${esc(state.reactionSolvent || 'solvent')}):</span>`;
    out += `    <span style="font-family:'IBM Plex Mono',monospace; font-weight:600; color:${solvVol < 0 ? '#fca5a5' : '#ffffff'};">${solvVol.toFixed(1)} µL</span>`;
    out += `  </div>`;
    out += `  <div style="display:flex; justify-content:space-between; font-weight:700; margin-top:2px; color:#ffffff;">`;
    out += `    <span>Total Reaction:</span>`;
    out += `    <span style="font-family:'IBM Plex Mono',monospace; font-weight:700; color:#38bdf8;">${(run.vialVolume || 200).toFixed(1)} µL</span>`;
    out += `  </div>`;
    out += `</div>`;
  }

  out += `</div>`;
  return out;
}

export function getStockTipHtml(stock: any, pn: number, c: number, displayKey: string): string {
  const s = stock.rawStock || stock || {};
  let out = `<div style="font-size:12px; line-height:1.45; min-width:210px; max-width:310px; color:#f1f5f3;">`;
  out += `<div style="display:flex; justify-content:space-between; align-items:baseline; gap:8px; border-bottom:1px solid rgba(255,255,255,0.2); padding-bottom:5px; margin-bottom:7px;">`;
  out += `  <strong style="font-size:13px; color:#ffffff; font-weight:700;">Stock ${esc(displayKey)}</strong>`;
  out += `  <span style="color:#94a3b8; font-family:'IBM Plex Mono',monospace; font-size:11px;">plate ${pn} · well ${c}</span>`;
  out += `</div>`;
  out += `<div style="margin-bottom:6px; color:#ffffff; font-weight:600;">${esc(s.source_name || s.source_reagent || stock.key)}</div>`;
  out += `<div style="display:flex; flex-direction:column; gap:3px; font-size:11px;">`;
  out += `  <div style="display:flex; justify-content:space-between;">`;
  out += `    <span style="color:#cbd5e1;">Concentration:</span>`;
  out += `    <span style="font-family:'IBM Plex Mono',monospace; font-weight:600; color:#ffffff;">${s.concentration_mM ?? '—'} mM (${s.dilution_label || 'Direct'})</span>`;
  out += `  </div>`;
  out += `  <div style="display:flex; justify-content:space-between;">`;
  out += `    <span style="color:#cbd5e1;">Prepared Volume:</span>`;
  out += `    <span style="font-family:'IBM Plex Mono',monospace; font-weight:600; color:#ffffff;">${(stock.ml || s.recommended_volume_ml || 0).toFixed(2)} mL / 20 mL</span>`;
  out += `  </div>`;
  out += `  <div style="display:flex; justify-content:space-between;">`;
  out += `    <span style="color:#cbd5e1;">Robot Consumption:</span>`;
  out += `    <span style="font-family:'IBM Plex Mono',monospace; color:#ffffff;">${(((s.consumption_uL || 0)) / 1000).toFixed(2)} mL</span>`;
  out += `  </div>`;
  out += `  <div style="display:flex; justify-content:space-between;">`;
  out += `    <span style="color:#cbd5e1;">Solvent:</span>`;
  out += `    <span style="color:#ffffff;">${esc(s.solvent || 'solvent')}</span>`;
  out += `  </div>`;
  if (s.mass_g != null && s.mass_g > 0) {
    out += `  <div style="display:flex; justify-content:space-between;">`;
    out += `    <span style="color:#cbd5e1;">Mass required:</span>`;
    out += `    <span style="font-family:'IBM Plex Mono',monospace; color:#38bdf8; font-weight:600;">${s.mass_g.toFixed(3)} g</span>`;
    out += `  </div>`;
  }
  out += `</div>`;
  out += `</div>`;
  return out;
}

export function getSolventTipHtml(run: RunResult, state: RunState, pn: number, kind: string): string {
  let out = `<div style="font-size:12px; line-height:1.45; min-width:200px; max-width:310px; color:#f1f5f3;">`;
  out += `<div style="display:flex; justify-content:space-between; align-items:baseline; gap:8px; border-bottom:1px solid rgba(255,255,255,0.2); padding-bottom:5px; margin-bottom:7px;">`;
  out += `  <strong style="font-size:13px; color:#ffffff; font-weight:700;">Reaction Solvent</strong>`;
  out += `  <span style="color:#94a3b8; font-family:'IBM Plex Mono',monospace; font-size:11px;">plate ${pn} · ${kind === 'jar' ? '100 mL Jar' : '20 mL Bottle'}</span>`;
  out += `</div>`;
  out += `<div style="margin-bottom:6px; color:#ffffff; font-weight:600;">${esc(state.reactionSolvent || 'solvent')}</div>`;
  out += `<div style="display:flex; flex-direction:column; gap:3px; font-size:11px;">`;
  out += `  <div style="display:flex; justify-content:space-between;">`;
  out += `    <span style="color:#cbd5e1;">Recommended Fill:</span>`;
  out += `    <span style="font-family:'IBM Plex Mono',monospace; font-weight:600; color:#38bdf8;">${run.solventRecommendedMl.toFixed(1)} mL</span>`;
  out += `  </div>`;
  out += `  <div style="display:flex; justify-content:space-between;">`;
  out += `    <span style="color:#cbd5e1;">Required for Vials:</span>`;
  out += `    <span style="font-family:'IBM Plex Mono',monospace; color:#ffffff;">${((run.solventConsumptionMl || 0)).toFixed(1)} mL</span>`;
  out += `  </div>`;
  out += `</div>`;
  out += `</div>`;
  return out;
}
