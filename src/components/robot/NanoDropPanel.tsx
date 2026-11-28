import React, { useMemo, useRef, useState } from 'react';
import {
  Activity,
  AlertTriangle,
  CheckCircle2,
  Download,
  Droplets,
  Layers,
  Microscope,
  Power,
  ShieldAlert,
  Sparkles,
  Upload,
  Wind,
} from 'lucide-react';
import type { RobotHardwareState } from '../../engine/predictor/backendClient';
import {
  buildCleanNanoDropCsv,
  deconvolveMixture,
  findSpectrumPeak,
  parseNanoDropFile,
  subtractBlank,
  type DeconvolutionReference,
  type ParsedNanoDropDataset,
} from '../../utils/nanodropParser';

const CURVE_COLORS = [
  '#2563eb',
  '#dc2626',
  '#059669',
  '#d97706',
  '#7c3aed',
  '#0891b2',
  '#db2777',
  '#4f46e5',
  '#65a30d',
  '#ea580c',
  '#0d9488',
  '#9333ea',
];

interface NanoDropPanelProps {
  hw: RobotHardwareState | null;
  cmdBusy: boolean;
  onRunCommand: (command: string, params?: Record<string, any>) => Promise<unknown>;
  onToast?: (msg: string) => void;
}

interface RefSlot {
  spectrumId: string;
  refConcMm: string;
}

