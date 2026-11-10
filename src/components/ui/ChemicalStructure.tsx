import React, { useEffect, useRef, useState } from 'react';
import SmilesDrawer from 'smiles-drawer';

interface ChemicalStructureProps {
  smiles?: string | null;
  iupac?: string | null;
  name?: string | null;
  width?: number;
  height?: number;
  className?: string;
  allowZoom?: boolean;
  onResolvedSmiles?: (smiles: string, mw?: number) => void;
}

// In-memory cache for resolved chemical names to avoid redundant network calls
const RESOLVED_NAME_CACHE = new Map<string, { smiles: string; mw?: number; iupac?: string }>();

export async function resolveChemicalNameToSmiles(
  query: string
): Promise<{ smiles: string; mw?: number; iupac?: string } | null> {
  const clean = query.trim();
  if (!clean || clean.length < 2) return null;
  const key = clean.toLowerCase();
  if (RESOLVED_NAME_CACHE.has(key)) {
    return RESOLVED_NAME_CACHE.get(key)!;
  }

  // 1. Try PubChem PUG REST API
  try {
    const url = `https://pubchem.ncbi.nlm.nih.gov/rest/pug/compound/name/${encodeURIComponent(clean)}/property/CanonicalSMILES,MolecularWeight,IUPACName/JSON`;
    const res = await fetch(url);
    if (res.ok) {
      const data = await res.json();
      const props = data?.PropertyTable?.Properties?.[0];
      if (props?.CanonicalSMILES) {
        const result = {
          smiles: props.CanonicalSMILES,
          mw: props.MolecularWeight ? Number(props.MolecularWeight) : undefined,
          iupac: props.IUPACName,
        };
        RESOLVED_NAME_CACHE.set(key, result);
        return result;
      }
    }
  } catch {}

  // 2. Fallback to NCI Cactus Resolver
  try {
    const cactusUrl = `https://cactus.nci.nih.gov/chemical/structure/${encodeURIComponent(clean)}/smiles`;
    const res = await fetch(cactusUrl);
    if (res.ok) {
      const text = await res.text();
      const smiles = text.trim();
      if (smiles && !smiles.includes('<!DOCTYPE') && !smiles.includes('Page not found')) {
        const result = { smiles };
        RESOLVED_NAME_CACHE.set(key, result);
        return result;
      }
    }
  } catch {}

  return null;
}

