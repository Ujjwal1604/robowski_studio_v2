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

import csv
import io
import json
import os
import re
import sqlite3
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, List, Optional

import numpy as np
from fastapi import FastAPI, File, Form, HTTPException, Request, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, PlainTextResponse, Response
from openpyxl import Workbook
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


if __name__ == "__main__":
    import uvicorn

    host = os.environ.get("ROBOWSKI_HOST", "127.0.0.1")
    port = int(os.environ.get("PORT", "8000"))
    uvicorn.run("app:app", host=host, port=port, reload=False)
