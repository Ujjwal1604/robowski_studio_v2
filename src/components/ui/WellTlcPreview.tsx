import React, { useEffect, useMemo, useRef, useState } from 'react';
import { ArrowUpRight, Layers } from 'lucide-react';
import { TlcLane, TlcSet, TlcSpot } from '../../types';
import {
  LANE_FRAME_WIDTH,
  TLC_SIGNAL,
  TlcChannelKey,
  computeLaneRowIntensity,
  extractDensitogram,
  getEffectiveLaneSpots,
  laneMatrix,
  renderFalseColorLane,
  tlcFront,
  tlcLane,
  tlcOrigin,
} from '../../engine';

interface WellTlcPreviewProps {
  tlcSet?: TlcSet;
  wellIndex: number;
  plateIndex: number;
  onOpenTlcMap: () => void;
}

let previewScratchCanvas: HTMLCanvasElement | null = null;

function extractLaneProfileLocal(
  set: TlcSet,
  key: TlcChannelKey,
  lane: TlcLane,
  coreFraction: number = 0.35
): number[] {
  const ck = `${key}:${lane.id}:${coreFraction.toFixed(2)}`;
  if (set.prof && set.prof[ck]) return set.prof[ck];

  const im = set.imgs?.[key];
  if (!im || !im.bmp || typeof document === 'undefined') return [];

  const W = Math.max(1, Math.round(lane.width));
  const L = Math.max(1, Math.round(lane.length));

  if (!previewScratchCanvas) {
    previewScratchCanvas = document.createElement('canvas');
  }
  previewScratchCanvas.width = W;
  previewScratchCanvas.height = L;

  const ctx = previewScratchCanvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) return [];

  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, W, L);

  const m = laneMatrix(lane, im.bmp.width / (set.frameW || LANE_FRAME_WIDTH), 1);
  ctx.setTransform(m[0], m[1], m[2], m[3], m[4], m[5]);
  ctx.drawImage(im.bmp, 0, 0);

  const imgData = ctx.getImageData(0, 0, W, L);
  const data = imgData.data;
  const ch = TLC_SIGNAL[key].ch;
  const out = new Array(L);

  for (let y = 0; y < L; y++) {
    const rowOffset = y * W * 4;
    const rowSlice = data.subarray(rowOffset, rowOffset + W * 4);
    out[L - 1 - y] = computeLaneRowIntensity(rowSlice, W, ch, coreFraction);
  }

  set.prof = set.prof || {};
  set.prof[ck] = out;
  return out;
}

