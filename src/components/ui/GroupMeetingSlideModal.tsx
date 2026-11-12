import React, { useState, useEffect, useRef } from 'react';
import { SavedRun } from '../../types';
import {
  SlideData,
  SlidePageKey,
  extractSlideData,
  drawSlideOnCanvas,
} from '../../engine/slideGenerator';
import { fetchAiMeetingBullets } from '../../services/aiService';

interface GroupMeetingSlideModalProps {
  isOpen: boolean;
  onClose: () => void;
  selectedRuns: SavedRun[];
  toast: (msg: string) => void;
}

export const GroupMeetingSlideModal: React.FC<GroupMeetingSlideModalProps> = ({
  isOpen,
  onClose,
  selectedRuns,
  toast,
}) => {
  const [activeRunIndex, setActiveRunIndex] = useState<number>(0);
  const [slideMode, setSlideMode] = useState<'individual' | 'comparative'>('individual');
  const [pageKey, setPageKey] = useState<SlidePageKey>('chemistry_design');
  const [forceUnlockAll, setForceUnlockAll] = useState<boolean>(false);
  const [theme, setTheme] = useState<'dark' | 'light'>('dark');
  const [presenter, setPresenter] = useState<string>('HTE Chemist');
  const [copied, setCopied] = useState<boolean>(false);
  const [aiGenerating, setAiGenerating] = useState<boolean>(false);

  // Extracted slide data per selected run
  const [slidesData, setSlidesData] = useState<SlideData[]>([]);
  const canvasRef = useRef<HTMLCanvasElement>(null);

  // Initialize slide data whenever selected runs change
  useEffect(() => {
    if (selectedRuns.length === 0) return;
    const extracted = selectedRuns.map((r) => extractSlideData(r.state, r, presenter));
    setSlidesData(extracted);
    setActiveRunIndex(0);
    setPageKey('chemistry_design');
    if (selectedRuns.length > 1) {
      setSlideMode('individual');
    }
  }, [selectedRuns, presenter]);

  // Current active slide data
  const currentSlide = slidesData[activeRunIndex] || slidesData[0];

  // Determine available slides in deck for current run
  const hasResults = Boolean(currentSlide?.hasResults || forceUnlockAll);
  const hasObservations = Boolean(currentSlide?.hasObservations || forceUnlockAll);

  const availablePages: Array<{ key: SlidePageKey; label: string; pageNumber: number; enabled: boolean; statusBadge: string }> = [
    {
      key: 'chemistry_design',
      label: '1. Chemistry & Design Matrix',
      pageNumber: 1,
      enabled: true,
      statusBadge: 'Always Included',
    },
    {
      key: 'results_hits',
      label: '2. Results & Winning Hits',
      pageNumber: 2,
      enabled: hasResults,
      statusBadge: currentSlide?.hasResults ? '✓ Notebook Results' : 'No Results Yet',
    },
    {
      key: 'observations_sar',
      label: '3. Chemical Observations & SAR',
      pageNumber: 3,
      enabled: hasObservations,
      statusBadge: currentSlide?.hasObservations ? '✓ Notebook Notes' : 'No Notes Yet',
    },
  ];

  const unlockedPages = availablePages.filter((p) => p.enabled);
  const activePageIndex = unlockedPages.findIndex((p) => p.key === pageKey);

  // If current page is locked and not forced, reset to page 1
  useEffect(() => {
    if (!hasResults && pageKey === 'results_hits') {
      setPageKey('chemistry_design');
    } else if (!hasObservations && pageKey === 'observations_sar') {
      setPageKey('chemistry_design');
    }
  }, [hasResults, hasObservations, pageKey]);

  // Re-draw canvas whenever slide data, index, mode, page, or theme changes
  useEffect(() => {
    if (!isOpen || !canvasRef.current || !currentSlide) return;

    if (slideMode === 'comparative' && slidesData.length > 1) {
      drawSlideOnCanvas(canvasRef.current, currentSlide, {
        theme,
        comparativeData: slidesData,
      });
    } else {
      drawSlideOnCanvas(canvasRef.current, currentSlide, {
        theme,
        pageKey,
      });
    }
  }, [isOpen, currentSlide, slideMode, slidesData, pageKey, theme]);

  if (!isOpen || selectedRuns.length === 0) return null;

  // Handle Copy to Clipboard (PNG Image)
  const handleCopyImage = async () => {
    if (!canvasRef.current) return;
    try {
      canvasRef.current.toBlob(async (blob) => {
        if (!blob) throw new Error('Could not create image blob');
        try {
          await navigator.clipboard.write([
            new ClipboardItem({ 'image/png': blob }),
          ]);
          setCopied(true);
          toast('✓ Slide image copied! Paste directly into PowerPoint or Google Slides (Ctrl+V).');
          setTimeout(() => setCopied(false), 2500);
        } catch {
          handleDownloadPng();
        }
      }, 'image/png');
    } catch {
      handleDownloadPng();
    }
  };

  // Handle Download PNG
  const handleDownloadPng = () => {
    if (!canvasRef.current) return;
    const pageTag = slideMode === 'comparative' ? 'comparative' : pageKey;
    const filename = `${(currentSlide?.runName || 'hte_run').replace(/\s+/g, '_')}_${pageTag}_${theme}.png`;
    const url = canvasRef.current.toDataURL('image/png');
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    toast(`Downloaded presentation slide (${filename}).`);
  };

  // Handle Download Deck (Sequential PNGs for all unlocked slides)
  const handleDownloadDeck = async () => {
    if (!canvasRef.current || !currentSlide) return;
    const pagesToDownload = slideMode === 'comparative'
      ? ['comparative']
      : unlockedPages.map((p) => p.key);

    for (let i = 0; i < pagesToDownload.length; i++) {
      const p = pagesToDownload[i];
      if (slideMode === 'comparative') {
        drawSlideOnCanvas(canvasRef.current, currentSlide, { theme, comparativeData: slidesData });
      } else {
        drawSlideOnCanvas(canvasRef.current, currentSlide, { theme, pageKey: p as SlidePageKey });
      }
      const filename = `${(currentSlide?.runName || 'hte_run').replace(/\s+/g, '_')}_slide_${i + 1}_${p}_${theme}.png`;
      const url = canvasRef.current.toDataURL('image/png');
      const a = document.createElement('a');
      a.href = url;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      a.remove();
      await new Promise((r) => setTimeout(r, 200));
    }
    // Restore current active view
    if (slideMode === 'comparative') {
      drawSlideOnCanvas(canvasRef.current, currentSlide, { theme, comparativeData: slidesData });
    } else {
      drawSlideOnCanvas(canvasRef.current, currentSlide, { theme, pageKey });
    }
    toast(`Downloaded complete ${pagesToDownload.length}-slide deck as PNGs!`);
  };

  // Handle AI Generate Bullets
  const handleAiBullets = async () => {
    if (!currentSlide) return;
    setAiGenerating(true);
    try {
      const bullets = await fetchAiMeetingBullets({
        runName: currentSlide.runName,
        reactionClass: currentSlide.reactionClass,
        designSummary: `${currentSlide.designSummary.matrixDimensions} · ${currentSlide.designSummary.format} · ${currentSlide.designSummary.vialVolumeUls} µL in ${currentSlide.designSummary.reactionSolvent}`,
        reagents: currentSlide.reagents,
        hitStats: currentSlide.stats,
        topHits: currentSlide.topHits,
      });

      if (bullets && bullets.length > 0) {
        setSlidesData((prev) => {
          const next = [...prev];
          if (next[activeRunIndex]) {
            next[activeRunIndex] = { ...next[activeRunIndex], bullets };
          }
          return next;
        });
        toast('✦ AI generated 3 group meeting takeaway bullets!');
      }
    } catch (err: any) {
      toast('Could not generate bullets: ' + (err?.message || 'Server busy'));
    } finally {
      setAiGenerating(false);
    }
  };

  const handleUpdateBullet = (index: number, newText: string) => {
    setSlidesData((prev) => {
      const next = [...prev];
      if (next[activeRunIndex]) {
        const nextBullets = [...(next[activeRunIndex].bullets || [])];
        nextBullets[index] = newText;
        next[activeRunIndex] = { ...next[activeRunIndex], bullets: nextBullets };
      }
      return next;
    });
  };

  const handleUpdateTitle = (newTitle: string) => {
    setSlidesData((prev) => {
      const next = [...prev];
      if (next[activeRunIndex]) {
        next[activeRunIndex] = { ...next[activeRunIndex], runName: newTitle };
      }
      return next;
    });
  };

  const handleUpdateHypothesis = (newHyp: string) => {
    setSlidesData((prev) => {
      const next = [...prev];
      if (next[activeRunIndex]) {
        next[activeRunIndex] = { ...next[activeRunIndex], hypothesis: newHyp };
      }
      return next;
    });
  };

  return (
    <div
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 9999,
        background: 'rgba(0, 0, 0, 0.85)',
        backdropFilter: 'blur(4px)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: '16px',
      }}
      onClick={onClose}
    >
      <div
        style={{
          background: 'var(--panel)',
          border: '1px solid var(--line)',
          borderRadius: '12px',
          width: '100%',
          maxWidth: '1320px',
          maxHeight: '95vh',
          display: 'flex',
          flexDirection: 'column',
          boxShadow: '0 24px 60px rgba(0,0,0,0.6)',
          overflow: 'hidden',
          color: 'var(--fg)',
        }}
        onClick={(e) => e.stopPropagation()}
      >
        {/* Modal Top Header */}
        <div
          style={{
            padding: '14px 20px',
            borderBottom: '1px solid var(--line)',
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
            background: 'var(--soft)',
            flexWrap: 'wrap',
            gap: '12px',
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
            <div
              style={{
                width: '34px',
                height: '34px',
                borderRadius: '8px',
                background: 'linear-gradient(135deg, #0284c7 0%, #0369a1 100%)',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                color: '#fff',
                fontSize: '18px',
                fontWeight: 'bold',
              }}
            >
              📊
            </div>
            <div>
              <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                <h3 style={{ margin: 0, fontSize: '15px', fontWeight: 600 }}>
                  Weekly Group Meeting Slide Generator & Exporter
                </h3>
                <span
                  style={{
                    fontSize: '10px',
                    fontWeight: 700,
                    textTransform: 'uppercase',
                    background: '#0284c7',
                    color: '#fff',
                    padding: '2px 8px',
                    borderRadius: '10px',
                  }}
                >
                  16:9 Chemistry-First
                </span>
                <span
                  style={{
                    fontSize: '11px',
                    fontWeight: 600,
                    background: currentSlide?.hasResults ? 'rgba(16, 185, 129, 0.15)' : 'rgba(56, 189, 248, 0.12)',
                    color: currentSlide?.hasResults ? '#10b981' : '#38bdf8',
                    padding: '2px 8px',
                    borderRadius: '10px',
                    border: currentSlide?.hasResults ? '1px solid rgba(16, 185, 129, 0.3)' : '1px solid rgba(56, 189, 248, 0.3)',
                  }}
                >
                  {currentSlide?.hasResults
                    ? `✓ Notebook Results Logged (${unlockedPages.length} Slides Deck)`
                    : `Screening in Progress (Slide 1 Design Matrix Only)`}
                </span>
              </div>
              <p style={{ margin: '2px 0 0', fontSize: '11px', color: 'var(--mut)' }}>
                Concise, high-resolution 1920×1080 slides focused strictly on reaction schemes, molecular structures, and factorial design — without robotic liquid-handling repetition.
              </p>
            </div>
          </div>

          {/* Quick Actions (Copy & Download) */}
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
            <button
              type="button"
              className="btn sm pri"
              onClick={handleCopyImage}
              style={{
                background: '#10b981',
                borderColor: '#059669',
                display: 'inline-flex',
                alignItems: 'center',
                gap: '6px',
                fontSize: '12px',
                fontWeight: 600,
                padding: '6px 14px',
              }}
              title="Copy 1920×1080 slide image to clipboard to paste (Ctrl+V) directly into PowerPoint or Google Slides"
            >
              <span>{copied ? '✓ Copied to Clipboard!' : '📋 Copy Slide Image'}</span>
            </button>

            <button
              type="button"
              className="btn sm"
              onClick={handleDownloadPng}
              style={{ fontSize: '12px', height: '32px' }}
              title="Download current slide as 1920×1080 PNG"
            >
              💾 Download Slide PNG
            </button>

            {unlockedPages.length > 1 && slideMode === 'individual' && (
              <button
                type="button"
                className="btn sm"
                onClick={handleDownloadDeck}
                style={{ fontSize: '12px', height: '32px' }}
                title="Download all unlocked slides in the deck as sequential PNGs"
              >
                📥 Download Full Deck ({unlockedPages.length})
              </button>
            )}

            <button
              type="button"
              className="btn sm"
              onClick={onClose}
              style={{ fontSize: '14px', width: '32px', height: '32px', padding: 0 }}
            >
              ✕
            </button>
          </div>
        </div>

        {/* Top Control Bar: Multi-Run & Mode Bar */}
        <div
          style={{
            padding: '10px 20px',
            borderBottom: '1px solid var(--line)',
            background: 'var(--panel)',
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
            flexWrap: 'wrap',
            gap: '12px',
          }}
        >
          {/* Multi-Run Selector / Mode Switcher */}
          <div style={{ display: 'flex', alignItems: 'center', gap: '10px', flexWrap: 'wrap' }}>
            {selectedRuns.length > 1 && (
              <div
                style={{
                  display: 'inline-flex',
                  borderRadius: '6px',
                  overflow: 'hidden',
                  border: '1px solid var(--line)',
                }}
              >
                <button
                  type="button"
                  onClick={() => setSlideMode('individual')}
                  style={{
                    padding: '5px 12px',
                    fontSize: '11px',
                    fontWeight: 600,
                    border: 'none',
                    cursor: 'pointer',
                    background: slideMode === 'individual' ? '#0284c7' : 'var(--soft)',
                    color: slideMode === 'individual' ? '#fff' : 'var(--fg)',
                  }}
                >
                  Individual Campaign Slides ({selectedRuns.length})
                </button>
                <button
                  type="button"
                  onClick={() => setSlideMode('comparative')}
                  style={{
                    padding: '5px 12px',
                    fontSize: '11px',
                    fontWeight: 600,
                    border: 'none',
                    cursor: 'pointer',
                    background: slideMode === 'comparative' ? '#0284c7' : 'var(--soft)',
                    color: slideMode === 'comparative' ? '#fff' : 'var(--fg)',
                  }}
                >
                  Side-by-Side Comparison Slide
                </button>
              </div>
            )}

            {slideMode === 'individual' && selectedRuns.length > 1 && (
              <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                <button
                  type="button"
                  className="btn sm"
                  disabled={activeRunIndex === 0}
                  onClick={() => {
                    setActiveRunIndex((i) => Math.max(0, i - 1));
                    setPageKey('chemistry_design');
                  }}
                  style={{ fontSize: '11px', padding: '3px 8px' }}
                >
                  ◀ Prev Run
                </button>
                <div style={{ display: 'inline-flex', gap: '4px' }}>
                  {selectedRuns.map((r, rIdx) => (
                    <button
                      key={r.id}
                      type="button"
                      onClick={() => {
                        setActiveRunIndex(rIdx);
                        setPageKey('chemistry_design');
                      }}
                      style={{
                        padding: '3px 8px',
                        fontSize: '11px',
                        borderRadius: '4px',
                        border: '1px solid var(--line)',
                        background: activeRunIndex === rIdx ? '#0284c7' : 'var(--soft)',
                        color: activeRunIndex === rIdx ? '#fff' : 'var(--fg)',
                        cursor: 'pointer',
                        fontWeight: activeRunIndex === rIdx ? 600 : 400,
                      }}
                      title={r.name}
                    >
                      Run {rIdx + 1}: {r.name.length > 18 ? r.name.slice(0, 18) + '…' : r.name}
                    </button>
                  ))}
                </div>
                <button
                  type="button"
                  className="btn sm"
                  disabled={activeRunIndex === selectedRuns.length - 1}
                  onClick={() => {
                    setActiveRunIndex((i) => Math.min(selectedRuns.length - 1, i + 1));
                    setPageKey('chemistry_design');
                  }}
                  style={{ fontSize: '11px', padding: '3px 8px' }}
                >
                  Next Run ▶
                </button>
              </div>
            )}
          </div>

          {/* Theme & Presenter Controls */}
          <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
            <label style={{ display: 'inline-flex', alignItems: 'center', gap: '6px', fontSize: '11px' }}>
              <span style={{ color: 'var(--mut)' }}>Presenter:</span>
              <input
                type="text"
                value={presenter}
                onChange={(e) => setPresenter(e.target.value)}
                style={{
                  padding: '3px 8px',
                  fontSize: '11px',
                  borderRadius: '4px',
                  border: '1px solid var(--line)',
                  background: 'var(--soft)',
                  color: 'var(--fg)',
                  width: '120px',
                }}
              />
            </label>

            <div style={{ display: 'inline-flex', border: '1px solid var(--line)', borderRadius: '6px', overflow: 'hidden' }}>
              <button
                type="button"
                onClick={() => setTheme('dark')}
                style={{
                  padding: '4px 10px',
                  fontSize: '11px',
                  border: 'none',
                  cursor: 'pointer',
                  background: theme === 'dark' ? '#0f172a' : 'var(--soft)',
                  color: theme === 'dark' ? '#38bdf8' : 'var(--fg)',
                  fontWeight: theme === 'dark' ? 600 : 400,
                }}
              >
                🌙 Dark Slide
              </button>
              <button
                type="button"
                onClick={() => setTheme('light')}
                style={{
                  padding: '4px 10px',
                  fontSize: '11px',
                  border: 'none',
                  cursor: 'pointer',
                  background: theme === 'light' ? '#ffffff' : 'var(--soft)',
                  color: theme === 'light' ? '#0284c7' : 'var(--fg)',
                  fontWeight: theme === 'light' ? 600 : 400,
                }}
              >
                ☀️ Light / Print
              </button>
            </div>
          </div>
        </div>

        {/* Slide Deck Pagination & Page Tabs (When in Individual Run Mode) */}
        {slideMode === 'individual' && (
          <div
            style={{
              padding: '8px 20px',
              borderBottom: '1px solid var(--line)',
              background: 'var(--soft)',
              display: 'flex',
              justifyContent: 'space-between',
              alignItems: 'center',
              flexWrap: 'wrap',
              gap: '10px',
            }}
          >
            {/* Slide Navigation Tabs */}
            <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' }}>
              <span style={{ fontSize: '11px', fontWeight: 600, color: 'var(--mut)', textTransform: 'uppercase' }}>
                Slide Deck:
              </span>

              {availablePages.map((page) => {
                const isCurrent = pageKey === page.key;
                const isDisabled = !page.enabled;

                return (
                  <button
                    key={page.key}
                    type="button"
                    onClick={() => {
                      if (!page.enabled) {
                        toast(`Slide ${page.pageNumber} is locked because no ${page.key === 'results_hits' ? 'results/conversions' : 'observations'} have been logged in the HTE notebook yet. Toggle "Preview All Slides" below to view anyway.`);
                        return;
                      }
                      setPageKey(page.key);
                    }}
                    style={{
                      padding: '5px 12px',
                      fontSize: '12px',
                      fontWeight: isCurrent ? 600 : 400,
                      borderRadius: '6px',
                      border: isCurrent
                        ? '1px solid #0284c7'
                        : '1px solid var(--line)',
                      background: isCurrent
                        ? '#0284c7'
                        : isDisabled
                        ? 'rgba(0,0,0,0.1)'
                        : 'var(--panel)',
                      color: isCurrent
                        ? '#ffffff'
                        : isDisabled
                        ? 'var(--mut)'
                        : 'var(--fg)',
                      cursor: isDisabled ? 'not-allowed' : 'pointer',
                      display: 'inline-flex',
                      alignItems: 'center',
                      gap: '6px',
                      opacity: isDisabled ? 0.6 : 1,
                    }}
                  >
                    <span>{page.label}</span>
                    <span
                      style={{
                        fontSize: '9px',
                        padding: '1px 5px',
                        borderRadius: '4px',
                        background: isCurrent
                          ? 'rgba(255,255,255,0.25)'
                          : page.enabled
                          ? 'rgba(16, 185, 129, 0.15)'
                          : 'rgba(148, 163, 184, 0.2)',
                        color: isCurrent
                          ? '#ffffff'
                          : page.enabled
                          ? '#10b981'
                          : 'var(--mut)',
                        fontWeight: 600,
                      }}
                    >
                      {page.statusBadge}
                    </span>
                  </button>
                );
              })}

              {/* Prev / Next Slide Pager */}
              {unlockedPages.length > 1 && (
                <div style={{ display: 'inline-flex', alignItems: 'center', gap: '4px', marginLeft: '6px' }}>
                  <button
                    type="button"
                    className="btn sm"
                    disabled={activePageIndex <= 0}
                    onClick={() => {
                      if (activePageIndex > 0) {
                        setPageKey(unlockedPages[activePageIndex - 1].key);
                      }
                    }}
                    style={{ fontSize: '11px', padding: '2px 8px' }}
                  >
                    ◀ Prev Slide
                  </button>
                  <span style={{ fontSize: '11px', color: 'var(--mut)', padding: '0 4px' }}>
                    {activePageIndex + 1} of {unlockedPages.length}
                  </span>
                  <button
                    type="button"
                    className="btn sm"
                    disabled={activePageIndex >= unlockedPages.length - 1}
                    onClick={() => {
                      if (activePageIndex < unlockedPages.length - 1) {
                        setPageKey(unlockedPages[activePageIndex + 1].key);
                      }
                    }}
                    style={{ fontSize: '11px', padding: '2px 8px' }}
                  >
                    Next Slide ▶
                  </button>
                </div>
              )}
            </div>

            {/* Conditional Logic Indicator & Force Preview Toggle */}
            <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
              {!currentSlide?.hasResults && (
                <label
                  style={{
                    display: 'inline-flex',
                    alignItems: 'center',
                    gap: '6px',
                    fontSize: '11px',
                    color: 'var(--mut)',
                    cursor: 'pointer',
                  }}
                  title="If results haven't been completed in the lab this week, Slide 1 is normally self-contained. Check this to preview empty results/observation slides."
                >
                  <input
                    type="checkbox"
                    checked={forceUnlockAll}
                    onChange={(e) => setForceUnlockAll(e.target.checked)}
                    style={{ cursor: 'pointer' }}
                  />
                  <span>Preview blank Results & SAR slides</span>
                </label>
              )}
            </div>
          </div>
        )}

        {/* Modal Main Body */}
        <div
          style={{
            padding: '16px 20px',
            overflowY: 'auto',
            display: 'flex',
            flexDirection: 'column',
            gap: '16px',
            alignItems: 'center',
          }}
        >
          {/* Informative single-slide banner when mid-week without notebook results */}
          {slideMode === 'individual' && !currentSlide?.hasResults && !forceUnlockAll && (
            <div
              style={{
                width: '100%',
                maxWidth: '1040px',
                padding: '10px 14px',
                borderRadius: '8px',
                background: 'rgba(56, 189, 248, 0.08)',
                border: '1px solid rgba(56, 189, 248, 0.25)',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                fontSize: '12px',
                color: 'var(--fg)',
              }}
            >
              <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                <span style={{ fontSize: '16px' }}>🧪</span>
                <span>
                  <b>Mid-Week Screening Progress:</b> Notebook results are pending incubation / LC-MS. Slide 1 (The Chemistry & Experiment Design Matrix) is generated. Results & SAR slides unlock automatically when logged in the HTE notebook.
                </span>
              </div>
              <button
                type="button"
                className="btn sm"
                onClick={() => setForceUnlockAll(true)}
                style={{ fontSize: '11px', whiteSpace: 'nowrap' }}
              >
                Force Unlock All 3 Slides
              </button>
            </div>
          )}

          {/* 16:9 Presentation Slide Canvas Preview */}
          <div
            style={{
              width: '100%',
              maxWidth: '1040px',
              aspectRatio: '16 / 9',
              background: theme === 'dark' ? '#0b1120' : '#f8fafc',
              borderRadius: '8px',
              border: '1px solid var(--line)',
              boxShadow: '0 8px 30px rgba(0,0,0,0.3)',
              overflow: 'hidden',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              position: 'relative',
            }}
          >
            <canvas
              ref={canvasRef}
              style={{
                width: '100%',
                height: '100%',
                objectFit: 'contain',
                display: 'block',
              }}
            />
          </div>

          {/* Slide Content Customization Drawer */}
          {slideMode === 'individual' && currentSlide && (
            <div
              style={{
                width: '100%',
                maxWidth: '1040px',
                background: 'var(--soft)',
                border: '1px solid var(--line)',
                borderRadius: '8px',
                padding: '14px 18px',
                display: 'flex',
                flexDirection: 'column',
                gap: '12px',
              }}
            >
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: '8px' }}>
                <span style={{ fontSize: '12px', fontWeight: 600 }}>
                  Active Slide Data & Scientific Takeaways:
                </span>

                <button
                  type="button"
                  className="btn sm"
                  disabled={aiGenerating}
                  onClick={handleAiBullets}
                  style={{
                    fontSize: '11px',
                    color: '#0284c7',
                    borderColor: 'rgba(2, 132, 199, 0.4)',
                    background: 'rgba(2, 132, 199, 0.08)',
                    display: 'inline-flex',
                    alignItems: 'center',
                    gap: '5px',
                  }}
                  title="Ask AI to synthesize 3 group meeting takeaway bullets from your experiment data"
                >
                  {aiGenerating ? '✦ AI Thinking…' : '✦ AI Draft 3 Meeting Bullets'}
                </button>
              </div>

              {/* Title & Objective Edit Inputs */}
              <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                  <span style={{ fontSize: '11px', color: 'var(--mut)', width: '130px' }}>Campaign Title:</span>
                  <input
                    type="text"
                    value={currentSlide.runName}
                    onChange={(e) => handleUpdateTitle(e.target.value)}
                    style={{
                      flex: 1,
                      padding: '5px 8px',
                      fontSize: '12px',
                      borderRadius: '4px',
                      border: '1px solid var(--line)',
                      background: 'var(--panel)',
                      color: 'var(--fg)',
                    }}
                  />
                </div>

                <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                  <span style={{ fontSize: '11px', color: 'var(--mut)', width: '130px' }}>Scientific Hypothesis:</span>
                  <input
                    type="text"
                    value={currentSlide.hypothesis}
                    onChange={(e) => handleUpdateHypothesis(e.target.value)}
                    style={{
                      flex: 1,
                      padding: '5px 8px',
                      fontSize: '12px',
                      borderRadius: '4px',
                      border: '1px solid var(--line)',
                      background: 'var(--panel)',
                      color: 'var(--fg)',
                    }}
                  />
                </div>

                {currentSlide.bullets && currentSlide.bullets.map((b, idx) => (
                  <div key={idx} style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                    <span style={{ fontSize: '11px', color: '#f59e0b', fontWeight: 600, width: '130px' }}>
                      Takeaway Bullet {idx + 1}:
                    </span>
                    <input
                      type="text"
                      value={b}
                      onChange={(e) => handleUpdateBullet(idx, e.target.value)}
                      style={{
                        flex: 1,
                        padding: '5px 8px',
                        fontSize: '12px',
                        borderRadius: '4px',
                        border: '1px solid var(--line)',
                        background: 'var(--panel)',
                        color: 'var(--fg)',
                      }}
                    />
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
};
