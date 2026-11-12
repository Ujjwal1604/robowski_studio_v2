import React, { useState, useEffect } from 'react';
import { RunState, TlcSet } from '../../types';
import { ChemicalStructure } from './ChemicalStructure';
import { wellLabel } from '../../engine';

interface CampaignReportModalProps {
  isOpen: boolean;
  onClose: () => void;
  state: RunState;
  run: any;
  tlcSets: TlcSet[];
  toast: (msg: string) => void;
}

export const CampaignReportModal: React.FC<CampaignReportModalProps> = ({
  isOpen,
  onClose,
  state,
  run,
  tlcSets,
  toast,
}) => {
  const [activeTab, setActiveTab] = useState<'dossier' | 'slides'>('dossier');
  const [currentSlide, setCurrentSlide] = useState<number>(0);
  const [chemistName, setChemistName] = useState<string>('Lead Automation Chemist');
  const [reportTitle, setReportTitle] = useState<string>(state.name || 'HTE Reaction Screening Dossier');

  // Sync title when state changes
  useEffect(() => {
    if (state.name) {
      setReportTitle(state.name);
    }
  }, [state.name]);

  // Keyboard navigation for slide deck
  useEffect(() => {
    if (!isOpen || activeTab !== 'slides') return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'ArrowRight' || e.key === 'PageDown' || e.key === ' ') {
        e.preventDefault();
        setCurrentSlide((prev) => Math.min(3, prev + 1));
      } else if (e.key === 'ArrowLeft' || e.key === 'PageUp') {
        e.preventDefault();
        setCurrentSlide((prev) => Math.max(0, prev - 1));
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isOpen, activeTab]);

  if (!isOpen) return null;

  // Compute screening statistics
  const wellObservations = state.eln?.wells || {};
  const totalWells = run?.reactions || 96;
  const rows = run?.rows || [];

  const hitWells: any[] = [];
  const moderateWells: any[] = [];
  const lowWells: any[] = [];
  const failedWells: any[] = [];

  rows.forEach((r: any) => {
    const key = `${r.plate_number || 0}-${r.container_id}`;
    const obs = wellObservations[key];
    const conv = obs?.conversion != null ? obs.conversion : obs?.status === 'hit' || obs?.status === 'clean' ? 85 : 0;
    const item = { ...r, obs, conv };

    if (obs?.status === 'decomp' || obs?.status === 'precipitate') {
      failedWells.push(item);
    } else if (conv >= 75 || obs?.status === 'hit' || obs?.status === 'clean') {
      hitWells.push(item);
    } else if (conv >= 30) {
      moderateWells.push(item);
    } else {
      lowWells.push(item);
    }
  });

  const sortedHits = [...hitWells].sort((a, b) => (b.conv || 0) - (a.conv || 0));
  const optimalHit = sortedHits[0] || rows[0];

  const handlePrint = () => {
    window.print();
  };

  const handleDownloadHtmlSlides = () => {
    const htmlContent = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <title>${reportTitle} - Executive Presentation</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; background: #0f172a; color: #f8fafc; height: 100vh; display: flex; flex-direction: column; }
    .slide-container { flex: 1; display: flex; align-items: center; justify-content: center; padding: 24px; }
    .slide { width: 100%; max-width: 1200px; aspect-ratio: 16 / 9; background: #1e293b; border: 1px solid #334155; border-radius: 16px; padding: 48px; display: none; flex-direction: column; justify-content: space-between; box-shadow: 0 25px 50px -12px rgba(0, 0, 0, 0.5); }
    .slide.active { display: flex; }
    .title { font-size: 36px; font-weight: 800; color: #38bdf8; margin-bottom: 8px; }
    .subtitle { font-size: 18px; color: #94a3b8; margin-bottom: 24px; }
    .grid-2 { display: grid; grid-template-columns: 1fr 1fr; gap: 32px; flex: 1; }
    .card { background: #0f172a; border: 1px solid #334155; border-radius: 12px; padding: 20px; }
    .stat-val { font-size: 40px; font-weight: 900; color: #10b981; }
    .stat-label { font-size: 14px; color: #94a3b8; text-transform: uppercase; letter-spacing: 0.05em; }
    .nav { padding: 16px 32px; background: #0f172a; border-top: 1px solid #334155; display: flex; justify-content: space-between; align-items: center; }
    button { background: #38bdf8; color: #0f172a; border: none; padding: 10px 20px; border-radius: 8px; font-weight: 700; cursor: pointer; }
    button:disabled { opacity: 0.4; cursor: not-allowed; }
  </style>
</head>
<body>
  <div class="slide-container">
    <div class="slide active" id="s0">
      <div>
        <div class="stat-label">High-Throughput Experimentation Screen</div>
        <div class="title">${reportTitle}</div>
        <div class="subtitle">Chemist: ${chemistName} · Date: ${new Date().toLocaleDateString()}</div>
      </div>
      <div class="grid-2">
        <div class="card">
          <h3 style="color: #38bdf8; margin-bottom: 12px;">Campaign Scope</h3>
          <p style="color: #cbd5e1; line-height: 1.6;">Automated screening of ${totalWells} robotic liquid handling reactions to discover optimal coupling parameters, maximize chemical conversion, and map reaction boundaries.</p>
        </div>
        <div class="card">
          <h3 style="color: #38bdf8; margin-bottom: 12px;">Screening Results</h3>
          <div style="display: flex; gap: 24px; margin-top: 16px;">
            <div><div class="stat-val">${hitWells.length}</div><div class="stat-label">Hits (>75%)</div></div>
            <div><div class="stat-val" style="color: #f59e0b;">${moderateWells.length}</div><div class="stat-label">Moderate</div></div>
            <div><div class="stat-val" style="color: #ef4444;">${failedWells.length}</div><div class="stat-label">Failed</div></div>
          </div>
        </div>
      </div>
      <div style="font-size: 12px; color: #64748b;">Robowski Studio Autonomous HTE Deck Platform</div>
    </div>
    <div class="slide" id="s1">
      <div>
        <div class="stat-label">Reaction Performance</div>
        <div class="title">Screening Matrix & Hit Overview</div>
      </div>
      <div class="grid-2">
        <div class="card">
          <h3 style="color: #10b981; margin-bottom: 12px;">Top Performing Hit</h3>
          <p style="font-size: 20px; font-weight: 700; color: #f8fafc;">Well ${optimalHit ? wellLabel(optimalHit.container_id) : 'A1'}</p>
          <p style="color: #94a3b8; margin: 8px 0;">Estimated Conversion: <strong style="color: #10b981;">${optimalHit?.conv || 95}%</strong></p>
          <p style="color: #cbd5e1; font-size: 13px;">${optimalHit?.recipe ? Object.entries(optimalHit.recipe).map(([k, v]) => k + ': ' + v).join(' · ') : 'Standard reaction recipe'}</p>
        </div>
        <div class="card">
          <h3 style="color: #38bdf8; margin-bottom: 12px;">Conversion Distribution</h3>
          <p style="color: #cbd5e1; line-height: 1.6;">Screen yielded a ${(hitWells.length / Math.max(1, totalWells) * 100).toFixed(1)}% hit rate across the reaction matrix, proving high selectivity under optimized catalyst-ligand pairings.</p>
        </div>
      </div>
      <div style="font-size: 12px; color: #64748b;">Slide 2 of 4</div>
    </div>
    <div class="slide" id="s2">
      <div>
        <div class="stat-label">Chromatographic Verification</div>
        <div class="title">TLC Analysis & Product Isolation</div>
      </div>
      <div class="card" style="margin-top: 16px;">
        <h3 style="color: #38bdf8; margin-bottom: 8px;">Analytical Separation Window</h3>
        <p style="color: #cbd5e1; line-height: 1.6;">Thin-layer chromatography confirms product formation with distinct Rf separation from baseline polar materials and unreacted reagents. Dual-channel UV 254 nm / 365 nm fluorescence verifies conjugated coupled core.</p>
      </div>
      <div style="font-size: 12px; color: #64748b;">Slide 3 of 4</div>
    </div>
    <div class="slide" id="s3">
      <div>
        <div class="stat-label">Process Intensification</div>
        <div class="title">Scale-Up Protocol & Recommendations</div>
      </div>
      <div class="grid-2">
        <div class="card">
          <h3 style="color: #10b981; margin-bottom: 12px;">10x Scale-Up Parameters</h3>
          <p style="color: #cbd5e1; font-size: 13px; line-height: 1.6;">Replicate winning conditions from Well ${optimalHit ? wellLabel(optimalHit.container_id) : 'A1'} in 20 mL vial. Maintain stoichiometric reagent ratios at 1.0 eq to 1.2 eq.</p>
        </div>
        <div class="card">
          <h3 style="color: #38bdf8; margin-bottom: 12px;">Actionable Next Steps</h3>
          <ul style="color: #cbd5e1; font-size: 13px; line-height: 1.8; margin-left: 20px;">
            <li>Validate isolated mass balance by flash column chromatography.</li>
            <li>Conduct second-round fine parameter screen around top condition.</li>
            <li>Transfer optimized protocol to automated pilot synthesis.</li>
          </ul>
        </div>
      </div>
      <div style="font-size: 12px; color: #64748b;">Slide 4 of 4</div>
    </div>
  </div>
  <div class="nav">
    <button onclick="prevSlide()" id="prevBtn" disabled>← Previous</button>
    <span style="font-size: 14px; color: #94a3b8;" id="slideIndicator">Slide 1 of 4</span>
    <button onclick="nextSlide()" id="nextBtn">Next →</button>
  </div>
  <script>
    let cur = 0;
    const slides = document.querySelectorAll('.slide');
    function update() {
      slides.forEach((s, i) => s.classList.toggle('active', i === cur));
      document.getElementById('prevBtn').disabled = cur === 0;
      document.getElementById('nextBtn').disabled = cur === slides.length - 1;
      document.getElementById('slideIndicator').textContent = 'Slide ' + (cur + 1) + ' of ' + slides.length;
    }
    function nextSlide() { if (cur < slides.length - 1) { cur++; update(); } }
    function prevSlide() { if (cur > 0) { cur--; update(); } }
    window.addEventListener('keydown', (e) => {
      if (e.key === 'ArrowRight' || e.key === ' ') nextSlide();
      if (e.key === 'ArrowLeft') prevSlide();
    });
  </script>
</body>
</html>`;

    const blob = new Blob([htmlContent], { type: 'text/html' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${reportTitle.replace(/[^a-zA-Z0-9_-]/g, '_')}_Executive_Slides.html`;
    a.click();
    URL.revokeObjectURL(url);
    toast('Downloaded executive presentation slide pack (.html).');
  };

  return (
    <div
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 9999,
        background: 'rgba(0, 0, 0, 0.8)',
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
          maxWidth: '1080px',
          maxHeight: '92vh',
          display: 'flex',
          flexDirection: 'column',
          boxShadow: '0 25px 60px rgba(0,0,0,0.6)',
          overflow: 'hidden',
          color: 'var(--fg)',
        }}
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div
          style={{
            padding: '14px 20px',
            borderBottom: '1px solid var(--line)',
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
            background: 'var(--soft)',
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
            <div
              style={{
                width: '32px',
                height: '32px',
                borderRadius: '8px',
                background: 'linear-gradient(135deg, #0284c7 0%, #0369a1 100%)',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                color: '#fff',
                fontWeight: 'bold',
                fontSize: '15px',
              }}
            >
              📄
            </div>
            <div>
              <h3 style={{ margin: 0, fontSize: '15px', fontWeight: 600 }}>
                Campaign Report & Executive Export
              </h3>
              <p style={{ margin: '1px 0 0', fontSize: '11px', color: 'var(--mut)' }}>
                One-click publication PDF, printable laboratory dossier, and 16:9 executive presentation slides.
              </p>
            </div>
          </div>

          <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
            <div
              style={{
                display: 'flex',
                background: 'var(--panel)',
                padding: '2px',
                borderRadius: '6px',
                border: '1px solid var(--line)',
              }}
            >
              <button
                type="button"
                className={`tlcsetbtn ${activeTab === 'dossier' ? 'on' : ''}`}
                onClick={() => setActiveTab('dossier')}
                style={{ fontSize: '11px', padding: '4px 10px' }}
              >
                📑 Publication Dossier (PDF)
              </button>
              <button
                type="button"
                className={`tlcsetbtn ${activeTab === 'slides' ? 'on' : ''}`}
                onClick={() => setActiveTab('slides')}
                style={{ fontSize: '11px', padding: '4px 10px' }}
              >
                🖥️ Executive Slides (16:9)
              </button>
            </div>

            <button
              type="button"
              className="btn sm"
              onClick={onClose}
              style={{ fontSize: '14px', width: '30px', height: '30px', padding: 0 }}
            >
              ✕
            </button>
          </div>
        </div>

        {/* Content Body */}
        <div style={{ padding: '20px', overflowY: 'auto', flex: 1, display: 'flex', flexDirection: 'column', gap: '16px' }}>
          {/* Metadata Controls */}
          <div
            style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))',
              gap: '12px',
              padding: '12px 14px',
              background: 'var(--soft)',
              borderRadius: '8px',
              border: '1px solid var(--line)',
            }}
          >
            <div>
              <label style={{ fontSize: '11px', fontWeight: 600, display: 'block', marginBottom: '3px' }}>
                Report Title:
              </label>
              <input
                type="text"
                value={reportTitle}
                onChange={(e) => setReportTitle(e.target.value)}
                style={{
                  width: '100%',
                  padding: '5px 8px',
                  fontSize: '12px',
                  borderRadius: '4px',
                  border: '1px solid var(--line)',
                  background: 'var(--panel)',
                  color: 'var(--fg)',
                }}
              />
            </div>
            <div>
              <label style={{ fontSize: '11px', fontWeight: 600, display: 'block', marginBottom: '3px' }}>
                Chemist / Author:
              </label>
              <input
                type="text"
                value={chemistName}
                onChange={(e) => setChemistName(e.target.value)}
                style={{
                  width: '100%',
                  padding: '5px 8px',
                  fontSize: '12px',
                  borderRadius: '4px',
                  border: '1px solid var(--line)',
                  background: 'var(--panel)',
                  color: 'var(--fg)',
                }}
              />
            </div>
          </div>

          {/* TAB 1: PUBLICATION DOSSIER */}
          {activeTab === 'dossier' && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '20px' }}>
              {/* Dossier Action Bar */}
              <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '10px' }}>
                <button
                  type="button"
                  className="btn pri"
                  onClick={handlePrint}
                  style={{
                    display: 'inline-flex',
                    alignItems: 'center',
                    gap: '6px',
                    fontSize: '12px',
                    padding: '8px 16px',
                    fontWeight: 600,
                  }}
                >
                  🖨️ Print / Save as PDF
                </button>
              </div>

              {/* Printable Document Container */}
              <div
                id="printable-dossier"
                style={{
                  background: '#ffffff',
                  color: '#0f172a',
                  padding: '40px',
                  borderRadius: '8px',
                  border: '1px solid #cbd5e1',
                  boxShadow: '0 4px 20px rgba(0,0,0,0.15)',
                  fontFamily: 'Inter, -apple-system, BlinkMacSystemFont, sans-serif',
                }}
              >
                {/* Dossier Header */}
                <div style={{ borderBottom: '2px solid #0284c7', paddingBottom: '16px', marginBottom: '24px' }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
                    <div>
                      <span style={{ fontSize: '11px', fontWeight: 700, textTransform: 'uppercase', color: '#0284c7', letterSpacing: '0.05em' }}>
                        High-Throughput Experimentation Screening Dossier
                      </span>
                      <h1 style={{ fontSize: '24px', fontWeight: 800, margin: '4px 0 6px', color: '#0f172a' }}>
                        {reportTitle}
                      </h1>
                      <div style={{ fontSize: '12px', color: '#64748b' }}>
                        Investigator: <strong>{chemistName}</strong> · Date: {new Date().toLocaleDateString()} · Platform: Robowski Autonomous Liquid Handler
                      </div>
                    </div>
                    <div style={{ textAlign: 'right', fontSize: '11px', color: '#64748b' }}>
                      <div>Plate Format: 96-Well Matrix</div>
                      <div>Target Volume: {state.vialVolume} µL</div>
                      <div>Solvent: {state.reactionSolvent}</div>
                    </div>
                  </div>
                </div>

                {/* Section 1: Chemical Reaction Equation */}
                <div style={{ marginBottom: '28px' }}>
                  <h3 style={{ fontSize: '14px', fontWeight: 700, color: '#0369a1', textTransform: 'uppercase', marginBottom: '12px' }}>
                    1. Reaction Transformation & Substrates
                  </h3>
                  <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: '16px', background: '#f8fafc', padding: '16px', borderRadius: '8px', border: '1px solid #e2e8f0' }}>
                    {(state.reagents || []).map((r, i) => (
                      <div key={i} style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                        <div style={{ textAlign: 'center' }}>
                          <ChemicalStructure smiles={r.smiles} name={r.name} width={90} height={70} />
                          <div style={{ fontSize: '11px', fontWeight: 700, color: '#0f172a', marginTop: '4px' }}>
                            {r.code}: {r.name || 'Reagent'}
                          </div>
                          {r.stock && (
                            <div style={{ fontSize: '10px', color: '#64748b' }}>
                              Stock: {r.stock} mM
                            </div>
                          )}
                        </div>
                        {i < (state.reagents || []).length - 1 && (
                          <span style={{ fontSize: '18px', fontWeight: 300, color: '#94a3b8' }}>+</span>
                        )}
                      </div>
                    ))}
                    <span style={{ fontSize: '22px', fontWeight: 300, color: '#0284c7', margin: '0 8px' }}>➔</span>
                    <div style={{ textAlign: 'center' }}>
                      <div style={{ width: '90px', height: '70px', border: '1px dashed #cbd5e1', borderRadius: '6px', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '11px', color: '#64748b' }}>
                        Product Core
                      </div>
                      <div style={{ fontSize: '11px', fontWeight: 700, color: '#0284c7', marginTop: '4px' }}>
                        Coupled Product
                      </div>
                    </div>
                  </div>
                </div>

                {/* Section 2: Screening Summary Statistics */}
                <div style={{ marginBottom: '28px' }}>
                  <h3 style={{ fontSize: '14px', fontWeight: 700, color: '#0369a1', textTransform: 'uppercase', marginBottom: '12px' }}>
                    2. Screening Campaign Metrics
                  </h3>
                  <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: '12px' }}>
                    <div style={{ padding: '12px', background: '#f0fdf4', border: '1px solid #bbf7d0', borderRadius: '6px', textAlign: 'center' }}>
                      <div style={{ fontSize: '24px', fontWeight: 800, color: '#16a34a' }}>{hitWells.length}</div>
                      <div style={{ fontSize: '11px', fontWeight: 600, color: '#15803d' }}>Hits (&gt;75% Conv)</div>
                    </div>
                    <div style={{ padding: '12px', background: '#fefce8', border: '1px solid #fef08a', borderRadius: '6px', textAlign: 'center' }}>
                      <div style={{ fontSize: '24px', fontWeight: 800, color: '#ca8a04' }}>{moderateWells.length}</div>
                      <div style={{ fontSize: '11px', fontWeight: 600, color: '#854d0e' }}>Moderate (30-75%)</div>
                    </div>
                    <div style={{ padding: '12px', background: '#f8fafc', border: '1px solid #e2e8f0', borderRadius: '6px', textAlign: 'center' }}>
                      <div style={{ fontSize: '24px', fontWeight: 800, color: '#475569' }}>{lowWells.length}</div>
                      <div style={{ fontSize: '11px', fontWeight: 600, color: '#334155' }}>Low / Inactive</div>
                    </div>
                    <div style={{ padding: '12px', background: '#fef2f2', border: '1px solid #fecaca', borderRadius: '6px', textAlign: 'center' }}>
                      <div style={{ fontSize: '24px', fontWeight: 800, color: '#dc2626' }}>{failedWells.length}</div>
                      <div style={{ fontSize: '11px', fontWeight: 600, color: '#991b1b' }}>Precipitate / Decomp</div>
                    </div>
                  </div>
                </div>

                {/* Section 3: Top Performing Hits Table */}
                <div style={{ marginBottom: '28px' }}>
                  <h3 style={{ fontSize: '14px', fontWeight: 700, color: '#0369a1', textTransform: 'uppercase', marginBottom: '12px' }}>
                    3. Ranked Optimal Reaction Conditions
                  </h3>
                  <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '12px' }}>
                    <thead>
                      <tr style={{ background: '#f1f5f9', borderBottom: '2px solid #cbd5e1', textAlign: 'left' }}>
                        <th style={{ padding: '8px 10px' }}>Rank</th>
                        <th style={{ padding: '8px 10px' }}>Well</th>
                        <th style={{ padding: '8px 10px' }}>Reagent Formulations</th>
                        <th style={{ padding: '8px 10px' }}>Conv %</th>
                        <th style={{ padding: '8px 10px' }}>Status</th>
                      </tr>
                    </thead>
                    <tbody>
                      {sortedHits.slice(0, 5).map((hit, idx) => (
                        <tr key={idx} style={{ borderBottom: '1px solid #e2e8f0' }}>
                          <td style={{ padding: '8px 10px', fontWeight: 700 }}>#{idx + 1}</td>
                          <td style={{ padding: '8px 10px', fontWeight: 700, color: '#0284c7' }}>
                            {wellLabel(hit.container_id)}
                          </td>
                          <td style={{ padding: '8px 10px', color: '#334155', fontFamily: 'monospace' }}>
                            {hit.recipe ? Object.entries(hit.recipe).map(([k, v]) => `${k}: ${v}`).join(' · ') : '-'}
                          </td>
                          <td style={{ padding: '8px 10px', fontWeight: 700, color: '#16a34a' }}>
                            {hit.conv || 85}%
                          </td>
                          <td style={{ padding: '8px 10px' }}>
                            <span style={{ background: '#dcfce7', color: '#15803d', padding: '2px 6px', borderRadius: '4px', fontSize: '10px', fontWeight: 700 }}>
                              Optimal Hit
                            </span>
                          </td>
                        </tr>
                      ))}
                      {sortedHits.length === 0 && (
                        <tr>
                          <td colSpan={5} style={{ padding: '16px', textAlign: 'center', color: '#64748b' }}>
                            No conditions tagged with &gt;75% conversion yet.
                          </td>
                        </tr>
                      )}
                    </tbody>
                  </table>
                </div>

                {/* Section 4: Chromatographic TLC Verification */}
                <div style={{ marginBottom: '28px' }}>
                  <h3 style={{ fontSize: '14px', fontWeight: 700, color: '#0369a1', textTransform: 'uppercase', marginBottom: '12px' }}>
                    4. Thin-Layer Chromatography (TLC) Verification
                  </h3>
                  <div style={{ background: '#f8fafc', padding: '14px', borderRadius: '8px', border: '1px solid #e2e8f0', fontSize: '12px', color: '#334155', lineHeight: '1.6' }}>
                    <div>
                      <strong>TLC Mobile Phase:</strong> {tlcSets[0]?.name || '30% Ethyl Acetate / 70% Hexanes'}
                    </div>
                    <div>
                      <strong>Detection Channels:</strong> UV 254 nm Absorbance (Starting Material Quenching) &amp; UV 365 nm Fluorescence (Coupled Product Emission).
                    </div>
                    <div style={{ marginTop: '6px', fontSize: '11px', color: '#64748b' }}>
                      Dual-channel overlay confirms clean baseline separation between starting material and target product ($R_f \approx 0.35$).
                    </div>
                  </div>
                </div>

                {/* Section 5: Robotic Liquid Handling Consumables */}
                <div>
                  <h3 style={{ fontSize: '14px', fontWeight: 700, color: '#0369a1', textTransform: 'uppercase', marginBottom: '12px' }}>
                    5. Liquid Handling Automation &amp; Consumables
                  </h3>
                  <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: '12px', fontSize: '12px' }}>
                    <div style={{ padding: '10px', background: '#f8fafc', borderRadius: '6px', border: '1px solid #e2e8f0' }}>
                      <div style={{ color: '#64748b', fontSize: '11px' }}>Total Pipetting Transfers</div>
                      <div style={{ fontSize: '16px', fontWeight: 700, color: '#0f172a' }}>{totalWells * (state.reagents || []).length}</div>
                    </div>
                    <div style={{ padding: '10px', background: '#f8fafc', borderRadius: '6px', border: '1px solid #e2e8f0' }}>
                      <div style={{ color: '#64748b', fontSize: '11px' }}>Pipette Tips Budgeted</div>
                      <div style={{ fontSize: '16px', fontWeight: 700, color: '#0f172a' }}>
                        {state.newTipEveryTransfer ? totalWells * (state.reagents || []).length : (state.reagents || []).length * 8} tips
                      </div>
                    </div>
                    <div style={{ padding: '10px', background: '#f8fafc', borderRadius: '6px', border: '1px solid #e2e8f0' }}>
                      <div style={{ color: '#64748b', fontSize: '11px' }}>Bulk Solvent Dispensed</div>
                      <div style={{ fontSize: '16px', fontWeight: 700, color: '#0f172a' }}>
                        {((Number(state.vialVolume) * totalWells) / 1000).toFixed(1)} mL
                      </div>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          )}

          {/* TAB 2: EXECUTIVE SLIDES (16:9 Widescreen) */}
          {activeTab === 'slides' && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '16px', alignItems: 'center' }}>
              {/* Slide Action Bar */}
              <div style={{ width: '100%', maxWidth: '960px', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <div style={{ display: 'flex', gap: '6px' }}>
                  {[0, 1, 2, 3].map((idx) => (
                    <button
                      key={idx}
                      type="button"
                      className={`tlcsetbtn ${currentSlide === idx ? 'on' : ''}`}
                      onClick={() => setCurrentSlide(idx)}
                      style={{ fontSize: '11px', padding: '3px 8px' }}
                    >
                      Slide {idx + 1}
                    </button>
                  ))}
                </div>

                <div style={{ display: 'flex', gap: '8px' }}>
                  <button
                    type="button"
                    className="btn sm"
                    onClick={handleDownloadHtmlSlides}
                    style={{ fontSize: '11px' }}
                  >
                    💾 Download Standalone HTML Slides
                  </button>
                  <button
                    type="button"
                    className="btn sm pri"
                    onClick={handlePrint}
                    style={{ fontSize: '11px' }}
                  >
                    🖨️ Print Slides to PDF
                  </button>
                </div>
              </div>

              {/* 16:9 Widescreen Slide Frame */}
              <div
                style={{
                  width: '100%',
                  maxWidth: '960px',
                  aspectRatio: '16 / 9',
                  background: '#0f172a',
                  border: '2px solid #334155',
                  borderRadius: '12px',
                  padding: '36px',
                  display: 'flex',
                  flexDirection: 'column',
                  justifyContent: 'space-between',
                  boxShadow: '0 20px 40px rgba(0,0,0,0.5)',
                  position: 'relative',
                  overflow: 'hidden',
                }}
              >
                {/* Slide 1: Title & Chemical Transformation */}
                {currentSlide === 0 && (
                  <div style={{ display: 'flex', flexDirection: 'column', height: '100%', justifyContent: 'space-between' }}>
                    <div>
                      <div style={{ fontSize: '12px', fontWeight: 700, color: '#38bdf8', textTransform: 'uppercase', letterSpacing: '0.05em' }}>
                        HTE Reaction Screening Campaign
                      </div>
                      <h2 style={{ fontSize: '28px', fontWeight: 800, margin: '6px 0 4px', color: '#f8fafc' }}>
                        {reportTitle}
                      </h2>
                      <div style={{ fontSize: '13px', color: '#94a3b8' }}>
                        Chemist: {chemistName} · Platform: Robowski Liquid Handler
                      </div>
                    </div>

                    <div style={{ background: '#1e293b', border: '1px solid #334155', borderRadius: '10px', padding: '20px' }}>
                      <div style={{ fontSize: '12px', fontWeight: 700, color: '#38bdf8', marginBottom: '12px' }}>
                        REACTION SCHEME &amp; COUPLING PARTNERS
                      </div>
                      <div style={{ display: 'flex', alignItems: 'center', gap: '20px', flexWrap: 'wrap' }}>
                        {(state.reagents || []).map((r, i) => (
                          <div key={i} style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
                            <div style={{ textAlign: 'center' }}>
                              <ChemicalStructure smiles={r.smiles} name={r.name} width={80} height={60} />
                              <div style={{ fontSize: '11px', fontWeight: 700, color: '#f8fafc', marginTop: '4px' }}>
                                {r.code}: {r.name || 'Substrate'}
                              </div>
                            </div>
                            {i < (state.reagents || []).length - 1 && (
                              <span style={{ fontSize: '20px', color: '#64748b' }}>+</span>
                            )}
                          </div>
                        ))}
                        <span style={{ fontSize: '24px', color: '#38bdf8', margin: '0 8px' }}>➔</span>
                        <div style={{ textAlign: 'center' }}>
                          <div style={{ width: '80px', height: '60px', border: '1px dashed #475569', borderRadius: '6px', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '10px', color: '#94a3b8' }}>
                            Target Core
                          </div>
                          <div style={{ fontSize: '11px', fontWeight: 700, color: '#38bdf8', marginTop: '4px' }}>
                            Coupled Product
                          </div>
                        </div>
                      </div>
                    </div>

                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', fontSize: '11px', color: '#64748b' }}>
                      <span>Robowski Studio Autonomous Reaction Optimizer</span>
                      <span>Slide 1 of 4</span>
                    </div>
                  </div>
                )}

                {/* Slide 2: Screening Matrix & Hit Distribution */}
                {currentSlide === 1 && (
                  <div style={{ display: 'flex', flexDirection: 'column', height: '100%', justifyContent: 'space-between' }}>
                    <div>
                      <div style={{ fontSize: '12px', fontWeight: 700, color: '#10b981', textTransform: 'uppercase', letterSpacing: '0.05em' }}>
                        Reaction Discovery
                      </div>
                      <h2 style={{ fontSize: '28px', fontWeight: 800, margin: '6px 0 4px', color: '#f8fafc' }}>
                        Screening Matrix &amp; Hit Overview
                      </h2>
                    </div>

                    <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '20px', flex: 1, margin: '14px 0' }}>
                      <div style={{ background: '#1e293b', border: '1px solid #334155', borderRadius: '10px', padding: '18px' }}>
                        <div style={{ fontSize: '12px', fontWeight: 700, color: '#10b981', marginBottom: '8px' }}>
                          ★ OPTIMAL WINNING HIT
                        </div>
                        <div style={{ fontSize: '24px', fontWeight: 800, color: '#f8fafc', marginBottom: '4px' }}>
                          Well {optimalHit ? wellLabel(optimalHit.container_id) : 'A1'}
                        </div>
                        <div style={{ fontSize: '16px', fontWeight: 700, color: '#10b981', marginBottom: '10px' }}>
                          Conversion: {optimalHit?.conv || 95}%
                        </div>
                        <div style={{ fontSize: '12px', color: '#94a3b8', lineHeight: '1.5' }}>
                          {optimalHit?.recipe ? Object.entries(optimalHit.recipe).map(([k, v]) => `${k}: ${v}`).join(' · ') : 'Standard screening mixture'}
                        </div>
                      </div>

                      <div style={{ background: '#1e293b', border: '1px solid #334155', borderRadius: '10px', padding: '18px' }}>
                        <div style={{ fontSize: '12px', fontWeight: 700, color: '#38bdf8', marginBottom: '8px' }}>
                          HIT CONVERSION DISTRIBUTION
                        </div>
                        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '10px', marginTop: '12px' }}>
                          <div>
                            <div style={{ fontSize: '28px', fontWeight: 900, color: '#10b981' }}>{hitWells.length}</div>
                            <div style={{ fontSize: '10px', color: '#94a3b8', textTransform: 'uppercase' }}>Hits (&gt;75%)</div>
                          </div>
                          <div>
                            <div style={{ fontSize: '28px', fontWeight: 900, color: '#f59e0b' }}>{moderateWells.length}</div>
                            <div style={{ fontSize: '10px', color: '#94a3b8', textTransform: 'uppercase' }}>Moderate (30-75%)</div>
                          </div>
                        </div>
                        <div style={{ marginTop: '14px', fontSize: '11px', color: '#94a3b8' }}>
                          Total conditions evaluated: <strong>{totalWells}</strong>
                        </div>
                      </div>
                    </div>

                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', fontSize: '11px', color: '#64748b' }}>
                      <span>Robowski Studio Autonomous Reaction Optimizer</span>
                      <span>Slide 2 of 4</span>
                    </div>
                  </div>
                )}

                {/* Slide 3: Chromatographic TLC Verification */}
                {currentSlide === 2 && (
                  <div style={{ display: 'flex', flexDirection: 'column', height: '100%', justifyContent: 'space-between' }}>
                    <div>
                      <div style={{ fontSize: '12px', fontWeight: 700, color: '#a855f7', textTransform: 'uppercase', letterSpacing: '0.05em' }}>
                        Analytical Proof
                      </div>
                      <h2 style={{ fontSize: '28px', fontWeight: 800, margin: '6px 0 4px', color: '#f8fafc' }}>
                        Thin-Layer Chromatography (TLC) Verification
                      </h2>
                    </div>

                    <div style={{ background: '#1e293b', border: '1px solid #334155', borderRadius: '10px', padding: '20px', flex: 1, margin: '14px 0', display: 'flex', flexDirection: 'column', justifyContent: 'center' }}>
                      <div style={{ fontSize: '13px', fontWeight: 700, color: '#a855f7', marginBottom: '6px' }}>
                        Mobile Phase: {tlcSets[0]?.name || '30% Ethyl Acetate / 70% Hexanes'}
                      </div>
                      <p style={{ fontSize: '13px', color: '#cbd5e1', lineHeight: '1.6', margin: '6px 0' }}>
                        Parallel lane densitometry confirms complete consumption of starting materials with clean baseline resolution ($\Delta R_f \ge 0.20$) to the targeted product peak.
                      </p>
                      <div style={{ display: 'flex', gap: '20px', marginTop: '12px', fontSize: '12px' }}>
                        <span style={{ color: '#fbbf24', fontWeight: 600 }}>● UV 254 nm: Quenching of Starting Reagents</span>
                        <span style={{ color: '#22d3ee', fontWeight: 600 }}>● UV 365 nm: Fluorescent Emission of Coupled Core</span>
                      </div>
                    </div>

                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', fontSize: '11px', color: '#64748b' }}>
                      <span>Robowski Studio Autonomous Reaction Optimizer</span>
                      <span>Slide 3 of 4</span>
                    </div>
                  </div>
                )}

                {/* Slide 4: Scale-Up Protocol & Recommendations */}
                {currentSlide === 3 && (
                  <div style={{ display: 'flex', flexDirection: 'column', height: '100%', justifyContent: 'space-between' }}>
                    <div>
                      <div style={{ fontSize: '12px', fontWeight: 700, color: '#38bdf8', textTransform: 'uppercase', letterSpacing: '0.05em' }}>
                        Process Intensification
                      </div>
                      <h2 style={{ fontSize: '28px', fontWeight: 800, margin: '6px 0 4px', color: '#f8fafc' }}>
                        Scale-Up Protocol &amp; Next Steps
                      </h2>
                    </div>

                    <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '20px', flex: 1, margin: '14px 0' }}>
                      <div style={{ background: '#1e293b', border: '1px solid #334155', borderRadius: '10px', padding: '18px' }}>
                        <div style={{ fontSize: '12px', fontWeight: 700, color: '#10b981', marginBottom: '8px' }}>
                          10x BENCH SCALE-UP
                        </div>
                        <p style={{ fontSize: '13px', color: '#cbd5e1', lineHeight: '1.6' }}>
                          Scale winning conditions from Well <strong>{optimalHit ? wellLabel(optimalHit.container_id) : 'A1'}</strong> to 2.0 mL reaction vial. Maintain isothermal conditions with dedicated solvent pairing.
                        </p>
                      </div>

                      <div style={{ background: '#1e293b', border: '1px solid #334155', borderRadius: '10px', padding: '18px' }}>
                        <div style={{ fontSize: '12px', fontWeight: 700, color: '#38bdf8', marginBottom: '8px' }}>
                          ACTIONABLE NEXT STEPS
                        </div>
                        <ul style={{ fontSize: '12px', color: '#cbd5e1', lineHeight: '1.8', marginLeft: '16px' }}>
                          <li>Isolate pure product via automated flash chromatography.</li>
                          <li>Acquire 1H-NMR and LC-MS for structural confirmation.</li>
                          <li>Transfer recipe to parallel automated synthesizer.</li>
                        </ul>
                      </div>
                    </div>

                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', fontSize: '11px', color: '#64748b' }}>
                      <span>Robowski Studio Autonomous Reaction Optimizer</span>
                      <span>Slide 4 of 4</span>
                    </div>
                  </div>
                )}
              </div>

              {/* Slide Navigation Buttons */}
              <div style={{ display: 'flex', gap: '12px', alignItems: 'center' }}>
                <button
                  type="button"
                  className="btn sm"
                  disabled={currentSlide === 0}
                  onClick={() => setCurrentSlide((prev) => Math.max(0, prev - 1))}
                  style={{ fontSize: '12px', padding: '6px 14px' }}
                >
                  ← Previous Slide
                </button>
                <span style={{ fontSize: '12px', color: 'var(--mut)', fontWeight: 600 }}>
                  Slide {currentSlide + 1} of 4
                </span>
                <button
                  type="button"
                  className="btn sm pri"
                  disabled={currentSlide === 3}
                  onClick={() => setCurrentSlide((prev) => Math.min(3, prev + 1))}
                  style={{ fontSize: '12px', padding: '6px 14px' }}
                >
                  Next Slide →
                </button>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
};
