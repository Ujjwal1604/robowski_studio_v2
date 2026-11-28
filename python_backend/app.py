"""
Robowski Studio - Whole-App Personal Lab PC Python Backend
----------------------------------------------------------
Powers every tab of Robowski Studio from your personal lab PC (free, private, offline-capable):
  1. Cross-PC Sync (SQLite): Saved Runs, ELN well observations, and Reagent Library
  2. TLC Plate Photo Storage: High-resolution TLC images saved on your PC disk
  3. One-Click Experiment Archiving: Saves .robowski archives into dated folders on your PC
  4. Illustrated Excel ELN Export: Generates .xlsx notebooks with embedded RDKit 2D structures
  5. Reagent Auto-Check (RDKit): Canonical SMILES, exact molar mass, formula, salt/hydrate check
  6. 3D Reaction Predictor: ETKDGv3 + MMFF94s ring-strain checks, rdMolStandardize tautomers,
     and permanent SQLite TLC hit-rate memory
  7. TLC Image Illumination Flattening (NumPy + Pillow)

Run on your personal lab PC with uv:
  uv run app.py
"""

from __future__ import annotations

import copy
import csv
import hmac
import io
import json
import math
import os
import re
import sqlite3
import sys
import threading
import uuid
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
from pathlib import Path
from types import SimpleNamespace
from typing import Any, Dict, List, Optional, Tuple

import numpy as np
from fastapi import FastAPI, File, Form, HTTPException, Query, Request, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, PlainTextResponse, Response
from openpyxl import Workbook, load_workbook
from openpyxl.drawing.image import Image as XLImage
from openpyxl.styles import Alignment, Font, PatternFill
from PIL import Image, ImageFilter
from pydantic import BaseModel, Field

import rdkit
from rdkit import Chem
from rdkit.Chem import AllChem, Crippen, Descriptors, Draw, rdMolDescriptors
from rdkit.Chem.MolStandardize import rdMolStandardize

# ---------------------------------------------------------------------------
# App & CORS setup
# ---------------------------------------------------------------------------
app = FastAPI(
    title="Robowski Studio Personal Lab PC Backend",
    version="2.0.0",
)

allowed_origins_env = os.environ.get("ROBOWSKI_ALLOWED_ORIGINS", "*").strip()
allowed_origins = (
    ["*"]
    if allowed_origins_env == "*"
    else [o.strip() for o in allowed_origins_env.split(",") if o.strip()]
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=allowed_origins,
    allow_credentials=False,
    allow_methods=["*"],
    allow_headers=["*"],
)

# ---------------------------------------------------------------------------
# Local disk paths & SQLite database
# ---------------------------------------------------------------------------
BASE_DIR = Path(__file__).parent
DATA_DIR = Path(os.environ.get("ROBOWSKI_DATA_DIR", str(BASE_DIR / "data")))
TLC_IMG_DIR = DATA_DIR / "tlc_images"
ARCHIVE_DIR = DATA_DIR / "archives"
DB_PATH = Path(os.environ.get("ROBOWSKI_DB_PATH", str(DATA_DIR / "robowski_studio.db")))

DATA_DIR.mkdir(parents=True, exist_ok=True)
TLC_IMG_DIR.mkdir(parents=True, exist_ok=True)
ARCHIVE_DIR.mkdir(parents=True, exist_ok=True)

_SAFE_TOKEN_RE = re.compile(r"[^A-Za-z0-9._-]+")


def _safe_token(raw: str, max_len: int = 96) -> str:
    cleaned = _SAFE_TOKEN_RE.sub("_", (raw or "").strip()).strip("._")
    if not cleaned:
        raise HTTPException(status_code=400, detail="Invalid identifier")
    return cleaned[:max_len]