export const WellTlcPreview: React.FC<WellTlcPreviewProps> = ({
  tlcSet,
  wellIndex,
  plateIndex,
  onOpenTlcMap,
}) => {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const laneIdx = tlcLane(wellIndex, 'column');
  const lane = useMemo(
    () => tlcSet?.cfg?.lanes?.find((l) => l.id === laneIdx) || null,
    [tlcSet, laneIdx]
  );

  const availableChannels = useMemo(() => {
    const imgs = tlcSet?.imgs || {};
    const keys: TlcChannelKey[] = [];
    if (imgs.UV254?.bmp) keys.push('UV254');
    if (imgs.UV366?.bmp) keys.push('UV366');
    if (imgs.White?.bmp) keys.push('White');
    return keys;
  }, [tlcSet]);

  const hasComposite = availableChannels.includes('UV254') && availableChannels.includes('UV366');
  const [selectedMode, setSelectedMode] = useState<'composite' | TlcChannelKey>('UV254');

  const activeMode: 'composite' | TlcChannelKey | null = useMemo(() => {
    if (selectedMode === 'composite' && hasComposite) return 'composite';
    if (selectedMode !== 'composite' && availableChannels.includes(selectedMode)) return selectedMode;
    if (hasComposite) return 'composite';
    return availableChannels[0] || null;
  }, [selectedMode, hasComposite, availableChannels]);

  const densitogramInfo = useMemo(() => {
    if (!tlcSet || !lane || !availableChannels.length) return null;
    const traceKey: TlcChannelKey =
      activeMode && activeMode !== 'composite'
        ? activeMode
        : availableChannels.includes('UV254')
        ? 'UV254'
        : availableChannels[0];

    const profile = extractLaneProfileLocal(tlcSet, traceKey, lane);
    if (!profile.length) return null;

    const origin = tlcOrigin(tlcSet, lane, extractLaneProfileLocal);
    const front = tlcFront(tlcSet, lane, extractLaneProfileLocal);
    const dens = extractDensitogram(profile, {
      sign: TLC_SIGNAL[traceKey].sign,
      origin,
      front,
      radius: lane.spotRadius ?? undefined,
      minProminence: tlcSet.spotProminence ?? 0.08,
    });
    const effectiveSpots = getEffectiveLaneSpots(lane, dens.spots);

    let uv366Dens = null;
    if (activeMode === 'composite' && availableChannels.includes('UV366')) {
      const p366 = extractLaneProfileLocal(tlcSet, 'UV366', lane);
      if (p366.length) {
        uv366Dens = extractDensitogram(p366, {
          sign: TLC_SIGNAL.UV366.sign,
          origin,
          front,
          radius: lane.spotRadius ?? undefined,
          minProminence: tlcSet.spotProminence ?? 0.08,
        });
      }
    }

    return {
      traceKey,
      dens,
      uv366Dens,
      spots: effectiveSpots,
      origin,
      front,
    };
  }, [tlcSet, lane, availableChannels, activeMode]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !tlcSet || !lane || !activeMode) return;

    const targetH = 148;
    const k = targetH / Math.max(1, lane.length);
    const targetW = Math.max(32, Math.round(lane.width * k * 1.45));
    const dpr = Math.min(window.devicePixelRatio || 1, 2);

    canvas.width = targetW * dpr;
    canvas.height = targetH * dpr;
    canvas.style.width = `${targetW}px`;
    canvas.style.height = `${targetH}px`;

    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, targetW, targetH);

    if (activeMode === 'composite') {
      const fc = renderFalseColorLane(tlcSet, lane, targetW, targetH);
      if (fc) ctx.drawImage(fc, 0, 0, targetW, targetH);
    } else {
      const im = tlcSet.imgs?.[activeMode];
      if (im?.bmp) {
        const m = laneMatrix(lane, im.bmp.width / (tlcSet.frameW || LANE_FRAME_WIDTH), k);
        const scaleX = targetW / Math.max(1, lane.width * k);
        ctx.save();
        ctx.setTransform(
          dpr * m[0] * scaleX,
          dpr * m[1],
          dpr * m[2] * scaleX,
          dpr * m[3],
          dpr * m[4] * scaleX,
          dpr * m[5]
        );
        ctx.drawImage(im.bmp, 0, 0);
        ctx.restore();
      }
    }

    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    if (densitogramInfo) {
      const origY = k * (lane.length - densitogramInfo.origin);
      const frontY = k * (lane.length - densitogramInfo.front);

      ctx.strokeStyle = '#FFC857';
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.moveTo(0, origY);
      ctx.lineTo(6, origY);
      ctx.moveTo(targetW - 6, origY);
      ctx.lineTo(targetW, origY);
      ctx.stroke();

      ctx.strokeStyle = '#38bdf8';
      ctx.lineWidth = 1.2;
      ctx.beginPath();
      ctx.moveTo(0, frontY);
      ctx.lineTo(targetW, frontY);
      ctx.stroke();

      for (const sp of densitogramInfo.spots) {
        const y = k * (lane.length - sp.pos);
        ctx.strokeStyle =
          sp.source === 'manual' ? '#f59e0b' : sp.source === 'adjusted' ? '#a855f7' : '#FF4D8D';
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.moveTo(targetW - 8, y);
        ctx.lineTo(targetW, y);
        ctx.stroke();
      }
    }
  }, [tlcSet, lane, activeMode, densitogramInfo]);

  const customSpotsOnly: TlcSpot[] = lane?.customSpots || [];
  const spotsToShow = densitogramInfo?.spots || customSpotsOnly;

  // Empty state: no images loaded
  if (!tlcSet || !lane || !availableChannels.length) {
    return (
      <div
        style={{
          padding: '12px 14px',
          borderRadius: '11px',
          background: 'var(--soft)',
          border: '1px solid var(--line)',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: '12px',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: '10px', minWidth: 0 }}>
          <div
            style={{
              width: '32px',
              height: '32px',
              borderRadius: '8px',
              background: 'var(--panel)',
              border: '1px solid var(--line)',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              color: 'var(--mut)',
              flexShrink: 0,
            }}
          >
            <Layers size={15} />
          </div>
          <div style={{ minWidth: 0 }}>
            <div style={{ fontWeight: 600, fontSize: '12.5px', color: 'var(--fg)' }}>
              TLC Lane #{laneIdx + 1} · Plate {plateIndex + 1}
            </div>
            <div style={{ fontSize: '11.5px', color: 'var(--mut)', marginTop: '1px' }}>
              {customSpotsOnly.length > 0
                ? `${customSpotsOnly.length} custom spot(s) · Main Rf ${customSpotsOnly[0]?.rf?.toFixed(2)}`
                : 'No TLC images uploaded for this plate yet'}
            </div>
          </div>
        </div>
        <button
          type="button"
          className="btn sm"
          style={{ display: 'inline-flex', alignItems: 'center', gap: '4px', flexShrink: 0 }}
          onClick={onOpenTlcMap}
          title="Jump directly to this well's lane in TLC Map"
        >
          <span>Open TLC Map</span>
          <ArrowUpRight size={13} />
        </button>
      </div>
    );
  }

  const svgW = 240;
  const svgH = 92;
  const padL = 8;
  const padR = 8;
  const padT = 10;
  const padB = 18;
  const plotW = svgW - padL - padR;
  const plotH = svgH - padT - padB;

  const buildPath = (
    points: { rf: number; signal: number }[],
    maxSig: number
  ): { line: string; area: string } => {
    const filtered = points.filter((p) => p.rf >= -0.05 && p.rf <= 1.05);
    if (filtered.length < 2) return { line: '', area: '' };
    const step = Math.max(1, Math.floor(filtered.length / 80));
    const sampled = filtered.filter((_, i) => i % step === 0 || i === filtered.length - 1);
    const coords = sampled.map((p) => {
      const x = padL + ((p.rf + 0.05) / 1.1) * plotW;
      const y = padT + plotH - Math.min(1, p.signal / maxSig) * plotH;
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    });
    const firstX = (padL + ((sampled[0].rf + 0.05) / 1.1) * plotW).toFixed(1);
    const lastX = (padL + ((sampled[sampled.length - 1].rf + 0.05) / 1.1) * plotW).toFixed(1);
    const baseY = (padT + plotH).toFixed(1);
    return {
      line: `M ${coords.join(' L ')}`,
      area: `M ${firstX},${baseY} L ${coords.join(' L ')} L ${lastX},${baseY} Z`,
    };
  };

  const primaryTrace = densitogramInfo
    ? buildPath(densitogramInfo.dens.points, densitogramInfo.dens.maxSignal)
    : { line: '', area: '' };
  const uv366Trace = densitogramInfo?.uv366Dens
    ? buildPath(densitogramInfo.uv366Dens.points, densitogramInfo.uv366Dens.maxSignal)
    : { line: '', area: '' };

  const traceColor =
    activeMode === 'UV366' ? '#a855f7' : activeMode === 'White' ? '#f59e0b' : '#10b981';

  return (
    <div
      style={{
        padding: '12px 14px',
        borderRadius: '11px',
        background: 'var(--soft)',
        border: '1px solid var(--line)',
      }}
    >
      {/* Top Bar */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: '8px',
          marginBottom: '10px',
          flexWrap: 'wrap',
        }}
      >
        <div style={{ fontWeight: 600, fontSize: '12.5px', color: 'var(--fg)' }}>
          TLC Lane #{laneIdx + 1}
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: '4px', flexWrap: 'wrap' }}>
          <div className="seg" style={{ padding: '2px', borderRadius: '8px' }}>
            {hasComposite && (
              <button
                type="button"
                className={activeMode === 'composite' ? 'on' : ''}
                style={{ height: '24px', padding: '0 8px', fontSize: '11px', borderRadius: '6px' }}
                onClick={() => setSelectedMode('composite')}
              >
                Composite
              </button>
            )}
            {availableChannels.map((ch) => (
              <button
                key={ch}
                type="button"
                className={activeMode === ch ? 'on' : ''}
                style={{ height: '24px', padding: '0 8px', fontSize: '11px', borderRadius: '6px' }}
                onClick={() => setSelectedMode(ch)}
              >
                {ch === 'White' ? 'Vis' : ch}
              </button>
            ))}
          </div>
          <button
            type="button"
            className="btn sm"
            style={{
              height: '26px',
              padding: '0 9px',
              fontSize: '11px',
              display: 'inline-flex',
              alignItems: 'center',
              gap: '3px',
            }}
            onClick={onOpenTlcMap}
            title="Inspect full TLC plate and adjust spot markers"
          >
            <span>TLC Map</span>
            <ArrowUpRight size={12} />
          </button>
        </div>
      </div>

      {/* Main Content: Cropped Lane Canvas + 1D Densitogram */}
      <div style={{ display: 'flex', gap: '12px', alignItems: 'stretch' }}>
        <div
          onClick={onOpenTlcMap}
          title="Click to inspect lane in TLC Map"
          style={{
            cursor: 'pointer',
            borderRadius: '8px',
            overflow: 'hidden',
            border: '1px solid var(--line)',
            background: '#090d16',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            flexShrink: 0,
          }}
        >
          <canvas ref={canvasRef} />
        </div>

        <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', justifyContent: 'space-between' }}>
          <div
            style={{
              background: 'var(--panel)',
              border: '1px solid var(--line)',
              borderRadius: '8px',
              padding: '6px 8px',
            }}
          >
            <svg
              viewBox={`0 0 ${svgW} ${svgH}`}
              style={{ width: '100%', height: 'auto', display: 'block' }}
              aria-label={`1D TLC densitogram for lane ${laneIdx + 1}`}
            >
              <line
                x1={padL + (0.05 / 1.1) * plotW}
                y1={padT}
                x2={padL + (0.05 / 1.1) * plotW}
                y2={padT + plotH}
                stroke="#FFC857"
                strokeWidth="1"
                strokeDasharray="2,2"
              />
              <line
                x1={padL + (1.05 / 1.1) * plotW}
                y1={padT}
                x2={padL + (1.05 / 1.1) * plotW}
                y2={padT + plotH}
                stroke="#38bdf8"
                strokeWidth="1"
                strokeDasharray="2,2"
              />
              <line
                x1={padL}
                y1={padT + plotH}
                x2={padL + plotW}
                y2={padT + plotH}
                stroke="var(--line)"
                strokeWidth="1"
              />

              {primaryTrace.area && (
                <path d={primaryTrace.area} fill={traceColor} fillOpacity="0.16" />
              )}
              {primaryTrace.line && (
                <path d={primaryTrace.line} fill="none" stroke={traceColor} strokeWidth="1.6" />
              )}

              {uv366Trace.line && (
                <path d={uv366Trace.line} fill="none" stroke="#a855f7" strokeWidth="1.4" strokeDasharray="3,2" />
              )}

              {spotsToShow.slice(0, 6).map((sp, idx) => {
                const sx = padL + ((Math.max(-0.05, Math.min(1.05, sp.rf)) + 0.05) / 1.1) * plotW;
                return (
                  <g key={idx}>
                    <line
                      x1={sx}
                      y1={padT}
                      x2={sx}
                      y2={padT + plotH}
                      stroke="#FF4D8D"
                      strokeWidth="1"
                      strokeDasharray="2,2"
                    />
                    <text
                      x={sx}
                      y={padT + 8}
                      fontSize="7"
                      fontFamily="IBM Plex Mono, monospace"
                      fontWeight="600"
                      fill="#FF4D8D"
                      textAnchor="middle"
                    >
                      {sp.rf.toFixed(2)}
                    </text>
                  </g>
                );
              })}

              <text x={padL + (0.05 / 1.1) * plotW} y={svgH - 4} fontSize="8" fill="var(--mut)" textAnchor="middle">
                Rf 0
              </text>
              <text x={padL + (0.55 / 1.1) * plotW} y={svgH - 4} fontSize="8" fill="var(--mut)" textAnchor="middle">
                0.5
              </text>
              <text x={padL + (1.05 / 1.1) * plotW} y={svgH - 4} fontSize="8" fill="var(--mut)" textAnchor="middle">
                1.0
              </text>
            </svg>
          </div>

          <div
            className="mono"
            style={{
              marginTop: '7px',
              fontSize: '11px',
              color: 'var(--fg2)',
              display: 'flex',
              gap: '6px',
              flexWrap: 'wrap',
              alignItems: 'center',
            }}
          >
            {spotsToShow.length > 0 ? (
              spotsToShow.slice(0, 5).map((sp, idx) => (
                <React.Fragment key={idx}>
                  {idx > 0 && <span style={{ color: 'var(--mut)' }}>·</span>}
                  <span>
                    Rf {sp.rf.toFixed(2)}
                    {sp.areaPct != null ? ` (${sp.areaPct}%)` : ''}
                  </span>
                </React.Fragment>
              ))
            ) : (
              <span style={{ fontFamily: 'inherit', color: 'var(--mut)' }}>
                No resolved peaks above baseline
              </span>
            )}
          </div>
        </div>
      </div>
    </div>
  );
};