export const ChemicalStructure: React.FC<ChemicalStructureProps> = ({
  smiles,
  iupac,
  name,
  width = 54,
  height = 38,
  className = '',
  allowZoom = true,
  onResolvedSmiles,
}) => {
  const svgRef = useRef<SVGSVGElement | null>(null);
  const [zoomOpen, setZoomOpen] = useState(false);
  const [activeSmiles, setActiveSmiles] = useState<string>(smiles || '');
  const [modalInputSmiles, setModalInputSmiles] = useState<string>('');
  const [resolving, setResolving] = useState(false);
  const [renderError, setRenderError] = useState(false);
  const [copied, setCopied] = useState(false);

  // Sync external smiles prop
  useEffect(() => {
    setActiveSmiles(smiles || '');
  }, [smiles]);

  // Attempt auto-resolution if no SMILES is provided but an IUPAC or chemical name exists
  useEffect(() => {
    if (activeSmiles) return;
    const candidate = (iupac || name || '').trim();
    if (!candidate || candidate.length < 2) return;

    // Check if the candidate itself is a SMILES string
    if (
      /^[CNOPSFIBrclH0-9=\-#+()\[\]\\/@:]+$/.test(candidate) &&
      candidate.length > 2 &&
      /[A-Z]/.test(candidate)
    ) {
      setActiveSmiles(candidate);
      if (onResolvedSmiles) onResolvedSmiles(candidate);
      return;
    }

    // Check in cache first
    const cached = RESOLVED_NAME_CACHE.get(candidate.toLowerCase());
    if (cached) {
      setActiveSmiles(cached.smiles);
      if (onResolvedSmiles) onResolvedSmiles(cached.smiles, cached.mw);
      return;
    }
  }, [activeSmiles, iupac, name, onResolvedSmiles]);

  // Render SMILES to SVG using SmilesDrawer.SvgDrawer
  useEffect(() => {
    if (!svgRef.current) return;
    if (!activeSmiles) {
      setRenderError(false);
      return;
    }

    try {
      const isDark =
        document.documentElement.getAttribute('data-theme') === 'dark' ||
        (window.matchMedia &&
          window.matchMedia('(prefers-color-scheme: dark)').matches &&
          document.documentElement.getAttribute('data-theme') !== 'light');

      while (svgRef.current.firstChild) {
        svgRef.current.removeChild(svgRef.current.firstChild);
      }

      const options = {
        width,
        height,
        bondThickness: 1.1,
        bondLength: 13,
        shortBondLength: 0.85,
        bondSpacing: 0.18 * 13,
        atomVisualization: 'default',
        isomeric: true,
        compactDrawing: true,
        themes: {
          light: {
            C: '#14211e',
            O: '#dc2626',
            N: '#2563eb',
            F: '#059669',
            CL: '#16a34a',
            BR: '#b45309',
            I: '#c2410c',
            P: '#ea580c',
            S: '#d97706',
            B: '#ca8a04',
            SI: '#ca8a04',
            H: '#4b5563',
            BACKGROUND: 'transparent',
          },
          dark: {
            C: '#e8f0ec',
            O: '#f87171',
            N: '#60a5fa',
            F: '#34d399',
            CL: '#4ade80',
            BR: '#fb923c',
            I: '#f97316',
            P: '#fb923c',
            S: '#fbbf24',
            B: '#fde047',
            SI: '#fde047',
            H: '#9ca3af',
            BACKGROUND: 'transparent',
          },
        },
      };

      const drawer = new SmilesDrawer.SvgDrawer(options);
      SmilesDrawer.parse(
        activeSmiles,
        (tree: any) => {
          if (!svgRef.current) return;
          drawer.draw(tree, svgRef.current, isDark ? 'dark' : 'light');
          setRenderError(false);
        },
        () => {
          setRenderError(true);
        }
      );
    } catch {
      setRenderError(true);
    }
  }, [activeSmiles, width, height]);

  const handleManualResolve = async (e: React.MouseEvent) => {
    e.stopPropagation();
    const candidate = (iupac || name || '').trim();
    if (!candidate) {
      if (allowZoom) {
        setModalInputSmiles(activeSmiles);
        setZoomOpen(true);
      }
      return;
    }
    setResolving(true);
    try {
      const res = await resolveChemicalNameToSmiles(candidate);
      if (res?.smiles) {
        setActiveSmiles(res.smiles);
        if (onResolvedSmiles) onResolvedSmiles(res.smiles, res.mw);
      } else if (allowZoom) {
        setModalInputSmiles(activeSmiles);
        setZoomOpen(true);
      }
    } finally {
      setResolving(false);
    }
  };

  const openInspector = (e: React.MouseEvent) => {
    e.stopPropagation();
    if (allowZoom) {
      setModalInputSmiles(activeSmiles);
      setZoomOpen(true);
    }
  };

  // If no SMILES is set
  if (!activeSmiles) {
    const candidateName = (iupac || name || '').trim();
    return (
      <>
        <div
          className={`chem-struct-empty ${className}`}
          style={{
            width,
            height,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            background: 'var(--soft)',
            borderRadius: '6px',
            border: '1px solid var(--line)',
            position: 'relative',
            cursor: 'pointer',
            transition: 'background 0.15s ease, border-color 0.15s ease',
          }}
          onClick={handleManualResolve}
          title={
            candidateName
              ? `Click to resolve structure for ${candidateName} (or enter SMILES)`
              : 'Click to enter SMILES structure'
          }
        >
          {resolving ? (
            <svg
              width="14"
              height="14"
              viewBox="0 0 24 24"
              fill="none"
              stroke="var(--acc)"
              strokeWidth="2.5"
              strokeLinecap="round"
              className="animate-spin"
              style={{ animation: 'spin 0.8s linear infinite' }}
            >
              <path d="M12 2v4M12 18v4M4.93 4.93l2.83 2.83M16.24 16.24l2.83 2.83M2 12h4M18 12h4M4.93 19.07l2.83-2.83M16.24 7.76l2.83-2.83" />
            </svg>
          ) : (
            <svg
              width="18"
              height="18"
              viewBox="0 0 24 24"
              fill="none"
              stroke="var(--mut)"
              strokeWidth="1.5"
              strokeLinecap="round"
              strokeLinejoin="round"
              style={{ opacity: 0.65 }}
            >
              {/* Benzene ring outline icon */}
              <polygon points="12 2 21 7.5 21 16.5 12 22 3 16.5 3 7.5" />
              <circle cx="12" cy="12" r="4.5" />
            </svg>
          )}
        </div>

        {/* Modal when user clicks empty structure */}
        {zoomOpen && (
          <StructureModal
            name={name}
            iupac={iupac}
            activeSmiles={activeSmiles}
            modalInputSmiles={modalInputSmiles}
            setModalInputSmiles={setModalInputSmiles}
            onClose={() => setZoomOpen(false)}
            onSave={(newSmi) => {
              setActiveSmiles(newSmi);
              if (onResolvedSmiles) onResolvedSmiles(newSmi);
              setZoomOpen(false);
            }}
            onResolveCandidate={async () => {
              const q = (modalInputSmiles || iupac || name || '').trim();
              if (!q) return;
              setResolving(true);
              try {
                const res = await resolveChemicalNameToSmiles(q);
                if (res?.smiles) {
                  setModalInputSmiles(res.smiles);
                  setActiveSmiles(res.smiles);
                  if (onResolvedSmiles) onResolvedSmiles(res.smiles, res.mw);
                }
              } finally {
                setResolving(false);
              }
            }}
            resolving={resolving}
          />
        )}
      </>
    );
  }

  return (
    <>
      <div
        className={`chem-struct-wrapper ${className}`}
        style={{
          width,
          height,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          background: 'var(--panel)',
          borderRadius: '6px',
          border: '1px solid var(--line)',
          padding: '2px',
          cursor: allowZoom ? 'pointer' : 'default',
          position: 'relative',
          overflow: 'hidden',
          transition: 'border-color 0.15s ease, box-shadow 0.15s ease',
        }}
        onClick={openInspector}
        title={`2D structure: ${activeSmiles} (click to inspect)`}
      >
        {renderError ? (
          <div style={{ fontSize: '9px', color: 'var(--mut)', textAlign: 'center', padding: '2px' }}>
            <svg
              width="14"
              height="14"
              viewBox="0 0 24 24"
              fill="none"
              stroke="var(--bad)"
              strokeWidth="2"
            >
              <circle cx="12" cy="12" r="10" />
              <line x1="12" y1="8" x2="12" y2="12" />
              <line x1="12" y1="16" x2="12.01" y2="16" />
            </svg>
          </div>
        ) : (
          <svg
            ref={svgRef}
            width={width - 4}
            height={height - 4}
            viewBox={`0 0 ${width - 4} ${height - 4}`}
            style={{ display: 'block', maxWidth: '100%', maxHeight: '100%' }}
          />
        )}
      </div>

      {/* Enlarged Structure Modal */}
      {zoomOpen && (
        <StructureModal
          name={name}
          iupac={iupac}
          activeSmiles={activeSmiles}
          modalInputSmiles={modalInputSmiles}
          setModalInputSmiles={setModalInputSmiles}
          onClose={() => setZoomOpen(false)}
          onSave={(newSmi) => {
            setActiveSmiles(newSmi);
            if (onResolvedSmiles) onResolvedSmiles(newSmi);
            setZoomOpen(false);
          }}
          onResolveCandidate={async () => {
            const q = (modalInputSmiles || iupac || name || '').trim();
            if (!q) return;
            setResolving(true);
            try {
              const res = await resolveChemicalNameToSmiles(q);
              if (res?.smiles) {
                setModalInputSmiles(res.smiles);
                setActiveSmiles(res.smiles);
                if (onResolvedSmiles) onResolvedSmiles(res.smiles, res.mw);
              }
            } finally {
              setResolving(false);
            }
          }}
          resolving={resolving}
        />
      )}
    </>
  );
};

// Modal Inspector Component
interface StructureModalProps {
  name?: string | null;
  iupac?: string | null;
  activeSmiles: string;
  modalInputSmiles: string;
  setModalInputSmiles: (s: string) => void;
  onClose: () => void;
  onSave: (s: string) => void;
  onResolveCandidate: () => Promise<void>;
  resolving: boolean;
}

const StructureModal: React.FC<StructureModalProps> = ({
  name,
  iupac,
  activeSmiles,
  modalInputSmiles,
  setModalInputSmiles,
  onClose,
  onSave,
  onResolveCandidate,
  resolving,
}) => {
  const [copied, setCopied] = useState(false);
  const displaySmiles = modalInputSmiles || activeSmiles;

  return (
    <div
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 9999,
        background: 'rgba(14, 21, 19, 0.65)',
        backdropFilter: 'blur(4px)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: '20px',
      }}
      onClick={onClose}
    >
      <div
        style={{
          background: 'var(--panel)',
          borderRadius: '14px',
          border: '1px solid var(--line)',
          boxShadow: 'var(--shadow-lg)',
          maxWidth: '460px',
          width: '100%',
          padding: '24px',
          position: 'relative',
        }}
        onClick={(e) => e.stopPropagation()}
      >
        {/* Modal Header */}
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: '16px' }}>
          <div>
            <h3 style={{ margin: 0, fontSize: '17px', fontWeight: 600, color: 'var(--fg)', letterSpacing: '-0.01em' }}>
              {name || 'Chemical Structure'}
            </h3>
            {iupac && (
              <div style={{ fontSize: '12px', color: 'var(--mut)', marginTop: '2px', lineHeight: 1.4 }}>
                {iupac}
              </div>
            )}
          </div>
          <button
            type="button"
            className="ib"
            onClick={onClose}
            aria-label="Close"
            style={{ width: '28px', height: '28px', borderRadius: '7px' }}
          >
            ✕
          </button>
        </div>

        {/* 2D Canvas Area */}
        <div
          style={{
            width: '100%',
            height: '240px',
            background: 'var(--bg)',
            borderRadius: '10px',
            border: '1px solid var(--line)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            marginBottom: '16px',
            padding: '12px',
          }}
        >
          {displaySmiles ? (
            <ModalEnlargedStructure smiles={displaySmiles} width={390} height={216} />
          ) : (
            <div style={{ textAlign: 'center', color: 'var(--mut)', fontSize: '13px' }}>
              No SMILES structure specified.
            </div>
          )}
        </div>

        {/* SMILES Input & Controls */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <label className="lbl" style={{ margin: 0, fontSize: '11px' }}>
              Canonical SMILES
            </label>
            <div style={{ display: 'flex', gap: '6px' }}>
              {displaySmiles && (
                <button
                  type="button"
                  className="btn sm"
                  style={{ fontSize: '11px', height: '26px', padding: '0 8px' }}
                  onClick={() => {
                    navigator.clipboard.writeText(displaySmiles);
                    setCopied(true);
                    setTimeout(() => setCopied(false), 2000);
                  }}
                >
                  {copied ? 'Copied' : 'Copy'}
                </button>
              )}
              <button
                type="button"
                className="btn sm"
                disabled={resolving}
                style={{ fontSize: '11px', height: '26px', padding: '0 8px' }}
                onClick={onResolveCandidate}
              >
                {resolving ? 'Resolving...' : 'PubChem Lookup'}
              </button>
            </div>
          </div>

          <div style={{ display: 'flex', gap: '6px' }}>
            <input
              type="text"
              className="f mono"
              placeholder="e.g. c1ccccc1C=O"
              style={{ fontSize: '12px', height: '34px', flex: 1 }}
              value={modalInputSmiles}
              onChange={(e) => setModalInputSmiles(e.target.value)}
            />
            {modalInputSmiles !== activeSmiles && (
              <button
                type="button"
                className="btn sm pri"
                style={{ height: '34px', padding: '0 12px' }}
                onClick={() => onSave(modalInputSmiles)}
              >
                Save
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
};

// Enlarged high-res vector drawer for modal
const ModalEnlargedStructure: React.FC<{ smiles: string; width: number; height: number }> = ({
  smiles,
  width,
  height,
}) => {
  const modalSvgRef = useRef<SVGSVGElement | null>(null);

  useEffect(() => {
    if (!modalSvgRef.current || !smiles) return;
    try {
      const isDark =
        document.documentElement.getAttribute('data-theme') === 'dark' ||
        (window.matchMedia &&
          window.matchMedia('(prefers-color-scheme: dark)').matches &&
          document.documentElement.getAttribute('data-theme') !== 'light');

      while (modalSvgRef.current.firstChild) {
        modalSvgRef.current.removeChild(modalSvgRef.current.firstChild);
      }

      const options = {
        width,
        height,
        bondThickness: 1.5,
        bondLength: 20,
        shortBondLength: 0.85,
        bondSpacing: 0.18 * 20,
        atomVisualization: 'default',
        isomeric: true,
        compactDrawing: false,
        themes: {
          light: {
            C: '#14211e',
            O: '#dc2626',
            N: '#2563eb',
            F: '#059669',
            CL: '#16a34a',
            BR: '#b45309',
            I: '#c2410c',
            P: '#ea580c',
            S: '#d97706',
            B: '#ca8a04',
            SI: '#ca8a04',
            H: '#4b5563',
            BACKGROUND: 'transparent',
          },
          dark: {
            C: '#e8f0ec',
            O: '#f87171',
            N: '#60a5fa',
            F: '#34d399',
            CL: '#4ade80',
            BR: '#fb923c',
            I: '#f97316',
            P: '#fb923c',
            S: '#fbbf24',
            B: '#fde047',
            SI: '#fde047',
            H: '#9ca3af',
            BACKGROUND: 'transparent',
          },
        },
      };

      const drawer = new SmilesDrawer.SvgDrawer(options);
      SmilesDrawer.parse(
        smiles,
        (tree: any) => {
          if (!modalSvgRef.current) return;
          drawer.draw(tree, modalSvgRef.current, isDark ? 'dark' : 'light');
        },
        () => {}
      );
    } catch {}
  }, [smiles, width, height]);

  return (
    <svg
      ref={modalSvgRef}
      width={width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      style={{ display: 'block', maxWidth: '100%', maxHeight: '100%' }}
    />
  );
};
