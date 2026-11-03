# Robowski Studio (React + TypeScript)

Robowski Studio is a robotic liquid handling workstation planner for high-throughput screening and reaction optimization. It designs reaction plates, calculates stock dilutions, plans deck layouts, verifies auto-fixes, and generates robot-ready workbooks and bench sheets.

The application has been ported from a legacy concatenated script to a modern, fully-typed React 19 + TypeScript + Vite SPA while preserving 100% of the mathematical calculations, dilution logic, deck layouts, and export file formats.

## Features

- **Setup & Reagent Management**:
  - Concentration mode, Equivalence mode, Custom vial import, and Triplet Plate design.
  - Multi-set combinatorial parameter sweeps with automatic vial count calculations.
  - Reagent library auto-complete (CAS, SMILES, IUPAC, molar mass, stock concentrations, densities).
  - Live stock prep checklist and real-time auto-fix solver that suggests verified adjustments for volume/dilution/flask constraints.
- **Vial Combinations**:
  - Filterable vial recipe table with paged navigation.
  - Dilution badges (`_N`, `_N2`), stock concentration routing, volume breakdowns, and stock distribution bars.
- **Deck & Hood Layout**:
  - Interactive deck plan for both **Front Hood** and **Side Hood** configurations.
  - 20 mL reagent bottle layout with fill levels, liquid heights, solvent jars, and 54-vial reaction plate positions.
  - Color-coded safety checks, deck load lists, and tip rack requirements (50 µL, 300 µL, 1000 µL).
- **Exports & Robot Files**:
  - Complete multi-sheet Excel workbook (`.xlsx`) generation directly in-browser.
  - Bench sheet (`.html`), deck load checklist (`.csv`), stock preparation sheet (`.csv`).
  - High-resolution SVG and PNG notebook run cards with condition summaries.
  - ZIP package bundle (`robowski_package.zip`) containing all run assets.
- **Run History & Comparison**:
  - Local persistence (`localStorage`) for drafts, completed runs, and reagent libraries.
  - Side-by-side run comparison diffing parameters, reagents, and plate requirements.
  - Full backup and restore via JSON.

## Development

```bash
# Install dependencies
npm install

# Start development server (runs on port 3000)
npm run dev

# Run automated calculation test suite
npm test

# Type check
npm run lint

# Build for production
npm run build
```

## Architecture

```
src/
├── engine/                      # 100% pure, testable math & robot physics (Zero React/DOM)
│   ├── constants.ts             # Solvents, densities, capacities, color palette
│   ├── combinations.ts          # Cartesian grid sweeps & well assignments
│   ├── dilution.ts              # Stock volumes, _N/_N2 dilution splits, flask sizing, buildRun
│   ├── deckTiming.ts            # Hood layout (Front/Side), tip racks, runtime estimator
│   ├── autoFix.ts               # Parameter relaxation solver & explanations
│   ├── triplet.ts               # 6×9 Triplet design mode & derivation logic
│   ├── tooltips.ts              # Rich chemical hover inspection generators
│   ├── exporters/               # Pure export file builders
│   │   ├── xlsx.ts              # Robowski OpenXML Excel workbook generator
│   │   ├── csv.ts               # Stock prep & deck load CSVs (formula safe)
│   │   ├── benchSheet.ts        # Printable HTML bench sheet
│   │   ├── runCard.ts           # SVG cards & canvas PNG rasterizers
│   │   ├── zipStore.ts          # In-browser ZIP archive writer
│   │   └── package.ts           # Bundle packager
│   └── importers/               # Pure file parsers
│       ├── tableReader.ts       # CSV, TSV, and ZIP/XLSX sheet parser
│       ├── generatorParser.ts   # Legacy Excel recipe importer
│       └── robotParser.ts       # Robot file reverse-engineer parser
│
├── context/                     # Lean React state & persistence
│   ├── AppContext.tsx           # Context provider & event dispatch
│   ├── runPayload.ts            # State normalization, validation & payload building
│   ├── storage.ts               # LocalStorage management (runs, library, drafts)
│   └── importers.ts             # Tabular reagent library importer
│
├── components/                  # Clear component boundaries
│   ├── layout/                  # Shell chrome (Header, StepsNav, SummaryStrip)
│   ├── views/                   # Step views (SetupView, CombinationsView, DeckView, etc.)
│   └── ui/                      # Reusable UI widgets (Tooltip, Toast, PreviewModal)
│
├── types/                       # TypeScript domain interfaces
│
└── tests/                       # Automated Vitest test suite (31 tests)
    ├── combinations.test.ts     # Axis divisions, precision, bounds, Cartesian sweeps
    ├── dilution.test.ts         # Direct pipetting, _N, _N2, flask prep, solvent balance
    ├── deckTiming.test.ts       # Hood positions, tip size classes, runtime estimation
    ├── triplet.test.ts          # 6×9 geometry, additive rows, doublet/singlet controls
    ├── autoFix.test.ts          # Relaxation search and diagnostics
    └── exporters.test.ts        # CSV formula injection prevention, XLSX XML structure
```
