import React, { useState, useEffect } from 'react';
import {
  fetchAiSolventSystems,
  SolventAdvisorPayload,
  SolventSuggestionResponse,
  SolventSystemRecommendation,
} from '../../services/aiService';

interface SubstrateItem {
  code?: string;
  name: string;
  smiles?: string;
  role?: string;
}

interface AiSolventAdvisorModalProps {
  isOpen: boolean;
  onClose: () => void;
  initialSubstrates?: SubstrateItem[];
  reactionClass?: string;
  onApplyToCurrentSet?: (systemName: string) => void;
  onCreateNewSet?: (systemName: string) => void;
  toast: (msg: string) => void;
}

const COMMON_REACTIONS = [
  'Amide Coupling',
  'Suzuki-Miyaura Cross-Coupling',
  'Buchwald-Hartwig Amination',
  'Esterification',
  'Nucleophilic Aromatic Substitution (SNAr)',
  'Reductive Amination',
  'Click Reaction (CuAAC / Triazole)',
  'Alkylation',
  'General Organic Transformation',
];

const STATIONARY_PHASES = [
  'Silica Gel (SiO2 - Normal Phase)',
  'Neutral Alumina (Al2O3)',
  'Basic Alumina (Al2O3)',
  'Reverse Phase (C18)',
];