def _init_db() -> None:
    with sqlite3.connect(DB_PATH) as conn:
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS saved_runs (
                id TEXT PRIMARY KEY,
                name TEXT NOT NULL,
                updated INTEGER NOT NULL,
                payload_json TEXT NOT NULL
            )
            """
        )
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS reagent_library (
                id TEXT PRIMARY KEY,
                name TEXT NOT NULL,
                updated INTEGER NOT NULL,
                payload_json TEXT NOT NULL
            )
            """
        )
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS tlc_feedback (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                timestamp TEXT NOT NULL,
                well_key TEXT NOT NULL,
                rule_ids_json TEXT NOT NULL,
                observed_new_spot INTEGER NOT NULL,
                solvent_system TEXT,
                measured_rf REAL,
                substrates_json TEXT,
                notes TEXT
            )
            """
        )
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS tlc_image_meta (
                uid TEXT NOT NULL,
                img_key TEXT NOT NULL,
                filename TEXT NOT NULL,
                content_type TEXT NOT NULL,
                disk_relpath TEXT NOT NULL,
                updated INTEGER NOT NULL,
                PRIMARY KEY (uid, img_key)
            )
            """
        )
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS saved_archives (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                timestamp TEXT NOT NULL,
                run_name TEXT NOT NULL,
                filename TEXT NOT NULL,
                disk_relpath TEXT NOT NULL,
                size_bytes INTEGER NOT NULL
            )
            """
        )
        conn.commit()


_init_db()

# ---------------------------------------------------------------------------
# Shared RDKit utilities (thread-safe helpers)
# ---------------------------------------------------------------------------
_TAUTOMER_ENUM = rdMolStandardize.TautomerEnumerator()
_TAUTOMER_ENUM.SetMaxTautomers(64)
_TAUTOMER_ENUM.SetMaxTransforms(64)
_LARGEST_FRAG = rdMolStandardize.LargestFragmentChooser()
_UNCHARGER = rdMolStandardize.Uncharger()
_EXECUTOR = ThreadPoolExecutor(max_workers=min(8, max(2, os.cpu_count() or 2)))


def _counts_summary() -> Dict[str, int]:
    with sqlite3.connect(DB_PATH) as conn:
        runs_count = int(conn.execute("SELECT COUNT(*) FROM saved_runs").fetchone()[0])
        lib_count = int(conn.execute("SELECT COUNT(*) FROM reagent_library").fetchone()[0])
        tlc_obs = int(conn.execute("SELECT COUNT(*) FROM tlc_feedback").fetchone()[0])
        tlc_imgs = int(conn.execute("SELECT COUNT(*) FROM tlc_image_meta").fetchone()[0])
        archives_count = int(conn.execute("SELECT COUNT(*) FROM saved_archives").fetchone()[0])
    return {
        "runsCount": runs_count,
        "libraryCount": lib_count,
        "tlcObservations": tlc_obs,
        "tlcImagesCount": tlc_imgs,
        "archivesCount": archives_count,
    }


def _standardize_smiles(raw_smiles: str) -> Dict[str, Any]:
    mol = Chem.MolFromSmiles(raw_smiles)
    if mol is None:
        return {"valid": False, "error": "Invalid SMILES"}

    raw_frags = Chem.GetMolFrags(mol, asMols=True, sanitizeFrags=True)
    salt_fragments: List[str] = []
    if len(raw_frags) > 1:
        sizes = [f.GetNumHeavyAtoms() for f in raw_frags]
        max_idx = sizes.index(max(sizes))
        for idx, frag in enumerate(raw_frags):
            if idx != max_idx:
                salt_fragments.append(Chem.MolToSmiles(frag, canonical=True))

    try:
        cleaned = rdMolStandardize.Cleanup(mol)
        parent = _LARGEST_FRAG.choose(cleaned)
        uncharged = _UNCHARGER.uncharge(parent)
        canonical_taut = _TAUTOMER_ENUM.Canonicalize(uncharged)
    except Exception:
        canonical_taut = mol

    can_smi = Chem.MolToSmiles(canonical_taut, canonical=True, isomericSmiles=False)
    formula = rdMolDescriptors.CalcMolFormula(canonical_taut)
    exact_mass = round(float(Descriptors.ExactMolWt(canonical_taut)), 5)
    mol_wt = round(float(Descriptors.MolWt(canonical_taut)), 3)
    full_mol_wt = round(float(Descriptors.MolWt(mol)), 3)
    clogp = round(float(Crippen.MolLogP(canonical_taut)), 2)
    tpsa = round(float(rdMolDescriptors.CalcTPSA(canonical_taut)), 1)
    hbd = int(rdMolDescriptors.CalcNumHBD(canonical_taut))
    hba = int(rdMolDescriptors.CalcNumHBA(canonical_taut))
    rot_bonds = int(rdMolDescriptors.CalcNumRotatableBonds(canonical_taut))

    return {
        "valid": True,
        "canonicalSmiles": can_smi,
        "formula": formula,
        "exactMass": exact_mass,
        "molarMass": full_mol_wt,
        "parentMolarMass": mol_wt,
        "saltFragments": salt_fragments,
        "hasWater": any(s == "O" for s in salt_fragments),
        "clogP": clogp,
        "tpsa": tpsa,
        "hbd": hbd,
        "hba": hba,
        "rotatableBonds": rot_bonds,
        "numRings": int(rdMolDescriptors.CalcNumRings(canonical_taut)),
        "numAromaticRings": int(rdMolDescriptors.CalcNumAromaticRings(canonical_taut)),
    }


def _evaluate_3d_strain(smiles: str) -> Dict[str, Any]:
    mol = Chem.MolFromSmiles(smiles)
    if mol is None:
        return {"ok": False, "reason": "parse_failed"}

    heavy = mol.GetNumHeavyAtoms()
    if heavy < 4 or heavy > 75:
        return {"ok": True, "skipped": True, "strainLevel": "none"}

    mol_h = Chem.AddHs(mol)
    params = AllChem.ETKDGv3()
    params.randomSeed = 42
    params.maxIterations = 250
    params.useSmallRingTorsions = True

    embed_status = AllChem.EmbedMolecule(mol_h, params)
    if embed_status != 0:
        params.useRandomCoords = True
        embed_status = AllChem.EmbedMolecule(mol_h, params)
    if embed_status != 0:
        return {
            "ok": False,
            "strainLevel": "impossible",
            "energyPerHeavy": None,
            "note": "3D ETKDGv3 could not embed a physically valid geometry (severe ring/bridgehead strain).",
        }

    energy: Optional[float] = None
    force_field = "MMFF94s"
    try:
        props = AllChem.MMFFGetMoleculeProperties(mol_h, mmffVariant="MMFF94s")
        if props is not None:
            ff = AllChem.MMFFGetMoleculeForceField(mol_h, props)
            if ff is not None:
                ff.Minimize(maxIts=250)
                energy = float(ff.CalcEnergy())
        if energy is None:
            force_field = "UFF"
            ff = AllChem.UFFGetMoleculeForceField(mol_h)
            if ff is not None:
                ff.Minimize(maxIts=250)
                energy = float(ff.CalcEnergy())
    except Exception:
        energy = None

    if energy is None:
        return {"ok": True, "strainLevel": "unknown", "energyPerHeavy": None}

    e_per_heavy = energy / max(1, heavy)
    num_rings = rdMolDescriptors.CalcNumRings(mol)

    if e_per_heavy > 14.0 and num_rings >= 1:
        level = "severe"
        note = f"Severe 3D {force_field} strain ({e_per_heavy:.1f} kcal/mol per heavy atom)."
    elif e_per_heavy > 8.5 and num_rings >= 1:
        level = "high"
        note = f"Elevated 3D {force_field} ring/steric strain ({e_per_heavy:.1f} kcal/mol per heavy atom)."
    else:
        level = "normal"
        note = None

    return {
        "ok": True,
        "forceField": force_field,
        "energyKcal": round(energy, 2),
        "energyPerHeavy": round(e_per_heavy, 2),
        "strainLevel": level,
        "note": note,
    }


def _compute_gasteiger_extrema(smiles: str) -> Optional[Dict[str, float]]:
    mol = Chem.MolFromSmiles(smiles)
    if mol is None:
        return None
    try:
        AllChem.ComputeGasteigerCharges(mol)
        charges = []
        for atom in mol.GetAtoms():
            val = float(atom.GetProp("_GasteigerCharge"))
            if val == val:  # exclude NaN
                charges.append(val)
        if not charges:
            return None
        return {"minCharge": round(min(charges), 3), "maxCharge": round(max(charges), 3)}
    except Exception:
        return None


def _get_tlc_rule_stats() -> Dict[str, Dict[str, Any]]:
    stats: Dict[str, Dict[str, Any]] = {}
    with sqlite3.connect(DB_PATH) as conn:
        for rule_ids_json, obs in conn.execute(
            "SELECT rule_ids_json, observed_new_spot FROM tlc_feedback"
        ):
            try:
                rule_ids = json.loads(rule_ids_json)
            except Exception:
                continue
            for rid in rule_ids:
                if not isinstance(rid, str):
                    continue
                entry = stats.setdefault(rid, {"hits": 0, "misses": 0})
                if obs:
                    entry["hits"] += 1
                else:
                    entry["misses"] += 1
    for entry in stats.values():
        total = entry["hits"] + entry["misses"]
        entry["total"] = total
        entry["hitRate"] = round(entry["hits"] / total, 3) if total else 0.0
    return stats


def _tier_for_score(score: float) -> str:
    if score >= 0.56:
        return "High"
    if score >= 0.34:
        return "Medium"
    if score >= 0.16:
        return "Low"
    return "Speculative"


def _refine_single_well(well_result: Dict[str, Any], tlc_stats: Dict[str, Dict[str, Any]]) -> Dict[str, Any]:
    species_list = well_result.get("species") or []
    if not species_list:
        return well_result

    refined_by_tautomer: Dict[str, Dict[str, Any]] = {}
    well_alerts = list(well_result.get("alerts") or [])
    strain_penalized_count = 0
    tlc_calibrated_count = 0

    for idx, sp in enumerate(species_list):
        sp_copy = dict(sp)
        smi = sp_copy.get("smiles", "")
        if not smi:
            continue

        std = _standardize_smiles(smi)
        taut_key = std["canonicalSmiles"] if std.get("valid") else sp_copy.get("tautomerKey", smi)
        sp_copy["tautomerKey"] = taut_key
        if std.get("valid"):
            sp_copy["clogP"] = std["clogP"]
            sp_copy["tpsa"] = std["tpsa"]

        alerts = list(sp_copy.get("alerts") or [])
        score = float(sp_copy.get("score", 0.0))

        # 3D conformer + MMFF94s strain check on top 14 candidates
        if idx < 14:
            strain = _evaluate_3d_strain(smi)
            level = strain.get("strainLevel")
            if level == "impossible":
                score *= 0.25
                strain_penalized_count += 1
                alerts.append({"kind": "python_3d_strain", "severity": "warn", "message": strain["note"]})
            elif level == "severe":
                score *= 0.45
                strain_penalized_count += 1
                alerts.append({"kind": "python_3d_strain", "severity": "warn", "message": strain["note"]})
            elif level == "high":
                score *= 0.78
                strain_penalized_count += 1
                alerts.append({"kind": "python_3d_strain", "severity": "info", "message": strain["note"]})

        # Empirical lab TLC feedback nudge
        chain = sp_copy.get("bestChain") or []
        rule_ids = [st.get("ruleId") for st in chain if isinstance(st, dict) and st.get("ruleId")]
        matched_rates = [
            (rid, tlc_stats[rid])
            for rid in rule_ids
            if rid in tlc_stats and tlc_stats[rid]["total"] >= 3
        ]
        if matched_rates:
            avg_rate = sum(s["hitRate"] for _, s in matched_rates) / len(matched_rates)
            n_obs = sum(s["total"] for _, s in matched_rates)
            if avg_rate >= 0.75:
                score = min(0.99, score * 1.12)
                tlc_calibrated_count += 1
                alerts.append(
                    {
                        "kind": "tlc_history",
                        "severity": "info",
                        "message": f"Lab TLC history: {int(round(avg_rate * 100))}% new-spot rate across {n_obs} logged checks.",
                    }
                )
            elif avg_rate <= 0.25:
                score *= 0.78
                tlc_calibrated_count += 1
                alerts.append(
                    {
                        "kind": "tlc_history",
                        "severity": "warn",
                        "message": f"Lab TLC history: low new-spot rate ({int(round(avg_rate * 100))}% across {n_obs} logged checks).",
                    }
                )

        sp_copy["score"] = round(max(0.0, min(0.99, score)), 4)
        sp_copy["tier"] = _tier_for_score(sp_copy["score"])
        sp_copy["alerts"] = alerts

        existing = refined_by_tautomer.get(taut_key)
        if existing is None:
            refined_by_tautomer[taut_key] = sp_copy
        else:
            existing["tautomerForms"] = int(existing.get("tautomerForms", 1)) + int(
                sp_copy.get("tautomerForms", 1)
            )
            if sp_copy["score"] > existing["score"]:
                sp_copy["tautomerForms"] = existing["tautomerForms"]
                refined_by_tautomer[taut_key] = sp_copy

    refined_list = sorted(refined_by_tautomer.values(), key=lambda x: x.get("score", 0.0), reverse=True)

    if strain_penalized_count > 0:
        well_alerts.append(
            {
                "kind": "python_3d_strain",
                "severity": "info",
                "message": f"Python 3D RDKit (MMFF94s) checked geometries and downgraded {strain_penalized_count} strained candidate(s).",
            }
        )
    if tlc_calibrated_count > 0:
        well_alerts.append(
            {
                "kind": "tlc_history",
                "severity": "info",
                "message": f"Adjusted {tlc_calibrated_count} candidate score(s) using your personal PC TLC history.",
            }
        )

    out = dict(well_result)
    out["species"] = refined_list
    out["alerts"] = well_alerts
    stats = dict(out.get("stats") or {})
    stats["highCount"] = sum(1 for s in refined_list if s.get("tier") == "High")
    stats["mediumCount"] = sum(1 for s in refined_list if s.get("tier") == "Medium")
    stats["lowCount"] = sum(1 for s in refined_list if s.get("tier") == "Low")
    stats["speculativeCount"] = sum(1 for s in refined_list if s.get("tier") == "Speculative")
    stats["pythonRefined"] = True
    out["stats"] = stats
    return out


# ---------------------------------------------------------------------------
# Request / response models
# ---------------------------------------------------------------------------
class StandardizeRequest(BaseModel):
    smiles: List[str] = Field(default_factory=list)


class InspectReagentRequest(BaseModel):
    smiles: str


class RefineWellRequest(BaseModel):
    wellResult: Dict[str, Any]


class RefinePlateRequest(BaseModel):
    wellResults: Dict[str, Dict[str, Any]]


class TlcFeedbackRequest(BaseModel):
    wellKey: str = "well"
    ruleIds: List[str] = Field(default_factory=list)
    observedNewSpot: bool
    solventSystem: Optional[str] = None
    measuredRf: Optional[float] = None
    substrates: Optional[List[str]] = None
    notes: Optional[str] = None


class BulkRunsRequest(BaseModel):
    runs: List[Dict[str, Any]] = Field(default_factory=list)


class BulkLibraryRequest(BaseModel):
    items: List[Dict[str, Any]] = Field(default_factory=list)


class IllustratedElnRequest(BaseModel):
    runName: str = "Robowski Run"
    hood: str = "left"
    mode: str = "grid"
    date: Optional[str] = None
    conditions: Dict[str, Any] = Field(default_factory=dict)
    reagents: List[Dict[str, Any]] = Field(default_factory=list)
    observations: List[Dict[str, Any]] = Field(default_factory=list)


# ---------------------------------------------------------------------------
# Health & status
# ---------------------------------------------------------------------------
@app.get("/health")
def health() -> Dict[str, Any]:
    counts = _counts_summary()
    return {
        "ok": True,
        "service": "robowski-studio-personal-backend",
        "version": "2.0.0",
        "rdkitVersion": rdkit.__version__,
        "dataDir": str(DATA_DIR.resolve()),
        **counts,
        "features": [
            "runs_sync",
            "library_sync",
            "tlc_images_sync",
            "archives_backup",
            "illustrated_eln_xlsx",
            "reagent_rdkit_inspect",
            "rdkit_3d_mmff94s_strain",
            "rdkit_canonical_tautomer",
            "sqlite_tlc_feedback",
            "tlc_plate_enhance",
            "robot_live_monitor",
            "robot_commands",
        ],
    }


# ---------------------------------------------------------------------------
# 1. Cross-PC Saved Runs CRUD (Setup + Combinations + ELN + TLC Metadata)
# ---------------------------------------------------------------------------
@app.get("/api/runs")
def api_list_runs() -> Dict[str, Any]:
    runs: List[Dict[str, Any]] = []
    with sqlite3.connect(DB_PATH) as conn:
        for (payload_json,) in conn.execute(
            "SELECT payload_json FROM saved_runs ORDER BY updated DESC"
        ):
            try:
                runs.append(json.loads(payload_json))
            except Exception:
                continue
    return {"success": True, "runs": runs}


@app.put("/api/runs/{run_id}")
async def api_put_run(run_id: str, request: Request) -> Dict[str, Any]:
    safe_id = _safe_token(run_id)
    body = await request.json()
    if not isinstance(body, dict):
        raise HTTPException(status_code=400, detail="Run payload must be a JSON object")
    body["id"] = safe_id
    name = str(body.get("name") or "Untitled run")
    updated = int(body.get("updated") or int(datetime.now(timezone.utc).timestamp() * 1000))
    body["updated"] = updated

    with sqlite3.connect(DB_PATH) as conn:
        conn.execute(
            """
            INSERT INTO saved_runs (id, name, updated, payload_json)
            VALUES (?, ?, ?, ?)
            ON CONFLICT(id) DO UPDATE SET
                name=excluded.name,
                updated=excluded.updated,
                payload_json=excluded.payload_json
            """,
            (safe_id, name, updated, json.dumps(body)),
        )
        conn.commit()
    return {"success": True, "id": safe_id, "updated": updated}


@app.post("/api/runs/bulk")
def api_bulk_put_runs(req: BulkRunsRequest) -> Dict[str, Any]:
    saved = 0
    with sqlite3.connect(DB_PATH) as conn:
        for item in req.runs:
            if not isinstance(item, dict) or not item.get("id"):
                continue
            safe_id = _safe_token(str(item["id"]))
            name = str(item.get("name") or "Untitled run")
            updated = int(item.get("updated") or int(datetime.now(timezone.utc).timestamp() * 1000))
            # Only overwrite if incoming timestamp is >= stored timestamp
            existing = conn.execute(
                "SELECT updated FROM saved_runs WHERE id = ?", (safe_id,)
            ).fetchone()
            if existing is not None and int(existing[0]) > updated:
                continue
            conn.execute(
                """
                INSERT INTO saved_runs (id, name, updated, payload_json)
                VALUES (?, ?, ?, ?)
                ON CONFLICT(id) DO UPDATE SET
                    name=excluded.name,
                    updated=excluded.updated,
                    payload_json=excluded.payload_json
                """,
                (safe_id, name, updated, json.dumps(item)),
            )
            saved += 1
        conn.commit()
    return {"success": True, "saved": saved}


@app.delete("/api/runs/{run_id}")
def api_delete_run(run_id: str) -> Dict[str, Any]:
    safe_id = _safe_token(run_id)
    with sqlite3.connect(DB_PATH) as conn:
        conn.execute("DELETE FROM saved_runs WHERE id = ?", (safe_id,))
        conn.commit()
    return {"success": True, "deleted": safe_id}


# ---------------------------------------------------------------------------
# 2. Cross-PC Reagent Library CRUD
# ---------------------------------------------------------------------------
@app.get("/api/library")
def api_list_library() -> Dict[str, Any]:
    items: List[Dict[str, Any]] = []
    with sqlite3.connect(DB_PATH) as conn:
        for (payload_json,) in conn.execute(
            "SELECT payload_json FROM reagent_library ORDER BY name COLLATE NOCASE ASC"
        ):
            try:
                items.append(json.loads(payload_json))
            except Exception:
                continue
    return {"success": True, "items": items}


@app.put("/api/library/{item_id}")
async def api_put_library_item(item_id: str, request: Request) -> Dict[str, Any]:
    safe_id = _safe_token(item_id)
    body = await request.json()
    if not isinstance(body, dict):
        raise HTTPException(status_code=400, detail="Library item must be a JSON object")
    body["id"] = safe_id
    name = str(body.get("name") or "Unnamed reagent")
    updated = int(datetime.now(timezone.utc).timestamp() * 1000)

    with sqlite3.connect(DB_PATH) as conn:
        conn.execute(
            """
            INSERT INTO reagent_library (id, name, updated, payload_json)
            VALUES (?, ?, ?, ?)
            ON CONFLICT(id) DO UPDATE SET
                name=excluded.name,
                updated=excluded.updated,
                payload_json=excluded.payload_json
            """,
            (safe_id, name, updated, json.dumps(body)),
        )
        conn.commit()
    return {"success": True, "id": safe_id}


@app.post("/api/library/bulk")
def api_bulk_put_library(req: BulkLibraryRequest) -> Dict[str, Any]:
    saved = 0
    now = int(datetime.now(timezone.utc).timestamp() * 1000)
    with sqlite3.connect(DB_PATH) as conn:
        for item in req.items:
            if not isinstance(item, dict) or not item.get("id"):
                continue
            safe_id = _safe_token(str(item["id"]))
            name = str(item.get("name") or "Unnamed reagent")
            conn.execute(
                """
                INSERT INTO reagent_library (id, name, updated, payload_json)
                VALUES (?, ?, ?, ?)
                ON CONFLICT(id) DO UPDATE SET
                    name=excluded.name,
                    updated=excluded.updated,
                    payload_json=excluded.payload_json
                """,
                (safe_id, name, now, json.dumps(item)),
            )
            saved += 1
        conn.commit()
    return {"success": True, "saved": saved}


@app.delete("/api/library/{item_id}")
def api_delete_library_item(item_id: str) -> Dict[str, Any]:
    safe_id = _safe_token(item_id)
    with sqlite3.connect(DB_PATH) as conn:
        conn.execute("DELETE FROM reagent_library WHERE id = ?", (safe_id,))
        conn.commit()
    return {"success": True, "deleted": safe_id}


# ---------------------------------------------------------------------------
# 3. High-Res TLC Plate Image Disk Storage (Sync across PCs)
# ---------------------------------------------------------------------------
@app.put("/api/tlc-images/{uid}/{img_key}")
async def api_put_tlc_image(
    uid: str,
    img_key: str,
    file: UploadFile = File(...),
    name: str = Form("plate.png"),
) -> Dict[str, Any]:
    safe_uid = _safe_token(uid)
    safe_key = _safe_token(img_key)
    raw_bytes = await file.read()
    if len(raw_bytes) > 60 * 1024 * 1024:
        raise HTTPException(status_code=413, detail="TLC image too large (>60 MB)")

    ext = Path(name).suffix.lower()
    if ext not in {".png", ".jpg", ".jpeg", ".webp", ".tif", ".tiff", ".npy", ".bin"}:
        ext = ".bin"
    rel_path = f"{safe_uid}/{safe_key}{ext}"
    target = (TLC_IMG_DIR / rel_path).resolve()
    if not str(target).startswith(str(TLC_IMG_DIR.resolve())):
        raise HTTPException(status_code=400, detail="Invalid path")
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_bytes(raw_bytes)

    now = int(datetime.now(timezone.utc).timestamp() * 1000)
    content_type = file.content_type or "application/octet-stream"
    with sqlite3.connect(DB_PATH) as conn:
        conn.execute(
            """
            INSERT INTO tlc_image_meta (uid, img_key, filename, content_type, disk_relpath, updated)
            VALUES (?, ?, ?, ?, ?, ?)
            ON CONFLICT(uid, img_key) DO UPDATE SET
                filename=excluded.filename,
                content_type=excluded.content_type,
                disk_relpath=excluded.disk_relpath,
                updated=excluded.updated
            """,
            (safe_uid, safe_key, name[:200], content_type, rel_path, now),
        )
        conn.commit()
    return {"success": True, "uid": safe_uid, "key": safe_key, "bytes": len(raw_bytes)}


@app.get("/api/tlc-images/{uid}/{img_key}")
def api_get_tlc_image(uid: str, img_key: str) -> FileResponse:
    safe_uid = _safe_token(uid)
    safe_key = _safe_token(img_key)
    with sqlite3.connect(DB_PATH) as conn:
        row = conn.execute(
            "SELECT filename, content_type, disk_relpath FROM tlc_image_meta WHERE uid = ? AND img_key = ?",
            (safe_uid, safe_key),
        ).fetchone()
    if not row:
        raise HTTPException(status_code=404, detail="Image not found")
    filename, content_type, rel_path = row
    target = (TLC_IMG_DIR / rel_path).resolve()
    if not str(target).startswith(str(TLC_IMG_DIR.resolve())) or not target.exists():
        raise HTTPException(status_code=404, detail="Image file missing on disk")
    return FileResponse(
        path=str(target),
        media_type=content_type or "application/octet-stream",
        headers={"X-Robowski-Filename": filename},
    )


@app.delete("/api/tlc-images/{uid}/{img_key}")
def api_delete_tlc_image(uid: str, img_key: str) -> Dict[str, Any]:
    safe_uid = _safe_token(uid)
    safe_key = _safe_token(img_key)
    with sqlite3.connect(DB_PATH) as conn:
        row = conn.execute(
            "SELECT disk_relpath FROM tlc_image_meta WHERE uid = ? AND img_key = ?",
            (safe_uid, safe_key),
        ).fetchone()
        conn.execute(
            "DELETE FROM tlc_image_meta WHERE uid = ? AND img_key = ?",
            (safe_uid, safe_key),
        )
        conn.commit()
    if row:
        target = (TLC_IMG_DIR / row[0]).resolve()
        if str(target).startswith(str(TLC_IMG_DIR.resolve())) and target.exists():
            try:
                target.unlink()
            except Exception:
                pass
    return {"success": True}


# ---------------------------------------------------------------------------
# 4. One-Click Experiment Archive Backup to Personal PC Folder
# ---------------------------------------------------------------------------
@app.post("/api/archives/save")
async def api_save_archive(
    file: UploadFile = File(...),
    runName: str = Form("robowski_run"),
    filename: str = Form("experiment.robowski"),
) -> Dict[str, Any]:
    raw_bytes = await file.read()
    if len(raw_bytes) > 200 * 1024 * 1024:
        raise HTTPException(status_code=413, detail="Archive exceeds 200 MB limit")

    today = datetime.now().strftime("%Y-%m-%d")
    safe_run = _safe_token(runName, max_len=48)
    safe_file = _safe_token(filename, max_len=120)
    folder_name = f"{today}_{safe_run}"
    rel_path = f"{folder_name}/{safe_file}"
    target = (ARCHIVE_DIR / rel_path).resolve()
    if not str(target).startswith(str(ARCHIVE_DIR.resolve())):
        raise HTTPException(status_code=400, detail="Invalid archive path")
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_bytes(raw_bytes)

    now = datetime.now(timezone.utc).isoformat()
    with sqlite3.connect(DB_PATH) as conn:
        conn.execute(
            """
            INSERT INTO saved_archives (timestamp, run_name, filename, disk_relpath, size_bytes)
            VALUES (?, ?, ?, ?, ?)
            """,
            (now, runName[:120], safe_file, rel_path, len(raw_bytes)),
        )
        conn.commit()

    return {
        "success": True,
        "savedPath": str(target),
        "relativePath": rel_path,
        "sizeBytes": len(raw_bytes),
    }


@app.get("/api/archives")
def api_list_archives() -> Dict[str, Any]:
    rows = []
    with sqlite3.connect(DB_PATH) as conn:
        for row in conn.execute(
            "SELECT id, timestamp, run_name, filename, disk_relpath, size_bytes FROM saved_archives ORDER BY id DESC LIMIT 100"
        ):
            rows.append(
                {
                    "id": row[0],
                    "timestamp": row[1],
                    "runName": row[2],
                    "filename": row[3],
                    "relativePath": row[4],
                    "sizeBytes": row[5],
                }
            )
    return {"success": True, "archives": rows}


# ---------------------------------------------------------------------------
# 5. Illustrated Excel ELN Export (with Embedded RDKit 2D Structure Drawings!)
# ---------------------------------------------------------------------------
def _smiles_to_png_stream(smiles: str, size: tuple[int, int] = (220, 140)) -> Optional[io.BytesIO]:
    if not smiles:
        return None
    mol = Chem.MolFromSmiles(smiles)
    if mol is None:
        return None
    try:
        img = Draw.MolToImage(mol, size=size)
        buf = io.BytesIO()
        img.save(buf, format="PNG")
        buf.seek(0)
        return buf
    except Exception:
        return None


@app.post("/api/export/eln-illustrated-xlsx")
def api_export_illustrated_eln(req: IllustratedElnRequest) -> Response:
    wb = Workbook()

    header_fill = PatternFill(start_color="1F4E78", end_color="1F4E78", fill_type="solid")
    header_font = Font(color="FFFFFF", bold=True, size=11)
    bold_font = Font(bold=True)

    # Sheet 1: Reagents with embedded 2D RDKit chemical structures
    ws_r = wb.active
    ws_r.title = "Reagents & Structures"
    headers = [
        "Code",
        "Name",
        "2D Structure",
        "Formula",
        "Molar Mass (g/mol)",
        "Stock (mM)",
        "Solvent",
        "SMILES",
        "Salts / Hydrates",
    ]
    ws_r.append(headers)
    for col_idx in range(1, len(headers) + 1):
        cell = ws_r.cell(row=1, column=col_idx)
        cell.fill = header_fill
        cell.font = header_font
        cell.alignment = Alignment(horizontal="center", vertical="center")
    ws_r.row_dimensions[1].height = 24

    col_widths = {1: 10, 2: 26, 3: 32, 4: 16, 5: 18, 6: 14, 7: 14, 8: 36, 9: 20}
    for col_idx, width in col_widths.items():
        ws_r.column_dimensions[ws_r.cell(row=1, column=col_idx).column_letter].width = width

    row_cursor = 2
    for rg in req.reagents:
        smi = str(rg.get("smiles") or "").strip()
        info = _standardize_smiles(smi) if smi else {"valid": False}
        formula = info.get("formula", "") if info.get("valid") else ""
        mw = rg.get("molarMass") or (info.get("molarMass") if info.get("valid") else "")
        salts = ", ".join(info.get("saltFragments") or []) if info.get("valid") else ""

        ws_r.append(
            [
                str(rg.get("code") or ""),
                str(rg.get("name") or ""),
                "",
                formula,
                mw,
                rg.get("stock", ""),
                str(rg.get("solvent") or ""),
                smi,
                salts,
            ]
        )
        for c in range(1, len(headers) + 1):
            ws_r.cell(row=row_cursor, column=c).alignment = Alignment(vertical="center", wrap_text=True)

        png_buf = _smiles_to_png_stream(smi, size=(210, 120))
        if png_buf is not None:
            ws_r.row_dimensions[row_cursor].height = 96
            xl_img = XLImage(png_buf)
            xl_img.width = 210
            xl_img.height = 120
            ws_r.add_image(xl_img, f"C{row_cursor}")
        else:
            ws_r.row_dimensions[row_cursor].height = 24
        row_cursor += 1

    # Sheet 2: Run Summary & Conditions
    ws_s = wb.create_sheet("Run Conditions")
    ws_s.append(["Field", "Value"])
    ws_s.cell(row=1, column=1).fill = header_fill
    ws_s.cell(row=1, column=1).font = header_font
    ws_s.cell(row=1, column=2).fill = header_fill
    ws_s.cell(row=1, column=2).font = header_font
    ws_s.column_dimensions["A"].width = 26
    ws_s.column_dimensions["B"].width = 48

    summary_rows = [
        ("Run Name", req.runName),
        ("Date", req.date or datetime.now().strftime("%Y-%m-%d")),
        ("Hood", req.hood),
        ("Design Mode", req.mode),
    ]
    for k, v in (req.conditions or {}).items():
        summary_rows.append((str(k), str(v)))
    for k, v in summary_rows:
        ws_s.append([k, v])
        ws_s.cell(row=ws_s.max_row, column=1).font = bold_font

    # Sheet 3: Well Observations (ELN)
    ws_o = wb.create_sheet("Well Observations (ELN)")
    obs_headers = ["Plate", "Well", "Outcome", "Tags", "TLC Rf / Notes", "Components"]
    ws_o.append(obs_headers)
    for col_idx in range(1, len(obs_headers) + 1):
        cell = ws_o.cell(row=1, column=col_idx)
        cell.fill = header_fill
        cell.font = header_font
    for col_idx, w in [(1, 10), (2, 10), (3, 18), (4, 24), (5, 38), (6, 42)]:
        ws_o.column_dimensions[ws_o.cell(row=1, column=col_idx).column_letter].width = w

    for ob in req.observations:
        tags = ob.get("tags")
        tags_str = ", ".join(tags) if isinstance(tags, list) else str(tags or "")
        ws_o.append(
            [
                ob.get("plate", 1),
                str(ob.get("well") or ""),
                str(ob.get("outcome") or ""),
                tags_str,
                str(ob.get("notes") or ""),
                str(ob.get("components") or ""),
            ]
        )

    out_buf = io.BytesIO()
    wb.save(out_buf)
    out_buf.seek(0)
    safe_name = _safe_token(req.runName, max_len=48)
    date_part = req.date or datetime.now().strftime("%Y-%m-%d")
    dl_name = f"{safe_name}_ELN_Illustrated_{date_part}.xlsx"

    return Response(
        content=out_buf.getvalue(),
        media_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        headers={"Content-Disposition": f'attachment; filename="{dl_name}"'},
    )


# ---------------------------------------------------------------------------
# 6. Chemistry Intelligence (Setup Reagent Check + 3D Reaction Predictor)
# ---------------------------------------------------------------------------
@app.post("/api/chemistry/inspect-reagent")
def api_inspect_reagent(req: InspectReagentRequest) -> Dict[str, Any]:
    std = _standardize_smiles(req.smiles)
    if not std.get("valid"):
        return {"success": False, "error": std.get("error", "Invalid SMILES")}
    return {"success": True, **std}


@app.post("/api/chemistry/standardize")
def api_standardize(req: StandardizeRequest) -> Dict[str, Any]:
    if len(req.smiles) > 200:
        raise HTTPException(status_code=400, detail="Maximum 200 SMILES per batch.")
    results = [_standardize_smiles(s) for s in req.smiles]
    return {"success": True, "results": results}


@app.post("/api/chemistry/refine-well")
def api_refine_well(req: RefineWellRequest) -> Dict[str, Any]:
    tlc_stats = _get_tlc_rule_stats()
    refined = _refine_single_well(req.wellResult, tlc_stats)
    return {"success": True, "result": refined}


@app.post("/api/chemistry/refine-plate")
def api_refine_plate(req: RefinePlateRequest) -> Dict[str, Any]:
    if len(req.wellResults) > 54:
        raise HTTPException(status_code=400, detail="Maximum 54 wells per plate request.")
    tlc_stats = _get_tlc_rule_stats()

    items = list(req.wellResults.items())
    futures = {
        key: _EXECUTOR.submit(_refine_single_well, well_res, tlc_stats)
        for key, well_res in items
    }
    results = {key: fut.result() for key, fut in futures.items()}
    return {"success": True, "results": results}


@app.post("/api/chemistry/charges")
def api_charges(req: StandardizeRequest) -> Dict[str, Any]:
    if len(req.smiles) > 100:
        raise HTTPException(status_code=400, detail="Maximum 100 SMILES per request.")
    return {"success": True, "results": [_compute_gasteiger_extrema(s) for s in req.smiles]}


# ---------------------------------------------------------------------------
# 7. TLC Photo Illumination Flattening (NumPy + Pillow)
# ---------------------------------------------------------------------------
@app.post("/api/tlc/enhance-plate")
async def api_enhance_tlc_plate(file: UploadFile = File(...)) -> Response:
    raw = await file.read()
    if len(raw) > 40 * 1024 * 1024:
        raise HTTPException(status_code=413, detail="Image too large (>40 MB)")
    try:
        img = Image.open(io.BytesIO(raw)).convert("RGB")
    except Exception:
        raise HTTPException(status_code=400, detail="Unsupported image format")

    # Estimate smooth lighting/vignette background via large Gaussian blur and divide it out
    blur_radius = max(12, min(img.width, img.height) // 18)
    bg = img.filter(ImageFilter.GaussianBlur(radius=blur_radius))

    arr = np.asarray(img, dtype=np.float32)
    bg_arr = np.maximum(np.asarray(bg, dtype=np.float32), 18.0)
    median_bg = np.median(bg_arr, axis=(0, 1), keepdims=True)
    flat = (arr / bg_arr) * median_bg

    # Gentle percentile contrast stretch (1st to 99.2th percentile) to make faint spots crisp
    lo = np.percentile(flat, 1.0)
    hi = np.percentile(flat, 99.2)
    if hi > lo + 1.0:
        flat = (flat - lo) / (hi - lo) * 255.0
    out_arr = np.clip(flat, 0, 255).astype(np.uint8)

    out_img = Image.fromarray(out_arr, mode="RGB")
    buf = io.BytesIO()
    out_img.save(buf, format="PNG")
    return Response(content=buf.getvalue(), media_type="image/png")


# ---------------------------------------------------------------------------
# 8. Permanent TLC Feedback Memory (SQLite)
# ---------------------------------------------------------------------------
@app.get("/api/tlc/feedback")
def api_get_tlc_feedback() -> Dict[str, Any]:
    counts = _counts_summary()
    return {
        "success": True,
        "totalObservations": counts["tlcObservations"],
        "ruleStats": _get_tlc_rule_stats(),
    }


@app.post("/api/tlc/feedback")
def api_post_tlc_feedback(req: TlcFeedbackRequest) -> Dict[str, Any]:
    now = datetime.now(timezone.utc).isoformat()
    with sqlite3.connect(DB_PATH) as conn:
        conn.execute(
            """
            INSERT INTO tlc_feedback
                (timestamp, well_key, rule_ids_json, observed_new_spot, solvent_system, measured_rf, substrates_json, notes)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                now,
                req.wellKey,
                json.dumps(req.ruleIds[:12]),
                1 if req.observedNewSpot else 0,
                req.solventSystem,
                req.measuredRf,
                json.dumps(req.substrates) if req.substrates else None,
                req.notes,
            ),
        )
        conn.commit()
    return {
        "success": True,
        "totalObservations": _counts_summary()["tlcObservations"],
        "ruleStats": _get_tlc_rule_stats(),
    }