function downloadTextFile(filename: string, content: string, mime = 'text/csv;charset=utf-8'): void {
  const blob = new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export const NanoDropPanel: React.FC<NanoDropPanelProps> = ({
  hw,
  cmdBusy,
  onRunCommand,
  onToast,
}) => {
  const [subTab, setSubTab] = useState<'controls' | 'viewer'>('controls');
  const [ndModel, setNdModel] = useState<'nd_2000c' | 'nd_2000'>('nd_2000c');

  // UV-Vis XML / CSV Viewer state
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const [dataset, setDataset] = useState<ParsedNanoDropDataset | null>(null);
  const [parseError, setParseError] = useState<string>('');
  const [skipRemove, setSkipRemove] = useState<boolean>(true);
  const [blankId, setBlankId] = useState<string>('');
  const [minNm, setMinNm] = useState<number>(220);
  const [maxNm, setMaxNm] = useState<number>(750);
  const [visibleIds, setVisibleIds] = useState<string[]>([]);
  const [sampleFilter, setSampleFilter] = useState<string>('');
  const [hoverWl, setHoverWl] = useState<number | null>(null);

  // Spectral Deconvolution state
  const [showDeconv, setShowDeconv] = useState<boolean>(false);
  const [refSlots, setRefSlots] = useState<RefSlot[]>([
    { spectrumId: '', refConcMm: '' },
    { spectrumId: '', refConcMm: '' },
  ]);
  const [targetSampleId, setTargetSampleId] = useState<string>('');
  const [includeBaseline, setIncludeBaseline] = useState<boolean>(true);

  const ndConnected = Boolean(hw?.nanodropConnected);
  const activeNdId = (hw?.nanodropId === 'nd_2000' ? 'nd_2000' : ndModel) as 'nd_2000c' | 'nd_2000';

  const handleFileLoad = async (file: File | undefined | null) => {
    if (!file) return;
    if (file.size > 25 * 1024 * 1024) {
      setParseError('File is larger than 25 MB. Please upload a standard NanoDrop XML or CSV file.');
      return;
    }
    try {
      const text = await file.text();
      const parsed = parseNanoDropFile(file.name, text);
      setDataset(parsed);
      setParseError('');
      const wlMin = parsed.wavelengths[0] ?? 220;
      const wlMax = parsed.wavelengths[parsed.wavelengths.length - 1] ?? 750;
      setMinNm(Math.max(wlMin, 220));
      setMaxNm(Math.min(wlMax, 750));
      setBlankId('');
      const kept = parsed.spectra.filter((s) => !s.isMarkedRemove);
      setVisibleIds(kept.slice(0, 8).map((s) => s.id));
      setTargetSampleId(kept[kept.length - 1]?.id || parsed.spectra[0]?.id || '');
      setRefSlots([
        { spectrumId: kept[0]?.id || '', refConcMm: '' },
        { spectrumId: kept[1]?.id || '', refConcMm: '' },
      ]);
      onToast?.(`Loaded ${parsed.spectra.length} UV-Vis spectra from ${file.name}`);
    } catch (err: any) {
      setParseError(err?.message || 'Could not read NanoDrop file.');
    }
  };

  const keptSpectra = useMemo(() => {
    if (!dataset) return [];
    return dataset.spectra.filter((s) => (!skipRemove || !s.isMarkedRemove) && s.id !== blankId);
  }, [dataset, skipRemove, blankId]);

  const blankValues = useMemo(() => {
    if (!dataset || !blankId) return null;
    return dataset.spectra.find((s) => s.id === blankId)?.values || null;
  }, [dataset, blankId]);

  const filteredSpectraList = useMemo(() => {
    const q = sampleFilter.trim().toLowerCase();
    if (!q) return keptSpectra;
    return keptSpectra.filter((s) => s.name.toLowerCase().includes(q));
  }, [keptSpectra, sampleFilter]);

  const plottedCurves = useMemo(() => {
    if (!dataset) return [];
    const visSet = new Set(visibleIds);
    return keptSpectra
      .filter((s) => visSet.has(s.id))
      .slice(0, 16)
      .map((s, idx) => {
        const vals = subtractBlank(s.values, blankValues);
        const peak = findSpectrumPeak(dataset.wavelengths, vals, minNm, maxNm);
        return {
          spectrum: s,
          values: vals,
          peak,
          color: CURVE_COLORS[idx % CURVE_COLORS.length],
        };
      });
  }, [dataset, keptSpectra, visibleIds, blankValues, minNm, maxNm]);

  // SVG plot geometry
  const plotGeom = useMemo(() => {
    if (!dataset || plottedCurves.length === 0) return null;
    const indices: number[] = [];
    for (let i = 0; i < dataset.wavelengths.length; i += 1) {
      const wl = dataset.wavelengths[i];
      if (wl >= minNm && wl <= maxNm) indices.push(i);
    }
    if (indices.length < 2) return null;

    let yMin = Infinity;
    let yMax = -Infinity;
    for (const c of plottedCurves) {
      for (const idx of indices) {
        const v = c.values[idx];
        if (Number.isFinite(v)) {
          if (v < yMin) yMin = v;
          if (v > yMax) yMax = v;
        }
      }
    }
    if (!Number.isFinite(yMin) || !Number.isFinite(yMax)) return null;
    if (Math.abs(yMax - yMin) < 1e-6) {
      yMin -= 0.1;
      yMax += 0.1;
    } else {
      const pad = (yMax - yMin) * 0.08;
      yMin = Math.min(0, yMin - pad * 0.4);
      yMax += pad;
    }

    const w = 720;
    const h = 290;
    const padL = 52;
    const padR = 16;
    const padT = 14;
    const padB = 34;
    const plotW = w - padL - padR;
    const plotH = h - padT - padB;
    const x0 = dataset.wavelengths[indices[0]];
    const x1 = dataset.wavelengths[indices[indices.length - 1]];
    const xSpan = Math.max(1, x1 - x0);
    const ySpan = Math.max(1e-6, yMax - yMin);

    const mapX = (wl: number) => padL + ((wl - x0) / xSpan) * plotW;
    const mapY = (abs: number) => padT + plotH - ((abs - yMin) / ySpan) * plotH;

    // Downsample if > 400 points so SVG stays crisp and fast on phones
    const step = Math.max(1, Math.floor(indices.length / 360));
    const sampled = indices.filter((_, k) => k % step === 0 || k === indices.length - 1);

    const paths = plottedCurves.map((c) => {
      const d = sampled
        .map((idx, k) => `${k === 0 ? 'M' : 'L'}${mapX(dataset.wavelengths[idx]).toFixed(1)},${mapY(c.values[idx]).toFixed(1)}`)
        .join(' ');
      return { ...c, d };
    });

    const xTicks = [0, 0.25, 0.5, 0.75, 1].map((t) => Math.round(x0 + t * xSpan));
    const yTicks = [0, 0.25, 0.5, 0.75, 1].map((t) => yMin + t * ySpan);

    return { w, h, padL, padR, padT, padB, plotW, plotH, x0, x1, yMin, yMax, mapX, mapY, paths, xTicks, yTicks };
  }, [dataset, plottedCurves, minNm, maxNm]);

  const toggleVisible = (id: string) => {
    setVisibleIds((prev) =>
      prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id].slice(-16)
    );
  };

  // Deconvolution computation
  const activeReferences = useMemo<DeconvolutionReference[]>(() => {
    if (!dataset) return [];
    const seen = new Set<string>();
    const out: DeconvolutionReference[] = [];
    for (const slot of refSlots) {
      if (!slot.spectrumId || seen.has(slot.spectrumId)) continue;
      const sp = dataset.spectra.find((s) => s.id === slot.spectrumId);
      if (!sp) continue;
      seen.add(slot.spectrumId);
      const conc = Number(slot.refConcMm);
      out.push({
        id: sp.id,
        name: sp.name,
        values: subtractBlank(sp.values, blankValues),
        refConcMm: Number.isFinite(conc) && conc > 0 ? conc : undefined,
      });
    }
    return out;
  }, [dataset, refSlots, blankValues]);

  const singleDeconv = useMemo(() => {
    if (!showDeconv || !dataset || activeReferences.length === 0 || !targetSampleId) return null;
    const sp = dataset.spectra.find((s) => s.id === targetSampleId);
    if (!sp) return null;
    const mixVals = subtractBlank(sp.values, blankValues);
    return {
      sampleName: sp.name,
      result: deconvolveMixture(dataset.wavelengths, mixVals, activeReferences, {
        minNm,
        maxNm,
        includeBaseline,
      }),
    };
  }, [showDeconv, dataset, activeReferences, targetSampleId, blankValues, minNm, maxNm, includeBaseline]);

  const batchDeconvRows = useMemo(() => {
    if (!showDeconv || !dataset || activeReferences.length === 0) return [];
    const refIds = new Set(activeReferences.map((r) => r.id));
    return keptSpectra
      .filter((s) => !refIds.has(s.id))
      .map((s) => {
        const res = deconvolveMixture(
          dataset.wavelengths,
          subtractBlank(s.values, blankValues),
          activeReferences,
          { minNm, maxNm, includeBaseline }
        );
        return { spectrum: s, result: res };
      });
  }, [showDeconv, dataset, activeReferences, keptSpectra, blankValues, minNm, maxNm, includeBaseline]);

  const handleExportCleanCsv = () => {
    if (!dataset) return;
    const csv = buildCleanNanoDropCsv(dataset, { skipRemove, blankId, minNm, maxNm });
    const base = dataset.fileName.replace(/\.(xml|csv|tsv|txt)$/i, '');
    downloadTextFile(`${base}_clean.csv`, csv);
    onToast?.('Exported clean NanoDrop CSV');
  };

  const handleExportDeconvCsv = () => {
    if (!dataset || activeReferences.length === 0 || batchDeconvRows.length === 0) return;
    const cols = [
      'sample',
      ...activeReferences.flatMap((r) => [
        `${r.name}_weight`,
        `${r.name}_pct`,
        ...(r.refConcMm ? [`${r.name}_mM`] : []),
      ]),
      'baseline_AU',
      'R2',
      'RMSE',
    ];
    const lines = [cols.map((c) => `"${c.replace(/"/g, '""')}"`).join(',')];
    for (const row of batchDeconvRows) {
      if (!row.result) continue;
      const r = row.result;
      const vals = [
        `"${row.spectrum.name.replace(/"/g, '""')}"`,
        ...activeReferences.flatMap((ref, idx) => [
          r.weights[idx].toFixed(4),
          r.fractionsPct[idx].toFixed(2),
          ...(ref.refConcMm ? [(r.concentrationsMm[idx] ?? 0).toFixed(4)] : []),
        ]),
        r.baseline.toFixed(5),
        r.r2.toFixed(5),
        r.rmse.toFixed(5),
      ];
      lines.push(vals.join(','));
    }
    const base = dataset.fileName.replace(/\.(xml|csv|tsv|txt)$/i, '');
    downloadTextFile(`${base}_deconvolution.csv`, lines.join('\n'));
    onToast?.('Exported UV-Vis deconvolution CSV');
  };

  return (
    <div className="card" style={{ marginBottom: '20px' }}>
      {/* Header + sub-tab switcher */}
      <div
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'flex-start',
          gap: '12px',
          flexWrap: 'wrap',
          marginBottom: '12px',
        }}
      >
        <div>
          <h2 style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
            <Microscope size={18} />
            NanoDrop UV-Vis Studio
          </h2>
          <p className="sub" style={{ margin: '2px 0 0 0' }}>
            Control the NanoDrop lid &amp; pedestal wash cycle (<span className="mono">nanodrop.py</span>)
            and inspect or deconvolve exported <span className="mono">.xml</span> /{' '}
            <span className="mono">.csv</span> spectra right here.
          </p>
        </div>

        <div style={{ display: 'flex', gap: '6px', flexWrap: 'wrap' }}>
          <button
            type="button"
            className={`btn sm${subTab === 'controls' ? ' pri' : ''}`}
            onClick={() => setSubTab('controls')}
          >
            Pedestal &amp; Lid Controls
          </button>
          <button
            type="button"
            className={`btn sm${subTab === 'viewer' ? ' pri' : ''}`}
            onClick={() => setSubTab('viewer')}
          >
            XML Viewer &amp; Deconvolution
          </button>
        </div>
      </div>

      {/* TAB 1: HARDWARE CONTROLS */}
      {subTab === 'controls' && (
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 280px), 1fr))',
            gap: '12px',
          }}
        >
          {/* Connection & Lid */}
          <div
            style={{
              padding: '12px 14px',
              borderRadius: '8px',
              background: 'var(--soft)',
              border: '1px solid var(--line)',
            }}
          >
            <div
              style={{
                display: 'flex',
                justifyContent: 'space-between',
                alignItems: 'center',
                gap: '8px',
                marginBottom: '8px',
                flexWrap: 'wrap',
              }}
            >
              <span style={{ fontWeight: 700, fontSize: '13px', display: 'flex', alignItems: 'center', gap: '6px' }}>
                <Power size={14} />
                <span>Arduino Connection &amp; Lid</span>
              </span>
              <span
                className="mono"
                style={{
                  fontSize: '11px',
                  fontWeight: 600,
                  color: ndConnected ? 'var(--ok)' : 'var(--mut)',
                }}
              >
                {ndConnected
                  ? `Connected (${activeNdId} · lid ${hw?.nanodropLidClosed ? 'closed' : 'open'})`
                  : 'COM free for measure_spectrum.py'}
              </span>
            </div>

            <div style={{ display: 'flex', gap: '6px', flexWrap: 'wrap', alignItems: 'center', marginBottom: '10px' }}>
              <select
                value={ndModel}
                onChange={(e) => setNdModel(e.target.value as 'nd_2000c' | 'nd_2000')}
                aria-label="NanoDrop model"
                style={{
                  height: '30px',
                  padding: '0 8px',
                  borderRadius: '6px',
                  border: '1px solid var(--line)',
                  background: 'var(--panel)',
                  color: 'var(--fg)',
                  fontSize: '12px',
                }}
              >
                <option value="nd_2000c">NanoDrop 2000c (COM6)</option>
                <option value="nd_2000">NanoDrop 2000 (COM4)</option>
              </select>
              <button
                type="button"
                className="btn sm pri"
                disabled={cmdBusy}
                onClick={() => onRunCommand('nanodrop_connect', { nd_id: ndModel })}
              >
                Connect NanoDrop
              </button>
              <button
                type="button"
                className="btn sm"
                disabled={cmdBusy}
                onClick={() => onRunCommand('nanodrop_disconnect')}
                style={
                  ndConnected
                    ? {
                        color: 'var(--warn)',
                        borderColor: 'color-mix(in srgb, var(--warn) 60%, var(--line))',
                        fontWeight: 600,
                      }
                    : undefined
                }
                title="Close valves and free the NanoDrop COM port so measure_spectrum.py can run"
              >
                Release COM Port
              </button>
            </div>

            <div style={{ display: 'flex', gap: '6px', flexWrap: 'wrap' }}>
              <button
                type="button"
                className="btn sm"
                disabled={cmdBusy}
                onClick={() => onRunCommand('nanodrop_lid_open', { nd_id: ndModel })}
              >
                Open Lid
              </button>
              {ndModel === 'nd_2000c' && (
                <button
                  type="button"
                  className="btn sm"
                  disabled={cmdBusy}
                  onClick={() => onRunCommand('nanodrop_lid_half_open', { nd_id: ndModel })}
                >
                  Half-Open Lid
                </button>
              )}
              <button
                type="button"
                className="btn sm"
                disabled={cmdBusy}
                onClick={() => onRunCommand('nanodrop_lid_close', { nd_id: ndModel })}
              >
                Close Lid
              </button>
              <button
                type="button"
                className="btn sm"
                disabled={cmdBusy}
                onClick={() => onRunCommand('move_to_nanodrop')}
                title="Move gantry arm safely at traverse height directly over the NanoDrop pedestal"
              >
                Move Arm Over Pedestal
              </button>
            </div>
          </div>

          {/* Pedestal Wash & Dry */}
          <div
            style={{
              padding: '12px 14px',
              borderRadius: '8px',
              background: 'var(--soft)',
              border: '1px solid var(--line)',
            }}
          >
            <div style={{ fontWeight: 700, fontSize: '13px', marginBottom: '6px', display: 'flex', alignItems: 'center', gap: '6px' }}>
              <Droplets size={14} />
              <span>Pedestal Cleaning &amp; Drying</span>
            </div>
            <div style={{ fontSize: '11.5px', color: 'var(--mut)', marginBottom: '10px', lineHeight: 1.45 }}>
              Runs the exact solvent flush, vacuum suction, and blower sequence from{' '}
              <span className="mono">nanodrop.py</span>. Remember to click{' '}
              <strong>Release COM Port</strong> before running <span className="mono">measure_spectrum.py</span>.
            </div>
            <div style={{ display: 'flex', gap: '6px', flexWrap: 'wrap' }}>
              <button
                type="button"
                className="btn sm pri"
                disabled={cmdBusy}
                onClick={() => onRunCommand('nanodrop_wash_cycle', { nd_id: ndModel })}
                style={{ display: 'inline-flex', alignItems: 'center', gap: '5px' }}
              >
                <Sparkles size={13} />
                <span>Full Wash &amp; Blow-Dry (~35s)</span>
              </button>
              <button
                type="button"
                className="btn sm"
                disabled={cmdBusy}
                onClick={() => onRunCommand('nanodrop_flush', { nd_id: ndModel })}
              >
                Flush Solvent (~15s)
              </button>
              <button
                type="button"
                className="btn sm"
                disabled={cmdBusy}
                onClick={() => onRunCommand('nanodrop_dry', { nd_id: ndModel })}
                style={{ display: 'inline-flex', alignItems: 'center', gap: '5px' }}
              >
                <Wind size={13} />
                <span>Vacuum &amp; Air Dry</span>
              </button>
              <button
                type="button"
                className="btn sm"
                disabled={cmdBusy}
                onClick={() => onRunCommand('nanodrop_close_all', { nd_id: ndModel })}
                style={{
                  color: 'var(--bad)',
                  borderColor: 'color-mix(in srgb, var(--bad) 50%, var(--line))',
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: '4px',
                }}
              >
                <ShieldAlert size={13} />
                <span>Close All Valves</span>
              </button>
            </div>
          </div>
        </div>
      )}

      {/* TAB 2: XML / CSV VIEWER & DECONVOLUTION */}
      {subTab === 'viewer' && (
        <div>
          {/* Dropzone / file loader */}
          <div
            onDragOver={(e) => {
              e.preventDefault();
              e.stopPropagation();
            }}
            onDrop={(e) => {
              e.preventDefault();
              e.stopPropagation();
              handleFileLoad(e.dataTransfer.files?.[0]);
            }}
            style={{
              padding: '14px',
              borderRadius: '10px',
              border: '1.5px dashed var(--line)',
              background: 'var(--soft)',
              display: 'flex',
              justifyContent: 'space-between',
              alignItems: 'center',
              gap: '12px',
              flexWrap: 'wrap',
              marginBottom: '12px',
            }}
          >
            <div style={{ minWidth: 0 }}>
              <div style={{ fontSize: '13px', fontWeight: 700, display: 'flex', alignItems: 'center', gap: '6px' }}>
                <Upload size={14} />
                <span>
                  {dataset
                    ? `Loaded: ${dataset.fileName} (${dataset.spectra.length} spectra · ${dataset.wavelengths[0]}–${dataset.wavelengths[dataset.wavelengths.length - 1]} nm)`
                    : 'Drop a NanoDrop .xml or .csv UV-Vis file here'}
                </span>
              </div>
              <div style={{ fontSize: '11.5px', color: 'var(--mut)', marginTop: '2px' }}>
                Runs 100% locally in your browser — parses Thermo NanoDrop SpreadsheetML XML exports
                (just like <span className="mono">nanodrop_xml_to_csv_simplified.py</span>) or existing CSV tables.
              </div>
            </div>

            <div style={{ display: 'flex', gap: '6px', flexWrap: 'wrap' }}>
              <input
                ref={fileInputRef}
                type="file"
                accept=".xml,.csv,.tsv,.txt"
                style={{ display: 'none' }}
                onChange={(e) => {
                  handleFileLoad(e.target.files?.[0]);
                  e.target.value = '';
                }}
              />
              <button
                type="button"
                className="btn sm pri"
                onClick={() => fileInputRef.current?.click()}
              >
                {dataset ? 'Load Another File' : 'Choose .xml / .csv File'}
              </button>
              {dataset && (
                <button
                  type="button"
                  className="btn sm"
                  onClick={handleExportCleanCsv}
                  style={{ display: 'inline-flex', alignItems: 'center', gap: '5px' }}
                >
                  <Download size={13} />
                  <span>Export Clean CSV</span>
                </button>
              )}
            </div>
          </div>

          {parseError && (
            <div className="issue bad" style={{ marginBottom: '12px' }}>
              <AlertTriangle size={15} style={{ flexShrink: 0 }} />
              <span>{parseError}</span>
            </div>
          )}

          {dataset && dataset.warnings.length > 0 && (
            <div className="issue warn" style={{ marginBottom: '12px' }}>
              <AlertTriangle size={15} style={{ flexShrink: 0 }} />
              <span>{dataset.warnings.join(' ')}</span>
            </div>
          )}

          {dataset && (
            <>
              {/* Controls bar: blank, range, skip-remove */}
              <div
                style={{
                  display: 'flex',
                  flexWrap: 'wrap',
                  gap: '10px',
                  alignItems: 'center',
                  padding: '10px 12px',
                  borderRadius: '8px',
                  background: 'var(--soft)',
                  border: '1px solid var(--line)',
                  marginBottom: '12px',
                }}
              >
                <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                  <span style={{ fontSize: '12px', color: 'var(--mut)' }}>Blank:</span>
                  <select
                    value={blankId}
                    onChange={(e) => setBlankId(e.target.value)}
                    style={{
                      height: '30px',
                      maxWidth: '180px',
                      padding: '0 8px',
                      borderRadius: '6px',
                      border: '1px solid var(--line)',
                      background: 'var(--panel)',
                      color: 'var(--fg)',
                      fontSize: '12px',
                    }}
                  >
                    <option value="">None (raw absorbance)</option>
                    {dataset.spectra.map((s) => (
                      <option key={s.id} value={s.id}>
                        {s.name}
                      </option>
                    ))}
                  </select>
                </div>

                <div style={{ display: 'flex', alignItems: 'center', gap: '5px' }}>
                  <span style={{ fontSize: '12px', color: 'var(--mut)' }}>Range (nm):</span>
                  <input
                    type="number"
                    value={minNm}
                    onChange={(e) => setMinNm(Number(e.target.value) || 190)}
                    className="mono"
                    style={{
                      width: '68px',
                      height: '30px',
                      padding: '0 6px',
                      borderRadius: '6px',
                      border: '1px solid var(--line)',
                      background: 'var(--panel)',
                      color: 'var(--fg)',
                      fontSize: '12px',
                    }}
                  />
                  <span style={{ fontSize: '12px', color: 'var(--mut)' }}>–</span>
                  <input
                    type="number"
                    value={maxNm}
                    onChange={(e) => setMaxNm(Number(e.target.value) || 850)}
                    className="mono"
                    style={{
                      width: '68px',
                      height: '30px',
                      padding: '0 6px',
                      borderRadius: '6px',
                      border: '1px solid var(--line)',
                      background: 'var(--panel)',
                      color: 'var(--fg)',
                      fontSize: '12px',
                    }}
                  />
                  <button
                    type="button"
                    className="btn sm"
                    onClick={() => {
                      setMinNm(dataset.wavelengths[0] ?? 190);
                      setMaxNm(dataset.wavelengths[dataset.wavelengths.length - 1] ?? 850);
                    }}
                  >
                    Full
                  </button>
                  <button
                    type="button"
                    className="btn sm"
                    onClick={() => {
                      setMinNm(220);
                      setMaxNm(400);
                    }}
                  >
                    UV
                  </button>
                  <button
                    type="button"
                    className="btn sm"
                    onClick={() => {
                      setMinNm(380);
                      setMaxNm(700);
                    }}
                  >
                    Vis
                  </button>
                </div>

                {dataset.removedCount > 0 && (
                  <label style={{ display: 'inline-flex', alignItems: 'center', gap: '5px', fontSize: '12px', cursor: 'pointer' }}>
                    <input
                      type="checkbox"
                      checked={skipRemove}
                      onChange={(e) => setSkipRemove(e.target.checked)}
                    />
                    <span>Skip {dataset.removedCount} “remove” col(s)</span>
                  </label>
                )}

                <button
                  type="button"
                  className={`btn sm${showDeconv ? ' pri' : ''}`}
                  onClick={() => setShowDeconv((v) => !v)}
                  style={{ marginLeft: 'auto', display: 'inline-flex', alignItems: 'center', gap: '5px' }}
                >
                  <Layers size={13} />
                  <span>{showDeconv ? 'Hide Deconvolution' : 'Mixture Deconvolution'}</span>
                </button>
              </div>

              {/* Interactive SVG UV-Vis Spectrum Chart */}
              {plotGeom ? (
                <div
                  style={{
                    borderRadius: '8px',
                    border: '1px solid var(--line)',
                    background: 'var(--bg)',
                    padding: '10px',
                    marginBottom: '12px',
                  }}
                >
                  <div
                    style={{
                      display: 'flex',
                      justifyContent: 'space-between',
                      alignItems: 'center',
                      gap: '8px',
                      flexWrap: 'wrap',
                      marginBottom: '6px',
                      fontSize: '11.5px',
                      color: 'var(--mut)',
                    }}
                  >
                    <span>
                      Showing <strong>{plottedCurves.length}</strong> spectrum curve(s)
                      {blankId ? ' · blank subtracted' : ''}
                    </span>
                    {hoverWl != null && (
                      <span className="mono" style={{ color: 'var(--fg)', fontWeight: 600 }}>
                        Cursor: {hoverWl} nm
                      </span>
                    )}
                  </div>

                  <svg
                    viewBox={`0 0 ${plotGeom.w} ${plotGeom.h}`}
                    style={{ width: '100%', height: 'auto', display: 'block' }}
                    onMouseMove={(e) => {
                      const rect = e.currentTarget.getBoundingClientRect();
                      const svgX = ((e.clientX - rect.left) / rect.width) * plotGeom.w;
                      if (svgX >= plotGeom.padL && svgX <= plotGeom.w - plotGeom.padR) {
                        const frac = (svgX - plotGeom.padL) / plotGeom.plotW;
                        setHoverWl(Math.round(plotGeom.x0 + frac * (plotGeom.x1 - plotGeom.x0)));
                      } else {
                        setHoverWl(null);
                      }
                    }}
                    onMouseLeave={() => setHoverWl(null)}
                  >
                    {/* Grid lines & Y ticks */}
                    {plotGeom.yTicks.map((yt, i) => {
                      const y = plotGeom.mapY(yt);
                      return (
                        <g key={`y-${i}`}>
                          <line
                            x1={plotGeom.padL}
                            x2={plotGeom.w - plotGeom.padR}
                            y1={y}
                            y2={y}
                            stroke="var(--line2)"
                            strokeWidth="1"
                          />
                          <text
                            x={plotGeom.padL - 6}
                            y={y + 3.5}
                            textAnchor="end"
                            fontSize="10"
                            fill="var(--mut)"
                            className="mono"
                          >
                            {yt.toFixed(2)}
                          </text>
                        </g>
                      );
                    })}

                    {/* X ticks */}
                    {plotGeom.xTicks.map((xt, i) => {
                      const x = plotGeom.mapX(xt);
                      return (
                        <g key={`x-${i}`}>
                          <line
                            x1={x}
                            x2={x}
                            y1={plotGeom.padT}
                            y2={plotGeom.h - plotGeom.padB}
                            stroke="var(--line2)"
                            strokeWidth="1"
                            strokeDasharray="3,3"
                          />
                          <text
                            x={x}
                            y={plotGeom.h - 14}
                            textAnchor="middle"
                            fontSize="10"
                            fill="var(--mut)"
                            className="mono"
                          >
                            {xt} nm
                          </text>
                        </g>
                      );
                    })}

                    {/* Zero baseline if inside range */}
                    {plotGeom.yMin < 0 && plotGeom.yMax > 0 && (
                      <line
                        x1={plotGeom.padL}
                        x2={plotGeom.w - plotGeom.padR}
                        y1={plotGeom.mapY(0)}
                        y2={plotGeom.mapY(0)}
                        stroke="var(--mut)"
                        strokeWidth="1"
                        strokeDasharray="4,3"
                      />
                    )}

                    {/* Spectrum curves */}
                    {plotGeom.paths.map((p) => (
                      <path
                        key={p.spectrum.id}
                        d={p.d}
                        fill="none"
                        stroke={p.color}
                        strokeWidth="1.75"
                        strokeLinejoin="round"
                      />
                    ))}

                    {/* Hover crosshair */}
                    {hoverWl != null && hoverWl >= plotGeom.x0 && hoverWl <= plotGeom.x1 && (
                      <line
                        x1={plotGeom.mapX(hoverWl)}
                        x2={plotGeom.mapX(hoverWl)}
                        y1={plotGeom.padT}
                        y2={plotGeom.h - plotGeom.padB}
                        stroke="var(--acc)"
                        strokeWidth="1"
                        strokeDasharray="3,2"
                      />
                    )}
                  </svg>

                  {/* Peak λmax legend */}
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: '8px', marginTop: '8px' }}>
                    {plottedCurves.map((c) => {
                      const hoverIdx =
                        hoverWl != null ? dataset.wavelengths.findIndex((w) => w >= hoverWl) : -1;
                      const hoverAbs = hoverIdx >= 0 ? c.values[hoverIdx] : null;
                      return (
                        <div
                          key={c.spectrum.id}
                          style={{
                            display: 'inline-flex',
                            alignItems: 'center',
                            gap: '6px',
                            padding: '3px 8px',
                            borderRadius: '6px',
                            background: 'var(--soft)',
                            border: '1px solid var(--line)',
                            fontSize: '11.5px',
                          }}
                        >
                          <span
                            style={{
                              width: '10px',
                              height: '3px',
                              borderRadius: '2px',
                              background: c.color,
                              display: 'inline-block',
                            }}
                          />
                          <strong style={{ maxWidth: '140px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                            {c.spectrum.name}
                          </strong>
                          <span className="mono" style={{ color: 'var(--mut)' }}>
                            {hoverAbs != null
                              ? `${hoverAbs.toFixed(3)} AU`
                              : c.peak
                              ? `λmax ${c.peak.wavelength} nm (${c.peak.absorbance.toFixed(2)})`
                              : ''}
                          </span>
                        </div>
                      );
                    })}
                  </div>
                </div>
              ) : (
                <div className="hint" style={{ marginBottom: '12px' }}>
                  Select one or more samples below to plot their UV-Vis spectra.
                </div>
              )}

              {/* Sample selector strip */}
              <div
                style={{
                  padding: '10px 12px',
                  borderRadius: '8px',
                  background: 'var(--soft)',
                  border: '1px solid var(--line)',
                  marginBottom: showDeconv ? '14px' : 0,
                }}
              >
                <div
                  style={{
                    display: 'flex',
                    justifyContent: 'space-between',
                    alignItems: 'center',
                    gap: '8px',
                    flexWrap: 'wrap',
                    marginBottom: '8px',
                  }}
                >
                  <span style={{ fontSize: '12px', fontWeight: 700 }}>
                    Samples ({keptSpectra.length}) — click to show/hide on chart (up to 16)
                  </span>
                  <div style={{ display: 'flex', gap: '6px', flexWrap: 'wrap', alignItems: 'center' }}>
                    <input
                      type="text"
                      value={sampleFilter}
                      onChange={(e) => setSampleFilter(e.target.value)}
                      placeholder="Filter samples..."
                      style={{
                        height: '28px',
                        width: '140px',
                        padding: '0 8px',
                        borderRadius: '6px',
                        border: '1px solid var(--line)',
                        background: 'var(--panel)',
                        color: 'var(--fg)',
                        fontSize: '12px',
                      }}
                    />
                    <button
                      type="button"
                      className="btn sm"
                      onClick={() => setVisibleIds(filteredSpectraList.slice(0, 12).map((s) => s.id))}
                    >
                      First 12
                    </button>
                    <button type="button" className="btn sm" onClick={() => setVisibleIds([])}>
                      Clear
                    </button>
                  </div>
                </div>
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: '5px', maxHeight: '120px', overflowY: 'auto' }}>
                  {filteredSpectraList.map((s) => {
                    const on = visibleIds.includes(s.id);
                    return (
                      <button
                        key={s.id}
                        type="button"
                        className={`btn sm${on ? ' pri' : ''}`}
                        onClick={() => toggleVisible(s.id)}
                      >
                        {s.name}
                      </button>
                    );
                  })}
                </div>
              </div>

              {/* SPECTRAL DECONVOLUTION SECTION */}
              {showDeconv && (
                <div
                  style={{
                    padding: '14px',
                    borderRadius: '10px',
                    background: 'var(--soft)',
                    border: '1px solid var(--line)',
                  }}
                >
                  <div
                    style={{
                      display: 'flex',
                      justifyContent: 'space-between',
                      alignItems: 'flex-start',
                      gap: '10px',
                      flexWrap: 'wrap',
                      marginBottom: '10px',
                    }}
                  >
                    <div>
                      <div style={{ fontWeight: 700, fontSize: '13.5px', display: 'flex', alignItems: 'center', gap: '6px' }}>
                        <Activity size={15} />
                        <span>Multi-Component UV-Vis Deconvolution</span>
                      </div>
                      <div style={{ fontSize: '12px', color: 'var(--mut)', marginTop: '2px' }}>
                        Pick 1–4 pure reference spectra (e.g., starting materials &amp; product) to
                        decompose reaction mixtures into non-negative weights, % composition, and
                        estimated mM concentration over {minNm}–{maxNm} nm.
                      </div>
                    </div>
                    {batchDeconvRows.length > 0 && (
                      <button
                        type="button"
                        className="btn sm pri"
                        onClick={handleExportDeconvCsv}
                        style={{ display: 'inline-flex', alignItems: 'center', gap: '5px' }}
                      >
                        <Download size={13} />
                        <span>Export Fit CSV ({batchDeconvRows.length})</span>
                      </button>
                    )}
                  </div>

                  {/* Reference spectrum pickers */}
                  <div
                    style={{
                      display: 'grid',
                      gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 220px), 1fr))',
                      gap: '8px',
                      marginBottom: '10px',
                    }}
                  >
                    {refSlots.map((slot, idx) => (
                      <div
                        key={idx}
                        style={{
                          padding: '8px 10px',
                          borderRadius: '8px',
                          background: 'var(--panel)',
                          border: '1px solid var(--line)',
                        }}
                      >
                        <div style={{ fontSize: '11.5px', fontWeight: 700, marginBottom: '5px' }}>
                          Reference {idx + 1}
                        </div>
                        <select
                          value={slot.spectrumId}
                          onChange={(e) =>
                            setRefSlots((prev) =>
                              prev.map((s, i) => (i === idx ? { ...s, spectrumId: e.target.value } : s))
                            )
                          }
                          style={{
                            width: '100%',
                            height: '30px',
                            padding: '0 6px',
                            borderRadius: '6px',
                            border: '1px solid var(--line)',
                            background: 'var(--bg)',
                            color: 'var(--fg)',
                            fontSize: '12px',
                            marginBottom: '6px',
                          }}
                        >
                          <option value="">— Unused —</option>
                          {keptSpectra.map((sp) => (
                            <option key={sp.id} value={sp.id}>
                              {sp.name}
                            </option>
                          ))}
                        </select>
                        <input
                          type="number"
                          min={0}
                          step="any"
                          value={slot.refConcMm}
                          onChange={(e) =>
                            setRefSlots((prev) =>
                              prev.map((s, i) => (i === idx ? { ...s, refConcMm: e.target.value } : s))
                            )
                          }
                          placeholder="Known ref conc (mM, optional)"
                          className="mono"
                          style={{
                            width: '100%',
                            height: '28px',
                            padding: '0 8px',
                            borderRadius: '6px',
                            border: '1px solid var(--line)',
                            background: 'var(--bg)',
                            color: 'var(--fg)',
                            fontSize: '11.5px',
                          }}
                        />
                      </div>
                    ))}
                  </div>

                  <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap', alignItems: 'center', marginBottom: '12px' }}>
                    {refSlots.length < 4 && (
                      <button
                        type="button"
                        className="btn sm"
                        onClick={() => setRefSlots((prev) => [...prev, { spectrumId: '', refConcMm: '' }])}
                      >
                        + Add Reference (max 4)
                      </button>
                    )}
                    {refSlots.length > 1 && (
                      <button
                        type="button"
                        className="btn sm"
                        onClick={() => setRefSlots((prev) => prev.slice(0, -1))}
                      >
                        Remove Last Ref
                      </button>
                    )}
                    <label style={{ display: 'inline-flex', alignItems: 'center', gap: '5px', fontSize: '12px', cursor: 'pointer' }}>
                      <input
                        type="checkbox"
                        checked={includeBaseline}
                        onChange={(e) => setIncludeBaseline(e.target.checked)}
                      />
                      <span>Include baseline offset</span>
                    </label>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '6px', marginLeft: 'auto' }}>
                      <span style={{ fontSize: '12px', color: 'var(--mut)' }}>Inspect sample:</span>
                      <select
                        value={targetSampleId}
                        onChange={(e) => setTargetSampleId(e.target.value)}
                        style={{
                          height: '30px',
                          maxWidth: '180px',
                          padding: '0 8px',
                          borderRadius: '6px',
                          border: '1px solid var(--line)',
                          background: 'var(--panel)',
                          color: 'var(--fg)',
                          fontSize: '12px',
                        }}
                      >
                        {keptSpectra.map((sp) => (
                          <option key={sp.id} value={sp.id}>
                            {sp.name}
                          </option>
                        ))}
                      </select>
                    </div>
                  </div>

                  {/* Single-sample fit summary */}
                  {singleDeconv?.result && (
                    <div
                      style={{
                        padding: '10px 12px',
                        borderRadius: '8px',
                        background: 'var(--panel)',
                        border: '1px solid var(--line)',
                        marginBottom: '12px',
                      }}
                    >
                      <div
                        style={{
                          display: 'flex',
                          justifyContent: 'space-between',
                          alignItems: 'center',
                          gap: '10px',
                          flexWrap: 'wrap',
                          marginBottom: '8px',
                        }}
                      >
                        <div style={{ fontWeight: 700, fontSize: '12.5px', display: 'flex', alignItems: 'center', gap: '6px' }}>
                          <CheckCircle2 size={14} style={{ color: singleDeconv.result.r2 >= 0.95 ? 'var(--ok)' : 'var(--warn)' }} />
                          <span>Fit for {singleDeconv.sampleName}</span>
                        </div>
                        <span className="mono" style={{ fontSize: '12px', color: 'var(--fg2)' }}>
                          R² = <strong>{singleDeconv.result.r2.toFixed(4)}</strong> · RMSE ={' '}
                          {singleDeconv.result.rmse.toFixed(4)} AU · baseline ={' '}
                          {singleDeconv.result.baseline >= 0 ? '+' : ''}
                          {singleDeconv.result.baseline.toFixed(4)}
                        </span>
                      </div>

                      <div
                        style={{
                          display: 'grid',
                          gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 160px), 1fr))',
                          gap: '8px',
                        }}
                      >
                        {activeReferences.map((ref, idx) => (
                          <div
                            key={ref.id}
                            style={{
                              padding: '8px 10px',
                              borderRadius: '6px',
                              background: 'var(--soft)',
                              border: '1px solid var(--line2)',
                            }}
                          >
                            <div style={{ fontSize: '11.5px', color: 'var(--mut)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                              {ref.name}
                            </div>
                            <div className="mono" style={{ fontSize: '16px', fontWeight: 700 }}>
                              {singleDeconv.result!.fractionsPct[idx].toFixed(1)}%
                            </div>
                            <div className="mono" style={{ fontSize: '11px', color: 'var(--fg2)' }}>
                              weight {singleDeconv.result!.weights[idx].toFixed(3)}
                              {singleDeconv.result!.concentrationsMm[idx] != null
                                ? ` · ${singleDeconv.result!.concentrationsMm[idx]!.toFixed(3)} mM`
                                : ''}
                            </div>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}

                  {/* Batch deconvolution table */}
                  {batchDeconvRows.length > 0 && (
                    <div style={{ overflowX: 'auto', maxHeight: '240px' }}>
                      <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '12px' }}>
                        <thead>
                          <tr style={{ borderBottom: '1px solid var(--line)', textAlign: 'left', color: 'var(--mut)', fontSize: '11px' }}>
                            <th style={{ padding: '6px 8px 6px 0' }}>Sample</th>
                            {activeReferences.map((ref) => (
                              <th key={ref.id} style={{ padding: '6px 8px', textAlign: 'right' }}>
                                {ref.name} {ref.refConcMm ? '(mM / %)' : '(% / wt)'}
                              </th>
                            ))}
                            <th style={{ padding: '6px 0 6px 8px', textAlign: 'right' }}>R²</th>
                          </tr>
                        </thead>
                        <tbody>
                          {batchDeconvRows.map(({ spectrum, result }) => (
                            <tr
                              key={spectrum.id}
                              onClick={() => setTargetSampleId(spectrum.id)}
                              style={{
                                borderBottom: '1px solid var(--line2)',
                                cursor: 'pointer',
                                background:
                                  targetSampleId === spectrum.id
                                    ? 'color-mix(in srgb, var(--acc) 9%, transparent)'
                                    : undefined,
                              }}
                            >
                              <td style={{ padding: '6px 8px 6px 0', fontWeight: 600 }}>{spectrum.name}</td>
                              {activeReferences.map((ref, idx) => (
                                <td key={ref.id} className="mono" style={{ padding: '6px 8px', textAlign: 'right' }}>
                                  {result
                                    ? ref.refConcMm && result.concentrationsMm[idx] != null
                                      ? `${result.concentrationsMm[idx]!.toFixed(3)} mM (${result.fractionsPct[idx].toFixed(0)}%)`
                                      : `${result.fractionsPct[idx].toFixed(1)}% (${result.weights[idx].toFixed(2)})`
                                    : '—'}
                                </td>
                              ))}
                              <td
                                className="mono"
                                style={{
                                  padding: '6px 0 6px 8px',
                                  textAlign: 'right',
                                  color: result && result.r2 >= 0.95 ? 'var(--ok)' : 'var(--warn)',
                                  fontWeight: 600,
                                }}
                              >
                                {result ? result.r2.toFixed(4) : '—'}
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  )}
                </div>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
};
