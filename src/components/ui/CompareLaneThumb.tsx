import React, { useEffect, useMemo, useRef } from 'react';
import { TlcLane, TlcSet, TlcSpot } from '../../types';
import {
  LANE_FRAME_WIDTH,
  TLC_SIGNAL,
  TlcChannelKey,
  extractDensitogram,
  extractLaneProfile2d,
  findMultiChannelSpots,
  getChannelHistogram,
  getChannelFrontBandProfile,
  getEffectiveLaneSpots,
  getLane2dMetrics,
  tlcHalf,
  laneMatrix,
  renderFalseColorLane,
  tlcFront,
  tlcOrigin,
} from '../../engine';

interface CompareLaneThumbProps {
  tlcSet?: TlcSet;
  lane: TlcLane | null;
  preferredMode: 'composite' | TlcChannelKey;
  onSpotsResolved?: (spots: TlcSpot[]) => void;
  height?: number;
}

function extractProfile(
  set: TlcSet,
  key: TlcChannelKey,
  lane: TlcLane,
  coreFraction: number = 0.35
): number[] {
  return extractLaneProfile2d(set, key, lane, coreFraction);
}

export const CompareLaneThumb: React.FC<CompareLaneThumbProps> = ({
  tlcSet,
  lane,
  preferredMode,
  height = 144,
}) => {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  const availableChannels = useMemo(() => {
    const imgs = tlcSet?.imgs || {};
    const keys: TlcChannelKey[] = [];
    if (imgs.UV254?.bmp) keys.push('UV254');
    if (imgs.UV366?.bmp) keys.push('UV366');
    if (imgs.White?.bmp) keys.push('White');
    return keys;
  }, [tlcSet]);

  const hasComposite = availableChannels.length >= 2;

  const activeMode: 'composite' | TlcChannelKey | null = useMemo(() => {
    if (preferredMode === 'composite' && hasComposite) return 'composite';
    if (preferredMode !== 'composite' && availableChannels.includes(preferredMode)) {
      return preferredMode;
    }
    if (hasComposite) return 'composite';
    return availableChannels[0] || null;
  }, [preferredMode, hasComposite, availableChannels]);

  const info = useMemo(() => {
    if (!tlcSet || !lane || !availableChannels.length) return null;
    const origin = tlcOrigin(tlcSet, lane, extractProfile);
    const front = tlcFront(tlcSet, lane, extractProfile);
    const profiles: Partial<Record<TlcChannelKey, number[]>> = {};
    const histograms: Partial<Record<TlcChannelKey, ReturnType<typeof getChannelHistogram>>> = {};
    const lane2dByChannel: Partial<Record<TlcChannelKey, ReturnType<typeof getLane2dMetrics>>> = {};
    const frontBandByChannel: Partial<Record<TlcChannelKey, number[]>> = {};
    const halfIdx = tlcHalf(lane);
    for (const ch of availableChannels) {
      const p = extractProfile(tlcSet, ch, lane);
      if (p.length) {
        profiles[ch] = p;
        const chHist = getChannelHistogram(tlcSet, ch, extractProfile);
        if (chHist) histograms[ch] = chHist;
        const m2d = getLane2dMetrics(tlcSet, ch, lane);
        if (m2d) lane2dByChannel[ch] = m2d;
        const fBg = getChannelFrontBandProfile(tlcSet, ch, halfIdx, extractProfile);
        if (fBg) frontBandByChannel[ch] = fBg;
      }
    }
    const autoSpots = findMultiChannelSpots({
      profiles,
      origin,
      front,
      radius: lane.spotRadius ?? undefined,
      minProminence: tlcSet.spotProminence ?? 0.28,
      histograms,
      lane2dByChannel,
      frontBandByChannel,
      detectorMode: tlcSet.spotDetectorMode,
    });
    const spots = getEffectiveLaneSpots(lane, autoSpots);
    return { origin, front, spots };
  }, [tlcSet, lane, availableChannels, activeMode]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !tlcSet || !lane || !activeMode) return;

    const k = height / Math.max(1, lane.length);
    const targetW = Math.max(36, Math.round(lane.width * k * 1.6));
    const dpr = Math.min(window.devicePixelRatio || 1, 2);

    canvas.width = targetW * dpr;
    canvas.height = height * dpr;
    canvas.style.width = `${targetW}px`;
    canvas.style.height = `${height}px`;

    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, targetW, height);

    if (activeMode === 'composite') {
      const fc = renderFalseColorLane(tlcSet, lane, targetW, height);
      if (fc) ctx.drawImage(fc, 0, 0, targetW, height);
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
    if (info) {
      const origY = k * (lane.length - info.origin);
      const frontY = k * (lane.length - info.front);

      ctx.strokeStyle = '#FFC857';
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.moveTo(0, origY);
      ctx.lineTo(targetW, origY);
      ctx.stroke();

      ctx.strokeStyle = '#38bdf8';
      ctx.lineWidth = 1.2;
      ctx.beginPath();
      ctx.moveTo(0, frontY);
      ctx.lineTo(targetW, frontY);
      ctx.stroke();

      for (const sp of info.spots) {
        const y = k * (lane.length - sp.pos);
        ctx.strokeStyle =
          sp.source === 'manual' ? '#f59e0b' : sp.source === 'adjusted' ? '#a855f7' : '#FF4D8D';
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.moveTo(targetW - 9, y);
        ctx.lineTo(targetW, y);
        ctx.stroke();
      }
    }
  }, [tlcSet, lane, activeMode, info, height]);

  const spotsList = info?.spots || lane?.customSpots || [];

  if (!tlcSet || !lane || !activeMode) {
    return (
      <div
        style={{
          height: `${height}px`,
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
          padding: '8px',
          borderRadius: '8px',
          background: 'var(--soft)',
          border: '1px dashed var(--line)',
          fontSize: '11.5px',
          color: 'var(--mut)',
          textAlign: 'center',
        }}
      >
        <span>No plate image</span>
        {spotsList.length > 0 && (
          <span className="mono" style={{ marginTop: '4px', color: 'var(--fg2)', fontSize: '11px' }}>
            {spotsList.length} spot{spotsList.length === 1 ? '' : 's'}
          </span>
        )}
      </div>
    );
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '6px' }}>
      <div
        style={{
          borderRadius: '7px',
          overflow: 'hidden',
          border: '1px solid var(--line)',
          background: '#090d16',
          lineHeight: 0,
        }}
      >
        <canvas ref={canvasRef} />
      </div>
      <div className="mono" style={{ fontSize: '11px', color: 'var(--fg2)', textAlign: 'center' }}>
        {spotsList.length > 0
          ? spotsList
              .slice(0, 4)
              .map((s) => s.rf.toFixed(2))
              .join(' · ')
          : 'No resolved spots'}
      </div>
    </div>
  );
};