@app.get("/api/tlc/export.csv", response_class=PlainTextResponse)
def api_export_tlc_csv() -> str:
    buf = io.StringIO()
    writer = csv.writer(buf)
    writer.writerow(
        ["id", "timestamp", "well_key", "observed_new_spot", "rule_ids", "solvent_system", "measured_rf", "notes"]
    )
    with sqlite3.connect(DB_PATH) as conn:
        for row in conn.execute(
            "SELECT id, timestamp, well_key, observed_new_spot, rule_ids_json, solvent_system, measured_rf, notes FROM tlc_feedback ORDER BY id DESC"
        ):
            writer.writerow(row)
    return buf.getvalue()


# ---------------------------------------------------------------------------
# 9. Live Robot Status Monitor, Excel Progress & Safe Hardware Command Bridge
# ---------------------------------------------------------------------------
ROBOT_NAME = os.environ.get("PIPETTER_NAME", "Robowski#2").strip() or "Robowski#2"
ROBOCHEM_DATA_ENV = os.environ.get("ROBOCHEM_DATA_PATH", "").strip()
ROBOWSKI_REPO_ENV = os.environ.get("ROBOWSKI_REPO_PATH", "").strip()
ROBOWSKI_STATUS_ENV = os.environ.get("ROBOWSKI_STATUS_PATH", "").strip()
ROBOWSKI_LOG_ENV = os.environ.get("ROBOWSKI_LOG_PATH", "").strip()
ROBOWSKI_ENABLE_HARDWARE = os.environ.get("ROBOWSKI_ENABLE_HARDWARE", "0").strip().lower() in {
    "1",
    "true",
    "yes",
    "on",
}
ROBOWSKI_CONTROL_PIN = os.environ.get("ROBOWSKI_CONTROL_PIN", "").strip()

_BOTTLE_BOTTOM_Z = 2180.0
_BOTTLE_AREA_MM2 = (24.6 ** 2) * 3.14 / 4.0  # 475.0506 mm^2 (breadboard.py)
_JAR_BOTTOM_Z = 2120.0
_JAR_AREA_MM2 = 2122.0

try:
    ROBOWSKI_IDLE_RELEASE_SEC = max(0, int(os.environ.get("ROBOWSKI_IDLE_RELEASE_SEC", "300").strip() or "300"))
except ValueError:
    ROBOWSKI_IDLE_RELEASE_SEC = 300

_ALLOWED_SOLVENTS = {
    "water",
    "ethanol",
    "DMF",
    "Dioxane",
    "DCE",
    "MeCN",
    "CHCl3",
    "DMSO",
    "glycerin",
    "TolueneMix",
    "serum",
    "hbrhac1v1",
    "waterft",
    "ethanolft",
}

_FALLBACK_LIQUID_CLASS: Dict[tuple[str, str], int] = {
    ("water", "50ul"): 0, ("water", "300ul"): 1, ("water", "1000ul"): 2,
    ("ethanol", "50ul"): 12, ("ethanol", "300ul"): 13, ("ethanol", "1000ul"): 14,
    ("glycerin", "50ul"): 15, ("glycerin", "300ul"): 16, ("glycerin", "1000ul"): 17,
    ("DMF", "50ul"): 24, ("DMF", "300ul"): 22, ("DMF", "1000ul"): 23,
    ("Dioxane", "50ul"): 27, ("Dioxane", "300ul"): 28, ("Dioxane", "1000ul"): 29,
    ("hbrhac1v1", "50ul"): 31, ("hbrhac1v1", "300ul"): 31, ("hbrhac1v1", "1000ul"): 31,
    ("DCE", "50ul"): 36, ("DCE", "300ul"): 37, ("DCE", "1000ul"): 38,
    ("MeCN", "50ul"): 39, ("MeCN", "300ul"): 40, ("MeCN", "1000ul"): 41,
    ("CHCl3", "50ul"): 12, ("CHCl3", "300ul"): 13, ("CHCl3", "1000ul"): 14,
    ("DMSO", "50ul"): 0, ("DMSO", "300ul"): 1, ("DMSO", "1000ul"): 2,
    ("TolueneMix", "50ul"): 46, ("TolueneMix", "300ul"): 47, ("TolueneMix", "1000ul"): 48,
    ("serum", "50ul"): 6, ("serum", "300ul"): 7, ("serum", "1000ul"): 8,
    ("waterft", "50ul"): 40, ("waterft", "300ul"): 41, ("waterft", "1000ul"): 42,
    ("ethanolft", "50ul"): 43, ("ethanolft", "300ul"): 44, ("ethanolft", "1000ul"): 45,
}

_LONG_ROBOT_COMMANDS = {
    "nanodrop_wash_cycle",
    "nanodrop_flush",
    "nanodrop_dry",
    "single_transfer",
}

_ROBOT_HW_LOCK = threading.Lock()
_PLATE_TRANSFER_STOP = threading.Event()
_ROBOT_HW: Dict[str, Any] = {
    "zm": None,
    "gt": None,
    "pt": None,
    "brb": None,
    "nd": None,
    "connected": False,
    "nanodropConnected": False,
    "nanodropId": "nd_2000c",
    "nanodropLidClosed": True,
    "busy": False,
    "currentTip": "",
    "currentPosition": "Unknown",
    "currentXY": None,
    "currentZ": None,
    "lastCommand": None,
    "lastCommandAt": None,
    "lastActivityMono": 0.0,
    "lastError": None,
    "plateTransfer": None,
}

_WELL_ROW_LETTERS = "ABCDEFGHIJKLMNOP"
_MAX_CUSTOM_PRESETS = 50
_CUSTOM_PLATES_PATH = DATA_DIR / "custom_plates.json"


def _format_well_name(well_idx: int, cols: int) -> str:
    safe_cols = max(1, int(cols))
    r = well_idx // safe_cols
    c = (well_idx % safe_cols) + 1
    row_lbl = _WELL_ROW_LETTERS[r] if 0 <= r < len(_WELL_ROW_LETTERS) else f"R{r + 1}"
    return f"{row_lbl}{c}"


def _parse_xy_pair(raw: Any, label: str) -> List[float]:
    if not isinstance(raw, (list, tuple)) or len(raw) != 2:
        raise HTTPException(status_code=400, detail=f"{label} must be an [X, Y] coordinate pair in mm.")
    try:
        x = float(raw[0])
        y = float(raw[1])
    except Exception:
        raise HTTPException(status_code=400, detail=f"{label} must contain valid numbers.")
    if not (math.isfinite(x) and math.isfinite(y)):
        raise HTTPException(status_code=400, detail=f"{label} must contain finite numbers.")
    if not (-600.0 <= x <= 600.0 and -600.0 <= y <= 600.0):
        raise HTTPException(status_code=400, detail=f"{label} ({x}, {y}) is outside safe deck bounds (-600 to 600 mm).")
    return [round(x, 3), round(y, 3)]


def _normalize_plate_preset_input(raw: Dict[str, Any]) -> Dict[str, Any]:
    name = str(raw.get("name", "")).strip()
    if not name or len(name) > 60:
        raise HTTPException(status_code=400, detail="Preset name must be between 1 and 60 characters.")
    try:
        plate_slot = int(raw.get("plate_slot", raw.get("plateSlot", 0)))
        rows = int(raw.get("rows", 8))
        cols = int(raw.get("cols", 12))
        default_z = int(raw.get("default_z", raw.get("defaultZ", 1900)))
    except Exception:
        raise HTTPException(status_code=400, detail="plate_slot, rows, cols, and default_z must be integers.")
    if plate_slot not in {0, 1, 2}:
        raise HTTPException(status_code=400, detail="plate_slot must be 0, 1, or 2.")
    if not (1 <= rows <= 16 and 1 <= cols <= 24) or (rows * cols > 384):
        raise HTTPException(status_code=400, detail="Grid dimensions must be 1–16 rows × 1–24 columns (max 384 wells).")
    if not (880 <= default_z <= 2190):
        raise HTTPException(status_code=400, detail="default_z must be between 880 and 2190.")
    a1 = _parse_xy_pair(raw.get("corner_a1", raw.get("cornerA1")), "Corner A1")
    tr = _parse_xy_pair(raw.get("corner_top_right", raw.get("cornerTopRight")), "Top-Right corner")
    bl = _parse_xy_pair(raw.get("corner_bottom_left", raw.get("cornerBottomLeft")), "Bottom-Left corner")

    col_pitch = 0.0
    if cols > 1:
        col_pitch = math.hypot(tr[0] - a1[0], tr[1] - a1[1]) / float(cols - 1)
        if not (2.0 <= col_pitch <= 80.0):
            raise HTTPException(
                status_code=400,
                detail=f"Detected column spacing ({col_pitch:.2f} mm) is outside the safe 2–80 mm range.",
            )
    row_pitch = 0.0
    if rows > 1:
        row_pitch = math.hypot(bl[0] - a1[0], bl[1] - a1[1]) / float(rows - 1)
        if not (2.0 <= row_pitch <= 80.0):
            raise HTTPException(
                status_code=400,
                detail=f"Detected row spacing ({row_pitch:.2f} mm) is outside the safe 2–80 mm range.",
            )

    angle_deg = 0.0
    if cols > 1:
        dx, dy = tr[0] - a1[0], tr[1] - a1[1]
        angle_deg = math.degrees(math.atan2(dy, abs(dx))) if abs(dx) >= abs(dy) else math.degrees(math.atan2(dx, abs(dy)))

    raw_id = str(raw.get("id", "")).strip()
    if raw_id:
        slug = re.sub(r"[^a-zA-Z0-9_-]", "_", raw_id)[:64]
    else:
        base = re.sub(r"[^a-zA-Z0-9]+", "_", name.lower()).strip("_")[:36] or "plate"
        slug = f"p{plate_slot}_{rows}x{cols}_{base}"
    if not slug or slug == "default_54":
        slug = f"p{plate_slot}_{rows}x{cols}_custom"

    return {
        "id": slug,
        "name": name,
        "plateSlot": plate_slot,
        "rows": rows,
        "cols": cols,
        "cornerA1": a1,
        "cornerTopRight": tr,
        "cornerBottomLeft": bl,
        "defaultZ": default_z,
        "colPitchMm": round(col_pitch, 3),
        "rowPitchMm": round(row_pitch, 3),
        "angleDeg": round(angle_deg, 2),
        "updatedAt": datetime.now(timezone.utc).isoformat(),
    }


def _load_local_plate_presets() -> List[Dict[str, Any]]:
    if not _CUSTOM_PLATES_PATH.exists() or not _CUSTOM_PLATES_PATH.is_file():
        return []
    try:
        raw = json.loads(_CUSTOM_PLATES_PATH.read_text(encoding="utf-8"))
        items = raw.get("presets", []) if isinstance(raw, dict) else (raw if isinstance(raw, list) else [])
        return [it for it in items if isinstance(it, dict) and it.get("id") and it.get("cornerA1")]
    except Exception:
        return []


