# Robowski Studio — Personal Lab PC Python Backend

This single Python server runs on your **personal lab PC** (100% free, private, no cloud account needed) and upgrades **all of Robowski Studio**:

- **Cross-PC Sync (Personal PC ↔ Public Robot PC)**: Permanently saves all your Runs, ELN well notes, Reagent Library, and high-res TLC plate photos on your personal PC (`python_backend/data/`). Design a run at your desk, then open it on the robot PC with no USB drives.
- **Reagent Auto-Check (RDKit)**: Automatically standardizes SMILES, calculates exact molar mass and formula, and spots salts/hydrates when adding reagents.
- **Illustrated Excel ELN Export**: Creates `.xlsx` lab notebook spreadsheets with crisp 2D chemical structure drawings embedded right inside Excel cells.
- **One-Click Archive Backup**: Saves `.robowski` run archives directly into dated folders in `python_backend/data/archives/`.
- **3D Reaction Predictor & Permanent TLC Memory**: Adds real 3D ring-strain checks (ETKDGv3 + MMFF94s), full tautomer cleanup, and permanent TLC feedback memory that learns from your **New spot / No new spot** checks.

## Quick Start with `uv`

1. Open a terminal inside this `python_backend` folder and run:

```bash
uv run app.py
```

`uv` automatically installs Python packages from `pyproject.toml` and starts the server at `http://127.0.0.1:8000`.

2. In Robowski Studio, click **Lab PC** in the top header bar → paste `http://localhost:8000` → click **Test & Save**.

## Using from the Public Robot PC (or Online HTTPS Robowski Studio)

On your personal lab PC, open a second terminal and run Cloudflare's free quick tunnel (no account required):

```bash
cloudflared tunnel --url http://127.0.0.1:8000
```

Paste the temporary `https://....trycloudflare.com` link it prints into the **Lab PC** box in Robowski Studio (on either PC). Whenever your personal PC is turned off, Robowski Studio automatically falls back to browser storage and its built-in predictor.

## Where Your Data Is Saved

Everything stays cleanly inside `python_backend/data/`:
- `robowski_studio.db` — All saved runs, reagent library, and TLC hit-rate memory (SQLite)
- `tlc_images/` — Full-resolution TLC plate photos synced from the TLC tab
- `archives/` — One-click `.robowski` experiment archives saved from the Export tab
