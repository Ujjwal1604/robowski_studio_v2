import React, { useState, useEffect, useRef } from 'react';
import { useApp } from '../../context/AppContext';
import { wellLabel, tlcLane, containerOfLane } from '../../engine';

export interface ParsedWellQuery {
  wellIndex: number;
  label: string;
  rowLetter: string;
  colNum: number;
  plateIndex: number;
  globalIndex: number;
  reactionNumber: number;
  laneIndex: number;
}

export function parseWellQuery(rawQuery: string, maxPlates = 1): ParsedWellQuery | null {
  const q = rawQuery.trim();
  if (!q) return null;

  // Case 1: Coordinate e.g. "A1", "b4", "F9", "well a1", "Plate 1 A1", "P2 C3", "A 1", "A-1", "A01"
  const wellRegex = /^(?:(?:plate|p)\s*(\d+)[\s_-]*)?(?:well\s*)?([a-fA-F])[\s_-]*0?([1-9])$/i;
  const match = q.match(wellRegex);
  if (match) {
    const parsedPlate = match[1] ? Math.max(0, parseInt(match[1], 10) - 1) : 0;
    const rowLetter = match[2].toUpperCase();
    const colNum = parseInt(match[3], 10);
    const rowIdx = rowLetter.charCodeAt(0) - 65;
    const colIdx = colNum - 1;
    if (rowIdx >= 0 && rowIdx <= 5 && colIdx >= 0 && colIdx <= 8) {
      const wellIndex = rowIdx * 9 + colIdx;
      const plateIndex = parsedPlate;
      const globalIndex = plateIndex * 54 + wellIndex;
      const laneIndex = tlcLane(wellIndex, 'column');
      return {
        wellIndex,
        label: `${rowLetter}${colNum}`,
        rowLetter,
        colNum,
        plateIndex,
        globalIndex,
        reactionNumber: globalIndex + 1,
        laneIndex,
      };
    }
  }

  // Case 2: Reaction index: "reaction 13", "rxn 5", "r12", "#13"
  const rxnRegex = /^(?:reaction|rxn|r|#)\s*#?\s*(\d+)$/i;
  const rxnMatch = q.match(rxnRegex);
  if (rxnMatch) {
    const rxnNum = parseInt(rxnMatch[1], 10);
    if (rxnNum >= 1 && rxnNum <= Math.max(54 * maxPlates, 54)) {
      const globalIndex = rxnNum - 1;
      const plateIndex = Math.floor(globalIndex / 54);
      const wellIndex = globalIndex % 54;
      const rowIdx = Math.floor(wellIndex / 9);
      const colNum = (wellIndex % 9) + 1;
      const rowLetter = String.fromCharCode(65 + rowIdx);
      const laneIndex = tlcLane(wellIndex, 'column');
      return {
        wellIndex,
        label: `${rowLetter}${colNum}`,
        rowLetter,
        colNum,
        plateIndex,
        globalIndex,
        reactionNumber: rxnNum,
        laneIndex,
      };
    }
  }

  // Case 3: Lane index: "lane 12", "lane 0"
  const laneRegex = /^lane\s*#?\s*(\d+)$/i;
  const laneMatch = q.match(laneRegex);
  if (laneMatch) {
    const laneNum = parseInt(laneMatch[1], 10);
    if (laneNum >= 0 && laneNum < 54) {
      const wellIndex = containerOfLane(laneNum);
      const rowIdx = Math.floor(wellIndex / 9);
      const colNum = (wellIndex % 9) + 1;
      const rowLetter = String.fromCharCode(65 + rowIdx);
      return {
        wellIndex,
        label: `${rowLetter}${colNum}`,
        rowLetter,
        colNum,
        plateIndex: 0,
        globalIndex: wellIndex,
        reactionNumber: wellIndex + 1,
        laneIndex: laneNum,
      };
    }
  }

  return null;
}

interface CommandItem {
  id: string;
  category: 'Navigation' | 'Well Jump' | 'Reagents' | 'Actions';
  title: string;
  subtitle?: string;
  badge?: string;
  icon: string;
  action: () => void;
}

export const CommandPalette: React.FC = () => {
  const [isOpen, setIsOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [selectedIndex, setSelectedIndex] = useState(0);

  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  const {
    state,
    run,
    view,
    setView,
    setVisited,
    setVialFocus,
    targetWell,
    setTargetWell,
    toggleTheme,
    downloadExport,
    exportRobowskiArchive,
    toast,
  } = useApp();

  // Listen for global shortcut (Ctrl+K or Cmd+K)
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setIsOpen((prev) => !prev);
        setQuery('');
        setSelectedIndex(0);
      }
      if (e.key === 'Escape' && isOpen) {
        setIsOpen(false);
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isOpen]);

  useEffect(() => {
    if (isOpen) {
      setTimeout(() => inputRef.current?.focus(), 50);
    }
  }, [isOpen]);

  // Construct items
  const items: CommandItem[] = [];

  // 1. Navigation items
  items.push(
    {
      id: 'nav-setup',
      category: 'Navigation',
      title: 'Go to 1. Setup',
      subtitle: 'Reagents, molar masses, solvents and concentration ranges',
      badge: 'Step 1',
      icon: '⚙️',
      action: () => {
        setVisited((v) => ({ ...v, setup: true }));
        setView('setup');
      },
    },
    {
      id: 'nav-combos',
      category: 'Navigation',
      title: 'Go to 2. Combinations',
      subtitle: 'Factorial pipetting table and 2D plate heatmap',
      badge: 'Step 2',
      icon: '▦',
      action: () => {
        setVisited((v) => ({ ...v, combos: true }));
        setView('combos');
      },
    },
    {
      id: 'nav-deck',
      category: 'Navigation',
      title: 'Go to 3. Deck Layout',
      subtitle: 'Breadboard vial coordinates, fill levels and tip racks',
      badge: 'Step 3',
      icon: '🧪',
      action: () => {
        setVisited((v) => ({ ...v, deck: true }));
        setView('deck');
      },
    },
    {
      id: 'nav-tlc',
      category: 'Navigation',
      title: 'Go to 4. TLC Map',
      subtitle: 'Physical TLC plate alignment, spot detection and Rf values',
      badge: 'Step 4',
      icon: '📷',
      action: () => {
        setVisited((v) => ({ ...v, tlc: true }));
        setView('tlc');
      },
    },
    {
      id: 'nav-export',
      category: 'Navigation',
      title: 'Go to 5. Export Package',
      subtitle: 'Robot input workbook (.xlsx), HTML bench sheet and archive',
      badge: 'Step 5',
      icon: '📦',
      action: () => {
        setVisited((v) => ({ ...v, export: true }));
        setView('export');
      },
    },
    {
      id: 'nav-runs',
      category: 'Navigation',
      title: 'Runs & Reagent Library',
      subtitle: 'Browse saved runs, chemical catalog and backup files',
      icon: '📚',
      action: () => setView('runs'),
    }
  );

  // 2. Reagents items
  state.reagents.forEach((r, idx) => {
    items.push({
      id: `reagent-${r.code}`,
      category: 'Reagents',
      title: `Reagent ${r.code}: ${r.name || 'Unnamed'}`,
      subtitle: `Stock: ${r.stock || '0'} mM · MW: ${r.molarMass || '0'} g/mol · ${r.solvent || state.reactionSolvent}`,
      badge: `${r.stock || '?'} mM`,
      icon: '🧪',
      action: () => {
        setVisited((v) => ({ ...v, setup: true }));
        setView('setup');
      },
    });
  });

  // 3. Well Jump items (A1 through F9, reactions, lanes)
  const wellInfo = parseWellQuery(query, run?.plates || 1);
  const wellItems: CommandItem[] = [];

  if (wellInfo) {
    const { wellIndex, label, plateIndex, reactionNumber, laneIndex, rowLetter, colNum } = wellInfo;
    const globalIdx = plateIndex * 54 + wellIndex;
    const isMultiPlate = (run?.plates || 1) > 1;
    const plateSuffix = isMultiPlate ? ` (Plate ${plateIndex + 1})` : '';

    wellItems.push(
      {
        id: `well-jump-combos-${globalIdx}`,
        category: 'Well Jump',
        title: `Inspect Well ${label}${plateSuffix} in Combinations Table`,
        subtitle: `Jump to reaction #${reactionNumber} (Row ${rowLetter}, Col ${colNum}) and view pipetted chemical volumes`,
        badge: `Well ${label}`,
        icon: '🎯',
        action: () => {
          setTargetWell({ wellIndex, plateIndex, source: 'combinations' });
          setVisited((v) => ({ ...v, combos: true }));
          setView('combos');
          toast(`Jumped to Well ${label}${plateSuffix} in Combinations Table.`);
        },
      },
      {
        id: `well-jump-tlc-${globalIdx}`,
        category: 'Well Jump',
        title: `Inspect Well ${label}${plateSuffix} in TLC Map & Densitometer`,
        subtitle: `Open TLC Lane ${laneIndex} · 1D absorbance/fluorescence densitogram and Rf peaks`,
        badge: `Lane ${laneIndex}`,
        icon: '🔬',
        action: () => {
          setTargetWell({ wellIndex, plateIndex, source: 'palette' });
          setVisited((v) => ({ ...v, tlc: true }));
          setView('tlc');
          toast(`Inspecting Well ${label}${plateSuffix} TLC lane ${laneIndex}.`);
        },
      },
      {
        id: `well-jump-heatmap-${globalIdx}`,
        category: 'Well Jump',
        title: `Highlight Well ${label}${plateSuffix} in 2D Plate Heatmap`,
        subtitle: `Plate ${plateIndex + 1} Matrix Heatmap · Row ${rowLetter}, Col ${colNum}`,
        badge: `Heatmap`,
        icon: '▦',
        action: () => {
          setTargetWell({ wellIndex, plateIndex, source: 'heatmap' });
          setVisited((v) => ({ ...v, combos: true }));
          setView('combos');
          toast(`Highlighted Well ${label}${plateSuffix} in 2D Plate Heatmap.`);
        },
      }
    );
  }

  // 4. Quick Actions
  items.push(
    {
      id: 'act-export-archive',
      category: 'Actions',
      title: 'Download .robowski Complete Experiment Archive',
      subtitle: 'Self-contained bundle with reaction matrix, robot files and TLC photos',
      icon: '💾',
      action: () => exportRobowskiArchive(),
    },
    {
      id: 'act-export-xlsx',
      category: 'Actions',
      title: 'Download Robot Run Workbook (.xlsx)',
      subtitle: 'Input sheets for the automated liquid handling robot',
      icon: '📊',
      action: () => downloadExport('xlsx'),
    },
    {
      id: 'act-export-bench',
      category: 'Actions',
      title: 'Download Printable Hood Bench Sheet (.html)',
      subtitle: 'Single printable page for stock prep and deck walk checklist',
      icon: '🖨️',
      action: () => downloadExport('bench'),
    },
    {
      id: 'act-theme',
      category: 'Actions',
      title: 'Toggle Dark / Light Theme',
      subtitle: 'Switch visual theme between laboratory dark mode and clean daylight',
      icon: '🌓',
      action: () => toggleTheme(),
    }
  );

  // Filter items by search query
  const regularFiltered = query.trim()
    ? items.filter((item) => {
        const q = query.toLowerCase();
        return (
          item.title.toLowerCase().includes(q) ||
          item.subtitle?.toLowerCase().includes(q) ||
          item.category.toLowerCase().includes(q) ||
          item.badge?.toLowerCase().includes(q)
        );
      })
    : items;

  // Well Jump items ALWAYS take top precedence if query matches a well coordinate!
  const filtered = wellInfo ? [...wellItems, ...regularFiltered] : regularFiltered;

  const handleSelect = (item: CommandItem) => {
    setIsOpen(false);
    item.action();
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setSelectedIndex((prev) => (prev + 1) % Math.max(1, filtered.length));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setSelectedIndex((prev) => (prev - 1 + filtered.length) % Math.max(1, filtered.length));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      if (filtered[selectedIndex]) {
        handleSelect(filtered[selectedIndex]);
      }
    }
  };

  if (!isOpen) return null;

  return (
    <div
      role="dialog"
      aria-modal="true"
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 10000,
        background: 'rgba(15, 23, 42, 0.72)',
        backdropFilter: 'blur(8px)',
        display: 'flex',
        alignItems: 'flex-start',
        justifyContent: 'center',
        padding: '12vh 16px 16px',
      }}
      onClick={(e) => {
        if (e.target === e.currentTarget) setIsOpen(false);
      }}
    >
      <div
        style={{
          width: '100%',
          maxWidth: '640px',
          background: 'var(--panel)',
          border: '1px solid var(--line)',
          borderRadius: '14px',
          boxShadow: '0 24px 60px rgba(0,0,0,0.5)',
          overflow: 'hidden',
          display: 'flex',
          flexDirection: 'column',
          maxHeight: '75vh',
        }}
      >
        {/* Search Input Bar */}
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            padding: '14px 18px',
            borderBottom: '1px solid var(--line)',
            background: 'var(--soft)',
            gap: '12px',
          }}
        >
          <span style={{ fontSize: '18px', color: 'var(--mut)' }}>🔍</span>
          <input
            ref={inputRef}
            type="text"
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setSelectedIndex(0);
            }}
            onKeyDown={handleKeyDown}
            placeholder="Jump to well (e.g. A1, B4, F9, P2 C3, Rxn 12) or search steps, reagents..."
            style={{
              flex: 1,
              background: 'transparent',
              border: 'none',
              outline: 'none',
              fontSize: '15px',
              color: 'var(--fg)',
              fontFamily: 'inherit',
            }}
          />
          {query && (
            <button
              type="button"
              onClick={() => {
                setQuery('');
                setSelectedIndex(0);
                inputRef.current?.focus();
              }}
              style={{
                background: 'transparent',
                border: 'none',
                color: 'var(--mut)',
                cursor: 'pointer',
                fontSize: '14px',
                padding: '2px 4px',
              }}
              title="Clear search"
            >
              ✕
            </button>
          )}
          <span
            style={{
              fontSize: '11px',
              padding: '2px 6px',
              background: 'var(--panel)',
              borderRadius: '4px',
              border: '1px solid var(--line)',
              color: 'var(--mut)',
            }}
          >
            ESC to close
          </span>
        </div>

        {/* Quick Coordinate Jump Suggestions when query is empty */}
        {!query && (
          <div
            style={{
              padding: '6px 14px',
              background: 'rgba(255,255,255,0.02)',
              borderBottom: '1px solid var(--line)',
              display: 'flex',
              alignItems: 'center',
              gap: '6px',
              flexWrap: 'wrap',
              fontSize: '11px',
              color: 'var(--mut)',
            }}
          >
            <span>Jump to well:</span>
            {['A1', 'B4', 'C6', 'D2', 'F9'].map((coord) => (
              <button
                key={coord}
                type="button"
                onClick={() => {
                  setQuery(coord);
                  setSelectedIndex(0);
                }}
                className="mono"
                style={{
                  background: 'var(--soft)',
                  border: '1px solid var(--line)',
                  borderRadius: '4px',
                  padding: '1px 6px',
                  fontSize: '11px',
                  color: 'var(--fg)',
                  cursor: 'pointer',
                }}
              >
                {coord}
              </button>
            ))}
            {(run?.plates || 1) > 1 && (
              <button
                type="button"
                onClick={() => {
                  setQuery('Plate 2 A1');
                  setSelectedIndex(0);
                }}
                className="mono"
                style={{
                  background: 'var(--soft)',
                  border: '1px solid var(--line)',
                  borderRadius: '4px',
                  padding: '1px 6px',
                  fontSize: '11px',
                  color: 'var(--fg)',
                  cursor: 'pointer',
                }}
              >
                P2 A1
              </button>
            )}
          </div>
        )}

        {/* Results List */}
        <div
          ref={listRef}
          style={{
            overflowY: 'auto',
            padding: '8px',
            display: 'flex',
            flexDirection: 'column',
            gap: '2px',
          }}
        >
          {filtered.length === 0 ? (
            <div style={{ textAlign: 'center', padding: '36px 16px', color: 'var(--mut)', fontSize: '13px' }}>
              No commands or wells matching "<b>{query}</b>"
            </div>
          ) : (
            filtered.map((item, idx) => {
              const isSelected = idx === selectedIndex;
              return (
                <div
                  key={item.id}
                  onClick={() => handleSelect(item)}
                  onMouseEnter={() => setSelectedIndex(idx)}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'space-between',
                    padding: '10px 12px',
                    borderRadius: '8px',
                    cursor: 'pointer',
                    background: isSelected ? 'var(--soft)' : 'transparent',
                    border: isSelected ? '1px solid var(--pri)' : '1px solid transparent',
                    transition: 'background 0.1s ease',
                  }}
                >
                  <div style={{ display: 'flex', alignItems: 'center', gap: '12px', minWidth: 0 }}>
                    <span style={{ fontSize: '18px', width: '24px', textAlign: 'center' }}>{item.icon}</span>
                    <div style={{ minWidth: 0 }}>
                      <div style={{ fontSize: '13px', fontWeight: 600, color: 'var(--fg)', display: 'flex', alignItems: 'center', gap: '6px' }}>
                        <span>{item.title}</span>
                        {item.badge && (
                          <span
                            className="mono"
                            style={{
                              fontSize: '10px',
                              padding: '1px 5px',
                              borderRadius: '3px',
                              background: 'var(--panel)',
                              border: '1px solid var(--line)',
                              color: 'var(--mut)',
                            }}
                          >
                            {item.badge}
                          </span>
                        )}
                      </div>
                      {item.subtitle && (
                        <div
                          style={{
                            fontSize: '11px',
                            color: 'var(--mut)',
                            marginTop: '2px',
                            whiteSpace: 'nowrap',
                            overflow: 'hidden',
                            textOverflow: 'ellipsis',
                          }}
                        >
                          {item.subtitle}
                        </div>
                      )}
                    </div>
                  </div>
                  <span style={{ fontSize: '11px', color: 'var(--mut)', textTransform: 'uppercase', letterSpacing: '0.04em', marginLeft: '12px' }}>
                    {item.category}
                  </span>
                </div>
              );
            })
          )}
        </div>

        {/* Footer shortcuts helper */}
        <div
          style={{
            padding: '8px 16px',
            background: 'var(--soft)',
            borderTop: '1px solid var(--line)',
            fontSize: '11px',
            color: 'var(--mut)',
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
          }}
        >
          <div style={{ display: 'flex', gap: '12px' }}>
            <span>↑↓ Navigate</span>
            <span>↵ Select</span>
            <span>ESC Close</span>
          </div>
          <div>Robowski Studio Command Palette</div>
        </div>
      </div>
    </div>
  );
};