def _save_local_plate_presets(presets: List[Dict[str, Any]]) -> None:
    _CUSTOM_PLATES_PATH.write_text(
        json.dumps({"version": 1, "presets": presets[:_MAX_CUSTOM_PRESETS]}, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )


def _get_local_preset(preset_id: str) -> Optional[Dict[str, Any]]:
    pid = (preset_id or "").strip()
    if not pid or pid == "default_54":
        return None
    for p in _load_local_plate_presets():
        if p.get("id") == pid:
            return p
    return None


def _compute_preset_well_xy(preset: Dict[str, Any], well_idx: int) -> Tuple[float, float]:
    rows = int(preset["rows"])
    cols = int(preset["cols"])
    if not (0 <= well_idx < rows * cols):
        raise RuntimeError(f"Well index {well_idx} is out of range for {rows}×{cols} plate.")
    r = well_idx // cols
    c = well_idx % cols
    a1 = preset["cornerA1"]
    tr = preset["cornerTopRight"]
    bl = preset["cornerBottomLeft"]
    u = float(c) / float(cols - 1) if cols > 1 else 0.0
    v = float(r) / float(rows - 1) if rows > 1 else 0.0
    x = float(a1[0]) + u * (float(tr[0]) - float(a1[0])) + v * (float(bl[0]) - float(a1[0]))
    y = float(a1[1]) + u * (float(tr[1]) - float(a1[1])) + v * (float(bl[1]) - float(a1[1]))
    return (round(x, 3), round(y, 3))


def _resolve_local_plate_container(
    brb: Any, plate_id: int, slot_id: int, preset_id: str = ""
) -> Tuple[Any, str, int, int, str]:
    pid = (preset_id or "").strip()
    if plate_id <= 2 and pid and pid != "default_54":
        preset = _get_local_preset(pid)
        if preset is None:
            raise RuntimeError(f"Plate preset '{pid}' was not found.")
        if int(preset.get("plateSlot", -1)) != plate_id:
            raise RuntimeError(f"Preset '{preset['name']}' is for plate{preset['plateSlot']}, not plate{plate_id}.")
        xy = _compute_preset_well_xy(preset, slot_id)
        c = copy.deepcopy(brb.plate_list[plate_id].containers[0])
        orig_xy = getattr(c, "xy", None)
        c.xy = [xy[0], xy[1]] if isinstance(orig_xy, list) else (xy[0], xy[1])
        return (c, f"{_format_well_name(slot_id, int(preset['cols']))} (#{slot_id})", int(preset["rows"]), int(preset["cols"]), str(preset["name"]))
    max_c = 53 if plate_id <= 2 else (7 if plate_id <= 5 else 1)
    if not (0 <= slot_id <= max_c):
        raise RuntimeError(f"Slot {slot_id} out of range for plate{plate_id}.")
    c = copy.deepcopy(brb.plate_list[plate_id].containers[slot_id])
    if plate_id <= 2:
        return (c, f"{_format_well_name(slot_id, 9)} (#{slot_id})", 6, 9, "54-vial (6×9)")
    return (c, f"pos {slot_id}", 1, max_c + 1, f"plate{plate_id}")


def _read_local_gantry_xy(gt: Any) -> Optional[List[float]]:
    if gt is not None:
        for meth_name in ("get_xy", "get_position", "get_current_xy"):
            fn = getattr(gt, meth_name, None)
            if callable(fn):
                try:
                    val = fn()
                    if isinstance(val, (list, tuple)) and len(val) >= 2:
                        x, y = float(val[0]), float(val[1])
                        if math.isfinite(x) and math.isfinite(y):
                            res = [round(x, 3), round(y, 3)]
                            _ROBOT_HW["currentXY"] = res
                            return res
                except Exception:
                    pass
        for attr_name in ("current_xy", "xy", "pos", "position", "current_pos"):
            val = getattr(gt, attr_name, None)
            if isinstance(val, (list, tuple)) and len(val) >= 2:
                try:
                    x, y = float(val[0]), float(val[1])
                    if math.isfinite(x) and math.isfinite(y):
                        res = [round(x, 3), round(y, 3)]
                        _ROBOT_HW["currentXY"] = res
                        return res
                except Exception:
                    pass
    cur = _ROBOT_HW.get("currentXY")
    if isinstance(cur, list) and len(cur) == 2:
        return [round(float(cur[0]), 3), round(float(cur[1]), 3)]
    return None

# Remote Robot PC Relay (allows tiny robot_pc_agent.py on the robot PC to push live status
# to this personal PC backend without installing Tailscale on the robot PC)
ROBOWSKI_RELAY_TOKEN = os.environ.get("ROBOWSKI_RELAY_TOKEN", "").strip()
_RELAY_LOCK = threading.Lock()
_RELAY_STATE: Dict[str, Any] = {
    "status": None,
    "pushedAt": 0.0,
    "requestedRunPath": None,
    "pendingCommand": None,  # {"id": str, "command": str, "params": dict, "createdAt": float}
    "waiters": {},           # command_id -> {"event": threading.Event, "result": dict | None}
}


def _get_robot_data_dir() -> Optional[Path]:
    if not ROBOCHEM_DATA_ENV:
        return None
    p = Path(ROBOCHEM_DATA_ENV).expanduser()
    return p.resolve() if p.exists() and p.is_dir() else None


def _get_pipetter_files_dir() -> Optional[Path]:
    candidates: List[Path] = []
    if ROBOWSKI_STATUS_ENV:
        candidates.append(Path(ROBOWSKI_STATUS_ENV).expanduser())
    data_dir = _get_robot_data_dir()
    if data_dir is not None:
        candidates.append(data_dir / "pipetter_files")
        candidates.append(data_dir.parent / "pipetter_files")
    if ROBOWSKI_REPO_ENV:
        repo = Path(ROBOWSKI_REPO_ENV).expanduser()
        candidates.append(repo / "pipetter_files")
        candidates.append(repo / "zeus-pipetter")
    for cand in candidates:
        if cand.exists() and cand.is_dir():
            return cand.resolve()
    return None


def _find_robot_log_file() -> Optional[Path]:
    if ROBOWSKI_LOG_ENV:
        p = Path(ROBOWSKI_LOG_ENV).expanduser()
        if p.exists() and p.is_file():
            return p.resolve()
    pf = _get_pipetter_files_dir()
    if pf is None:
        return None
    preferred = [pf / "main_roboski2.log", pf / "main_roboski1.log", pf / "main.log"]
    for cand in preferred:
        if cand.exists() and cand.is_file():
            return cand.resolve()
    logs = sorted(pf.glob("*.log"), key=lambda x: x.stat().st_mtime, reverse=True)
    return logs[0].resolve() if logs else None


def _find_tip_rack_json() -> Optional[Path]:
    pf = _get_pipetter_files_dir()
    sub = "roboski1" if "1" in ROBOT_NAME else "roboski2"
    other = "roboski2" if sub == "roboski1" else "roboski1"
    if pf is not None:
        for cand in (pf / sub / "tip_rack.json", pf / "tip_rack.json", pf / other / "tip_rack.json"):
            if cand.exists() and cand.is_file():
                return cand.resolve()
    if ROBOWSKI_REPO_ENV:
        cand = Path(ROBOWSKI_REPO_ENV).expanduser() / "zeus-pipetter" / "tip_rack.json"
        if cand.exists() and cand.is_file():
            return cand.resolve()
    return None


def _read_tip_racks() -> List[Dict[str, Any]]:
    path = _find_tip_rack_json()
    if path is None:
        return []
    try:
        data = json.loads(path.read_text(encoding="utf-8", errors="replace"))
    except Exception:
        return []
    out: List[Dict[str, Any]] = []
    for tip_type in ("50ul", "300ul", "1000ul"):
        rack = data.get(tip_type)
        if not isinstance(rack, dict):
            continue
        tips = rack.get("tips")
        if not isinstance(tips, list):
            continue
        total = len(tips)
        remaining = sum(1 for item in tips if isinstance(item, dict) and item.get("exists") is True)
        out.append(
            {
                "tipType": tip_type,
                "remaining": remaining,
                "total": total,
                "used": max(0, total - remaining),
            }
        )
    return out


def _translate_log_line(raw: str) -> Dict[str, Any]:
    line = raw.strip()
    ts_match = re.match(r"^(\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}:\d{2})", line)
    timestamp = ts_match.group(1) if ts_match else ""
    lower = line.lower()

    level = "info"
    if any(tok in lower for tok in ("error", "zeuserror", "traceback", "exception", "failed")):
        level = "error"
    elif any(tok in lower for tok in ("warning", "empty", "reload", "short")):
        level = "warning"

    summary = line
    if "tip rack is empty" in lower or "beep_for_tip_changing" in lower:
        summary = "Tip rack is empty — waiting for you to reload a fresh rack"
        level = "warning"
    elif "gantry is homing" in lower:
        summary = "Moving pipetter arm back to home position"
    elif "gantry is homed" in lower:
        summary = "Pipetter arm homed and ready at (0, 0)"
    elif "now the tip on zeus is" in lower:
        m = re.search(r"(\d+ul)", line, re.IGNORECASE)
        summary = f"Picked up a fresh {m.group(1).replace('ul', ' µL')} tip" if m else "Picked up a fresh pipette tip"
    elif "prewetting tip with" in lower:
        m = re.search(r"prewetting tip with\s+([\d.]+)ul of\s+([^,]+)", line, re.IGNORECASE)
        summary = (
            f"Pre-wetting tip with {m.group(1)} µL of {m.group(2).strip()}"
            if m
            else "Pre-wetting new tip in stock bottle"
        )
    elif "prewet done" in lower:
        summary = "Tip pre-wet finished — continuing pipetting"
    elif "first dilution step" in lower and "done" in lower:
        m = re.search(r"step\s+(\d+)", lower)
        summary = f"Finished Plate A → B dilution step {int(m.group(1)) + 1 if m else ''}".strip()
    elif "second dilution step" in lower and "done" in lower:
        m = re.search(r"step\s+(\d+)", lower)
        summary = f"Finished Plate B → C dilution step {int(m.group(1)) + 1 if m else ''}".strip()
    elif "all dilution(s) are done" in lower or "all dilutions are done" in lower:
        summary = "All post-reaction plate dilutions are complete"
    elif "all reactions are done" in lower or "all events are completed" in lower:
        summary = "Run complete — all planned pipetting steps finished"
    elif "initial liquid level of the stock solutions from" in lower:
        m = re.search(r"from:\s*(.+)$", line, re.IGNORECASE)
        src = m.group(1).strip() if m else "volume"
        summary = f"Calculated starting liquid heights ({src})"
    elif "zeus is loaded" in lower:
        summary = "Connected to Zeus pipetting head"
    elif "pipetter is loaded" in lower:
        summary = "Connected to robot pipetter and ready"
    elif "zeuserror" in lower or "valueerror" in lower:
        summary = f"Robot stopped with an error: {line.split(':', 2)[-1].strip()[:140]}"
        level = "error"
    else:
        # Clean standard logger prefix "YYYY-MM-DD HH:MM:SS,mmm - name - LEVEL - message"
        parts = line.split(" - ")
        if len(parts) >= 4:
            summary = " - ".join(parts[3:]).strip()

    return {
        "timestamp": timestamp,
        "level": level,
        "summary": summary[:220],
        "raw": line[:400],
    }


def _tail_log_lines(log_path: Path, max_lines: int = 80) -> List[str]:
    try:
        size = log_path.stat().st_size
        read_size = min(size, 64 * 1024)
        with log_path.open("rb") as f:
            if size > read_size:
                f.seek(size - read_size)
            chunk = f.read().decode("utf-8", errors="replace")
        lines = [ln for ln in chunk.splitlines() if ln.strip()]
        return lines[-max_lines:]
    except Exception:
        return []


def _list_recent_robot_runs(data_dir: Path, limit: int = 25) -> List[Dict[str, Any]]:
    found: List[tuple[float, Path]] = []
    try:
        for p in data_dir.rglob("*.xlsx"):
            if p.name.startswith("~$"):
                continue
            try:
                found.append((p.stat().st_mtime, p))
            except OSError:
                continue
    except Exception:
        return []
    found.sort(key=lambda pair: pair[0], reverse=True)
    out: List[Dict[str, Any]] = []
    for mtime, p in found[:limit]:
        try:
            rel = str(p.resolve().relative_to(data_dir.resolve())).replace("\\", "/")
        except Exception:
            continue
        out.append(
            {
                "fileName": p.name,
                "relativePath": rel,
                "updatedIso": datetime.fromtimestamp(mtime, tz=timezone.utc).isoformat(),
            }
        )
    return out


def _resolve_confined_run_xlsx(data_dir: Path, rel_path: str) -> Path:
    if not rel_path or not rel_path.lower().endswith(".xlsx"):
        raise HTTPException(status_code=400, detail="Invalid run file path")
    base = data_dir.resolve()
    target = (base / rel_path).resolve()
    if not str(target).startswith(str(base) + os.sep) or not target.exists() or not target.is_file():
        raise HTTPException(status_code=404, detail="Run Excel file not found inside ROBOCHEM_DATA_PATH")
    return target


def _parse_robot_run_xlsx(xlsx_path: Path, data_dir: Path) -> Optional[Dict[str, Any]]:
    try:
        wb = load_workbook(xlsx_path, read_only=True, data_only=True)
    except Exception:
        return None
    try:
        if "reactions_with_run_info" not in wb.sheetnames:
            return None
        ws_rx = wb["reactions_with_run_info"]
        rx_rows = list(ws_rx.iter_rows(values_only=True))
        if len(rx_rows) < 2:
            return None

        headers = [str(c or "").strip() for c in rx_rows[0]]
        col_idx = {h: i for i, h in enumerate(headers)}
        vol_substances = [h[4:].strip() for h in headers if h.startswith("vol#")]

        status_col = col_idx.get("status")
        full_status_col = col_idx.get("full_status")
        barcode_col = col_idx.get("plate_barcode")
        dil_barcode_col = col_idx.get("plate_barcodes_for_dilution")
        dur_col = col_idx.get("reaction_duration")

        total_vials = 0
        completed_vials = 0
        in_progress_vials = 0
        not_started_vials = 0
        well_states: List[str] = []
        sub_done: Dict[str, int] = {s: 0 for s in vol_substances}
        sub_total: Dict[str, int] = {s: 0 for s in vol_substances}
        plate_barcode: Optional[str] = None
        dilution_barcodes: List[str] = []
        reaction_duration: Optional[float] = None

        for row in rx_rows[1:]:
            if not row or all(v is None or str(v).strip() == "" for v in row):
                continue
            total_vials += 1

            if plate_barcode is None and barcode_col is not None and barcode_col < len(row) and row[barcode_col] not in (None, ""):
                plate_barcode = str(row[barcode_col])
            if not dilution_barcodes and dil_barcode_col is not None and dil_barcode_col < len(row) and row[dil_barcode_col] not in (None, ""):
                raw_db = str(row[dil_barcode_col]).strip()
                if raw_db:
                    dilution_barcodes = [x.strip(" []'\"") for x in raw_db.split(",") if x.strip(" []'\"")]
            if reaction_duration is None and dur_col is not None and dur_col < len(row):
                try:
                    if row[dur_col] not in (None, ""):
                        reaction_duration = float(row[dur_col])
                except Exception:
                    pass

            for sub in vol_substances:
                ci = col_idx.get(f"vol#{sub}")
                try:
                    if ci is not None and ci < len(row) and float(row[ci] or 0) >= 0.5:
                        sub_total[sub] = sub_total.get(sub, 0) + 1
                except Exception:
                    pass

            fs_raw = row[full_status_col] if (full_status_col is not None and full_status_col < len(row)) else None
            st_raw = str(row[status_col]).strip().lower() if (status_col is not None and status_col < len(row) and row[status_col] is not None) else ""

            w_state = "not_started"
            if fs_raw:
                try:
                    fs_dict = json.loads(str(fs_raw))
                    if isinstance(fs_dict, dict) and fs_dict:
                        done_here = 0
                        total_here = 0
                        for k, val in fs_dict.items():
                            state_str = str(val[0] if isinstance(val, list) and val else val).lower()
                            total_here += 1
                            if state_str == "completed":
                                done_here += 1
                                sub_done[k] = sub_done.get(k, 0) + 1
                                if k not in sub_total:
                                    sub_total[k] = total_vials
                        if total_here > 0 and done_here >= total_here:
                            w_state = "completed"
                        elif done_here > 0:
                            w_state = "in_progress"
                except Exception:
                    pass
            elif st_raw in {"completed", "done", "finished"}:
                w_state = "completed"
            elif st_raw in {"in_progress", "running", "started"}:
                w_state = "in_progress"

            if w_state == "completed":
                completed_vials += 1
            elif w_state == "in_progress":
                in_progress_vials += 1
            else:
                not_started_vials += 1
            well_states.append(w_state)

        stocks_live: List[Dict[str, Any]] = []
        if "stock_solutions" in wb.sheetnames:
            ws_ss = wb["stock_solutions"]
            ss_rows = list(ws_ss.iter_rows(values_only=True))
            if len(ss_rows) >= 2:
                sh = [str(c or "").strip() for c in ss_rows[0]]
                si = {h: i for i, h in enumerate(sh)}
                for r in ss_rows[1:]:
                    if not r or r[0] in (None, ""):
                        continue
                    sub_name = str(r[si.get("substance", 0)]).strip()
                    plate_id = int(float(r[si.get("breadboard_plate_id", 1)] or 3))
                    cont_id = int(float(r[si.get("container_id", 2)] or 0))
                    solv = str(r[si.get("solvent", 3)] or "")
                    init_vol = float(r[si.get("volume", 5)] or 0.0)
                    h_raw = r[si.get("liquid_surface_height", 6)] if si.get("liquid_surface_height", 6) < len(r) else None
                    h_val: Optional[float] = None
                    try:
                        if h_raw not in (None, ""):
                            h_val = float(h_raw)
                    except Exception:
                        h_val = None

                    is_jar = plate_id >= 6
                    bottom_z = _JAR_BOTTOM_Z if is_jar else _BOTTLE_BOTTOM_Z
                    area = _JAR_AREA_MM2 if is_jar else _BOTTLE_AREA_MM2
                    rem_vol = init_vol
                    if h_val is not None and h_val < bottom_z:
                        rem_vol = max(0.0, ((bottom_z - h_val) / 10.0) * area)
                    pct_rem = round(min(100.0, (rem_vol / init_vol) * 100.0), 1) if init_vol > 0 else 0.0
                    stocks_live.append(
                        {
                            "substance": sub_name,
                            "plate": plate_id,
                            "containerId": cont_id,
                            "solvent": solv,
                            "initialVolumeUl": round(init_vol, 1),
                            "remainingVolumeUl": round(rem_vol, 1),
                            "surfaceHeightZ": round(h_val, 1) if h_val is not None else None,
                            "percentRemaining": pct_rem,
                        }
                    )

        substances = []
        for s_name in (vol_substances or list(sub_done.keys())):
            tot = max(sub_total.get(s_name, 0), sub_done.get(s_name, 0))
            dn = sub_done.get(s_name, 0)
            if tot <= 0:
                continue
            substances.append(
                {
                    "substance": s_name,
                    "completed": dn,
                    "total": tot,
                    "percent": round((dn / tot) * 100.0, 1) if tot > 0 else 0.0,
                }
            )

        pct_complete = (
            round(((completed_vials + 0.5 * in_progress_vials) / total_vials) * 100.0, 1)
            if total_vials > 0
            else 0.0
        )
        rel = str(xlsx_path.resolve().relative_to(data_dir.resolve())).replace("\\", "/")
        mtime = xlsx_path.stat().st_mtime
        return {
            "fileName": xlsx_path.name,
            "relativePath": rel,
            "updatedIso": datetime.fromtimestamp(mtime, tz=timezone.utc).isoformat(),
            "totalVials": total_vials,
            "completedVials": completed_vials,
            "inProgressVials": in_progress_vials,
            "notStartedVials": not_started_vials,
            "percentComplete": pct_complete,
            "plateBarcode": plate_barcode,
            "dilutionBarcodes": dilution_barcodes,
            "reactionDurationHours": reaction_duration,
            "substances": substances,
            "wellStates": well_states[:162],
            "stocks": stocks_live,
        }
    finally:
        wb.close()


def _disconnect_nanodrop_hardware() -> None:
    nd = _ROBOT_HW.get("nd")
    if nd is not None:
        for fn in (
            lambda: nd.close_all() if hasattr(nd, "close_all") else None,
            lambda: nd.close_serial() if hasattr(nd, "close_serial") else None,
            lambda: nd.serial.close() if getattr(nd, "serial", None) is not None else None,
        ):
            try:
                fn()
            except Exception:
                pass
    _ROBOT_HW["nd"] = None
    _ROBOT_HW["nanodropConnected"] = False
    _ROBOT_HW["nanodropLidClosed"] = True


def _disconnect_robot_hardware(position_label: str = "Disconnected (USB free for main.py)") -> None:
    _disconnect_nanodrop_hardware()
    pt = _ROBOT_HW.get("pt")
    gt = _ROBOT_HW.get("gt")
    zm = _ROBOT_HW.get("zm")
    for fn in (
        lambda: pt.close_ports_and_zeus() if pt is not None and hasattr(pt, "close_ports_and_zeus") else None,
        lambda: pt.balance.close() if pt is not None and getattr(pt, "balance", None) is not None else None,
        lambda: gt.close_gantry() if gt is not None and hasattr(gt, "close_gantry") else None,
        lambda: gt.serial.close() if gt is not None and getattr(gt, "serial", None) is not None else None,
        lambda: zm.remoteFrameNotifier.stop() if zm is not None and getattr(zm, "remoteFrameNotifier", None) is not None else None,
        lambda: zm.CANBus.shutdown() if zm is not None and getattr(zm, "CANBus", None) is not None else None,
    ):
        try:
            fn()
        except Exception:
            pass
    _ROBOT_HW.update(
        {
            "zm": None,
            "gt": None,
            "pt": None,
            "brb": None,
            "connected": False,
            "currentPosition": position_label,
            "lastActivityMono": 0.0,
            "lastError": None,
        }
    )


def _check_idle_auto_release() -> None:
    any_conn = bool(_ROBOT_HW.get("connected") or _ROBOT_HW.get("nanodropConnected"))
    if not any_conn or _ROBOT_HW.get("busy") or ROBOWSKI_IDLE_RELEASE_SEC <= 0:
        return
    last_mono = float(_ROBOT_HW.get("lastActivityMono") or 0.0)
    if last_mono <= 0.0:
        return
    if (time.monotonic() - last_mono) >= ROBOWSKI_IDLE_RELEASE_SEC:
        with _ROBOT_HW_LOCK:
            if (_ROBOT_HW.get("connected") or _ROBOT_HW.get("nanodropConnected")) and not _ROBOT_HW.get("busy"):
                mins = max(1, round(ROBOWSKI_IDLE_RELEASE_SEC / 60))
                _disconnect_robot_hardware(f"USB auto-released after {mins} min idle (ready for main.py)")
                _ROBOT_HW["lastCommand"] = "auto_release_idle"
                _ROBOT_HW["lastCommandAt"] = datetime.now(timezone.utc).isoformat()


def _hardware_state_snapshot() -> Dict[str, Any]:
    _check_idle_auto_release()
    idle_rem: Optional[int] = None
    if (_ROBOT_HW.get("connected") or _ROBOT_HW.get("nanodropConnected")) and ROBOWSKI_IDLE_RELEASE_SEC > 0:
        last_mono = float(_ROBOT_HW.get("lastActivityMono") or 0.0)
        elapsed = max(0.0, time.monotonic() - last_mono) if last_mono > 0 else 0.0
        idle_rem = max(0, int(round(ROBOWSKI_IDLE_RELEASE_SEC - elapsed)))
    pt_job = _ROBOT_HW.get("plateTransfer")
    return {
        "controlEnabled": ROBOWSKI_ENABLE_HARDWARE,
        "connected": bool(_ROBOT_HW["connected"]),
        "nanodropConnected": bool(_ROBOT_HW.get("nanodropConnected")),
        "nanodropId": str(_ROBOT_HW.get("nanodropId") or "nd_2000c"),
        "nanodropLidClosed": bool(_ROBOT_HW.get("nanodropLidClosed", True)),
        "busy": bool(_ROBOT_HW["busy"]),
        "currentTip": str(_ROBOT_HW["currentTip"] or ""),
        "currentPosition": str(_ROBOT_HW["currentPosition"] or "Unknown"),
        "currentXY": _ROBOT_HW.get("currentXY"),
        "currentZ": _ROBOT_HW.get("currentZ"),
        "lastCommand": _ROBOT_HW["lastCommand"],
        "lastCommandAt": _ROBOT_HW["lastCommandAt"],
        "lastError": _ROBOT_HW["lastError"],
        "idleReleaseSeconds": ROBOWSKI_IDLE_RELEASE_SEC,
        "idleSecondsRemaining": idle_rem,
        "plateTransfer": copy.deepcopy(pt_job) if isinstance(pt_job, dict) else None,
        "platePresets": _load_local_plate_presets(),
    }


def _verify_relay_token(request: Request) -> None:
    if ROBOWSKI_RELAY_TOKEN:
        supplied = (request.headers.get("X-Robowski-Agent-Token") or "").strip()
        if not hmac.compare_digest(supplied, ROBOWSKI_RELAY_TOKEN):
            raise HTTPException(status_code=403, detail="Invalid Robot PC helper token.")


class RelayPushPayload(BaseModel):
    status: Dict[str, Any]


class RelayCommandResultPayload(BaseModel):
    commandId: str
    ok: bool
    executed: bool = True
    command: str = ""
    humanMessage: str = ""
    pythonSnippet: str = ""
    data: Optional[Dict[str, Any]] = None
    hardware: Optional[Dict[str, Any]] = None
    error: Optional[str] = None


@app.post("/api/robot/relay/push")
def api_robot_relay_push(payload: RelayPushPayload, request: Request) -> Dict[str, Any]:
    """Receives periodic live status snapshots pushed by robot_pc_agent.py on the robot PC."""
    _verify_relay_token(request)
    now = datetime.now(timezone.utc).timestamp()
    pending_out = None
    with _RELAY_LOCK:
        _RELAY_STATE["status"] = payload.status
        _RELAY_STATE["pushedAt"] = now
        req_run = _RELAY_STATE["requestedRunPath"]
        pending = _RELAY_STATE["pendingCommand"]
        if pending is not None:
            # Hand command to the robot PC agent once (drop if expired > 30s)
            if now - float(pending.get("createdAt", 0.0)) <= 30.0:
                pending_out = {
                    "id": pending["id"],
                    "command": pending["command"],
                    "params": pending["params"],
                    "pin": pending.get("pin", ""),
                }
            _RELAY_STATE["pendingCommand"] = None
    return {
        "ok": True,
        "requestedRunPath": req_run,
        "pendingCommand": pending_out,
    }


@app.post("/api/robot/relay/result")
def api_robot_relay_result(payload: RelayCommandResultPayload, request: Request) -> Dict[str, Any]:
    """Receives execution result for a relayed hardware command from robot_pc_agent.py."""
    _verify_relay_token(request)
    with _RELAY_LOCK:
        waiter = _RELAY_STATE["waiters"].get(payload.commandId)
        if waiter is not None:
            waiter["result"] = payload.model_dump()
            waiter["event"].set()
        if payload.hardware and isinstance(_RELAY_STATE["status"], dict):
            _RELAY_STATE["status"]["hardware"] = payload.hardware
    return {"ok": True}


@app.get("/api/robot/status")
def api_robot_status(run_path: Optional[str] = Query(default=None)) -> Dict[str, Any]:
    # Prefer live status pushed from the Robot PC helper if it has checked in
    with _RELAY_LOCK:
        if run_path is not None:
            _RELAY_STATE["requestedRunPath"] = run_path.strip() or None
        relayed = copy.deepcopy(_RELAY_STATE["status"]) if _RELAY_STATE["status"] else None
        pushed_at = float(_RELAY_STATE["pushedAt"] or 0.0)

    if relayed is not None and pushed_at > 0:
        age = max(0, int(datetime.now(timezone.utc).timestamp() - pushed_at))
        agent_online = age <= 30
        relayed["relaySource"] = "robot_pc_agent"
        relayed["agentOnline"] = agent_online
        relayed["agentLastSeenSecondsAgo"] = age
        if not agent_online:
            relayed["state"] = "not_configured"
            mins = max(1, age // 60)
            relayed["headline"] = f"Robot PC helper paused (last update {mins} min ago)"
            relayed["detail"] = (
                "The helper script on the robot PC hasn't checked in recently. "
                "Start robot_pc_agent.py on the robot PC to resume live updates."
            )
        return relayed

    data_dir = _get_robot_data_dir()
    log_file = _find_robot_log_file()
    tip_racks = _read_tip_racks()
    available_runs = _list_recent_robot_runs(data_dir) if data_dir is not None else []

    active_run: Optional[Dict[str, Any]] = None
    if data_dir is not None:
        target_xlsx: Optional[Path] = None
        if run_path:
            target_xlsx = _resolve_confined_run_xlsx(data_dir, run_path)
        elif available_runs:
            target_xlsx = _resolve_confined_run_xlsx(data_dir, available_runs[0]["relativePath"])
        if target_xlsx is not None:
            active_run = _parse_robot_run_xlsx(target_xlsx, data_dir)

    raw_tail = _tail_log_lines(log_file, max_lines=60) if log_file is not None else []
    recent_activity = [_translate_log_line(ln) for ln in raw_tail[-25:]][::-1]

    last_updated_iso: Optional[str] = None
    seconds_ago: Optional[int] = None
    if log_file is not None:
        mtime = log_file.stat().st_mtime
        last_updated_iso = datetime.fromtimestamp(mtime, tz=timezone.utc).isoformat()
        seconds_ago = max(0, int(datetime.now(timezone.utc).timestamp() - mtime))

    # Build clear plain-English status for a common person
    state = "idle"
    headline = f"{ROBOT_NAME} is idle and ready"
    detail = "No active pipetting job detected right now."

    if data_dir is None and log_file is None and not _ROBOT_HW["connected"]:
        state = "not_configured"
        headline = "Waiting for the Robot PC helper to check in"
        detail = (
            "Your personal PC is connected. Run the tiny robot_pc_agent.py helper on the robot PC "
            "(it finds your Robowski folder automatically) to stream live vial progress, tip counts, and logs here."
        )
    elif _ROBOT_HW["busy"]:
        state = "running"
        headline = f"{ROBOT_NAME} is moving ({_ROBOT_HW['lastCommand'] or 'command in progress'})"
        detail = "Waiting for the current hardware action to finish safely."
    elif recent_activity and seconds_ago is not None and seconds_ago <= 180:
        latest = recent_activity[0]
        if latest["level"] == "error":
            state = "error"
            headline = f"{ROBOT_NAME} stopped with an error"
            detail = latest["summary"]
        elif "waiting for you" in latest["summary"].lower() or "empty" in latest["summary"].lower():
            state = "waiting_user"
            headline = f"{ROBOT_NAME} needs your help"
            detail = latest["summary"]
        elif "complete" in latest["summary"].lower() or "finished" in latest["summary"].lower():
            state = "idle"
            headline = latest["summary"]
            detail = f"Last log update {seconds_ago}s ago."
        else:
            state = "running"
            if active_run and active_run["totalVials"] > 0 and active_run["completedVials"] < active_run["totalVials"]:
                headline = (
                    f"{ROBOT_NAME} is running — {active_run['completedVials']} of {active_run['totalVials']} "
                    f"vials done ({active_run['percentComplete']}%)"
                )
            else:
                headline = f"{ROBOT_NAME} is actively working"
            detail = latest["summary"]
    elif active_run:
        if active_run["totalVials"] > 0 and active_run["completedVials"] >= active_run["totalVials"]:
            state = "idle"
            headline = f"Last run finished — all {active_run['totalVials']} vials completed"
            detail = f"Workbook: {active_run['fileName']}"
        elif active_run["completedVials"] > 0 or active_run["inProgressVials"] > 0:
            state = "waiting_user"
            headline = (
                f"Run paused partway — {active_run['completedVials']} of {active_run['totalVials']} "
                f"vials done ({active_run['percentComplete']}%)"
            )
            detail = f"Workbook {active_run['fileName']} can be resumed right where it left off."
        else:
            state = "idle"
            headline = f"{ROBOT_NAME} is ready — {active_run['totalVials']} vials queued"
            detail = f"Latest workbook: {active_run['fileName']}"

    return {
        "ok": True,
        "robotName": ROBOT_NAME,
        "state": state,
        "headline": headline,
        "detail": detail,
        "lastUpdatedIso": last_updated_iso,
        "secondsAgo": seconds_ago,
        "dataPathConfigured": data_dir is not None,
        "logFileName": log_file.name if log_file is not None else None,
        "tipRacks": tip_racks,
        "activeRun": active_run,
        "availableRuns": available_runs,
        "recentActivity": recent_activity,
        "rawLogTail": raw_tail[-40:],
        "hardware": _hardware_state_snapshot(),
    }


class RobotCommandRequest(BaseModel):
    command: str
    params: Dict[str, Any] = Field(default_factory=dict)


def _command_snippet(cmd: str, p: Dict[str, Any]) -> tuple[str, str]:
    """Returns (plain_english_description, exact_python_snippet) for allowlisted commands."""
    if cmd == "init_hardware":
        return ("Connect to Zeus pipetter & gantry and home axes", "zm, gt, pt = initiate_hardware()")
    if cmd == "disconnect_hardware":
        return ("Release USB & CAN ports so main.py can use the robot", "pt.close_ports_and_zeus(); gt.close_gantry()")
    if cmd == "home_xy":
        return ("Raise arm safely and home X/Y to (0, 0)", "gt.home_xy()")
    if cmd == "move_idle":
        return ("Move pipetter arm to safe parking position", "gt.move_to_idle_position()")
    if cmd == "move_z_traverse":
        return ("Raise pipette arm up to safe travel height", "zm.move_zeus_to_traverse_height()")
    if cmd == "kill_alarm":
        return ("Clear GRBL gantry alarm lock", "gt.kill_alarm()")
    if cmd == "emergency_stop":
        return ("Trigger Zeus emergency stop", "zm.setEmergencyStop(1)")
    if cmd == "pick_tip":
        tt = str(p.get("tip_type", "300ul"))
        return (f"Pick up a fresh {tt.replace('ul', ' µL')} tip", f"pt.pick_tip('{tt}')")
    if cmd == "discard_tip":
        return ("Move to trash bin and eject current tip", "pt.discard_tip()")
    if cmd == "change_tip":
        tt = str(p.get("tip_type", "300ul"))
        return (f"Eject current tip and pick a fresh {tt.replace('ul', ' µL')} tip", f"pt.change_tip('{tt}')")
    if cmd == "check_tip_status":
        return ("Check whether a tip is currently attached", "zm.getTipPresenceStatus()")
    if cmd == "reload_tip_rack":
        tt = str(p.get("tip_type", "300ul"))
        return (f"Reset {tt.replace('ul', ' µL')} tip rack as full (96/96)", f"brb.load_new_tip_rack('{tt}')")
    if cmd == "mark_tips_used":
        tt = str(p.get("tip_type", "300ul"))
        cnt = int(p.get("count", 1))
        return (f"Mark next {cnt} tip(s) as used in {tt.replace('ul', ' µL')} rack", f"brb.mark_next_n_tip_as_used('{tt}', {cnt})")
    if cmd == "move_to_container":
        pl = int(p.get("plate_id", 0))
        ct = int(p.get("container_id", 0))
        return (f"Move arm over plate{pl}, position {ct}", f"gt.move_xy(brb.plate_list[{pl}].containers[{ct}].xy)")
    if cmd == "move_to_trash":
        return ("Move arm over the tip waste bin", "gt.move_to_trash_bin()")
    if cmd == "move_to_balance":
        return ("Move arm over the balance cuvette", "pt.move_to_balance()")
    if cmd == "move_to_nanodrop":
        return ("Move arm safely over the NanoDrop pedestal", "gt.move_xy(brb.nanodrop_pedestal.xy, ensure_traverse_height=True)")
    if cmd == "single_transfer":
        sp = int(p.get("src_plate", 3))
        ss = int(p.get("src_slot", 0))
        dp = int(p.get("dst_plate", 0))
        ds = int(p.get("dst_slot", 0))
        vol = float(p.get("volume_ul", 100.0))
        solv = str(p.get("solvent", "ethanol"))
        return (
            f"Transfer {vol:g} µL of {solv} from plate{sp} pos {ss} → plate{dp} pos {ds}",
            f"# Single transfer: {vol:g} uL {solv} plate{sp}[{ss}] -> plate{dp}[{ds}]\npt.transfer_liquid(transfer_event, purpose='reaction')",
        )
    if cmd == "plate_transfer_start":
        sp = int(p.get("src_plate", 0))
        dp = int(p.get("dst_plate", 1))
        vol = float(p.get("volume_ul", 50.0))
        solv = str(p.get("solvent", "ethanol"))
        pairs = p.get("pairs") if isinstance(p.get("pairs"), list) else None
        count = len(pairs) if pairs is not None else len(p.get("wells") if isinstance(p.get("wells"), list) else list(range(54)))
        return (
            f"Plate-to-plate transfer: {count} wells ({vol:g} µL {solv}) plate{sp} → plate{dp}",
            f"# Plate-to-plate transfer: {count} wells, {vol:g} uL {solv}, plate{sp} -> plate{dp}\n# Supports 54-vial, 96-well, 24-well & custom calibrated formats",
        )
    if cmd == "plate_transfer_stop":
        return ("Stop plate-to-plate transfer cleanly after current vial", "# Stop signal sent to active plate-to-plate transfer loop")
    if cmd == "save_plate_preset":
        name = str(p.get("name", "Custom plate")).strip()
        r = int(p.get("rows", 8))
        c = int(p.get("cols", 12))
        slot = int(p.get("plate_slot", 0))
        return (
            f"Save {r}×{c} plate preset '{name}' for plate{slot}",
            f"# Saved 3-corner calibration preset '{name}' ({r}x{c}) for plate{slot}",
        )
    if cmd == "delete_plate_preset":
        pid = str(p.get("id", "")).strip()
        return (f"Delete plate preset '{pid}'", f"# Deleted custom plate preset '{pid}'")
    if cmd == "move_to_plate_well":
        pl = int(p.get("plate_id", 0))
        wi = int(p.get("well_index", 0))
        return (
            f"Dry-run move safely over plate{pl} well #{wi}",
            f"gt.move_xy(calibrated_xy(plate{pl}, well={wi}), ensure_traverse_height=True)",
        )
    if cmd == "read_xy_position":
        return ("Read current gantry (X, Y) and Z position", "# Read live gantry XY & Zeus Z for 3-corner plate calibration")
    if cmd == "move_xy_rel":
        dx = float(p.get("dx", 0))
        dy = float(p.get("dy", 0))
        return (f"Jog arm by ({dx:+.1f} mm, {dy:+.1f} mm)", f"gt.move_xy_rel(({dx}, {dy}))")
    if cmd == "move_z":
        z = int(p.get("z", 880))
        return (f"Move pipette Z height to {z} ({z / 10:.1f} mm)", f"zm.move_z({z})")
    if cmd == "move_z_rel":
        dz = int(p.get("dz", 0))
        direction = "Lower" if dz > 0 else "Raise"
        return (f"{direction} pipette tip by {abs(dz) / 10:.1f} mm ({dz:+d} steps)", f"zm.move_z(zm.pos + ({dz}))")
    if cmd == "check_liquid_level":
        pl = int(p.get("plate_id", 3))
        ct = int(p.get("container_id", 0))
        return (
            f"Probe liquid height in plate{pl}, position {ct}",
            f"pt.check_volume_in_container(brb.plate_list[{pl}].containers[{ct}])",
        )
    if cmd == "balance_door_open":
        return ("Open analytical balance door", "pt.open_balance_door()")
    if cmd == "balance_door_close":
        return ("Close analytical balance door", "pt.close_balance_door()")
    if cmd == "balance_tare":
        return ("Tare analytical balance", "pt.balance_tare()")
    if cmd == "balance_read":
        return ("Read stable weight from balance", "pt.balance_stable_value()")
    if cmd == "read_instrument_status":
        return ("Read Zeus Z height, tip sensor, and error code", "zm.getAbsoluteZPosition(); zm.getTipPresenceStatus(); zm.getErrorCode()")
    if cmd == "nanodrop_connect":
        nid = str(p.get("nd_id", "nd_2000c"))
        return (f"Connect to NanoDrop Arduino ({nid})", f"nd = nanodrop.Nanodrop('{nid}')")
    if cmd == "nanodrop_disconnect":
        return ("Close NanoDrop valves and release COM port", "nd.close_all(); nd.close_serial()")
    if cmd == "nanodrop_lid_open":
        return ("Open NanoDrop pedestal lid", "nd.open_lid()")
    if cmd == "nanodrop_lid_close":
        return ("Close NanoDrop pedestal lid", "nd.close_lid()")
    if cmd == "nanodrop_lid_half_open":
        return ("Half-open NanoDrop pedestal lid", "nd.lid_full_close_to_half_open()")
    if cmd == "nanodrop_flush":
        return ("Flush NanoDrop pedestal with solvent + vacuum", "nd.flush_pedestal_not_async()")
    if cmd == "nanodrop_dry":
        return ("Dry NanoDrop pedestal with vacuum + air", "nd.dry_pedestal_not_async()")
    if cmd == "nanodrop_wash_cycle":
        return ("Run full NanoDrop wash, vacuum dry & blower cycle", "nd.wash_nanodrop_pedestal_with_blower()")
    if cmd == "nanodrop_close_all":
        return ("Close NanoDrop lid and all wash/vacuum/air/blower valves", "nd.close_all(); nd.close_blower()")
    raise HTTPException(status_code=400, detail=f"Unknown or unsupported robot command: {cmd}")


def _validate_command_params(cmd: str, params: Dict[str, Any]) -> Dict[str, Any]:
    clean: Dict[str, Any] = {}
    if cmd in {"pick_tip", "change_tip", "reload_tip_rack", "mark_tips_used"}:
        tt = str(params.get("tip_type", "300ul")).strip()
        if tt not in {"50ul", "300ul", "1000ul"}:
            raise HTTPException(status_code=400, detail="tip_type must be 50ul, 300ul, or 1000ul")
        clean["tip_type"] = tt
    if cmd == "mark_tips_used":
        try:
            cnt = int(params.get("count", 1))
        except Exception:
            raise HTTPException(status_code=400, detail="count must be an integer between 1 and 96")
        if cnt < 1 or cnt > 96:
            raise HTTPException(status_code=400, detail="count must be between 1 and 96")
        clean["count"] = cnt
    if cmd in {"move_to_container", "check_liquid_level"}:
        try:
            plate_id = int(params.get("plate_id", 0))
            container_id = int(params.get("container_id", 0))
        except Exception:
            raise HTTPException(status_code=400, detail="plate_id and container_id must be integers")
        if plate_id < 0 or plate_id > 7:
            raise HTTPException(status_code=400, detail="plate_id must be between 0 and 7")
        max_c = 53 if plate_id <= 2 else (7 if plate_id <= 5 else 1)
        if container_id < 0 or container_id > max_c:
            raise HTTPException(status_code=400, detail=f"container_id for plate{plate_id} must be between 0 and {max_c}")
        clean["plate_id"] = plate_id
        clean["container_id"] = container_id
    if cmd == "move_xy_rel":
        try:
            dx = float(params.get("dx", 0))
            dy = float(params.get("dy", 0))
        except Exception:
            raise HTTPException(status_code=400, detail="dx and dy must be numbers")
        if not (-100.0 <= dx <= 100.0 and -100.0 <= dy <= 100.0):
            raise HTTPException(status_code=400, detail="Relative jog must stay within ±100 mm per click for safety")
        clean["dx"] = round(dx, 2)
        clean["dy"] = round(dy, 2)
    if cmd == "move_z":
        try:
            z = int(params.get("z", 880))
        except Exception:
            raise HTTPException(status_code=400, detail="z must be an integer between 500 and 2200")
        if z < 500 or z > 2200:
            raise HTTPException(status_code=400, detail="Z height must stay between 500 (top) and 2200 (just above bottom) for safety")
        clean["z"] = z
    if cmd == "move_z_rel":
        try:
            dz = int(params.get("dz", 0))
        except Exception:
            raise HTTPException(status_code=400, detail="dz must be an integer between -300 and +300")
        if dz < -300 or dz > 300:
            raise HTTPException(status_code=400, detail="Z step must stay within ±30 mm (±300 units) per click for safety")
        clean["dz"] = dz
    if cmd == "single_transfer":
        try:
            src_plate = int(params.get("src_plate", 3))
            src_slot = int(params.get("src_slot", 0))
            dst_plate = int(params.get("dst_plate", 0))
            dst_slot = int(params.get("dst_slot", 0))
            vol_ul = float(params.get("volume_ul", 100.0))
            src_z = int(params.get("src_z", 1900))
            dst_z = int(params.get("dst_z", 2100))
        except Exception:
            raise HTTPException(status_code=400, detail="Invalid numeric transfer parameters.")
        if not (0 <= src_plate <= 7 and 0 <= dst_plate <= 7):
            raise HTTPException(status_code=400, detail="Source and destination plates must be between 0 and 7.")
        src_preset_id = str(params.get("src_preset_id", "default_54")).strip() or "default_54"
        dst_preset_id = str(params.get("dst_preset_id", "default_54")).strip() or "default_54"
        if not re.match(r"^[a-zA-Z0-9_-]{1,64}$", src_preset_id) or not re.match(r"^[a-zA-Z0-9_-]{1,64}$", dst_preset_id):
            raise HTTPException(status_code=400, detail="Invalid plate preset ID.")
        src_max = (383 if src_preset_id != "default_54" else 53) if src_plate <= 2 else (7 if src_plate <= 5 else 1)
        dst_max = (383 if dst_preset_id != "default_54" else 53) if dst_plate <= 2 else (7 if dst_plate <= 5 else 1)
        if not (0 <= src_slot <= src_max and 0 <= dst_slot <= dst_max):
            raise HTTPException(status_code=400, detail="Source or destination slot is out of range for that plate.")
        if not (1.0 <= vol_ul <= 2000.0):
            raise HTTPException(status_code=400, detail="Transfer volume must be between 1 and 2000 µL.")
        if not (880 <= src_z <= 2190 and 880 <= dst_z <= 2190):
            raise HTTPException(status_code=400, detail="Liquid surface Z heights must be between 880 and 2190.")
        solvent = str(params.get("solvent", "ethanol")).strip()
        if solvent not in _ALLOWED_SOLVENTS:
            raise HTTPException(status_code=400, detail=f"Unsupported solvent '{solvent}'.")
        tip_type = str(params.get("tip_type", "auto")).strip()
        if tip_type not in {"auto", "50ul", "300ul", "1000ul"}:
            raise HTTPException(status_code=400, detail="tip_type must be auto, 50ul, 300ul, or 1000ul.")
        clean.update(
            {
                "src_plate": src_plate,
                "src_slot": src_slot,
                "src_preset_id": src_preset_id,
                "dst_plate": dst_plate,
                "dst_slot": dst_slot,
                "dst_preset_id": dst_preset_id,
                "volume_ul": round(vol_ul, 2),
                "solvent": solvent,
                "tip_type": tip_type,
                "src_z": src_z,
                "dst_z": dst_z,
                "pick_tip": bool(params.get("pick_tip", True)),
                "prewet": bool(params.get("prewet", False)),
                "mix_after": bool(params.get("mix_after", False)),
                "drop_tip": bool(params.get("drop_tip", True)),
            }
        )
    if cmd == "plate_transfer_start":
        try:
            src_plate = int(params.get("src_plate", 0))
            dst_plate = int(params.get("dst_plate", 1))
            vol_ul = float(params.get("volume_ul", 50.0))
            src_z = int(params.get("src_z", 2100))
            dst_z = int(params.get("dst_z", 2100))
        except Exception:
            raise HTTPException(status_code=400, detail="Invalid numeric plate transfer parameters.")
        if src_plate not in {0, 1, 2} or dst_plate not in {0, 1, 2}:
            raise HTTPException(status_code=400, detail="Plate-to-plate transfer uses plates 0, 1, or 2.")
        if src_plate == dst_plate:
            raise HTTPException(status_code=400, detail="Source plate and destination plate must be different.")
        src_preset_id = str(params.get("src_preset_id", "default_54")).strip() or "default_54"
        dst_preset_id = str(params.get("dst_preset_id", "default_54")).strip() or "default_54"
        if not re.match(r"^[a-zA-Z0-9_-]{1,64}$", src_preset_id) or not re.match(r"^[a-zA-Z0-9_-]{1,64}$", dst_preset_id):
            raise HTTPException(status_code=400, detail="Invalid plate preset ID.")
        if not (1.0 <= vol_ul <= 2000.0):
            raise HTTPException(status_code=400, detail="Transfer volume must be between 1 and 2000 µL.")
        if not (880 <= src_z <= 2190 and 880 <= dst_z <= 2190):
            raise HTTPException(status_code=400, detail="Liquid surface Z heights must be between 880 and 2190.")

        raw_pairs = params.get("pairs")
        pairs: List[List[int]] = []
        if isinstance(raw_pairs, list) and len(raw_pairs) > 0:
            if len(raw_pairs) > 384:
                raise HTTPException(status_code=400, detail="Maximum 384 well transfers per job.")
            seen_p: set[tuple[int, int]] = set()
            for item in raw_pairs:
                if not isinstance(item, (list, tuple)) or len(item) != 2:
                    raise HTTPException(status_code=400, detail="Each transfer pair must be [srcWell, dstWell].")
                try:
                    sw, dw = int(item[0]), int(item[1])
                except Exception:
                    raise HTTPException(status_code=400, detail="Well indices must be integers.")
                if not (0 <= sw <= 383 and 0 <= dw <= 383):
                    raise HTTPException(status_code=400, detail="Well indices must be between 0 and 383.")
                if (sw, dw) not in seen_p:
                    seen_p.add((sw, dw))
                    pairs.append([sw, dw])
            wells = [p[0] for p in pairs]
        else:
            raw_wells = params.get("wells")
            if raw_wells is None:
                wells = list(range(54))
            elif isinstance(raw_wells, list):
                wells_set = set()
                for w in raw_wells:
                    try:
                        wi = int(w)
                    except Exception:
                        raise HTTPException(status_code=400, detail="Well indices must be integers.")
                    if wi < 0 or wi > 383:
                        raise HTTPException(status_code=400, detail="Well indices must be between 0 and 383.")
                    wells_set.add(wi)
                wells = sorted(wells_set)
            else:
                raise HTTPException(status_code=400, detail="wells must be a list of well indices.")
            pairs = [[w, w] for w in wells]
        if not pairs:
            raise HTTPException(status_code=400, detail="Select at least one well to transfer.")
        solvent = str(params.get("solvent", "ethanol")).strip()
        if solvent not in _ALLOWED_SOLVENTS:
            raise HTTPException(status_code=400, detail=f"Unsupported solvent '{solvent}'.")
        tip_type = str(params.get("tip_type", "auto")).strip()
        if tip_type not in {"auto", "50ul", "300ul", "1000ul"}:
            raise HTTPException(status_code=400, detail="tip_type must be auto, 50ul, 300ul, or 1000ul.")
        clean.update(
            {
                "src_plate": src_plate,
                "dst_plate": dst_plate,
                "src_preset_id": src_preset_id,
                "dst_preset_id": dst_preset_id,
                "wells": wells,
                "pairs": pairs,
                "volume_ul": round(vol_ul, 2),
                "solvent": solvent,
                "tip_type": tip_type,
                "src_z": src_z,
                "dst_z": dst_z,
                "change_tip_each_vial": bool(params.get("change_tip_each_vial", True)),
                "prewet": bool(params.get("prewet", False)),
                "mix_after": bool(params.get("mix_after", False)),
                "drop_tip_at_end": bool(params.get("drop_tip_at_end", True)),
            }
        )
    if cmd == "save_plate_preset":
        norm = _normalize_plate_preset_input(params)
        clean.update(
            {
                "id": norm["id"],
                "name": norm["name"],
                "plate_slot": norm["plateSlot"],
                "rows": norm["rows"],
                "cols": norm["cols"],
                "corner_a1": norm["cornerA1"],
                "corner_top_right": norm["cornerTopRight"],
                "corner_bottom_left": norm["cornerBottomLeft"],
                "default_z": norm["defaultZ"],
            }
        )
    if cmd == "delete_plate_preset":
        pid = str(params.get("id", "")).strip()
        if not pid or not re.match(r"^[a-zA-Z0-9_-]{1,64}$", pid):
            raise HTTPException(status_code=400, detail="Invalid plate preset ID.")
        clean["id"] = pid
    if cmd == "move_to_plate_well":
        try:
            pl = int(params.get("plate_id", 0))
            wi = int(params.get("well_index", 0))
        except Exception:
            raise HTTPException(status_code=400, detail="plate_id and well_index must be integers.")
        if pl not in {0, 1, 2}:
            raise HTTPException(status_code=400, detail="plate_id must be 0, 1, or 2.")
        if not (0 <= wi <= 383):
            raise HTTPException(status_code=400, detail="well_index must be between 0 and 383.")
        clean["plate_id"] = pl
        clean["well_index"] = wi
        if params.get("corner_a1") is not None and params.get("corner_top_right") is not None and params.get("corner_bottom_left") is not None:
            norm = _normalize_plate_preset_input(
                {
                    "name": "Test preview",
                    "plate_slot": pl,
                    "rows": params.get("rows", 8),
                    "cols": params.get("cols", 12),
                    "corner_a1": params.get("corner_a1"),
                    "corner_top_right": params.get("corner_top_right"),
                    "corner_bottom_left": params.get("corner_bottom_left"),
                    "default_z": params.get("default_z", 1900),
                }
            )
            if wi >= norm["rows"] * norm["cols"]:
                raise HTTPException(status_code=400, detail="well_index exceeds rows × cols.")
            clean.update(
                {
                    "rows": norm["rows"],
                    "cols": norm["cols"],
                    "corner_a1": norm["cornerA1"],
                    "corner_top_right": norm["cornerTopRight"],
                    "corner_bottom_left": norm["cornerBottomLeft"],
                    "default_z": norm["defaultZ"],
                }
            )
        else:
            pid = str(params.get("preset_id", "default_54")).strip() or "default_54"
            if not re.match(r"^[a-zA-Z0-9_-]{1,64}$", pid):
                raise HTTPException(status_code=400, detail="Invalid preset_id.")
            clean["preset_id"] = pid
    if cmd in {
        "nanodrop_connect",
        "nanodrop_lid_open",
        "nanodrop_lid_close",
        "nanodrop_lid_half_open",
        "nanodrop_flush",
        "nanodrop_dry",
        "nanodrop_wash_cycle",
        "nanodrop_close_all",
    }:
        nd_id = str(params.get("nd_id", "nd_2000c")).strip()
        if nd_id not in {"nd_2000c", "nd_2000"}:
            raise HTTPException(status_code=400, detail="nd_id must be nd_2000c or nd_2000.")
        clean["nd_id"] = nd_id
    return clean


def _ensure_robot_hardware_loaded() -> None:
    if _ROBOT_HW["connected"] and _ROBOT_HW["pt"] is not None:
        return
    if not ROBOWSKI_REPO_ENV:
        raise RuntimeError("ROBOWSKI_REPO_PATH is not set on this PC.")
    zeus_dir = Path(ROBOWSKI_REPO_ENV).expanduser().resolve()
    if (zeus_dir / "zeus-pipetter").is_dir():
        zeus_dir = (zeus_dir / "zeus-pipetter").resolve()
    if str(zeus_dir) not in sys.path:
        sys.path.insert(0, str(zeus_dir))
    work_dir = zeus_dir
    if not (zeus_dir / "config").is_dir() and (zeus_dir.parent / "config").is_dir():
        work_dir = zeus_dir.parent
    try:
        os.chdir(str(work_dir))
    except OSError:
        pass
    import breadboard as brb  # type: ignore
    import pipetter  # type: ignore
    import zeus  # type: ignore

    zm = zeus.ZeusModule(id=1)
    gt = pipetter.Gantry(zeus=zm)
    gt.home_xy()
    pt = pipetter.Pipetter(zeus=zm, gantry=gt)
    _ROBOT_HW.update(
        {
            "zm": zm,
            "gt": gt,
            "pt": pt,
            "brb": brb,
            "connected": True,
            "currentTip": getattr(zm, "tip_on_zeus", "") or "",
            "currentPosition": "Home (0, 0)",
            "lastError": None,
        }
    )


def _ensure_nanodrop_loaded(nd_id: str = "nd_2000c") -> Any:
    clean_id = "nd_2000" if nd_id == "nd_2000" else "nd_2000c"
    if _ROBOT_HW.get("nanodropConnected") and _ROBOT_HW.get("nd") is not None:
        if _ROBOT_HW.get("nanodropId") == clean_id:
            return _ROBOT_HW["nd"]
        _disconnect_nanodrop_hardware()
    if not ROBOWSKI_REPO_ENV:
        raise RuntimeError("ROBOWSKI_REPO_PATH is not set on this PC.")
    zeus_dir = Path(ROBOWSKI_REPO_ENV).expanduser().resolve()
    if (zeus_dir / "zeus-pipetter").is_dir():
        zeus_dir = (zeus_dir / "zeus-pipetter").resolve()
    if str(zeus_dir) not in sys.path:
        sys.path.insert(0, str(zeus_dir))
    import nanodrop  # type: ignore

    nd = nanodrop.Nanodrop(clean_id)
    if not hasattr(nd, "serial") or getattr(nd, "serial", None) is None:
        raise RuntimeError(f"NanoDrop Arduino ({clean_id}) did not connect.")
    _ROBOT_HW["nd"] = nd
    _ROBOT_HW["nanodropConnected"] = True
    _ROBOT_HW["nanodropId"] = clean_id
    _ROBOT_HW["nanodropLidClosed"] = bool(getattr(nd, "lid_closed", True))
    return nd


def _resolve_local_liquid_class(solvent: str, tip_type: str) -> int:
    try:
        import config as robowski_cfg  # type: ignore

        lc_dict = getattr(robowski_cfg, "liquid_class_dict", {})
        if isinstance(lc_dict, dict):
            for target in ({solvent, "empty", tip_type}, {solvent, tip_type}):
                for key, idx in lc_dict.items():
                    if target.issubset(set(str(key).split("_"))):
                        return int(idx)
    except Exception:
        pass
    return _FALLBACK_LIQUID_CLASS.get((solvent, tip_type), _FALLBACK_LIQUID_CLASS.get(("ethanol", tip_type), 13))


@app.post("/api/robot/command")
def api_robot_command(req: RobotCommandRequest, request: Request) -> Dict[str, Any]:
    cmd = (req.command or "").strip()
    clean = _validate_command_params(cmd, req.params or {})
    desc, snippet = _command_snippet(cmd, clean)

    supplied_pin = (request.headers.get("X-Robowski-Pin") or "").strip()
    if ROBOWSKI_CONTROL_PIN:
        if not hmac.compare_digest(supplied_pin, ROBOWSKI_CONTROL_PIN):
            raise HTTPException(status_code=403, detail="Control PIN required to send live robot commands.")

    # If a remote Robot PC helper is actively connected, relay the command to it
    now = datetime.now(timezone.utc).timestamp()
    with _RELAY_LOCK:
        relayed_status = _RELAY_STATE["status"]
        relayed_age = now - float(_RELAY_STATE["pushedAt"] or 0.0)
        agent_online = relayed_status is not None and relayed_age <= 30.0
        agent_control_enabled = bool(
            agent_online and isinstance(relayed_status.get("hardware"), dict) and relayed_status["hardware"].get("controlEnabled")
        )

    if agent_online:
        if not agent_control_enabled:
            return {
                "ok": True,
                "executed": False,
                "command": cmd,
                "humanMessage": (
                    f"Safe monitor mode: '{desc}' was not sent to the robot arm. "
                    "To unlock live buttons with just a PIN, save your PIN in a file called robot_pin.txt next to robot_pc_agent.py on the robot PC."
                ),
                "pythonSnippet": snippet,
                "hardware": relayed_status.get("hardware"),
            }

        cmd_id = uuid.uuid4().hex
        ev = threading.Event()
        with _RELAY_LOCK:
            if _RELAY_STATE["pendingCommand"] is not None:
                raise HTTPException(status_code=409, detail="Robot PC is already running the previous command. Wait a moment and try again.")
            _RELAY_STATE["pendingCommand"] = {
                "id": cmd_id,
                "command": cmd,
                "params": clean,
                "pin": supplied_pin,
                "createdAt": now,
            }
            _RELAY_STATE["waiters"][cmd_id] = {"event": ev, "result": None}

        wait_timeout = 65.0 if cmd in _LONG_ROBOT_COMMANDS else 22.0
        try:
            finished = ev.wait(timeout=wait_timeout)
            with _RELAY_LOCK:
                waiter = _RELAY_STATE["waiters"].pop(cmd_id, None)
                if _RELAY_STATE["pendingCommand"] and _RELAY_STATE["pendingCommand"].get("id") == cmd_id:
                    _RELAY_STATE["pendingCommand"] = None
            if finished and waiter and waiter.get("result"):
                res = waiter["result"]
                if not res.get("pythonSnippet"):
                    res["pythonSnippet"] = snippet
                return res
            return {
                "ok": False,
                "executed": False,
                "command": cmd,
                "humanMessage": f"The robot PC did not reply within {int(wait_timeout)} seconds — check the hood and live status.",
                "pythonSnippet": snippet,
                "error": "Relay timeout",
            }
        except Exception as exc:
            with _RELAY_LOCK:
                _RELAY_STATE["waiters"].pop(cmd_id, None)
            raise HTTPException(status_code=500, detail=str(exc))

    # Tip-rack JSON helpers can work directly on tip_rack.json if hardware control is enabled
    if not ROBOWSKI_ENABLE_HARDWARE:
        return {
            "ok": True,
            "executed": False,
            "command": cmd,
            "humanMessage": (
                f"Read-only monitor mode: '{desc}' was not sent to the physical robot. "
                "Run robot_pc_agent.py --enable-hardware on the robot PC (or ROBOWSKI_ENABLE_HARDWARE=1 locally) "
                "to run live commands, or copy the Python snippet below."
            ),
            "pythonSnippet": snippet,
            "hardware": _hardware_state_snapshot(),
        }

    if cmd == "plate_transfer_stop":
        job = _ROBOT_HW.get("plateTransfer")
        if isinstance(job, dict) and job.get("active"):
            _PLATE_TRANSFER_STOP.set()
            job["message"] = "Stop requested — finishing current vial cleanly before halting..."
            return {
                "ok": True,
                "executed": True,
                "command": cmd,
                "humanMessage": "Stop requested — the robot will finish the current vial and stop cleanly.",
                "pythonSnippet": snippet,
                "data": {"plateTransfer": copy.deepcopy(job)},
                "hardware": _hardware_state_snapshot(),
            }
        return {
            "ok": True,
            "executed": True,
            "command": cmd,
            "humanMessage": "No plate-to-plate transfer is running right now.",
            "pythonSnippet": snippet,
            "hardware": _hardware_state_snapshot(),
        }

    if not _ROBOT_HW_LOCK.acquire(blocking=False):
        raise HTTPException(status_code=409, detail="Robot is busy finishing the previous command. Wait a moment and try again.")

    _ROBOT_HW["busy"] = True
    _ROBOT_HW["lastCommand"] = desc
    _ROBOT_HW["lastCommandAt"] = datetime.now(timezone.utc).isoformat()
    _ROBOT_HW["lastActivityMono"] = time.monotonic()
    result_data: Dict[str, Any] = {}
    human_msg = f"Completed: {desc}"
    try:
        # Release USB & CAN ports cleanly so main.py / diluter.py can use the robot
        if cmd == "disconnect_hardware":
            _disconnect_robot_hardware("Disconnected (USB free for main.py)")
            human_msg = "Released robot USB, CAN & NanoDrop ports — main.py can now connect normally."
        elif cmd == "nanodrop_disconnect":
            _disconnect_nanodrop_hardware()
            human_msg = "Released NanoDrop Arduino COM port — measure_spectrum.py can now connect normally."
        elif cmd in {
            "nanodrop_connect",
            "nanodrop_lid_open",
            "nanodrop_lid_close",
            "nanodrop_lid_half_open",
            "nanodrop_flush",
            "nanodrop_dry",
            "nanodrop_wash_cycle",
            "nanodrop_close_all",
        }:
            nd = _ensure_nanodrop_loaded(clean.get("nd_id", "nd_2000c"))
            if cmd == "nanodrop_connect":
                human_msg = f"Connected to NanoDrop ({_ROBOT_HW['nanodropId']})."
            elif cmd == "nanodrop_lid_open":
                nd.open_lid()
                _ROBOT_HW["nanodropLidClosed"] = False
                human_msg = "Opened NanoDrop pedestal lid."
            elif cmd == "nanodrop_lid_close":
                nd.close_lid()
                _ROBOT_HW["nanodropLidClosed"] = True
                human_msg = "Closed NanoDrop pedestal lid."
            elif cmd == "nanodrop_lid_half_open":
                if hasattr(nd, "lid_full_close_to_half_open") and _ROBOT_HW["nanodropId"] == "nd_2000c":
                    nd.lid_full_close_to_half_open()
                else:
                    nd.open_lid()
                _ROBOT_HW["nanodropLidClosed"] = False
                human_msg = "Moved NanoDrop lid to half-open position."
            elif cmd == "nanodrop_flush":
                nd.flush_pedestal_not_async()
                human_msg = "Flushed NanoDrop pedestal with solvent and vacuum."
            elif cmd == "nanodrop_dry":
                nd.dry_pedestal_not_async()
                human_msg = "Vacuum & air-dried NanoDrop pedestal."
            elif cmd == "nanodrop_wash_cycle":
                nd.wash_nanodrop_pedestal_with_blower()
                _ROBOT_HW["nanodropLidClosed"] = True
                human_msg = "Completed full NanoDrop wash, vacuum dry & blower cycle."
            elif cmd == "nanodrop_close_all":
                nd.close_all()
                if hasattr(nd, "close_blower"):
                    nd.close_blower()
                _ROBOT_HW["nanodropLidClosed"] = True
                human_msg = "Closed NanoDrop lid and all wash/vacuum/air/blower valves."
        # Handle pure JSON tip rack updates even before full hardware init if tip_rack.json is found
        elif cmd in {"reload_tip_rack", "mark_tips_used"} and not _ROBOT_HW["connected"]:
            rack_path = _find_tip_rack_json()
            if rack_path is None:
                raise RuntimeError("tip_rack.json not found. Check ROBOCHEM_DATA_PATH or ROBOWSKI_STATUS_PATH.")
            rack_data = json.loads(rack_path.read_text(encoding="utf-8"))
            tt = clean["tip_type"]
            if tt not in rack_data or "tips" not in rack_data[tt]:
                raise RuntimeError(f"Tip rack '{tt}' not found in tip_rack.json.")
            if cmd == "reload_tip_rack":
                for tip in rack_data[tt]["tips"]:
                    tip["exists"] = True
                human_msg = f"Marked {tt.replace('ul', ' µL')} tip rack as full (96/96 tips ready)."
            else:
                marked = 0
                for tip in rack_data[tt]["tips"]:
                    if marked >= clean["count"]:
                        break
                    if tip.get("exists"):
                        tip["exists"] = False
                        marked += 1
                human_msg = f"Marked {marked} tip(s) as used in the {tt.replace('ul', ' µL')} rack."
            rack_path.write_text(json.dumps(rack_data, ensure_ascii=False, indent=4), encoding="utf-8")
            result_data["tipRacks"] = _read_tip_racks()
        elif cmd == "save_plate_preset":
            preset = _normalize_plate_preset_input(clean)
            presets = _load_local_plate_presets()
            updated = False
            for idx_p, existing in enumerate(presets):
                if existing.get("id") == preset["id"]:
                    presets[idx_p] = preset
                    updated = True
                    break
            if not updated:
                if len(presets) >= _MAX_CUSTOM_PRESETS:
                    raise RuntimeError(f"Maximum of {_MAX_CUSTOM_PRESETS} custom plate presets reached.")
                presets.append(preset)
            _save_local_plate_presets(presets)
            result_data["preset"] = preset
            result_data["platePresets"] = presets
            human_msg = (
                f"Saved plate preset '{preset['name']}' ({preset['rows']}×{preset['cols']}) for plate{preset['plateSlot']} "
                f"— spacing {preset['colPitchMm']:.2f} × {preset['rowPitchMm']:.2f} mm."
            )
        elif cmd == "delete_plate_preset":
            presets = _load_local_plate_presets()
            new_presets = [p for p in presets if p.get("id") != clean["id"]]
            if len(new_presets) == len(presets):
                raise RuntimeError(f"Plate preset '{clean['id']}' not found.")
            _save_local_plate_presets(new_presets)
            result_data["platePresets"] = new_presets
            human_msg = f"Deleted plate preset '{clean['id']}'."
        else:
            _ensure_robot_hardware_loaded()
            zm, gt, pt, brb = _ROBOT_HW["zm"], _ROBOT_HW["gt"], _ROBOT_HW["pt"], _ROBOT_HW["brb"]

            if cmd == "init_hardware":
                _ROBOT_HW["currentXY"] = [0.0, 0.0]
                human_msg = f"Connected to {ROBOT_NAME} and homed arm to (0, 0)."
            elif cmd == "home_xy":
                gt.home_xy()
                _ROBOT_HW["currentPosition"] = "Home (0, 0)"
                _ROBOT_HW["currentXY"] = [0.0, 0.0]
                human_msg = "Moved pipetter arm back to home (0, 0)."
            elif cmd == "move_idle":
                gt.move_to_idle_position()
                _ROBOT_HW["currentPosition"] = "Park / Idle"
                _read_local_gantry_xy(gt)
                human_msg = "Parked pipetter arm out of the way."
            elif cmd == "move_z_traverse":
                zm.move_zeus_to_traverse_height()
                _ROBOT_HW["currentZ"] = int(getattr(zm, "pos", None) or getattr(zm, "ZeusTraversePosition", 880))
                human_msg = "Raised pipette head up to safe travel height."
            elif cmd == "kill_alarm":
                gt.kill_alarm()
                human_msg = "Cleared gantry alarm lock."
            elif cmd == "emergency_stop":
                zm.setEmergencyStop(1)
                human_msg = "Emergency stop triggered on Zeus pipetter."
            elif cmd == "pick_tip":
                pt.pick_tip(clean["tip_type"])
                _ROBOT_HW["currentTip"] = clean["tip_type"]
                human_msg = f"Picked up a fresh {clean['tip_type'].replace('ul', ' µL')} tip."
            elif cmd == "discard_tip":
                pt.discard_tip()
                _ROBOT_HW["currentTip"] = ""
                _ROBOT_HW["currentPosition"] = "Trash bin"
                human_msg = "Ejected pipette tip into the waste bin."
            elif cmd == "change_tip":
                pt.change_tip(clean["tip_type"])
                _ROBOT_HW["currentTip"] = clean["tip_type"]
                human_msg = f"Switched to a fresh {clean['tip_type'].replace('ul', ' µL')} tip."
            elif cmd == "check_tip_status":
                present = bool(zm.getTipPresenceStatus())
                result_data["tipPresent"] = present
                human_msg = (
                    f"Tip sensor: a tip IS attached ({_ROBOT_HW['currentTip'] or 'attached'})."
                    if present
                    else "Tip sensor: no tip attached right now."
                )
            elif cmd == "reload_tip_rack":
                brb.load_new_tip_rack(clean["tip_type"])
                result_data["tipRacks"] = _read_tip_racks()
                human_msg = f"Reset {clean['tip_type'].replace('ul', ' µL')} tip rack to full (96/96)."
            elif cmd == "mark_tips_used":
                brb.mark_next_n_tip_as_used(clean["tip_type"], clean["count"])
                result_data["tipRacks"] = _read_tip_racks()
                human_msg = f"Skipped {clean['count']} used tip(s) in {clean['tip_type'].replace('ul', ' µL')} rack."
            elif cmd == "move_to_container":
                c = brb.plate_list[clean["plate_id"]].containers[clean["container_id"]]
                gt.move_xy(c.xy, ensure_traverse_height=True)
                try:
                    _ROBOT_HW["currentXY"] = [round(float(c.xy[0]), 3), round(float(c.xy[1]), 3)]
                except Exception:
                    pass
                _ROBOT_HW["currentPosition"] = f"plate{clean['plate_id']}, pos {clean['container_id']}"
                _ROBOT_HW["currentZ"] = int(getattr(zm, "pos", None) or getattr(zm, "ZeusTraversePosition", 880))
                result_data["xy"] = _ROBOT_HW.get("currentXY")
                human_msg = f"Moved arm over plate{clean['plate_id']}, position {clean['container_id']}."
            elif cmd == "move_to_plate_well":
                pl = clean["plate_id"]
                wi = clean["well_index"]
                if "corner_a1" in clean:
                    tmp_p = _normalize_plate_preset_input(
                        {
                            "name": "Test preview",
                            "plate_slot": pl,
                            "rows": clean["rows"],
                            "cols": clean["cols"],
                            "corner_a1": clean["corner_a1"],
                            "corner_top_right": clean["corner_top_right"],
                            "corner_bottom_left": clean["corner_bottom_left"],
                            "default_z": clean["default_z"],
                        }
                    )
                    xy = _compute_preset_well_xy(tmp_p, wi)
                    well_lbl = _format_well_name(wi, tmp_p["cols"])
                    gt.move_xy(xy, ensure_traverse_height=True)
                    _ROBOT_HW["currentXY"] = [xy[0], xy[1]]
                    _ROBOT_HW["currentPosition"] = f"plate{pl} {well_lbl} (test)"
                else:
                    c, well_lbl, _r, _c, pname = _resolve_local_plate_container(brb, pl, wi, clean.get("preset_id", "default_54"))
                    gt.move_xy(c.xy, ensure_traverse_height=True)
                    _ROBOT_HW["currentXY"] = [round(float(c.xy[0]), 3), round(float(c.xy[1]), 3)]
                    _ROBOT_HW["currentPosition"] = f"plate{pl} {well_lbl} ({pname})"
                _ROBOT_HW["currentZ"] = int(getattr(zm, "pos", None) or getattr(zm, "ZeusTraversePosition", 880))
                result_data["xy"] = _ROBOT_HW.get("currentXY")
                result_data["zPosition"] = _ROBOT_HW["currentZ"]
                human_msg = f"Moved safely at travel height over plate{pl} well {well_lbl}."
            elif cmd == "read_xy_position":
                xy = _read_local_gantry_xy(gt)
                z_pos = None
                try:
                    zp = zm.getAbsoluteZPosition()
                    if isinstance(zp, (int, float)):
                        z_pos = int(zp)
                        _ROBOT_HW["currentZ"] = z_pos
                except Exception:
                    z_pos = _ROBOT_HW.get("currentZ")
                result_data["xy"] = xy
                result_data["zPosition"] = z_pos
                human_msg = (
                    f"Current gantry position: X={xy[0]:.2f} mm, Y={xy[1]:.2f} mm, Z={z_pos or '—'}."
                    if xy is not None
                    else "Move to a plate slot or Home first so gantry coordinates are tracked."
                )
            elif cmd == "move_to_trash":
                gt.move_to_trash_bin()
                _ROBOT_HW["currentPosition"] = "Trash bin"
                _read_local_gantry_xy(gt)
                human_msg = "Moved arm over the tip trash bin."
            elif cmd == "move_to_balance":
                pt.move_to_balance()
                _ROBOT_HW["currentPosition"] = "Balance cuvette"
                _read_local_gantry_xy(gt)
                human_msg = "Moved arm over the balance cuvette."
            elif cmd == "move_to_nanodrop":
                if not hasattr(brb, "nanodrop_pedestal"):
                    raise RuntimeError("nanodrop_pedestal is not configured in breadboard.py.")
                gt.move_xy(brb.nanodrop_pedestal.xy, ensure_traverse_height=True)
                _ROBOT_HW["currentPosition"] = "NanoDrop pedestal"
                _ROBOT_HW["currentZ"] = int(getattr(zm, "pos", None) or getattr(zm, "ZeusTraversePosition", 880))
                human_msg = "Moved arm safely over the NanoDrop pedestal."
            elif cmd == "single_transfer":
                vol_ul = clean["volume_ul"]
                tip_type = (
                    clean["tip_type"]
                    if clean["tip_type"] != "auto"
                    else ("50ul" if vol_ul <= 50.0 else ("300ul" if vol_ul <= 300.0 else "1000ul"))
                )
                src_c, src_lbl, _sr, _sc, _sn = _resolve_local_plate_container(
                    brb, clean["src_plate"], clean["src_slot"], clean.get("src_preset_id", "default_54")
                )
                dst_c, dst_lbl, _dr, _dc, _dn = _resolve_local_plate_container(
                    brb, clean["dst_plate"], clean["dst_slot"], clean.get("dst_preset_id", "default_54")
                )
                src_c.liquid_surface_height = clean["src_z"]
                dst_c.liquid_surface_height = clean["dst_z"]

                if clean["pick_tip"]:
                    cur_tip = getattr(zm, "tip_on_zeus", "") or ""
                    if not cur_tip:
                        pt.pick_tip(tip_type)
                    elif cur_tip != tip_type:
                        pt.change_tip(tip_type)
                    _ROBOT_HW["currentTip"] = tip_type
                elif not (getattr(zm, "tip_on_zeus", "") or ""):
                    raise RuntimeError("No pipette tip attached. Enable 'Pick fresh tip' or pick a tip first.")

                deck_idx = {"50ul": 3, "300ul": 0, "1000ul": 1}[tip_type]
                lc_idx = _resolve_local_liquid_class(clean["solvent"], tip_type)
                max_tip_vol = int(tip_type[:-2])
                mix_vol_01 = min(int(round(vol_ul)), max_tip_vol) * 10 if clean["mix_after"] else 0

                ev = SimpleNamespace(
                    source_container=src_c,
                    destination_container=dst_c,
                    transfer_volume=vol_ul,
                    aspirationVolume=vol_ul,
                    tip_type=tip_type,
                    solvent=clean["solvent"],
                    substance=clean["solvent"],
                    liquidClassTableIndex=lc_idx,
                    asp_containerGeometryTableIndex=getattr(src_c, "containerGeometryTableIndex", 1),
                    asp_deckGeometryTableIndex=deck_idx,
                    asp_lld=0,
                    asp_mixVolume=0,
                    asp_mixFlowRate=0,
                    asp_mixCycles=0,
                    disp_containerGeometryTableIndex=getattr(dst_c, "containerGeometryTableIndex", 0),
                    disp_deckGeometryTableIndex=deck_idx,
                    disp_lld=0,
                    searchBottomMode=0,
                    disp_mixVolume=mix_vol_01,
                    disp_mixCycles=3 if clean["mix_after"] else 0,
                )
                if clean["prewet"] and hasattr(pt, "prewet_new_tip"):
                    pt.prewet_new_tip(zm=zm, pt=pt, pipetting_event=ev, use_calibration=False)
                pt.transfer_liquid(transfer_event=ev, purpose="reaction", use_calibration=False)
                zm.move_zeus_to_traverse_height()
                if clean["drop_tip"]:
                    pt.discard_tip()
                    _ROBOT_HW["currentTip"] = ""
                    _ROBOT_HW["currentPosition"] = "Trash bin"
                else:
                    _ROBOT_HW["currentPosition"] = f"plate{clean['dst_plate']}, pos {clean['dst_slot']}"
                _ROBOT_HW["currentZ"] = int(getattr(zm, "pos", None) or getattr(zm, "ZeusTraversePosition", 880))
                result_data["tipRacks"] = _read_tip_racks()
                human_msg = (
                    f"Transferred {vol_ul:g} µL of {clean['solvent']} from plate{clean['src_plate']} pos {clean['src_slot']} "
                    f"→ plate{clean['dst_plate']} pos {clean['dst_slot']}."
                )
            elif cmd == "plate_transfer_start":
                vol_ul = clean["volume_ul"]
                tip_type = (
                    clean["tip_type"]
                    if clean["tip_type"] != "auto"
                    else ("50ul" if vol_ul <= 50.0 else ("300ul" if vol_ul <= 300.0 else "1000ul"))
                )
                pairs = clean["pairs"]
                wells = [p[0] for p in pairs]
                src_plate = clean["src_plate"]
                dst_plate = clean["dst_plate"]
                src_preset_id = clean.get("src_preset_id", "default_54")
                dst_preset_id = clean.get("dst_preset_id", "default_54")
                src_p = _get_local_preset(src_preset_id)
                dst_p = _get_local_preset(dst_preset_id)
                src_rows = int(src_p["rows"]) if src_p else 6
                src_cols = int(src_p["cols"]) if src_p else 9
                dst_rows = int(dst_p["rows"]) if dst_p else 6
                dst_cols = int(dst_p["cols"]) if dst_p else 9
                src_name = str(src_p["name"]) if src_p else "54-vial (6×9)"
                dst_name = str(dst_p["name"]) if dst_p else "54-vial (6×9)"
                _PLATE_TRANSFER_STOP.clear()
                job_state: Dict[str, Any] = {
                    "active": True,
                    "state": "running",
                    "srcPlate": src_plate,
                    "dstPlate": dst_plate,
                    "srcPresetId": src_preset_id,
                    "dstPresetId": dst_preset_id,
                    "srcPresetName": src_name,
                    "dstPresetName": dst_name,
                    "srcRows": src_rows,
                    "srcCols": src_cols,
                    "dstRows": dst_rows,
                    "dstCols": dst_cols,
                    "volumeUl": vol_ul,
                    "solvent": clean["solvent"],
                    "tipType": tip_type,
                    "changeTipEachVial": clean["change_tip_each_vial"],
                    "totalWells": len(pairs),
                    "completedWells": 0,
                    "currentWell": pairs[0][0],
                    "currentPair": pairs[0],
                    "failedWell": None,
                    "failedPair": None,
                    "wells": wells,
                    "pairs": pairs,
                    "completedList": [],
                    "completedPairs": [],
                    "startedAt": datetime.now(timezone.utc).isoformat(),
                    "finishedAt": None,
                    "message": f"Starting transfer of {len(pairs)} well(s): plate{src_plate} ({src_name}) → plate{dst_plate} ({dst_name})...",
                    "error": None,
                }
                _ROBOT_HW["plateTransfer"] = job_state

                def _local_worker() -> None:
                    deck_idx = {"50ul": 3, "300ul": 0, "1000ul": 1}[tip_type]
                    lc_idx = _resolve_local_liquid_class(clean["solvent"], tip_type)
                    max_tip_vol = int(tip_type[:-2])
                    mix_vol_01 = min(int(round(vol_ul)), max_tip_vol) * 10 if clean["mix_after"] else 0
                    try:
                        if not clean["change_tip_each_vial"]:
                            cur_tip = getattr(zm, "tip_on_zeus", "") or ""
                            if not cur_tip:
                                pt.pick_tip(tip_type)
                            elif cur_tip != tip_type:
                                pt.change_tip(tip_type)
                            _ROBOT_HW["currentTip"] = tip_type

                        for idx_i, pair in enumerate(pairs):
                            if _PLATE_TRANSFER_STOP.is_set():
                                job_state["state"] = "stopped"
                                job_state["message"] = f"Stopped cleanly after {job_state['completedWells']} of {len(pairs)} wells."
                                break
                            src_w, dst_w = pair[0], pair[1]
                            src_code = _format_well_name(src_w, src_cols)
                            dst_code = _format_well_name(dst_w, dst_cols)
                            job_state["currentWell"] = src_w
                            job_state["currentPair"] = [src_w, dst_w]
                            job_state["message"] = f"Transferring {src_code} → {dst_code} ({idx_i + 1} of {len(pairs)})"
                            _ROBOT_HW["lastActivityMono"] = time.monotonic()

                            if clean["change_tip_each_vial"]:
                                cur_tip = getattr(zm, "tip_on_zeus", "") or ""
                                if cur_tip:
                                    pt.change_tip(tip_type)
                                else:
                                    pt.pick_tip(tip_type)
                                _ROBOT_HW["currentTip"] = tip_type

                            src_c, _sl, _sr2, _sc2, _sn2 = _resolve_local_plate_container(brb, src_plate, src_w, src_preset_id)
                            dst_c, _dl, _dr2, _dc2, _dn2 = _resolve_local_plate_container(brb, dst_plate, dst_w, dst_preset_id)
                            src_c.liquid_surface_height = clean["src_z"]
                            dst_c.liquid_surface_height = clean["dst_z"]
                            ev = SimpleNamespace(
                                source_container=src_c,
                                destination_container=dst_c,
                                transfer_volume=vol_ul,
                                aspirationVolume=vol_ul,
                                tip_type=tip_type,
                                solvent=clean["solvent"],
                                substance=clean["solvent"],
                                liquidClassTableIndex=lc_idx,
                                asp_containerGeometryTableIndex=getattr(src_c, "containerGeometryTableIndex", 0),
                                asp_deckGeometryTableIndex=deck_idx,
                                asp_lld=0,
                                asp_mixVolume=0,
                                asp_mixFlowRate=0,
                                asp_mixCycles=0,
                                disp_containerGeometryTableIndex=getattr(dst_c, "containerGeometryTableIndex", 0),
                                disp_deckGeometryTableIndex=deck_idx,
                                disp_lld=0,
                                searchBottomMode=0,
                                disp_mixVolume=mix_vol_01,
                                disp_mixCycles=3 if clean["mix_after"] else 0,
                            )
                            if clean["prewet"] and hasattr(pt, "prewet_new_tip") and (clean["change_tip_each_vial"] or idx_i == 0):
                                pt.prewet_new_tip(zm=zm, pt=pt, pipetting_event=ev, use_calibration=False)
                            pt.transfer_liquid(transfer_event=ev, purpose="reaction", use_calibration=False)
                            zm.move_zeus_to_traverse_height()
                            job_state["completedList"].append(src_w)
                            job_state["completedPairs"].append([src_w, dst_w])
                            job_state["completedWells"] = len(job_state["completedPairs"])
                            _ROBOT_HW["currentPosition"] = f"plate{dst_plate} {dst_code}"
                            _ROBOT_HW["currentZ"] = int(getattr(zm, "pos", None) or getattr(zm, "ZeusTraversePosition", 880))
                            _ROBOT_HW["lastActivityMono"] = time.monotonic()
                        else:
                            job_state["state"] = "completed"
                            job_state["currentWell"] = None
                            job_state["currentPair"] = None
                            job_state["message"] = f"Completed all {len(pairs)} wells (plate{src_plate} {src_name} → plate{dst_plate} {dst_name})."
                        if clean["drop_tip_at_end"] and (getattr(zm, "tip_on_zeus", "") or ""):
                            pt.discard_tip()
                            _ROBOT_HW["currentTip"] = ""
                            _ROBOT_HW["currentPosition"] = "Trash bin"
                    except Exception as exc:
                        try:
                            zm.move_zeus_to_traverse_height()
                        except Exception:
                            pass
                        job_state["state"] = "error"
                        job_state["failedWell"] = job_state.get("currentWell")
                        job_state["failedPair"] = job_state.get("currentPair")
                        job_state["error"] = str(exc)
                        job_state["message"] = f"Stopped with error at well #{job_state.get('currentWell')}: {exc}"
                        _ROBOT_HW["lastError"] = str(exc)
                    finally:
                        job_state["active"] = False
                        job_state["finishedAt"] = datetime.now(timezone.utc).isoformat()
                        _ROBOT_HW["busy"] = False
                        _ROBOT_HW["lastActivityMono"] = time.monotonic()
                        _ROBOT_HW_LOCK.release()

                threading.Thread(target=_local_worker, daemon=True).start()
                result_data["plateTransfer"] = copy.deepcopy(job_state)
                human_msg = f"Started plate-to-plate transfer: {len(pairs)} wells ({vol_ul:g} µL {clean['solvent']}, plate{src_plate} → plate{dst_plate})."
            elif cmd == "move_xy_rel":
                gt.move_xy_rel((clean["dx"], clean["dy"]))
                cur_xy = _ROBOT_HW.get("currentXY")
                if isinstance(cur_xy, list) and len(cur_xy) == 2:
                    _ROBOT_HW["currentXY"] = [round(float(cur_xy[0]) + clean["dx"], 3), round(float(cur_xy[1]) + clean["dy"], 3)]
                _read_local_gantry_xy(gt)
                result_data["xy"] = _ROBOT_HW.get("currentXY")
                _ROBOT_HW["currentPosition"] = f"Jogged ({clean['dx']:+.1f}, {clean['dy']:+.1f}) mm"
                human_msg = f"Moved arm by X {clean['dx']:+.1f} mm, Y {clean['dy']:+.1f} mm."
            elif cmd == "move_z":
                zm.move_z(clean["z"])
                _ROBOT_HW["currentZ"] = clean["z"]
                result_data["zPosition"] = clean["z"]
                human_msg = f"Moved pipette height to z = {clean['z']} ({clean['z'] / 10:.1f} mm)."
            elif cmd == "move_z_rel":
                cur_z = int(getattr(zm, "pos", None) or _ROBOT_HW.get("currentZ") or getattr(zm, "ZeusTraversePosition", 880))
                new_z = max(500, min(2200, cur_z + clean["dz"]))
                zm.move_z(new_z)
                _ROBOT_HW["currentZ"] = new_z
                result_data["zPosition"] = new_z
                direction = "Lowered" if clean["dz"] > 0 else "Raised"
                human_msg = f"{direction} tip to z = {new_z} ({new_z / 10:.1f} mm)."
            elif cmd == "check_liquid_level":
                c = brb.plate_list[clean["plate_id"]].containers[clean["container_id"]]
                res = pt.check_volume_in_container(c)
                surf = res[0] if isinstance(res, tuple) and len(res) >= 1 else getattr(c, "liquid_surface_height", None)
                true_ul = (
                    round(max(0.0, ((float(c.bottomPosition) - float(surf)) / 10.0) * float(c.area)), 1)
                    if surf and hasattr(c, "bottomPosition") and hasattr(c, "area")
                    else None
                )
                result_data["surfaceHeightZ"] = surf
                result_data["volumeUl"] = true_ul
                _ROBOT_HW["currentTip"] = "300ul"
                if not surf:
                    human_msg = f"No liquid detected in plate{clean['plate_id']} pos {clean['container_id']} (bottle may be empty or non-conductive solvent)."
                else:
                    ml_str = f" (~{round(true_ul / 1000.0, 2)} mL)" if true_ul is not None else ""
                    human_msg = f"Measured plate{clean['plate_id']} pos {clean['container_id']}: height z={surf}{ml_str}."
            elif cmd == "balance_door_open":
                pt.open_balance_door()
                human_msg = "Opened balance chamber door."
            elif cmd == "balance_door_close":
                pt.close_balance_door()
                human_msg = "Closed balance chamber door."
            elif cmd == "balance_tare":
                pt.balance_tare()
                human_msg = "Tared analytical balance to 0.000 g."
            elif cmd == "balance_read":
                w = pt.balance_stable_value()
                result_data["weightGrams"] = w
                human_msg = f"Stable balance reading: {w} g."
            elif cmd == "read_instrument_status":
                z_pos = zm.getAbsoluteZPosition()
                if isinstance(z_pos, (int, float)):
                    _ROBOT_HW["currentZ"] = int(z_pos)
                tip_on = bool(zm.getTipPresenceStatus())
                err_code = zm.getErrorCode()
                result_data = {"zPosition": z_pos, "tipPresent": tip_on, "errorCode": err_code}
                human_msg = f"Zeus Z={z_pos}, tip {'attached' if tip_on else 'none'}, error={err_code or 'none'}."

        _ROBOT_HW["lastError"] = None
        return {
            "ok": True,
            "executed": True,
            "command": cmd,
            "humanMessage": human_msg,
            "pythonSnippet": snippet,
            "data": result_data,
            "hardware": _hardware_state_snapshot(),
        }
    except Exception as exc:
        _ROBOT_HW["lastError"] = str(exc)
        return {
            "ok": False,
            "executed": True,
            "command": cmd,
            "humanMessage": f"Could not complete '{desc}': {exc}",
            "pythonSnippet": snippet,
            "error": str(exc),
            "hardware": _hardware_state_snapshot(),
        }
    finally:
        pt_active = isinstance(_ROBOT_HW.get("plateTransfer"), dict) and bool(_ROBOT_HW["plateTransfer"].get("active"))
        if not pt_active:
            _ROBOT_HW["busy"] = False
            if _ROBOT_HW.get("connected") or _ROBOT_HW.get("nanodropConnected"):
                _ROBOT_HW["lastActivityMono"] = time.monotonic()
            _ROBOT_HW_LOCK.release()


if __name__ == "__main__":
    import uvicorn

    host = os.environ.get("ROBOWSKI_HOST", "127.0.0.1")
    port = int(os.environ.get("PORT", "8000"))
    uvicorn.run("app:app", host=host, port=port, reload=False)
