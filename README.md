# Robowski Studio

Robowski Studio is an interactive robotic liquid-handling workstation planner, reaction predictor, and high-throughput experimentation (HTE) notebook for synthetic chemistry screening. It designs combinatorial reaction plates, computes multi-tier stock dilutions, lays out robot decks, predicts reaction cascades and LC-MS/TLC outcomes, maps multi-plate TLC images, and generates robot-ready workbooks and bench documentation.

## Key Capabilities

### 1. Setup & Plate Design
- **Flexible Design Modes**: Concentration sweeps, equivalence sweeps, custom vial recipe imports, and **Triplet / Doublet / Quadruplet** plate patterns (`3 × 3` sections across a 54-well `6 × 9` plate with customizable stoichiometric ratios and additive rows).
- **Reagent Library & Chemical Structures**: Built-in library management with CAS, SMILES, IUPAC, molar mass, density, hydrate/salt awareness, PubChem / NCI Cactus structure lookup, and live 2D structure rendering via **RDKit WebAssembly** (with **SmilesDrawer** fallback and reactive light/dark theme contrast).
- **Condition Modeling & Auto-Fix Solver**: Temperature, water content, acid/base/buffer presets, live stock preparation checklist, and an automated constraint relaxation solver with diff previews (`_N` / `_N2` dilution routing, flask sizing, and minimum transfer thresholds).

### 2. Combinations & Plate Heatmap
- Interactive 54-well plate heatmap alongside a filterable, paginated vial recipe table.
- Direct well inspection with dilution badges (`_N`, `_N2`), stock concentration routing, per-reagent volume breakdowns, and stock consumption bars.

### 3. Reaction & Analytical Predictor
- **Offline RDKit Cascade Engine**: Evaluates multi-step organic reaction and tautomer rules across every plate well using substrate functionality, stoichiometry, pH/medium, water content, and temperature.
- **Analytical Readouts**: Groups pathways, highlights newly formed bonds directly on 2D product structures, calculates expected **LC-MS** exact masses and common adducts, and previews expected **TLC** spot profiles per well.

### 4. Deck & Hood Layout
- Interactive **Left hood** and **Right hood** spatial layouts showing 20 mL stock bottles (fill levels and liquid heights), solvent jars, and 54-vial reaction plates.
- Safety validation, deck load lists, pipette tip rack accounting (`50 µL`, `300 µL`, `1000 µL`), and run-time estimation.

### 5. TLC Map & Solvent Advisor
- **Automated Multi-Plate TLC Mapping**: Slices uploaded TLC plate images, detects lanes and spots, aligns 6×9 robotic spotting coordinates (`A1–F9` interleaved half-plates), and supports edge/lane inspection.
- **TLC Solvent System Advisor**: Recommends complete carrier mobile phases and resolution estimates tailored to stationary phase (**Silica Gel (SiO₂)**, **Neutral Alumina (Al₂O₃)**, **Basic Alumina (Al₂O₃)**, and **Reverse Phase (C18)**), respecting phase-modifier compatibility.

### 6. HTE Notebook & Cross-Run Comparison
- **HTE Notebook (ELN)**: Track experimental objectives, reaction classes, well conversion/yield annotations, and editable campaign tables.
- **Compare View**: Side-by-side comparison of wells and saved runs, including condition diffs and aligned TLC lane thumbnails.
- **Runs, Library & Command Palette**: Persistent browser storage (`localStorage`), JSON backup/restore, and quick navigation/well jumping via `Ctrl+K` / `⌘K`.

### 7. Exports & Archives
- **Excel Workbook (`.xlsx`)**: In-browser OpenXML generation compatible with Robowski workflows.
- **Bench & Deck Sheets**: Printable HTML bench sheet, formula-safe stock prep and deck load CSVs, and high-resolution SVG/PNG notebook run cards.
- **Packages & Archives**: One-click `robowski_package.zip` run bundle and full `.robowski` project archives preserving state, TLC images, and ELN records.

### 8. Optional AI Assistance (Server-Side Gemini)
When `GEMINI_API_KEY` is configured on the server, optional AI endpoints assist with:
- Liquid-handling & pipetting error diagnostics
- TLC lane & spot interpretation
- TLC mobile-phase solvent system recommendations
- HTE campaign synthesis reports and group-meeting slide bullets

---

## Development

### Prerequisites
- Node.js 20+ and npm

### Commands

```bash
# Install dependencies
npm install

# Start full-stack dev server (Express + Vite middleware on port 3000)
npm run dev

# Run automated Vitest suite
npm test

# Type-check with TypeScript
npm run lint

# Build client bundle for production
npm run build

# Start production server (serves dist/ and /api/* on port 3000)
NODE_ENV=production npm start
```

### Environment Variables
- `GEMINI_API_KEY` *(optional)*: Enables `/api/ai/*` endpoints in `server.ts`. Core plate design, dilution math, RDKit reaction prediction, TLC mapping, and all exports run completely locally in the browser without an API key.

---

## Project Architecture

```text
├── server.ts                        # Express server (port 3000): Vite dev / static dist & /api/ai/* routes
├── src/
│   ├── engine/                      # Pure, DOM-free calculation, chemistry, and file engines
│   │   ├── combinations.ts          # Parameter sweeps & well assignments
│   │   ├── dilution.ts              # Stock volumes, _N/_N2 dilutions, flask prep, run builder
│   │   ├── dilutionTier.ts          # Multi-tier dilution calculations
│   │   ├── deckTiming.ts            # Left/Right hood layouts, tip racks, runtime estimates
│   │   ├── autoFix.ts               # Constraint solver & relaxation diffs
│   │   ├── triplet.ts               # 6×9 Triplet/Doublet/Quadruplet plate pattern logic
│   │   ├── conditions.ts            # Reaction condition normalization & hydrate/salt math
│   │   ├── tlcLanes.ts              # Robotic TLC spotting layouts & lane coordinate mapping
│   │   ├── tlcLaneDetect.ts         # Automated TLC lane & spot detection
│   │   ├── tlcPlateSlice.ts         # Multi-plate image slicing
│   │   ├── tlcEdge.ts               # TLC plate edge / front calibration
│   │   ├── comparison.ts            # Cross-run & cross-well diff engine
│   │   ├── elnSpreadsheet.ts        # ELN tabular state & metrics
│   │   ├── predictor/               # RDKit WASM cascade predictor, bond highlighting, LC-MS targets & TLC advisor
│   │   ├── exporters/               # Pure XLSX, CSV, HTML bench sheet, SVG/PNG card, ZIP & .robowski archive builders
│   │   └── importers/               # CSV, TSV, XLSX, legacy generator, and robot file parsers
│   ├── context/                     # React state management, normalization, and browser persistence
│   ├── services/                    # Client API wrappers for /api/ai/*
│   ├── utils/                       # RDKit WebAssembly loader & SVG molecule renderer
│   ├── components/
│   │   ├── layout/                  # Header, StepsNav, BottomStepper, SummaryStrip
│   │   ├── views/                   # Setup, Combinations, Predict, Deck, TLC Map, ELN, Export, Compare, Runs
│   │   └── ui/                      # ChemicalStructure, Ai* modals, WellTlcPreview, CommandPalette, etc.
│   └── types/                       # Shared TypeScript domain interfaces
└── tests/                           # Automated Vitest suite covering math, RDKit, TLC, AI, and exporters
```