export const AiSolventAdvisorModal: React.FC<AiSolventAdvisorModalProps> = ({
  isOpen,
  onClose,
  initialSubstrates = [],
  reactionClass = 'Amide Coupling',
  onApplyToCurrentSet,
  onCreateNewSet,
  toast,
}) => {
  const [substrates, setSubstrates] = useState<SubstrateItem[]>([]);
  const [newSubstrateName, setNewSubstrateName] = useState<string>('');
  const [expectedProduct, setExpectedProduct] = useState<string>('');
  const [selectedReaction, setSelectedReaction] = useState<string>(reactionClass);
  const [stationaryPhase, setStationaryPhase] = useState<string>('Silica Gel (SiO2 - Normal Phase)');
  const [loading, setLoading] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);
  const [response, setResponse] = useState<SolventSuggestionResponse | null>(null);
  const [copiedIndex, setCopiedIndex] = useState<number | null>(null);

  // Initialize substrates from props
  useEffect(() => {
    if (initialSubstrates.length > 0) {
      setSubstrates(initialSubstrates);
      // Generate intelligent default product name if not set
      if (!expectedProduct) {
        const names = initialSubstrates.map((s) => s.name).filter(Boolean);
        if (names.length >= 2) {
          setExpectedProduct(`Coupling product of ${names[0]} and ${names[1]}`);
        } else if (names.length === 1) {
          setExpectedProduct(`Reaction product of ${names[0]}`);
        } else {
          setExpectedProduct('Target reaction product');
        }
      }
    } else {
      setSubstrates([
        { code: 'AA', name: 'p-toluic acid', smiles: 'Cc1ccc(cc1)C(=O)O' },
        { code: 'BB', name: 'benzylamine', smiles: 'NCc1ccccc1' },
      ]);
      if (!expectedProduct) {
        setExpectedProduct('N-benzyl-4-methylbenzamide (amide product)');
      }
    }
  }, [initialSubstrates]);

  if (!isOpen) return null;

  const handleAddSubstrate = () => {
    if (!newSubstrateName.trim()) return;
    setSubstrates((prev) => [
      ...prev,
      { code: `S${prev.length + 1}`, name: newSubstrateName.trim() },
    ]);
    setNewSubstrateName('');
  };

  const handleRemoveSubstrate = (index: number) => {
    setSubstrates((prev) => prev.filter((_, i) => i !== index));
  };

  const handleGenerate = async () => {
    if (substrates.length === 0) {
      setError('Please provide at least one starting material / substrate.');
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const payload: SolventAdvisorPayload = {
        substrates,
        expectedProduct: expectedProduct.trim() || 'Target reaction product',
        reactionClass: selectedReaction,
        stationaryPhase,
      };

      const result = await fetchAiSolventSystems(payload);
      setResponse(result);
    } catch (err: any) {
      console.error('Error fetching solvent recommendations:', err);
      setError(err?.message || 'Could not generate solvent recommendations.');
    } finally {
      setLoading(false);
    }
  };

  const handleCopyRecipe = (system: SolventSystemRecommendation, index: number) => {
    const text = `TLC Mobile Phase: ${system.name}\nRatio: ${system.ratio}\nChamber Prep: ${system.chamberPrep}\nModifiers: ${system.modifiers || 'None'}\nRationale: ${system.rationale}`;
    navigator.clipboard?.writeText(text);
    setCopiedIndex(index);
    toast(`Copied "${system.name}" recipe to clipboard.`);
    setTimeout(() => setCopiedIndex(null), 2000);
  };

  return (
    <div
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 9999,
        background: 'rgba(0, 0, 0, 0.75)',
        backdropFilter: 'blur(3px)',
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
          maxWidth: '920px',
          maxHeight: '90vh',
          display: 'flex',
          flexDirection: 'column',
          boxShadow: '0 20px 50px rgba(0,0,0,0.5)',
          overflow: 'hidden',
          color: 'var(--fg)',
        }}
        onClick={(e) => e.stopPropagation()}
      >
        {/* Modal Header */}
        <div
          style={{
            padding: '16px 20px',
            borderBottom: '1px solid var(--line)',
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
            background: 'var(--soft)',
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
            <div
              style={{
                width: '32px',
                height: '32px',
                borderRadius: '8px',
                background: 'linear-gradient(135deg, #10b981 0%, #059669 100%)',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                color: '#fff',
                fontWeight: 'bold',
                fontSize: '16px',
              }}
            >
              ✦
            </div>
            <div>
              <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                <h3 style={{ margin: 0, fontSize: '15px', fontWeight: 600 }}>
                  AI TLC Solvent System & Mobile Phase Advisor
                </h3>
                <span
                  style={{
                    fontSize: '9px',
                    fontWeight: 600,
                    textTransform: 'uppercase',
                    background: 'var(--panel)',
                    color: '#10b981',
                    padding: '1px 7px',
                    borderRadius: '10px',
                    border: '1px solid var(--line)',
                  }}
                >
                  Gemini
                </span>
              </div>
              <p style={{ margin: '2px 0 0', fontSize: '12px', color: 'var(--mut)' }}>
                Predicts 2–3 optimal solvent systems (with the #1 best system) to cleanly monitor and separate your reaction product.
              </p>
            </div>
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

        {/* Modal Body */}
        <div
          style={{
            padding: '20px',
            overflowY: 'auto',
            display: 'flex',
            flexDirection: 'column',
            gap: '16px',
          }}
        >
          {/* Reaction & Substrate Inputs */}
          <div
            style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))',
              gap: '14px',
              padding: '14px',
              background: 'var(--soft)',
              borderRadius: '8px',
              border: '1px solid var(--line)',
            }}
          >
            {/* Substrates Box */}
            <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
              <label style={{ fontSize: '12px', fontWeight: 600 }}>
                Substrates / Starting Materials ({substrates.length}):
              </label>
              <div
                style={{
                  display: 'flex',
                  flexWrap: 'wrap',
                  gap: '6px',
                  minHeight: '36px',
                  padding: '6px',
                  background: 'var(--panel)',
                  borderRadius: '6px',
                  border: '1px solid var(--line)',
                }}
              >
                {substrates.map((sub, i) => (
                  <span
                    key={i}
                    style={{
                      display: 'inline-flex',
                      alignItems: 'center',
                      gap: '4px',
                      background: 'rgba(16, 185, 129, 0.12)',
                      border: '1px solid rgba(16, 185, 129, 0.3)',
                      borderRadius: '4px',
                      padding: '2px 6px',
                      fontSize: '11px',
                    }}
                  >
                    {sub.code && <strong>{sub.code}:</strong>}
                    <span>{sub.name}</span>
                    <button
                      type="button"
                      onClick={() => handleRemoveSubstrate(i)}
                      style={{
                        background: 'transparent',
                        border: 'none',
                        color: 'var(--mut)',
                        cursor: 'pointer',
                        padding: '0 2px',
                        fontSize: '10px',
                      }}
                      title="Remove substrate"
                    >
                      ✕
                    </button>
                  </span>
                ))}
              </div>
              <div style={{ display: 'flex', gap: '6px' }}>
                <input
                  type="text"
                  placeholder="Add another starting material or reagent…"
                  value={newSubstrateName}
                  onChange={(e) => setNewSubstrateName(e.target.value)}
                  onKeyDown={(e) => e.key === 'Enter' && handleAddSubstrate()}
                  style={{
                    flex: 1,
                    padding: '6px 10px',
                    fontSize: '12px',
                    borderRadius: '4px',
                    border: '1px solid var(--line)',
                    background: 'var(--panel)',
                    color: 'var(--fg)',
                  }}
                />
                <button
                  type="button"
                  className="btn sm"
                  onClick={handleAddSubstrate}
                  style={{ fontSize: '11px', height: '30px' }}
                >
                  + Add
                </button>
              </div>
            </div>

            {/* Target Product & Reaction Details */}
            <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
              <div>
                <label style={{ fontSize: '12px', fontWeight: 600, display: 'block', marginBottom: '4px' }}>
                  Expected / Possible Product:
                </label>
                <input
                  type="text"
                  placeholder="e.g. Amide product, Biaryl ester, Secondary amine…"
                  value={expectedProduct}
                  onChange={(e) => setExpectedProduct(e.target.value)}
                  style={{
                    width: '100%',
                    padding: '6px 10px',
                    fontSize: '12px',
                    borderRadius: '4px',
                    border: '1px solid var(--line)',
                    background: 'var(--panel)',
                    color: 'var(--fg)',
                  }}
                />
              </div>

              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '8px' }}>
                <div>
                  <label style={{ fontSize: '11px', fontWeight: 600, display: 'block', marginBottom: '3px' }}>
                    Reaction Type:
                  </label>
                  <select
                    value={selectedReaction}
                    onChange={(e) => setSelectedReaction(e.target.value)}
                    style={{
                      width: '100%',
                      padding: '5px 8px',
                      fontSize: '11px',
                      borderRadius: '4px',
                      border: '1px solid var(--line)',
                      background: 'var(--panel)',
                      color: 'var(--fg)',
                    }}
                  >
                    {COMMON_REACTIONS.map((r) => (
                      <option key={r} value={r}>
                        {r}
                      </option>
                    ))}
                  </select>
                </div>

                <div>
                  <label style={{ fontSize: '11px', fontWeight: 600, display: 'block', marginBottom: '3px' }}>
                    Stationary Phase:
                  </label>
                  <select
                    value={stationaryPhase}
                    onChange={(e) => setStationaryPhase(e.target.value)}
                    style={{
                      width: '100%',
                      padding: '5px 8px',
                      fontSize: '11px',
                      borderRadius: '4px',
                      border: '1px solid var(--line)',
                      background: 'var(--panel)',
                      color: 'var(--fg)',
                    }}
                  >
                    {STATIONARY_PHASES.map((p) => (
                      <option key={p} value={p}>
                        {p}
                      </option>
                    ))}
                  </select>
                </div>
              </div>
            </div>
          </div>

          {/* Action Trigger */}
          <div style={{ display: 'flex', justifyContent: 'flex-end', alignItems: 'center', gap: '10px' }}>
            <button
              type="button"
              className="btn pri"
              disabled={loading || substrates.length === 0}
              onClick={handleGenerate}
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: '8px',
                padding: '8px 18px',
                fontSize: '12px',
                fontWeight: 600,
                background: '#10b981',
                borderColor: '#059669',
              }}
            >
              {loading ? (
                <>
                  <span
                    style={{
                      display: 'inline-block',
                      width: '12px',
                      height: '12px',
                      borderRadius: '50%',
                      border: '2px solid rgba(255,255,255,0.3)',
                      borderTopColor: '#fff',
                      animation: 'spin 0.8s linear infinite',
                    }}
                  />
                  Calculating Solvent Polarities…
                </>
              ) : (
                <>
                  <span>✦</span>
                  Suggest Best TLC Solvent Systems
                </>
              )}
            </button>
          </div>

          {/* Error Message */}
          {error && (
            <div
              style={{
                padding: '12px 14px',
                background: 'var(--warnbg, rgba(239, 68, 68, 0.08))',
                border: '1px solid var(--warn, #ef4444)',
                borderRadius: '8px',
                fontSize: '12px',
                color: 'var(--fg)',
              }}
            >
              ⚠ {error}
            </div>
          )}

          {/* Results Display */}
          {response && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '16px', marginTop: '6px' }}>
              {/* Chemical Polarity Summary Banner */}
              <div
                style={{
                  padding: '12px 16px',
                  background: 'rgba(16, 185, 129, 0.08)',
                  border: '1px solid rgba(16, 185, 129, 0.25)',
                  borderRadius: '8px',
                  fontSize: '12px',
                  lineHeight: '1.5',
                }}
              >
                <div style={{ fontWeight: 600, color: '#10b981', marginBottom: '2px' }}>
                  🔬 Chemical Separation Strategy & Polarity Shift:
                </div>
                <div>{response.reactionSummary}</div>
              </div>

              {/* Solvent System Cards */}
              <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
                <div style={{ fontSize: '13px', fontWeight: 600, display: 'flex', alignItems: 'center', gap: '6px' }}>
                  <span>Recommended Mobile Phases:</span>
                  <span style={{ fontSize: '11px', color: 'var(--mut)', fontWeight: 400 }}>
                    (Evaluated for optimal Rf 0.30–0.45 product window)
                  </span>
                </div>

                <div
                  style={{
                    display: 'grid',
                    gridTemplateColumns: 'repeat(auto-fit, minmax(270px, 1fr))',
                    gap: '12px',
                  }}
                >
                  {response.systems.map((sys, idx) => (
                    <div
                      key={idx}
                      style={{
                        background: 'var(--panel)',
                        border: sys.isBest
                          ? '2px solid #10b981'
                          : '1px solid var(--line)',
                        borderRadius: '10px',
                        padding: '14px',
                        display: 'flex',
                        flexDirection: 'column',
                        justifyContent: 'space-between',
                        gap: '12px',
                        boxShadow: sys.isBest
                          ? '0 4px 16px rgba(16, 185, 129, 0.15)'
                          : 'none',
                        position: 'relative',
                      }}
                    >
                      {/* Card Header & Best Badge */}
                      <div>
                        <div
                          style={{
                            display: 'flex',
                            justifyContent: 'space-between',
                            alignItems: 'flex-start',
                            gap: '6px',
                            marginBottom: '6px',
                          }}
                        >
                          <span
                            style={{
                              fontSize: '10px',
                              fontWeight: 700,
                              textTransform: 'uppercase',
                              letterSpacing: '0.04em',
                              padding: '2px 8px',
                              borderRadius: '12px',
                              background: sys.isBest
                                ? '#10b981'
                                : 'var(--soft)',
                              color: sys.isBest ? '#fff' : 'var(--fg)',
                              border: sys.isBest ? 'none' : '1px solid var(--line)',
                            }}
                          >
                            {sys.isBest ? '★ Best Recommended' : sys.tag || `Option ${idx + 1}`}
                          </span>

                          <span
                            style={{
                              fontSize: '10px',
                              color: 'var(--mut)',
                              fontFamily: 'monospace',
                            }}
                          >
                            {sys.polarityRating}
                          </span>
                        </div>

                        {/* Solvent System Name & Ratio */}
                        <div
                          style={{
                            fontSize: '14px',
                            fontWeight: 700,
                            fontFamily: 'var(--font-mono, monospace)',
                            color: sys.isBest ? '#10b981' : 'var(--fg)',
                            marginBottom: '4px',
                          }}
                        >
                          {sys.name}
                        </div>
                        <div
                          style={{
                            fontSize: '11px',
                            color: 'var(--mut)',
                            fontFamily: 'var(--font-mono, monospace)',
                            marginBottom: '8px',
                          }}
                        >
                          {sys.ratio}
                        </div>

                        {/* Simulated Mini TLC Lane Bar */}
                        <div
                          style={{
                            margin: '8px 0',
                            padding: '8px',
                            background: 'var(--soft)',
                            borderRadius: '6px',
                            border: '1px solid var(--line)',
                          }}
                        >
                          <div
                            style={{
                              display: 'flex',
                              justifyContent: 'space-between',
                              fontSize: '10px',
                              color: 'var(--mut)',
                              marginBottom: '4px',
                            }}
                          >
                            <span>Origin (0.0)</span>
                            <span style={{ fontWeight: 600, color: 'var(--fg)' }}>
                              {sys.resolutionDelta}
                            </span>
                            <span>Front (1.0)</span>
                          </div>

                          {/* Horizontal simulated chromatogram bar */}
                          <div
                            style={{
                              position: 'relative',
                              height: '18px',
                              background: 'rgba(255,255,255,0.06)',
                              borderRadius: '9px',
                              border: '1px solid var(--line)',
                              overflow: 'hidden',
                            }}
                          >
                            {/* Target Product Spot */}
                            {sys.predictedRf.product !== undefined && (
                              <div
                                style={{
                                  position: 'absolute',
                                  left: `${Math.min(96, Math.max(4, sys.predictedRf.product * 100))}%`,
                                  top: '50%',
                                  transform: 'translate(-50%, -50%)',
                                  width: '12px',
                                  height: '12px',
                                  borderRadius: '50%',
                                  background: '#10b981',
                                  boxShadow: '0 0 6px #10b981',
                                  zIndex: 3,
                                }}
                                title={`Target Product (Rf ~${sys.predictedRf.product.toFixed(2)})`}
                              />
                            )}

                            {/* Substrate A Spot */}
                            {sys.predictedRf.substrateA?.rf !== undefined && (
                              <div
                                style={{
                                  position: 'absolute',
                                  left: `${Math.min(96, Math.max(4, sys.predictedRf.substrateA.rf * 100))}%`,
                                  top: '50%',
                                  transform: 'translate(-50%, -50%)',
                                  width: '10px',
                                  height: '10px',
                                  borderRadius: '50%',
                                  background: '#38bdf8',
                                  zIndex: 2,
                                }}
                                title={`${sys.predictedRf.substrateA.name || 'Substrate A'} (Rf ~${sys.predictedRf.substrateA.rf.toFixed(2)})`}
                              />
                            )}

                            {/* Substrate B Spot */}
                            {sys.predictedRf.substrateB?.rf !== undefined && (
                              <div
                                style={{
                                  position: 'absolute',
                                  left: `${Math.min(96, Math.max(4, sys.predictedRf.substrateB.rf * 100))}%`,
                                  top: '50%',
                                  transform: 'translate(-50%, -50%)',
                                  width: '10px',
                                  height: '10px',
                                  borderRadius: '50%',
                                  background: '#f59e0b',
                                  zIndex: 2,
                                }}
                                title={`${sys.predictedRf.substrateB.name || 'Substrate B'} (Rf ~${sys.predictedRf.substrateB.rf.toFixed(2)})`}
                              />
                            )}
                          </div>

                          {/* Legend under bar */}
                          <div
                            style={{
                              display: 'flex',
                              justifyContent: 'space-between',
                              fontSize: '10px',
                              marginTop: '4px',
                            }}
                          >
                            <span style={{ color: '#10b981', fontWeight: 600 }}>
                              ● Product (Rf {sys.predictedRf.product?.toFixed(2)})
                            </span>
                            {sys.predictedRf.substrateA && (
                              <span style={{ color: '#38bdf8' }}>
                                ● {sys.predictedRf.substrateA.name?.slice(0, 10)} (Rf {sys.predictedRf.substrateA.rf.toFixed(2)})
                              </span>
                            )}
                            {sys.predictedRf.substrateB && (
                              <span style={{ color: '#f59e0b' }}>
                                ● {sys.predictedRf.substrateB.name?.slice(0, 10)} (Rf {sys.predictedRf.substrateB.rf.toFixed(2)})
                              </span>
                            )}
                          </div>
                        </div>

                        {/* Chamber preparation recipe */}
                        <div
                          style={{
                            fontSize: '11px',
                            padding: '6px 8px',
                            background: 'rgba(0,0,0,0.2)',
                            borderRadius: '4px',
                            fontFamily: 'monospace',
                            color: 'var(--fg)',
                            marginBottom: '8px',
                          }}
                        >
                          🧪 {sys.chamberPrep}
                        </div>

                        {/* Modifiers / Additives */}
                        {sys.modifiers && sys.modifiers !== 'None required' && (
                          <div
                            style={{
                              fontSize: '11px',
                              color: '#fbbf24',
                              marginBottom: '6px',
                            }}
                          >
                            ⚡ Modifier: {sys.modifiers}
                          </div>
                        )}

                        {/* Chemical Rationale */}
                        <p
                          style={{
                            fontSize: '11px',
                            color: 'var(--mut)',
                            lineHeight: '1.45',
                            margin: 0,
                          }}
                        >
                          {sys.rationale}
                        </p>
                      </div>

                      {/* Action Buttons */}
                      <div
                        style={{
                          display: 'flex',
                          flexWrap: 'wrap',
                          gap: '6px',
                          borderTop: '1px solid var(--line)',
                          paddingTop: '10px',
                        }}
                      >
                        {onApplyToCurrentSet && (
                          <button
                            type="button"
                            className="btn sm pri"
                            style={{
                              flex: 1,
                              fontSize: '11px',
                              height: '28px',
                              background: sys.isBest ? '#10b981' : undefined,
                            }}
                            onClick={() => {
                              onApplyToCurrentSet(sys.name);
                              toast(`Applied "${sys.name}" to current TLC Plate set.`);
                            }}
                          >
                            Apply to Plate
                          </button>
                        )}

                        {onCreateNewSet && (
                          <button
                            type="button"
                            className="btn sm"
                            style={{ fontSize: '11px', height: '28px' }}
                            onClick={() => {
                              onCreateNewSet(sys.name);
                              toast(`Created new TLC plate set for "${sys.name}".`);
                            }}
                          >
                            + New TLC Tab
                          </button>
                        )}

                        <button
                          type="button"
                          className="btn sm"
                          style={{ fontSize: '11px', height: '28px' }}
                          onClick={() => handleCopyRecipe(sys, idx)}
                          title="Copy recipe to clipboard"
                        >
                          {copiedIndex === idx ? '✓ Copied' : '📋 Copy'}
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
              </div>

              {/* Visualization & Staining Guide */}
              <div
                style={{
                  display: 'grid',
                  gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))',
                  gap: '12px',
                  background: 'var(--soft)',
                  padding: '14px',
                  borderRadius: '8px',
                  border: '1px solid var(--line)',
                }}
              >
                <div>
                  <div style={{ fontSize: '12px', fontWeight: 600, marginBottom: '6px' }}>
                    🔍 Recommended Visualization & Stains:
                  </div>
                  <div style={{ fontSize: '12px', display: 'flex', flexDirection: 'column', gap: '4px' }}>
                    <div>
                      <strong>Primary:</strong> {response.visualization.primaryStain}
                    </div>
                    <div>
                      <strong>Secondary Stain:</strong> {response.visualization.secondaryStain}
                    </div>
                    <div style={{ fontSize: '11px', color: 'var(--mut)', marginTop: '2px' }}>
                      {response.visualization.stainNotes}
                    </div>
                  </div>
                </div>

                <div>
                  <div style={{ fontSize: '12px', fontWeight: 600, marginBottom: '6px' }}>
                    📏 Recommended 4-Lane Co-Spotting Protocol:
                  </div>
                  <div style={{ fontSize: '11px', color: 'var(--mut)', display: 'flex', flexDirection: 'column', gap: '3px' }}>
                    {response.coSpottingProtocol.map((step, i) => (
                      <div key={i} style={{ display: 'flex', gap: '6px' }}>
                        <span style={{ color: '#10b981', fontWeight: 'bold' }}>•</span>
                        <span>{step}</span>
                      </div>
                    ))}
                  </div>
                </div>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
};
