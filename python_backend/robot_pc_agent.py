#!/usr/bin/env python3
"""
Robowski Studio — Tiny Robot PC Background Helper
=================================================
Run this single file on the ROBOT PC (just double-click start_robot_helper_windows.bat).

Required 1-time setup files (save next to this script):
  - `server_url.txt`  : Your Personal Lab PC backend URL (e.g. https://your-pc.ts.net or http://192.168.1.50:8000)
  - `relay_token.txt` : A shared secret phrase (must match `relay_token.txt` / `ROBOWSKI_RELAY_TOKEN` on your Personal PC)
  - `robot_pin.txt`   : Optional on Robot PC if you unlock via Personal PC PIN + signed relay token;
                        keep `robot_pin.txt` on your Personal PC (6+ characters recommended).

How it finds your active Excel run:
  1. Automatically reads the exact `.xlsx` file Robowski itself just opened from `main_roboski2.log`
     (even if you saved that Excel file on your Desktop or anywhere else!).
  2. Also scans `ROBOCHEM_DATA_PATH` and any extra folders listed in an optional `watch_folders.txt` next to this file.
  3. Live buttons and tip-rack counts work completely fine even if there is no Excel file at all.
"""

from __future__ import annotations

import argparse
import copy
import hmac
import json
import math
import os
import re
import sys
import threading
import time
import urllib.error
import urllib.request
from datetime import datetime, timezone
from pathlib import Path
from types import SimpleNamespace
from typing import Any, Dict, List, Optional, Tuple

try:
    import openpyxl  # Already installed on Robowski PCs
except ImportError:
    openpyxl = None  # type: ignore

SCRIPT_DIR = Path(__file__).resolve().parent
if str(SCRIPT_DIR) not in sys.path:
    sys.path.insert(0, str(SCRIPT_DIR))

from robot_safety import (  # noqa: E402
    ALLOWED_COMMANDS as _ALLOWED_COMMANDS,
    ALLOWED_SOLVENTS as _ALLOWED_SOLVENTS,
    COMMANDS_ALLOWED_WITHOUT_HOMING as _COMMANDS_ALLOWED_WITHOUT_HOMING,
    MAX_CUSTOM_PRESETS as _MAX_CUSTOM_PRESETS,
    PinRateLimiter,
    apply_custom_xy_to_container as _apply_custom_xy_to_container,
    compute_preset_well_xy as _compute_preset_well_xy,
    format_well_name as _format_well_name,
    normalize_plate_preset as _normalize_plate_preset,
    resolve_and_validate_tip_and_volume,
    validate_robot_command_params,
    validate_solvent,
    verify_relay_command,
)


def _read_optional_text_file(filename: str) -> str:
    p = SCRIPT_DIR / filename
    if not p.exists() or not p.is_file():
        return ""
    try:
        for line in p.read_text(encoding="utf-8", errors="replace").splitlines():
            clean = line.strip()
            if clean and not clean.startswith("#"):
                return clean
    except OSError:
        return ""
    return ""


DEFAULT_BACKEND_URL = (
    os.environ.get("ROBOWSKI_BACKEND_URL", "").strip()
    or _read_optional_text_file("server_url.txt")
).strip().rstrip("/")

_BOTTLE_BOTTOM_Z = 2180.0
_BOTTLE_AREA_MM2 = (24.6 ** 2) * 3.14 / 4.0  # 475.0506 mm^2 (breadboard.py)
_JAR_BOTTOM_Z = 2120.0
_JAR_AREA_MM2 = 2122.0


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


def _read_optional_folder_list(filename: str) -> List[Path]:
    p = SCRIPT_DIR / filename
    if not p.exists() or not p.is_file():
        return []
    folders: List[Path] = []
    try:
        for line in p.read_text(encoding="utf-8", errors="replace").splitlines():
            clean = line.strip().strip('"').strip("'")
            if not clean or clean.startswith("#"):
                continue
            cand = Path(clean).expanduser()
            if cand.exists() and cand.is_dir():
                folders.append(cand.resolve())
    except OSError:
        return []
    return folders


class _SimContainer:
    def __init__(self, x: float, y: float, bottom_z: int = 2180) -> None:
        self.xy = [round(x, 3), round(y, 3)]
        self.x = self.xy[0]
        self.y = self.xy[1]
        self.liquid_surface_height = 1900
        self.bottom_z = bottom_z
        self.containerGeometryTableIndex = 1


class _SimPlate:
    def __init__(self, count: int, origin_x: float, origin_y: float, cols: int, pitch: float, bottom_z: int) -> None:
        self.containers = [
            _SimContainer(origin_x + (i % cols) * pitch, origin_y - (i // cols) * pitch, bottom_z=bottom_z)
            for i in range(count)
        ]


class _SimBreadboard:
    def __init__(self) -> None:
        self.plate_list = [
            _SimPlate(54, -264.0, -325.0, 9, 12.2, 2190),
            _SimPlate(54, -129.0, -325.0, 9, 12.2, 2190),
            _SimPlate(54, -264.0, -225.0, 9, 12.2, 2190),
            _SimPlate(8, -124.0, -240.0, 4, 29.0, 2180),
            _SimPlate(8, -259.0, -140.0, 4, 29.0, 2180),
            _SimPlate(8, -124.0, -140.0, 4, 29.0, 2180),
            _SimPlate(2, -240.0, -61.0, 2, 48.0, 2120),
            _SimPlate(2, -105.0, -61.0, 2, 48.0, 2120),
        ]
        self.trash = _SimContainer(-380.0, -160.0)
        self.balance_location = _SimContainer(-335.0, -359.0)
        self.nanodrop_pedestal = _SimContainer(-335.0, -314.0)


class _SimZeus:
    ZeusTraversePosition = 880

    def __init__(self) -> None:
        self.pos = 880
        self.tip_on_zeus = ""
        self.emergency_stopped = False

    def getTipPresenceStatus(self) -> bool:
        return bool(self.tip_on_zeus)

    def setEmergencyStop(self, value: int) -> None:
        self.emergency_stopped = bool(value)

    def move_zeus_to_traverse_height(self) -> None:
        self.pos = self.ZeusTraversePosition

    def moveZDrive(self, z: int) -> None:
        z_int = int(z)
        if not (500 <= z_int <= 2200):
            raise RuntimeError(f"[SIM] Z={z_int} outside safe 500–2200 range.")
        self.pos = z_int

    def move_z(self, z: int) -> None:
        self.moveZDrive(z)

    def getAbsoluteZPosition(self) -> int:
        return int(self.pos)

    def getZPosition(self) -> int:
        return int(self.pos)


class _SimGantry:
    def __init__(self, zm: _SimZeus) -> None:
        self.zm = zm
        self.xy = [0.0, 0.0]

    def _check_safe_xy(self, x: float, y: float, ensure_traverse_height: bool = False) -> None:
        if ensure_traverse_height:
            self.zm.move_zeus_to_traverse_height()
        if self.zm.pos > 950:
            raise RuntimeError(
                f"[SIM] Sideways XY crash prevented: Z={self.zm.pos} is below safe traverse height (880). Lift arm first."
            )
        if not (-440.0 <= x <= 10.0 and -420.0 <= y <= 10.0):
            raise RuntimeError(f"[SIM] Target ({x:.1f}, {y:.1f} mm) is outside safe deck bounds.")

    def home_xy(self) -> None:
        self.zm.move_zeus_to_traverse_height()
        self.xy = [0.0, 0.0]

    def kill_alarm(self) -> None:
        self.zm.emergency_stopped = False

    def move_xy(self, xy: Any, ensure_traverse_height: bool = True) -> None:
        nx, ny = float(xy[0]), float(xy[1])
        self._check_safe_xy(nx, ny, ensure_traverse_height=ensure_traverse_height)
        self.xy = [round(nx, 3), round(ny, 3)]

    def move_to_xy(self, xy: Any) -> None:
        self.move_xy(xy, ensure_traverse_height=True)

    def move_xy_relative(self, dx: float, dy: float) -> None:
        nx, ny = self.xy[0] + float(dx), self.xy[1] + float(dy)
        self._check_safe_xy(nx, ny, ensure_traverse_height=False)
        self.xy = [round(nx, 3), round(ny, 3)]

    def move_xy_rel(self, delta: Any) -> None:
        self.move_xy_relative(float(delta[0]), float(delta[1]))

    def move_to_trash_bin(self) -> None:
        self.move_xy([-380.0, -160.0], ensure_traverse_height=True)

    def get_xy(self) -> List[float]:
        return [self.xy[0], self.xy[1]]


class _SimPipetter:
    def __init__(self, zeus: _SimZeus, gantry: _SimGantry) -> None:
        self.zm = zeus
        self.gt = gantry
        self.balance = None

    def pick_tip(self, tip_type: str) -> None:
        if self.zm.tip_on_zeus:
            raise RuntimeError(f"[SIM] Double tip-pick prevented: {self.zm.tip_on_zeus} tip already attached.")
        self.zm.move_zeus_to_traverse_height()
        self.zm.tip_on_zeus = tip_type

    def discard_tip(self) -> None:
        self.gt.move_to_trash_bin()
        self.zm.tip_on_zeus = ""

    def change_tip(self, tip_type: str) -> None:
        if self.zm.tip_on_zeus:
            self.discard_tip()
        self.pick_tip(tip_type)

    def move_to_container(self, container: Any) -> None:
        self.gt.move_xy(container.xy, ensure_traverse_height=True)

    def move_to_idle_position(self) -> None:
        self.gt.move_xy([-300.0, -390.0], ensure_traverse_height=True)

    def move_to_balance(self) -> None:
        self.gt.move_xy([-335.0, -359.0], ensure_traverse_height=True)

    def transfer_liquid(self, transfer_event: Any, purpose: str = "reaction", use_calibration: bool = False) -> None:
        src = transfer_event.source_container
        dst = transfer_event.destination_container
        if int(getattr(src, "liquid_surface_height", 1900)) > int(getattr(src, "bottom_z", 2190)):
            raise RuntimeError("[SIM] Source Z exceeds container bottom floor.")
        if int(getattr(dst, "liquid_surface_height", 2100)) > int(getattr(dst, "bottom_z", 2190)):
            raise RuntimeError("[SIM] Destination Z exceeds container bottom floor.")
        self.gt.move_xy(src.xy, ensure_traverse_height=True)
        self.zm.moveZDrive(int(getattr(src, "liquid_surface_height", 1900)))
        self.zm.move_zeus_to_traverse_height()
        self.gt.move_xy(dst.xy, ensure_traverse_height=True)
        self.zm.moveZDrive(int(getattr(dst, "liquid_surface_height", 2100)))
        self.zm.move_zeus_to_traverse_height()


class _SimNanoDrop:
    def __init__(self, nd_id: str = "nd_2000c") -> None:
        self.nd_id = nd_id
        self.serial = object()
        self.lid_closed = True

    def open_lid(self) -> None:
        self.lid_closed = False

    def close_lid(self) -> None:
        self.lid_closed = True

    def half_open_lid(self) -> None:
        self.lid_closed = False

    def flush(self) -> None:
        pass

    def dry(self) -> None:
        pass

    def close_all(self) -> None:
        self.lid_closed = True


class RobotPcAgent:
    def __init__(
        self,
        server_url: str,
        interval_sec: float = 5.0,
        enable_hardware: bool = False,
        repo_path: str = "",
        relay_token: str = "",
        control_pin: str = "",
        simulate: bool = False,
    ) -> None:
        self.server_url = (server_url or "").strip().rstrip("/")
        self.interval_sec = max(2.0, float(interval_sec))
        self.simulate = bool(
            simulate or os.environ.get("ROBOWSKI_SIMULATE", "0").strip().lower() in {"1", "true", "yes"}
        )
        self.control_pin = (
            control_pin.strip()
            or os.environ.get("ROBOWSKI_CONTROL_PIN", "").strip()
            or _read_optional_text_file("robot_pin.txt")
        )
        self.relay_token = (
            relay_token.strip()
            or os.environ.get("ROBOWSKI_RELAY_TOKEN", "").strip()
            or _read_optional_text_file("relay_token.txt")
        )
        # Never allow unauthenticated live hardware control: requires either a relay_token
        # (for signed commands verified by the personal PC's PIN) or a local control_pin.
        has_auth = bool(self.control_pin or self.relay_token)
        self.enable_hardware = bool((enable_hardware or self.control_pin or self.simulate) and has_auth)
        self.repo_path = (
            repo_path.strip()
            or os.environ.get("ROBOWSKI_MAIN_FOLDER", "").strip()
            or os.environ.get("ROBOWSKI_REPO_PATH", "").strip()
            or _read_optional_text_file("robowski_folder.txt")
            or _read_optional_text_file("robowski_repo.txt")
        ).strip('"').strip("'")
        self._zeus_dir_checked = False
        self._cached_zeus_dir: Optional[Path] = None
        base_name = os.environ.get("PIPETTER_NAME", "Robowski#2").strip() or "Robowski#2"
        self.robot_name = f"{base_name} (Dry-Run Simulator)" if self.simulate else base_name
        self.requested_run_path: Optional[str] = None
        try:
            self.idle_release_sec = max(0, int(os.environ.get("ROBOWSKI_IDLE_RELEASE_SEC", "300").strip() or "300"))
        except ValueError:
            self.idle_release_sec = 300
        self._pin_limiter = PinRateLimiter(max_attempts=5, lockout_sec=300.0)
        self._hw_lock = threading.Lock()
        self._emergency_stop_flag = threading.Event()
        self._plate_transfer_stop = threading.Event()
        self._plate_transfer_thread: Optional[threading.Thread] = None
        self._cmd_thread: Optional[threading.Thread] = None
        self._active_cmd_id: Optional[str] = None
        self.hw: Dict[str, Any] = {
            "zm": None,
            "gt": None,
            "pt": None,
            "brb": None,
            "nd": None,
            "connected": False,
            "homed": False,
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

    def _presets_file(self) -> Path:
        return SCRIPT_DIR / "custom_plates.json"

    def _load_plate_presets(self) -> List[Dict[str, Any]]:
        fp = self._presets_file()
        if not fp.exists() or not fp.is_file():
            return []
        try:
            raw = json.loads(fp.read_text(encoding="utf-8"))
            items = raw.get("presets", []) if isinstance(raw, dict) else (raw if isinstance(raw, list) else [])
            out: List[Dict[str, Any]] = []
            for item in items:
                if isinstance(item, dict) and item.get("id") and item.get("cornerA1"):
                    out.append(item)
            return out
        except Exception:
            return []

    def _save_plate_presets(self, presets: List[Dict[str, Any]]) -> None:
        fp = self._presets_file()
        payload = {"version": 1, "presets": presets[:_MAX_CUSTOM_PRESETS]}
        fp.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")

    def _get_preset_by_id(self, preset_id: str) -> Optional[Dict[str, Any]]:
        pid = (preset_id or "").strip()
        if not pid or pid == "default_54":
            return None
        for p in self._load_plate_presets():
            if p.get("id") == pid:
                return p
        return None

    def _resolve_plate_container(
        self, brb: Any, plate_id: int, slot_id: int, preset_id: str = ""
    ) -> Tuple[Any, str, int, int, str]:
        pid = (preset_id or "").strip()
        if plate_id <= 2 and pid and pid != "default_54":
            preset = self._get_preset_by_id(pid)
            if preset is None:
                raise RuntimeError(f"Plate preset '{pid}' was not found on the Robot PC.")
            if int(preset.get("plateSlot", -1)) != plate_id:
                raise RuntimeError(
                    f"Plate preset '{preset.get('name', pid)}' is calibrated for plate{preset.get('plateSlot')}, not plate{plate_id}."
                )
            rows = int(preset["rows"])
            cols = int(preset["cols"])
            xy = _compute_preset_well_xy(preset, slot_id)
            c = copy.deepcopy(brb.plate_list[plate_id].containers[0])
            _apply_custom_xy_to_container(c, xy)
            return (c, f"{_format_well_name(slot_id, cols)} (#{slot_id})", rows, cols, str(preset["name"]))

        max_c = 53 if plate_id <= 2 else (7 if plate_id <= 5 else 1)
        if not (0 <= slot_id <= max_c):
            raise RuntimeError(f"Slot {slot_id} is out of range for plate{plate_id} (0–{max_c}).")
        c = copy.deepcopy(brb.plate_list[plate_id].containers[slot_id])
        if plate_id <= 2:
            return (c, f"{_format_well_name(slot_id, 9)} (#{slot_id})", 6, 9, "54-vial (6×9)")
        return (c, f"pos {slot_id}", 1, max_c + 1, f"plate{plate_id}")

    def _read_gantry_xy(self, gt: Any) -> Optional[List[float]]:
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
                                self.hw["currentXY"] = res
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
                            self.hw["currentXY"] = res
                            return res
                    except Exception:
                        pass
        cur = self.hw.get("currentXY")
        if isinstance(cur, list) and len(cur) == 2:
            return [round(float(cur[0]), 3), round(float(cur[1]), 3)]
        return None

    def _data_dir(self) -> Optional[Path]:
        raw = os.environ.get("ROBOCHEM_DATA_PATH", "").strip()
        if not raw:
            return None
        p = Path(raw).expanduser()
        return p.resolve() if p.exists() and p.is_dir() else None

    def _watch_roots(self) -> List[Path]:
        roots: List[Path] = []
        d = self._data_dir()
        if d is not None:
            roots.append(d)
        for extra in _read_optional_folder_list("watch_folders.txt"):
            if extra not in roots:
                roots.append(extra)
        return roots

    def _find_tip_rack_json(self, data_dir: Optional[Path]) -> Optional[Path]:
        sub = "roboski1" if "1" in self.robot_name else "roboski2"
        other = "roboski2" if sub == "roboski1" else "roboski1"
        candidates: List[Path] = []
        status_env = os.environ.get("ROBOWSKI_STATUS_PATH", "").strip()
        if status_env:
            candidates.append(Path(status_env).expanduser() / "tip_rack.json")
        if data_dir is not None:
            candidates.append(data_dir / "pipetter_files" / sub / "tip_rack.json")
            candidates.append(data_dir / "pipetter_files" / "tip_rack.json")
            candidates.append(data_dir / "pipetter_files" / other / "tip_rack.json")
            candidates.append(data_dir.parent / "pipetter_files" / sub / "tip_rack.json")
            candidates.append(data_dir.parent / "pipetter_files" / "tip_rack.json")
        zeus_dir = self._find_zeus_dir()
        if zeus_dir is not None:
            candidates.append(zeus_dir / "tip_rack.json")
        for c in candidates:
            if c.exists() and c.is_file():
                return c.resolve()
        return None

    def _find_log_file(self, data_dir: Optional[Path]) -> Optional[Path]:
        log_env = os.environ.get("ROBOWSKI_LOG_PATH", "").strip()
        if log_env:
            p = Path(log_env).expanduser()
            if p.exists() and p.is_file():
                return p.resolve()
        candidates: List[Path] = []
        if data_dir is not None:
            for pf in (data_dir.parent / "pipetter_files", data_dir / "pipetter_files"):
                if pf.exists() and pf.is_dir():
                    candidates.extend(
                        [pf / "main_roboski2.log", pf / "main_roboski1.log", pf / "main.log"]
                    )
                    candidates.extend(
                        sorted(pf.glob("*.log"), key=lambda x: x.stat().st_mtime, reverse=True)
                    )
        for c in candidates:
            if c.exists() and c.is_file():
                return c.resolve()
        return None

    def _extract_logged_excel_path(self, raw_log_lines: List[str]) -> Optional[Path]:
        """Reads the exact Excel file path that Robowski's planner.py logged it is currently running."""
        for line in reversed(raw_log_lines):
            m = re.search(r"Interpretating dataframe_filename from\s+(.+?\.xlsx)", line, re.IGNORECASE)
            if not m:
                continue
            raw_path = m.group(1).strip().strip('"').strip("'")
            cand = Path(raw_path).expanduser()
            try:
                resolved = cand.resolve()
                if resolved.exists() and resolved.is_file() and resolved.suffix.lower() == ".xlsx":
                    return resolved
            except OSError:
                continue
        return None

    def _read_tip_racks(self, data_dir: Optional[Path]) -> List[Dict[str, Any]]:
        path = self._find_tip_rack_json(data_dir)
        if path is None:
            return []
        try:
            data = json.loads(path.read_text(encoding="utf-8", errors="replace"))
        except Exception:
            return []
        out: List[Dict[str, Any]] = []
        for tt in ("50ul", "300ul", "1000ul"):
            rack = data.get(tt)
            if not isinstance(rack, dict) or not isinstance(rack.get("tips"), list):
                continue
            tips = rack["tips"]
            total = len(tips)
            rem = sum(1 for t in tips if isinstance(t, dict) and t.get("exists") is True)
            out.append({"tipType": tt, "remaining": rem, "total": total, "used": max(0, total - rem)})
        return out

    def _list_recent_runs(self, roots: List[Path], logged_xlsx: Optional[Path], limit: int = 12) -> List[Dict[str, Any]]:
        found: List[tuple[float, Path, Path]] = []
        seen_paths: set[str] = set()

        if logged_xlsx is not None:
            try:
                seen_paths.add(str(logged_xlsx))
                found.append((logged_xlsx.stat().st_mtime + 1.0, logged_xlsx, logged_xlsx.parent))
            except OSError:
                pass

        for root_dir in roots:
            root_depth = len(root_dir.parts)
            for root, dirs, files in os.walk(root_dir):
                cur = Path(root)
                if len(cur.parts) - root_depth > 4:
                    dirs[:] = []
                    continue
                dirs[:] = [d for d in dirs if not d.startswith(".") and d not in {"__pycache__", "node_modules"}]
                for fname in files:
                    if not fname.lower().endswith(".xlsx") or fname.startswith("~$"):
                        continue
                    fp = (cur / fname).resolve()
                    if str(fp) in seen_paths:
                        continue
                    try:
                        seen_paths.add(str(fp))
                        found.append((fp.stat().st_mtime, fp, root_dir))
                    except OSError:
                        continue

        found.sort(key=lambda item: item[0], reverse=True)
        out: List[Dict[str, Any]] = []
        for _, fp, base in found[:limit]:
            try:
                rel = str(fp.relative_to(base)).replace("\\", "/")
            except ValueError:
                rel = fp.name
            try:
                mtime = fp.stat().st_mtime
            except OSError:
                continue
            out.append(
                {
                    "fileName": fp.name,
                    "relativePath": rel,
                    "updatedIso": datetime.fromtimestamp(mtime, tz=timezone.utc).isoformat(),
                }
            )
        return out

    def _resolve_allowed_xlsx(
        self, roots: List[Path], logged_xlsx: Optional[Path], rel_path: str
    ) -> Optional[Path]:
        if not rel_path or "\x00" in rel_path:
            return None
        if logged_xlsx is not None and (rel_path == logged_xlsx.name or rel_path == str(logged_xlsx)):
            return logged_xlsx
        for base in roots:
            cand = (base / rel_path).resolve()
            root_str = str(base)
            cand_str = str(cand)
            if not (cand_str == root_str or cand_str.startswith(root_str + os.sep)):
                continue
            if cand.exists() and cand.is_file() and cand.suffix.lower() == ".xlsx":
                return cand
        return None

    def _parse_run_xlsx(self, xlsx_path: Path, base_dir: Optional[Path]) -> Optional[Dict[str, Any]]:
        if openpyxl is None:
            return None
        try:
            wb = openpyxl.load_workbook(xlsx_path, read_only=True, data_only=True)
        except Exception:
            return None
        try:
            sheet_name = None
            for cand in ("reactions_with_run_info", "reactions"):
                if cand in wb.sheetnames:
                    sheet_name = cand
                    break
            if sheet_name is None:
                return None

            ws = wb[sheet_name]
            rows_iter = ws.iter_rows(values_only=True)
            header_row = next(rows_iter, None)
            if not header_row:
                return None
            headers = [str(h).strip() if h is not None else "" for h in header_row]
            h_idx = {h: i for i, h in enumerate(headers) if h}
            vol_subs = [h[4:] for h in headers if h.startswith("vol#") and len(h) > 4]

            total_vials = completed_vials = in_progress_vials = not_started_vials = 0
            well_states: List[str] = []
            sub_done: Dict[str, int] = {s: 0 for s in vol_subs}
            sub_total: Dict[str, int] = {s: 0 for s in vol_subs}
            plate_barcode: Optional[str] = None
            dilution_barcodes: List[str] = []
            reaction_duration: Optional[float] = None

            for row in rows_iter:
                if row is None or all(v is None for v in row):
                    continue
                total_vials += 1
                raw_status = (
                    str(row[h_idx["status"]]).strip().lower()
                    if "status" in h_idx and h_idx["status"] < len(row) and row[h_idx["status"]] is not None
                    else "not_started"
                )
                if raw_status == "completed":
                    completed_vials += 1
                    well_states.append("completed")
                elif raw_status in {"in_progress", "running", "partial"}:
                    in_progress_vials += 1
                    well_states.append("in_progress")
                else:
                    not_started_vials += 1
                    well_states.append("not_started")

                if plate_barcode is None and "plate_barcode" in h_idx and h_idx["plate_barcode"] < len(row):
                    val = row[h_idx["plate_barcode"]]
                    if val is not None and str(val).strip():
                        plate_barcode = str(val).strip()

                if not dilution_barcodes and "plate_barcodes_for_dilution" in h_idx:
                    idx = h_idx["plate_barcodes_for_dilution"]
                    if idx < len(row) and row[idx] is not None:
                        s_val = str(row[idx]).strip()
                        if s_val:
                            dilution_barcodes = [p.strip() for p in re.split(r"[,;|\s]+", s_val) if p.strip()]

                if reaction_duration is None and "reaction_duration" in h_idx:
                    idx = h_idx["reaction_duration"]
                    if idx < len(row) and row[idx] is not None:
                        try:
                            reaction_duration = float(row[idx])
                        except (TypeError, ValueError):
                            pass

                if "full_status" in h_idx and h_idx["full_status"] < len(row) and row[h_idx["full_status"]]:
                    try:
                        fs = json.loads(str(row[h_idx["full_status"]]))
                        if isinstance(fs, dict):
                            for s_name, s_val in fs.items():
                                st = s_val[0] if isinstance(s_val, list) and s_val else s_val
                                sub_total[s_name] = sub_total.get(s_name, 0) + 1
                                if str(st).lower() == "completed":
                                    sub_done[s_name] = sub_done.get(s_name, 0) + 1
                    except Exception:
                        pass

            stocks_live: List[Dict[str, Any]] = []
            if "stock_solutions" in wb.sheetnames:
                sws = wb["stock_solutions"]
                s_iter = sws.iter_rows(values_only=True)
                sh_row = next(s_iter, None)
                if sh_row:
                    s_headers = [str(h).strip() if h is not None else "" for h in sh_row]
                    si = {h: i for i, h in enumerate(s_headers) if h}
                    for srow in s_iter:
                        if srow is None or all(v is None for v in srow):
                            continue
                        sub_name = (
                            str(srow[si["substance"]]).strip()
                            if "substance" in si and si["substance"] < len(srow) and srow[si["substance"]] is not None
                            else ""
                        )
                        if not sub_name:
                            continue
                        plate_num = int(float(srow[si["breadboard_plate_id"]])) if "breadboard_plate_id" in si and srow[si["breadboard_plate_id"]] is not None else 3
                        cont_id = int(float(srow[si["container_id"]])) if "container_id" in si and srow[si["container_id"]] is not None else 0
                        solvent = str(srow[si["solvent"]]).strip() if "solvent" in si and srow[si["solvent"]] is not None else ""
                        init_ul = float(srow[si["volume"]]) if "volume" in si and srow[si["volume"]] is not None else 0.0
                        surf_z: Optional[float] = None
                        if "liquid_surface_height" in si and si["liquid_surface_height"] < len(srow) and srow[si["liquid_surface_height"]] is not None:
                            try:
                                surf_z = float(srow[si["liquid_surface_height"]])
                            except (TypeError, ValueError):
                                surf_z = None
                        rem_ul = init_ul
                        if surf_z is not None and surf_z > 0:
                            is_jar = plate_num >= 6
                            bottom_z = _JAR_BOTTOM_Z if is_jar else _BOTTLE_BOTTOM_Z
                            area = _JAR_AREA_MM2 if is_jar else _BOTTLE_AREA_MM2
                            rem_ul = max(0.0, ((bottom_z - surf_z) / 10.0) * area)
                        pct_rem = round(min(100.0, max(0.0, (rem_ul / init_ul) * 100.0)), 1) if init_ul > 0 else 0.0
                        stocks_live.append(
                            {
                                "substance": sub_name,
                                "plate": plate_num,
                                "containerId": cont_id,
                                "solvent": solvent,
                                "initialVolumeUl": round(init_ul, 1),
                                "remainingVolumeUl": round(rem_ul, 1),
                                "surfaceHeightZ": round(surf_z, 1) if surf_z is not None else None,
                                "percentRemaining": pct_rem,
                            }
                        )

            substances = []
            for s_name in (vol_subs or list(sub_done.keys())):
                tot = max(sub_total.get(s_name, 0), sub_done.get(s_name, 0))
                dn = sub_done.get(s_name, 0)
                if tot <= 0:
                    continue
                substances.append(
                    {"substance": s_name, "completed": dn, "total": tot, "percent": round((dn / tot) * 100.0, 1)}
                )

            pct_complete = (
                round(((completed_vials + 0.5 * in_progress_vials) / total_vials) * 100.0, 1)
                if total_vials > 0
                else 0.0
            )
            try:
                rel = str(xlsx_path.resolve().relative_to(base_dir.resolve())).replace("\\", "/") if base_dir else xlsx_path.name
            except ValueError:
                rel = xlsx_path.name
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

    def _tail_log(self, log_file: Path, max_lines: int = 80) -> List[str]:
        try:
            with log_file.open("rb") as f:
                f.seek(0, os.SEEK_END)
                size = f.tell()
                f.seek(max(0, size - 64 * 1024), os.SEEK_SET)
                raw = f.read().decode("utf-8", errors="replace")
            return [ln for ln in raw.splitlines() if ln.strip()][-max_lines:]
        except Exception:
            return []

    def _translate_log(self, raw: str) -> Dict[str, Any]:
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
            summary = f"Pre-wetting tip with {m.group(1)} µL of {m.group(2).strip()}" if m else "Pre-wetting new tip"
        elif "prewet done" in lower:
            summary = "Tip pre-wet finished — continuing pipetting"
        elif "all reactions are done" in lower or "all events are completed" in lower:
            summary = "Run complete — all planned pipetting steps finished"
        elif "all dilution(s) are done" in lower or "all dilutions are done" in lower:
            summary = "All post-reaction plate dilutions are complete"
        else:
            parts = line.split(" - ")
            if len(parts) >= 4:
                summary = " - ".join(parts[3:]).strip()
        return {"timestamp": timestamp, "level": level, "summary": summary, "raw": line}

    def _disconnect_nanodrop(self) -> None:
        nd = self.hw.get("nd")
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
        self.hw["nd"] = None
        self.hw["nanodropConnected"] = False
        self.hw["nanodropLidClosed"] = True

    def _disconnect_hardware(self, position_label: str = "Disconnected (USB free for main.py)") -> None:
        self._disconnect_nanodrop()
        pt = self.hw.get("pt")
        gt = self.hw.get("gt")
        zm = self.hw.get("zm")
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
        self.hw.update(
            {
                "zm": None,
                "gt": None,
                "pt": None,
                "brb": None,
                "connected": False,
                "homed": False,
                "currentPosition": position_label,
                "lastActivityMono": 0.0,
                "lastError": None,
            }
        )

    def _check_idle_auto_release(self) -> None:
        any_connected = bool(self.hw.get("connected") or self.hw.get("nanodropConnected"))
        if not any_connected or self.hw.get("busy") or self.idle_release_sec <= 0:
            return
        last_mono = float(self.hw.get("lastActivityMono") or 0.0)
        if last_mono <= 0.0:
            return
        if (time.monotonic() - last_mono) >= self.idle_release_sec:
            mins = max(1, round(self.idle_release_sec / 60))
            self._disconnect_hardware(f"USB auto-released after {mins} min idle (ready for main.py)")
            self.hw["lastCommand"] = "auto_release_idle"
            self.hw["lastCommandAt"] = datetime.now(timezone.utc).isoformat()
            print(f"[Robowski Helper] Auto-released USB, CAN & NanoDrop ports after {mins} min idle — ready for main.py.")

    def _hardware_snapshot(self) -> Dict[str, Any]:
        idle_rem: Optional[int] = None
        if (self.hw.get("connected") or self.hw.get("nanodropConnected")) and self.idle_release_sec > 0:
            last_mono = float(self.hw.get("lastActivityMono") or 0.0)
            elapsed = max(0.0, time.monotonic() - last_mono) if last_mono > 0 else 0.0
            idle_rem = max(0, int(round(self.idle_release_sec - elapsed)))
        pt_job = self.hw.get("plateTransfer")
        pt_snap = copy.deepcopy(pt_job) if isinstance(pt_job, dict) else None
        return {
            "controlEnabled": self.enable_hardware,
            "simulated": self.simulate,
            "pinProtected": bool(self.control_pin or self.relay_token),
            "relayTokenConfigured": bool(self.relay_token),
            "connected": bool(self.hw["connected"]),
            "homed": bool(self.hw.get("homed", False)),
            "nanodropConnected": bool(self.hw.get("nanodropConnected")),
            "nanodropId": str(self.hw.get("nanodropId") or "nd_2000c"),
            "nanodropLidClosed": bool(self.hw.get("nanodropLidClosed", True)),
            "busy": bool(self.hw["busy"]),
            "currentTip": str(self.hw["currentTip"] or ""),
            "currentPosition": str(self.hw["currentPosition"] or "Unknown"),
            "currentXY": self.hw.get("currentXY"),
            "currentZ": self.hw.get("currentZ"),
            "lastCommand": self.hw["lastCommand"],
            "lastCommandAt": self.hw["lastCommandAt"],
            "lastError": self.hw["lastError"],
            "idleReleaseSeconds": self.idle_release_sec,
            "idleSecondsRemaining": idle_rem,
            "plateTransfer": pt_snap,
            "platePresets": self._load_plate_presets(),
        }

    def collect_status(self) -> Dict[str, Any]:
        self._check_idle_auto_release()
        data_dir = self._data_dir()
        roots = self._watch_roots()
        log_file = self._find_log_file(data_dir)
        tip_racks = self._read_tip_racks(data_dir)

        raw_tail = self._tail_log(log_file, max_lines=80) if log_file is not None else []
        logged_xlsx = self._extract_logged_excel_path(raw_tail)
        available_runs = self._list_recent_runs(roots, logged_xlsx)

        active_run: Optional[Dict[str, Any]] = None
        target: Optional[Path] = None
        if self.requested_run_path:
            target = self._resolve_allowed_xlsx(roots, logged_xlsx, self.requested_run_path)
        if target is None and logged_xlsx is not None:
            target = logged_xlsx
        if target is None and available_runs:
            target = self._resolve_allowed_xlsx(roots, logged_xlsx, available_runs[0]["relativePath"])
        if target is not None:
            active_run = self._parse_run_xlsx(target, data_dir)

        recent_activity = [self._translate_log(ln) for ln in raw_tail[-25:]][::-1]

        last_updated_iso: Optional[str] = None
        seconds_ago: Optional[int] = None
        if log_file is not None:
            mtime = log_file.stat().st_mtime
            last_updated_iso = datetime.fromtimestamp(mtime, tz=timezone.utc).isoformat()
            seconds_ago = max(0, int(datetime.now(timezone.utc).timestamp() - mtime))

        state = "idle"
        headline = f"{self.robot_name} is idle and ready"
        detail = "No active pipetting job detected right now."

        if data_dir is None and log_file is None and not self.enable_hardware:
            state = "not_configured"
            headline = "ROBOCHEM_DATA_PATH was not found on this PC"
            detail = "Check that ROBOCHEM_DATA_PATH is set in Windows on the robot PC."
        elif self.hw["busy"]:
            state = "running"
            headline = f"{self.robot_name} is moving ({self.hw['lastCommand'] or 'command'})"
            detail = "Waiting for the current hardware action to finish."
        elif recent_activity and seconds_ago is not None and seconds_ago <= 180:
            latest = recent_activity[0]
            if latest["level"] == "error":
                state = "error"
                headline = f"{self.robot_name} stopped with an error"
                detail = latest["summary"]
            elif "waiting for you" in latest["summary"].lower() or "empty" in latest["summary"].lower():
                state = "waiting_user"
                headline = f"{self.robot_name} needs your help"
                detail = latest["summary"]
            elif "complete" in latest["summary"].lower() or "finished" in latest["summary"].lower():
                state = "idle"
                headline = latest["summary"]
                detail = f"Last log update {seconds_ago}s ago."
            else:
                state = "running"
                if active_run and active_run["totalVials"] > 0 and active_run["completedVials"] < active_run["totalVials"]:
                    headline = (
                        f"{self.robot_name} is running — {active_run['completedVials']} of "
                        f"{active_run['totalVials']} vials done ({active_run['percentComplete']}%)"
                    )
                else:
                    headline = f"{self.robot_name} is actively working"
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
                headline = f"{self.robot_name} is ready — {active_run['totalVials']} vials queued"
                detail = f"Latest workbook: {active_run['fileName']}"

        return {
            "ok": True,
            "robotName": self.robot_name,
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
            "hardware": self._hardware_snapshot(),
        }

    @staticmethod
    def _is_zeus_dir(folder: Path) -> bool:
        try:
            return folder.is_dir() and (folder / "pipetter.py").is_file() and (folder / "zeus.py").is_file()
        except OSError:
            return False

    def _find_zeus_dir(self) -> Optional[Path]:
        if self._zeus_dir_checked:
            return self._cached_zeus_dir
        self._zeus_dir_checked = True

        candidates: List[Path] = []
        if self.repo_path:
            p = Path(self.repo_path).expanduser()
            # Handle pasting the full path to main.py / pipetter.py OR its folder
            if p.suffix.lower() == ".py":
                p = p.parent
            candidates.extend([p, p / "zeus-pipetter", p.parent / "zeus-pipetter"])

        # Check next to this script or its parent
        candidates.extend(
            [
                SCRIPT_DIR / "zeus-pipetter",
                SCRIPT_DIR.parent / "zeus-pipetter",
                SCRIPT_DIR,
            ]
        )

        # Check near ROBOCHEM_DATA_PATH if set
        data_dir = self._data_dir()
        if data_dir is not None:
            candidates.extend(
                [
                    data_dir / "zeus-pipetter",
                    data_dir.parent / "zeus-pipetter",
                    data_dir.parent / "robowski" / "zeus-pipetter",
                ]
            )

        for c in candidates:
            if self._is_zeus_dir(c):
                self._cached_zeus_dir = c.resolve()
                return self._cached_zeus_dir

        # Fast shallow auto-search in common user folders so the helper can live anywhere
        skip_names = {
            ".git", ".hg", ".svn", "__pycache__", "node_modules", ".venv", "venv",
            "appdata", "windows", "program files", "program files (x86)", "programdata",
            "$recycle.bin", "system volume information", "anaconda3", "miniconda3", "conda",
        }
        home = Path.home()
        search_roots: List[Path] = [
            home / "Desktop",
            home / "Documents",
            home / "PycharmProjects",
            home / "Projects",
            home / "GitHub",
            home / "source" / "repos",
            home / "Downloads",
            home / "OneDrive" / "Desktop",
            home / "OneDrive" / "Documents",
            home,
        ]
        if os.name == "nt":
            for drive in ("C:/", "D:/", "E:/"):
                dp = Path(drive)
                if dp.exists():
                    search_roots.append(dp)

        visited: set[str] = set()

        def _scan(root: Path, depth: int) -> Optional[Path]:
            if depth < 0:
                return None
            try:
                resolved = str(root.resolve())
            except OSError:
                return None
            if resolved in visited:
                return None
            visited.add(resolved)
            if self._is_zeus_dir(root):
                return root.resolve()
            if depth == 0:
                return None
            try:
                entries = list(root.iterdir())
            except OSError:
                return None
            # Prioritize folders whose name hints at robowski / zeus / pipetter
            dirs = [
                e for e in entries
                if e.is_dir() and not e.is_symlink() and e.name.lower() not in skip_names
            ]
            dirs.sort(
                key=lambda d: (
                    0 if any(k in d.name.lower() for k in ("zeus", "robowski", "roboski", "pipet")) else 1,
                    d.name.lower(),
                )
            )
            for child in dirs:
                found = _scan(child, depth - 1)
                if found is not None:
                    return found
            return None

        for root in search_roots:
            if not root.exists() or not root.is_dir():
                continue
            max_depth = 2 if root in (home, Path("C:/"), Path("D:/"), Path("E:/")) else 3
            found = _scan(root, max_depth)
            if found is not None:
                self._cached_zeus_dir = found
                return self._cached_zeus_dir

        return None

    def _connect_hardware_only(self) -> None:
        """
        Connects to Zeus, Gantry, and Pipetter WITHOUT automatically calling home_xy().
        Homing must be triggered explicitly via Connect & Home / Home XY after checking tip presence.
        """
        if self.hw["connected"] and self.hw["pt"] is not None:
            return
        if self.simulate:
            brb = _SimBreadboard()
            zm = _SimZeus()
            gt = _SimGantry(zm=zm)
            pt = _SimPipetter(zeus=zm, gantry=gt)
            self.hw.update(
                {
                    "zm": zm,
                    "gt": gt,
                    "pt": pt,
                    "brb": brb,
                    "connected": True,
                    "homed": False,
                    "currentTip": "",
                    "currentPosition": "[SIM] Connected (not homed yet)",
                    "currentXY": [0.0, 0.0],
                    "currentZ": zm.pos,
                    "lastError": None,
                }
            )
            return
        zeus_dir = self._find_zeus_dir()
        if zeus_dir is not None:
            if str(zeus_dir) not in sys.path:
                sys.path.insert(0, str(zeus_dir))
            if zeus_dir.name.lower() == "zeus-pipetter" and str(zeus_dir.parent) not in sys.path:
                sys.path.insert(0, str(zeus_dir.parent))
            work_dir = zeus_dir
            if not (zeus_dir / "config").is_dir() and (zeus_dir.parent / "config").is_dir():
                work_dir = zeus_dir.parent
            try:
                os.chdir(str(work_dir))
            except OSError:
                pass
        try:
            import breadboard as brb  # type: ignore
            import pipetter  # type: ignore
            import zeus  # type: ignore
        except ImportError as exc:
            raise RuntimeError(
                "Could not find Robowski's main.py / pipetter.py folder automatically. "
                "Right-click start_robot_helper_windows.bat -> Edit, and paste the folder path of main.py "
                "into ROBOWSKI_MAIN_FOLDER= (or save that folder path in robowski_folder.txt next to this script)."
            ) from exc

        zm = zeus.ZeusModule(id=1)
        gt = pipetter.Gantry(zeus=zm)
        pt = pipetter.Pipetter(zeus=zm, gantry=gt)
        self.hw.update(
            {
                "zm": zm,
                "gt": gt,
                "pt": pt,
                "brb": brb,
                "connected": True,
                "homed": False,
                "currentTip": getattr(zm, "tip_on_zeus", "") or "",
                "currentPosition": "Connected (not homed yet)",
                "currentZ": getattr(zm, "pos", getattr(zm, "ZeusTraversePosition", 880)),
                "lastError": None,
            }
        )

    def _safe_home_xy(self, zm: Any, gt: Any) -> None:
        """
        Raises Z to traverse height and verifies no pipette tip is attached before homing XY.
        """
        if hasattr(zm, "move_zeus_to_traverse_height"):
            zm.move_zeus_to_traverse_height()
        tip_present = False
        try:
            if hasattr(zm, "getTipPresenceStatus"):
                tip_present = bool(zm.getTipPresenceStatus())
        except Exception:
            tip_present = False
        if tip_present or bool(getattr(zm, "tip_on_zeus", "")):
            raise RuntimeError(
                "Cannot home while a pipette tip is attached! "
                "Click 'Drop Tip' first (or remove the tip manually), then click 'Connect & Home'."
            )
        gt.home_xy()
        self.hw["homed"] = True
        self.hw["currentPosition"] = "Home (0, 0)"
        self.hw["currentXY"] = [0.0, 0.0]
        self.hw["currentZ"] = int(getattr(zm, "pos", None) or getattr(zm, "ZeusTraversePosition", 880))

    def trigger_emergency_stop(self, cmd_id: str = "") -> Dict[str, Any]:
        """
        Pre-emptive software stop: signals all running loops immediately and calls
        zm.setEmergencyStop(1) without waiting for the worker thread or hardware lock.
        Does NOT replace a physical E-stop switch on the hardware.
        """
        self._emergency_stop_flag.set()
        self._plate_transfer_stop.set()
        zm = self.hw.get("zm")
        hw_stopped = False
        stop_err: Optional[str] = None
        if zm is not None and hasattr(zm, "setEmergencyStop"):
            try:
                zm.setEmergencyStop(1)
                hw_stopped = True
            except Exception as exc:
                stop_err = str(exc)
        job = self.hw.get("plateTransfer")
        if isinstance(job, dict) and job.get("active"):
            job["message"] = "Software Stop triggered — halting transfer immediately."
        self.hw["lastCommand"] = "emergency_stop"
        self.hw["lastCommandAt"] = datetime.now(timezone.utc).isoformat()
        if stop_err:
            msg = f"Software Stop flag set, but Zeus reported: {stop_err}. Use the physical E-stop if the arm is still moving."
        elif hw_stopped:
            msg = "Software Stop sent immediately to Zeus pipetter (and all queued moves halted)."
        else:
            msg = "Software Stop flag set (Zeus was not connected)."
        return {
            "commandId": cmd_id,
            "ok": stop_err is None,
            "executed": True,
            "command": "emergency_stop",
            "humanMessage": msg,
            "error": stop_err,
            "hardware": self._hardware_snapshot(),
        }

    def _ensure_nanodrop(self, nd_id: str = "nd_2000c") -> Any:
        clean_id = "nd_2000" if nd_id == "nd_2000" else "nd_2000c"
        if self.hw.get("nanodropConnected") and self.hw.get("nd") is not None:
            if self.hw.get("nanodropId") == clean_id:
                return self.hw["nd"]
            self._disconnect_nanodrop()

        if self.simulate:
            nd = _SimNanoDrop(clean_id)
            self.hw["nd"] = nd
            self.hw["nanodropConnected"] = True
            self.hw["nanodropId"] = clean_id
            self.hw["nanodropLidClosed"] = True
            return nd

        zeus_dir = self._find_zeus_dir()
        if zeus_dir is not None:
            if str(zeus_dir) not in sys.path:
                sys.path.insert(0, str(zeus_dir))
            if zeus_dir.name.lower() == "zeus-pipetter" and str(zeus_dir.parent) not in sys.path:
                sys.path.insert(0, str(zeus_dir.parent))
        try:
            import nanodrop  # type: ignore
        except ImportError as exc:
            raise RuntimeError(
                "Could not find nanodrop.py in the Robowski folder. Check ROBOWSKI_MAIN_FOLDER in start_robot_helper_windows.bat."
            ) from exc

        nd = nanodrop.Nanodrop(clean_id)
        if not hasattr(nd, "serial") or getattr(nd, "serial", None) is None:
            port_hint = getattr(nd, "com_id", "COM6")
            raise RuntimeError(
                f"NanoDrop Arduino ({clean_id} on {port_hint}) did not connect. "
                "Check the USB cable and make sure measure_spectrum.py isn't already using that port."
            )
        self.hw["nd"] = nd
        self.hw["nanodropConnected"] = True
        self.hw["nanodropId"] = clean_id
        self.hw["nanodropLidClosed"] = bool(getattr(nd, "lid_closed", True))
        return nd

    def _resolve_liquid_class_index(self, solvent: str, tip_type: str) -> int:
        try:
            import config as robowski_cfg  # type: ignore

            lc_dict = getattr(robowski_cfg, "liquid_class_dict", {})
            if isinstance(lc_dict, dict):
                target_empty = {solvent, "empty", tip_type}
                for key, idx in lc_dict.items():
                    parts = set(str(key).split("_"))
                    if target_empty.issubset(parts):
                        return int(idx)
                target_loose = {solvent, tip_type}
                for key, idx in lc_dict.items():
                    parts = set(str(key).split("_"))
                    if target_loose.issubset(parts):
                        return int(idx)
        except Exception:
            pass
        return _FALLBACK_LIQUID_CLASS.get((solvent, tip_type), _FALLBACK_LIQUID_CLASS.get(("ethanol", tip_type), 13))

    def execute_command(
        self,
        cmd_id: str,
        cmd: str,
        params: Dict[str, Any],
        supplied_pin: str = "",
        verified_relay: bool = False,
    ) -> Dict[str, Any]:
        if not self.enable_hardware or cmd not in _ALLOWED_COMMANDS:
            return {
                "commandId": cmd_id,
                "ok": False,
                "executed": False,
                "command": cmd,
                "humanMessage": (
                    "Live robot buttons are locked. Configure relay_token.txt (on both PCs) "
                    "and robot_pin.txt on your Personal PC to unlock live control."
                ),
                "hardware": self._hardware_snapshot(),
            }

        # Direct (non-relayed) invocation still enforces PIN + 5-try / 5-min lockout
        if not verified_relay:
            if not self.control_pin:
                return {
                    "commandId": cmd_id,
                    "ok": False,
                    "executed": False,
                    "command": cmd,
                    "humanMessage": "Direct hardware execution requires a configured PIN or a signed relay command.",
                    "error": "Authentication required",
                    "hardware": self._hardware_snapshot(),
                }
            locked_sec = self._pin_limiter.check_locked("direct")
            if locked_sec is not None:
                return {
                    "commandId": cmd_id,
                    "ok": False,
                    "executed": False,
                    "command": cmd,
                    "humanMessage": f"Too many wrong PIN attempts. Locked for {locked_sec}s.",
                    "error": "PIN locked",
                    "hardware": self._hardware_snapshot(),
                }
            if not hmac.compare_digest((supplied_pin or "").strip(), self.control_pin):
                _tries, lock_now = self._pin_limiter.record_failure("direct")
                if lock_now is not None:
                    err_msg = f"Too many wrong PIN attempts. Locked for {lock_now}s."
                else:
                    err_msg = "Wrong or missing PIN. Type your PIN into the PIN box at the top right of Robot Commands."
                return {
                    "commandId": cmd_id,
                    "ok": False,
                    "executed": False,
                    "command": cmd,
                    "humanMessage": err_msg,
                    "error": "Invalid PIN",
                    "hardware": self._hardware_snapshot(),
                }
            self._pin_limiter.record_success("direct")

        # Software stop pre-empts EVERYTHING immediately without waiting for any lock
        if cmd == "emergency_stop":
            return self.trigger_emergency_stop(cmd_id)

        # Handle plate transfer graceful stop immediately even while transfer worker is active
        if cmd == "plate_transfer_stop":
            job = self.hw.get("plateTransfer")
            if isinstance(job, dict) and job.get("active"):
                self._plate_transfer_stop.set()
                job["message"] = "Stop requested — finishing current vial cleanly before halting..."
                return {
                    "commandId": cmd_id,
                    "ok": True,
                    "executed": True,
                    "command": cmd,
                    "humanMessage": "Stop requested — the robot will finish the current vial, raise to safe height, and stop cleanly.",
                    "data": {"plateTransfer": copy.deepcopy(job)},
                    "hardware": self._hardware_snapshot(),
                }
            return {
                "commandId": cmd_id,
                "ok": True,
                "executed": True,
                "command": cmd,
                "humanMessage": "No plate-to-plate transfer is running right now.",
                "hardware": self._hardware_snapshot(),
            }

        # Validate parameters strictly with shared safety module BEFORE touching hardware
        try:
            params = validate_robot_command_params(cmd, params)
        except ValueError as exc:
            return {
                "commandId": cmd_id,
                "ok": False,
                "executed": False,
                "command": cmd,
                "humanMessage": str(exc),
                "error": str(exc),
                "hardware": self._hardware_snapshot(),
            }

        active_job = self.hw.get("plateTransfer")
        if isinstance(active_job, dict) and active_job.get("active"):
            return {
                "commandId": cmd_id,
                "ok": False,
                "executed": False,
                "command": cmd,
                "humanMessage": "A plate-to-plate transfer is currently running. Click 'Stop After Current Vial' or 'Software Stop' before sending other moves.",
                "error": "Plate transfer active",
                "hardware": self._hardware_snapshot(),
            }

        if not self._hw_lock.acquire(blocking=False):
            return {
                "commandId": cmd_id,
                "ok": False,
                "executed": False,
                "command": cmd,
                "humanMessage": "The robot is currently executing another command. Wait for it to finish or click Software Stop.",
                "error": "Robot busy",
                "hardware": self._hardware_snapshot(),
            }

        self._emergency_stop_flag.clear()
        self.hw["busy"] = True
        self.hw["lastCommand"] = cmd
        self.hw["lastCommandAt"] = datetime.now(timezone.utc).isoformat()
        self.hw["lastActivityMono"] = time.monotonic()
        result_data: Dict[str, Any] = {}
        try:
            data_dir = self._data_dir()
            if cmd == "disconnect_hardware":
                self._disconnect_hardware("Disconnected (USB free for main.py)")
                msg = "Released robot USB, CAN & NanoDrop ports — you can now run main.py, diluter.py, or measure_spectrum.py normally."
            elif cmd == "nanodrop_disconnect":
                self._disconnect_nanodrop()
                msg = "Released NanoDrop Arduino COM port — measure_spectrum.py can now connect normally."
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
                nd_id = str(params.get("nd_id") or self.hw.get("nanodropId") or "nd_2000c")
                nd = self._ensure_nanodrop(nd_id)
                if cmd == "nanodrop_connect":
                    msg = f"Connected to NanoDrop ({self.hw['nanodropId']} on {getattr(nd, 'com_id', 'COM')})."
                elif cmd == "nanodrop_lid_open":
                    nd.open_lid()
                    self.hw["nanodropLidClosed"] = False
                    msg = "Opened NanoDrop pedestal lid."
                elif cmd == "nanodrop_lid_close":
                    nd.close_lid()
                    self.hw["nanodropLidClosed"] = True
                    msg = "Closed NanoDrop pedestal lid."
                elif cmd == "nanodrop_lid_half_open":
                    if hasattr(nd, "lid_full_close_to_half_open") and self.hw["nanodropId"] == "nd_2000c":
                        nd.lid_full_close_to_half_open()
                        self.hw["nanodropLidClosed"] = False
                        msg = "Moved NanoDrop lid to half-open position."
                    else:
                        nd.open_lid()
                        self.hw["nanodropLidClosed"] = False
                        msg = "Opened NanoDrop lid (half-open is nd_2000c only)."
                elif cmd == "nanodrop_flush":
                    nd.flush_pedestal_not_async()
                    msg = "Flushed NanoDrop pedestal with wash solvent and vacuum."
                elif cmd == "nanodrop_dry":
                    nd.dry_pedestal_not_async()
                    msg = "Vacuum & air-dried NanoDrop pedestal."
                elif cmd == "nanodrop_wash_cycle":
                    nd.wash_nanodrop_pedestal_with_blower()
                    self.hw["nanodropLidClosed"] = True
                    msg = "Completed full NanoDrop pedestal wash, vacuum dry & blower cycle."
                elif cmd == "nanodrop_close_all":
                    nd.close_all()
                    if hasattr(nd, "close_blower"):
                        nd.close_blower()
                    self.hw["nanodropLidClosed"] = True
                    msg = "Closed NanoDrop lid and shut off all wash, vacuum, air & blower valves."
            elif cmd in {"reload_tip_rack", "mark_tips_used"} and not self.hw["connected"]:
                rack_path = self._find_tip_rack_json(data_dir)
                if rack_path is None:
                    raise RuntimeError("tip_rack.json not found on the robot PC.")
                rack_data = json.loads(rack_path.read_text(encoding="utf-8"))
                tt = str(params["tip_type"])
                if tt not in rack_data:
                    raise RuntimeError(f"Invalid tip rack '{tt}'.")
                if cmd == "reload_tip_rack":
                    for tip in rack_data[tt]["tips"]:
                        tip["exists"] = True
                    msg = f"Marked {tt.replace('ul', ' µL')} tip rack as full (96/96)."
                else:
                    cnt = int(params["count"])
                    marked = 0
                    for tip in rack_data[tt]["tips"]:
                        if marked >= cnt:
                            break
                        if tip.get("exists"):
                            tip["exists"] = False
                            marked += 1
                    msg = f"Marked {marked} tip(s) as used in the {tt.replace('ul', ' µL')} rack."
                rack_path.write_text(json.dumps(rack_data, ensure_ascii=False, indent=4), encoding="utf-8")
                result_data["tipRacks"] = self._read_tip_racks(data_dir)
            elif cmd == "save_plate_preset":
                preset = _normalize_plate_preset(params)
                presets = self._load_plate_presets()
                updated = False
                for idx_p, existing in enumerate(presets):
                    if existing.get("id") == preset["id"]:
                        presets[idx_p] = preset
                        updated = True
                        break
                if not updated:
                    if len(presets) >= _MAX_CUSTOM_PRESETS:
                        raise RuntimeError(f"Maximum of {_MAX_CUSTOM_PRESETS} custom plate presets reached. Delete an unused one first.")
                    presets.append(preset)
                self._save_plate_presets(presets)
                result_data["preset"] = preset
                result_data["platePresets"] = presets
                msg = (
                    f"Saved plate preset '{preset['name']}' ({preset['rows']}×{preset['cols']}) for plate{preset['plateSlot']} "
                    f"— spacing {preset['colPitchMm']:.2f} × {preset['rowPitchMm']:.2f} mm, default Z={preset['defaultZ']}."
                )
            elif cmd == "delete_plate_preset":
                pid = str(params["id"])
                presets = self._load_plate_presets()
                new_presets = [p for p in presets if p.get("id") != pid]
                if len(new_presets) == len(presets):
                    raise RuntimeError(f"Plate preset '{pid}' was not found.")
                self._save_plate_presets(new_presets)
                result_data["platePresets"] = new_presets
                msg = f"Deleted plate preset '{pid}'."
            else:
                # Safe reconnect & homing guard: never silently home on an arbitrary motion command
                if cmd in _COMMANDS_ALLOWED_WITHOUT_HOMING:
                    self._connect_hardware_only()
                else:
                    if not self.hw["connected"] or not self.hw.get("homed"):
                        raise RuntimeError(
                            "Robot is not connected & homed yet (or was released after being idle). "
                            "Make sure the deck is clear and no tip is stuck, then click 'Connect & Home' first."
                        )

                zm, gt, pt, brb = self.hw["zm"], self.hw["gt"], self.hw["pt"], self.hw["brb"]
                if cmd == "init_hardware":
                    self._safe_home_xy(zm, gt)
                    msg = f"Connected to {self.robot_name} and homed arm to (0, 0)."
                elif cmd == "home_xy":
                    self._safe_home_xy(zm, gt)
                    msg = "Moved arm back to home (0, 0)."
                elif cmd == "move_idle":
                    gt.move_to_idle_position()
                    self.hw["currentPosition"] = "Park / Idle"
                    self._read_gantry_xy(gt)
                    msg = "Parked pipetter arm safely out of the way."
                elif cmd == "move_z_traverse":
                    zm.move_zeus_to_traverse_height()
                    self.hw["currentZ"] = int(getattr(zm, "pos", None) or getattr(zm, "ZeusTraversePosition", 880))
                    msg = "Raised pipette head to safe travel height."
                elif cmd == "kill_alarm":
                    gt.kill_alarm()
                    msg = "Cleared gantry alarm lock."
                elif cmd == "pick_tip":
                    tt = str(params["tip_type"])
                    pt.pick_tip(tt)
                    self.hw["currentTip"] = tt
                    msg = f"Picked up a fresh {tt.replace('ul', ' µL')} tip."
                elif cmd == "discard_tip":
                    pt.discard_tip()
                    self.hw["currentTip"] = ""
                    self.hw["currentPosition"] = "Trash bin"
                    msg = "Dropped pipette tip into the waste bin."
                elif cmd == "change_tip":
                    tt = str(params["tip_type"])
                    pt.change_tip(tt)
                    self.hw["currentTip"] = tt
                    msg = f"Switched to a fresh {tt.replace('ul', ' µL')} tip."
                elif cmd == "check_tip_status":
                    present = bool(zm.getTipPresenceStatus())
                    result_data["tipPresent"] = present
                    msg = "Tip sensor: a tip IS attached." if present else "Tip sensor: no tip attached."
                elif cmd == "reload_tip_rack":
                    tt = str(params["tip_type"])
                    brb.load_new_tip_rack(tt)
                    msg = f"Reset {tt.replace('ul', ' µL')} tip rack to full (96/96)."
                elif cmd == "mark_tips_used":
                    tt = str(params["tip_type"])
                    cnt = int(params["count"])
                    brb.mark_next_n_tip_as_used(tt, cnt)
                    msg = f"Skipped {cnt} used tip(s) in {tt.replace('ul', ' µL')} rack."
                elif cmd == "move_to_container":
                    pl = int(params["plate_id"])
                    ct = int(params["container_id"])
                    c = brb.plate_list[pl].containers[ct]
                    gt.move_xy(c.xy, ensure_traverse_height=True)
                    try:
                        self.hw["currentXY"] = [round(float(c.xy[0]), 3), round(float(c.xy[1]), 3)]
                    except Exception:
                        pass
                    self.hw["currentPosition"] = f"plate{pl}, pos {ct}"
                    self.hw["currentZ"] = int(getattr(zm, "pos", None) or getattr(zm, "ZeusTraversePosition", 880))
                    result_data["xy"] = self.hw.get("currentXY")
                    msg = f"Moved arm over plate{pl}, position {ct}."
                elif cmd == "move_to_plate_well":
                    pl = int(params["plate_id"])
                    well_idx = int(params["well_index"])
                    preset_id = str(params.get("preset_id", "")).strip()
                    if params.get("corner_a1") is not None and params.get("corner_top_right") is not None and params.get("corner_bottom_left") is not None:
                        tmp_preset = _normalize_plate_preset(
                            {
                                "name": "Test preview",
                                "plate_slot": pl,
                                "rows": int(params.get("rows", 8)),
                                "cols": int(params.get("cols", 12)),
                                "corner_a1": params.get("corner_a1"),
                                "corner_top_right": params.get("corner_top_right"),
                                "corner_bottom_left": params.get("corner_bottom_left"),
                                "default_z": int(params.get("default_z", 1900)),
                            }
                        )
                        xy = _compute_preset_well_xy(tmp_preset, well_idx)
                        well_lbl = _format_well_name(well_idx, tmp_preset["cols"])
                        gt.move_xy(xy, ensure_traverse_height=True)
                        self.hw["currentXY"] = [xy[0], xy[1]]
                        self.hw["currentPosition"] = f"plate{pl} {well_lbl} (test)"
                    else:
                        c, well_lbl, _r, _c, pname = self._resolve_plate_container(brb, pl, well_idx, preset_id)
                        gt.move_xy(c.xy, ensure_traverse_height=True)
                        self.hw["currentXY"] = [round(float(c.xy[0]), 3), round(float(c.xy[1]), 3)]
                        self.hw["currentPosition"] = f"plate{pl} {well_lbl} ({pname})"
                    self.hw["currentZ"] = int(getattr(zm, "pos", None) or getattr(zm, "ZeusTraversePosition", 880))
                    result_data["xy"] = self.hw.get("currentXY")
                    result_data["zPosition"] = self.hw["currentZ"]
                    msg = (
                        f"Moved safely at travel height over plate{pl} well {well_lbl} "
                        f"(X={self.hw['currentXY'][0]:.2f}, Y={self.hw['currentXY'][1]:.2f} mm)."
                    )
                elif cmd == "read_xy_position":
                    xy = self._read_gantry_xy(gt)
                    z_pos = None
                    try:
                        zp = zm.getAbsoluteZPosition()
                        if isinstance(zp, (int, float)):
                            z_pos = int(zp)
                            self.hw["currentZ"] = z_pos
                    except Exception:
                        z_pos = self.hw.get("currentZ")
                    result_data["xy"] = xy
                    result_data["zPosition"] = z_pos
                    if xy is not None:
                        msg = f"Current gantry position: X={xy[0]:.2f} mm, Y={xy[1]:.2f} mm, Z={z_pos or '—'}."
                    else:
                        msg = "Move to a plate slot or Home first so the gantry coordinates are tracked."
                elif cmd == "move_to_trash":
                    gt.move_to_trash_bin()
                    self.hw["currentPosition"] = "Trash bin"
                    self._read_gantry_xy(gt)
                    msg = "Moved arm over the tip waste bin."
                elif cmd == "move_to_balance":
                    pt.move_to_balance()
                    self.hw["currentPosition"] = "Balance cuvette"
                    self._read_gantry_xy(gt)
                    msg = "Moved arm over the balance cuvette."
                elif cmd == "move_to_nanodrop":
                    if not hasattr(brb, "nanodrop_pedestal"):
                        raise RuntimeError("nanodrop_pedestal is not configured in breadboard.py.")
                    gt.move_xy(brb.nanodrop_pedestal.xy, ensure_traverse_height=True)
                    try:
                        self.hw["currentXY"] = [
                            round(float(brb.nanodrop_pedestal.xy[0]), 3),
                            round(float(brb.nanodrop_pedestal.xy[1]), 3),
                        ]
                    except Exception:
                        pass
                    self.hw["currentPosition"] = "NanoDrop pedestal"
                    self.hw["currentZ"] = int(getattr(zm, "pos", None) or getattr(zm, "ZeusTraversePosition", 880))
                    msg = "Moved pipetter arm safely over the NanoDrop pedestal."
                elif cmd == "single_transfer":
                    src_plate = int(params["src_plate"])
                    dst_plate = int(params["dst_plate"])
                    src_preset_id = str(params["src_preset_id"])
                    dst_preset_id = str(params["dst_preset_id"])
                    src_slot = int(params["src_slot"])
                    dst_slot = int(params["dst_slot"])
                    solvent = validate_solvent(params["solvent"])
                    vol_ul, _tip_setting, tip_type = resolve_and_validate_tip_and_volume(
                        params["volume_ul"], params["tip_type"]
                    )
                    src_z = int(params["src_z"])
                    dst_z = int(params["dst_z"])
                    pick_tip = bool(params["pick_tip"])
                    prewet = bool(params["prewet"])
                    mix_after = bool(params["mix_after"])
                    drop_tip = bool(params["drop_tip"])

                    src_c, src_lbl, _sr, _sc, _spn = self._resolve_plate_container(brb, src_plate, src_slot, src_preset_id)
                    dst_c, dst_lbl, _dr, _dc, _dpn = self._resolve_plate_container(brb, dst_plate, dst_slot, dst_preset_id)
                    src_c.liquid_surface_height = src_z
                    dst_c.liquid_surface_height = dst_z

                    if self._emergency_stop_flag.is_set():
                        raise RuntimeError("Aborted by Software Stop.")

                    if pick_tip:
                        cur_tip = getattr(zm, "tip_on_zeus", "") or ""
                        if not cur_tip:
                            pt.pick_tip(tip_type)
                        elif cur_tip != tip_type:
                            pt.change_tip(tip_type)
                        self.hw["currentTip"] = tip_type
                    elif not (getattr(zm, "tip_on_zeus", "") or ""):
                        raise RuntimeError("No pipette tip attached. Enable 'Pick fresh tip' or pick a tip first.")
                    else:
                        attached_tip = str(getattr(zm, "tip_on_zeus", ""))
                        if attached_tip in {"50ul", "300ul", "1000ul"}:
                            resolve_and_validate_tip_and_volume(vol_ul, attached_tip)
                            tip_type = attached_tip

                    deck_idx = {"50ul": 3, "300ul": 0, "1000ul": 1}[tip_type]
                    lc_idx = self._resolve_liquid_class_index(solvent, tip_type)
                    max_tip_vol = int(tip_type[:-2])
                    mix_vol_01 = min(int(round(vol_ul)), max_tip_vol) * 10 if mix_after else 0

                    ev = SimpleNamespace(
                        source_container=src_c,
                        destination_container=dst_c,
                        transfer_volume=vol_ul,
                        aspirationVolume=vol_ul,
                        tip_type=tip_type,
                        solvent=solvent,
                        substance=solvent,
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
                        disp_mixCycles=3 if mix_after else 0,
                    )

                    if self._emergency_stop_flag.is_set():
                        raise RuntimeError("Aborted by Software Stop.")
                    if prewet and hasattr(pt, "prewet_new_tip"):
                        pt.prewet_new_tip(zm=zm, pt=pt, pipetting_event=ev, use_calibration=False)

                    if self._emergency_stop_flag.is_set():
                        raise RuntimeError("Aborted by Software Stop.")
                    pt.transfer_liquid(transfer_event=ev, purpose="reaction", use_calibration=False)
                    zm.move_zeus_to_traverse_height()

                    if drop_tip and not self._emergency_stop_flag.is_set():
                        pt.discard_tip()
                        self.hw["currentTip"] = ""
                        self.hw["currentPosition"] = "Trash bin"
                    else:
                        self.hw["currentPosition"] = f"plate{dst_plate}, {dst_lbl}"
                        try:
                            self.hw["currentXY"] = [round(float(dst_c.xy[0]), 3), round(float(dst_c.xy[1]), 3)]
                        except Exception:
                            pass

                    self.hw["currentZ"] = int(getattr(zm, "pos", None) or getattr(zm, "ZeusTraversePosition", 880))
                    result_data["tipRacks"] = self._read_tip_racks(data_dir)
                    msg = (
                        f"Transferred {vol_ul:g} µL of {solvent} from plate{src_plate} {src_lbl} "
                        f"→ plate{dst_plate} {dst_lbl} ({tip_type.replace('ul', ' µL')} tip"
                        f"{', tip dropped' if drop_tip else ''})."
                    )
                elif cmd == "plate_transfer_start":
                    src_plate = int(params["src_plate"])
                    dst_plate = int(params["dst_plate"])
                    src_preset_id = str(params["src_preset_id"])
                    dst_preset_id = str(params["dst_preset_id"])

                    src_preset = self._get_preset_by_id(src_preset_id)
                    dst_preset = self._get_preset_by_id(dst_preset_id)
                    if src_preset_id != "default_54":
                        if src_preset is None:
                            raise RuntimeError(f"Source plate preset '{src_preset_id}' was not found on the Robot PC.")
                        if int(src_preset.get("plateSlot", -1)) != src_plate:
                            raise RuntimeError(
                                f"Source preset '{src_preset['name']}' is calibrated for plate{src_preset['plateSlot']}, not plate{src_plate}."
                            )
                    if dst_preset_id != "default_54":
                        if dst_preset is None:
                            raise RuntimeError(f"Destination plate preset '{dst_preset_id}' was not found on the Robot PC.")
                        if int(dst_preset.get("plateSlot", -1)) != dst_plate:
                            raise RuntimeError(
                                f"Destination preset '{dst_preset['name']}' is calibrated for plate{dst_preset['plateSlot']}, not plate{dst_plate}."
                            )

                    src_rows = int(src_preset["rows"]) if src_preset else 6
                    src_cols = int(src_preset["cols"]) if src_preset else 9
                    dst_rows = int(dst_preset["rows"]) if dst_preset else 6
                    dst_cols = int(dst_preset["cols"]) if dst_preset else 9
                    src_total = src_rows * src_cols
                    dst_total = dst_rows * dst_cols
                    src_name = str(src_preset["name"]) if src_preset else "54-vial (6×9)"
                    dst_name = str(dst_preset["name"]) if dst_preset else "54-vial (6×9)"

                    pairs: List[List[int]] = []
                    for item in params["pairs"]:
                        sw, dw = int(item[0]), int(item[1])
                        if not (0 <= sw < src_total and 0 <= dw < dst_total):
                            raise RuntimeError(
                                f"Transfer pair ({sw} → {dw}) is out of range for {src_name} ({src_total} wells) → {dst_name} ({dst_total} wells)."
                            )
                        pairs.append([sw, dw])
                    if not pairs or len(pairs) > 384:
                        raise RuntimeError("Select between 1 and 384 valid well transfers.")

                    wells = [p[0] for p in pairs]
                    solvent = validate_solvent(params["solvent"])
                    vol_ul, _tip_setting, tip_type = resolve_and_validate_tip_and_volume(
                        params["volume_ul"], params["tip_type"]
                    )
                    src_z = int(params["src_z"])
                    dst_z = int(params["dst_z"])
                    change_tip_each = bool(params["change_tip_each_vial"])
                    prewet = bool(params["prewet"])
                    mix_after = bool(params["mix_after"])
                    drop_tip_at_end = bool(params["drop_tip_at_end"])

                    self._plate_transfer_stop.clear()
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
                        "solvent": solvent,
                        "tipType": tip_type,
                        "changeTipEachVial": change_tip_each,
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
                        "message": (
                            f"Starting transfer of {len(pairs)} well(s): "
                            f"plate{src_plate} ({src_name}) → plate{dst_plate} ({dst_name})..."
                        ),
                        "error": None,
                    }
                    self.hw["plateTransfer"] = job_state

                    def _worker() -> None:
                        deck_idx = {"50ul": 3, "300ul": 0, "1000ul": 1}[tip_type]
                        lc_idx = self._resolve_liquid_class_index(solvent, tip_type)
                        max_tip_vol = int(tip_type[:-2])
                        mix_vol_01 = min(int(round(vol_ul)), max_tip_vol) * 10 if mix_after else 0
                        try:
                            if not change_tip_each:
                                if self._plate_transfer_stop.is_set() or self._emergency_stop_flag.is_set():
                                    job_state["state"] = "stopped"
                                    job_state["message"] = "Stopped before first well."
                                    return
                                cur_tip = getattr(zm, "tip_on_zeus", "") or ""
                                if not cur_tip:
                                    pt.pick_tip(tip_type)
                                elif cur_tip != tip_type:
                                    pt.change_tip(tip_type)
                                self.hw["currentTip"] = tip_type

                            for idx_i, pair in enumerate(pairs):
                                if self._plate_transfer_stop.is_set() or self._emergency_stop_flag.is_set():
                                    job_state["state"] = "stopped"
                                    job_state["message"] = (
                                        f"Stopped after {job_state['completedWells']} of {len(pairs)} wells."
                                    )
                                    break

                                src_w, dst_w = pair[0], pair[1]
                                src_code = _format_well_name(src_w, src_cols)
                                dst_code = _format_well_name(dst_w, dst_cols)
                                job_state["currentWell"] = src_w
                                job_state["currentPair"] = [src_w, dst_w]
                                job_state["message"] = (
                                    f"Transferring {src_code} → {dst_code} ({idx_i + 1} of {len(pairs)}) — "
                                    f"plate{src_plate} → plate{dst_plate}"
                                )
                                self.hw["lastActivityMono"] = time.monotonic()

                                if change_tip_each:
                                    cur_tip = getattr(zm, "tip_on_zeus", "") or ""
                                    if cur_tip:
                                        pt.change_tip(tip_type)
                                    else:
                                        pt.pick_tip(tip_type)
                                    self.hw["currentTip"] = tip_type

                                if self._emergency_stop_flag.is_set():
                                    job_state["state"] = "stopped"
                                    job_state["message"] = (
                                        f"Halted by Software Stop at {src_code} → {dst_code}."
                                    )
                                    break

                                src_c, _sl, _sr2, _sc2, _sn2 = self._resolve_plate_container(
                                    brb, src_plate, src_w, src_preset_id
                                )
                                dst_c, _dl, _dr2, _dc2, _dn2 = self._resolve_plate_container(
                                    brb, dst_plate, dst_w, dst_preset_id
                                )
                                src_c.liquid_surface_height = src_z
                                dst_c.liquid_surface_height = dst_z

                                ev = SimpleNamespace(
                                    source_container=src_c,
                                    destination_container=dst_c,
                                    transfer_volume=vol_ul,
                                    aspirationVolume=vol_ul,
                                    tip_type=tip_type,
                                    solvent=solvent,
                                    substance=solvent,
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
                                    disp_mixCycles=3 if mix_after else 0,
                                )

                                if prewet and hasattr(pt, "prewet_new_tip") and (change_tip_each or idx_i == 0):
                                    pt.prewet_new_tip(zm=zm, pt=pt, pipetting_event=ev, use_calibration=False)

                                if self._emergency_stop_flag.is_set():
                                    job_state["state"] = "stopped"
                                    job_state["message"] = f"Halted by Software Stop at {src_code} → {dst_code}."
                                    break

                                pt.transfer_liquid(transfer_event=ev, purpose="reaction", use_calibration=False)
                                zm.move_zeus_to_traverse_height()

                                job_state["completedList"].append(src_w)
                                job_state["completedPairs"].append([src_w, dst_w])
                                job_state["completedWells"] = len(job_state["completedPairs"])
                                self.hw["currentPosition"] = f"plate{dst_plate} {dst_code}"
                                try:
                                    self.hw["currentXY"] = [
                                        round(float(dst_c.xy[0]), 3),
                                        round(float(dst_c.xy[1]), 3),
                                    ]
                                except Exception:
                                    pass
                                self.hw["currentZ"] = int(
                                    getattr(zm, "pos", None) or getattr(zm, "ZeusTraversePosition", 880)
                                )
                                self.hw["lastActivityMono"] = time.monotonic()

                            else:
                                job_state["state"] = "completed"
                                job_state["currentWell"] = None
                                job_state["currentPair"] = None
                                job_state["message"] = (
                                    f"Completed all {len(pairs)} wells ({vol_ul:g} µL {solvent}, "
                                    f"plate{src_plate} {src_name} → plate{dst_plate} {dst_name})."
                                )

                            if drop_tip_at_end and not self._emergency_stop_flag.is_set() and (getattr(zm, "tip_on_zeus", "") or ""):
                                pt.discard_tip()
                                self.hw["currentTip"] = ""
                                self.hw["currentPosition"] = "Trash bin"
                        except Exception as exc:
                            try:
                                if not self._emergency_stop_flag.is_set():
                                    zm.move_zeus_to_traverse_height()
                            except Exception:
                                pass
                            job_state["state"] = "error"
                            job_state["failedWell"] = job_state.get("currentWell")
                            job_state["failedPair"] = job_state.get("currentPair")
                            job_state["error"] = str(exc)
                            job_state["message"] = (
                                f"Stopped with error at well #{job_state.get('currentWell')}: {exc}"
                            )
                            self.hw["lastError"] = str(exc)
                        finally:
                            job_state["active"] = False
                            job_state["finishedAt"] = datetime.now(timezone.utc).isoformat()
                            self.hw["busy"] = False
                            self.hw["lastActivityMono"] = time.monotonic()

                    self._plate_transfer_thread = threading.Thread(target=_worker, daemon=True)
                    self._plate_transfer_thread.start()
                    result_data["plateTransfer"] = copy.deepcopy(job_state)
                    msg = (
                        f"Started plate-to-plate transfer: {len(pairs)} well(s), {vol_ul:g} µL of {solvent} "
                        f"from plate{src_plate} ({src_name}) → plate{dst_plate} ({dst_name})."
                    )
                elif cmd == "move_xy_rel":
                    dx = float(params["dx"])
                    dy = float(params["dy"])
                    gt.move_xy_rel((dx, dy))
                    cur_xy = self.hw.get("currentXY")
                    if isinstance(cur_xy, list) and len(cur_xy) == 2:
                        self.hw["currentXY"] = [round(float(cur_xy[0]) + dx, 3), round(float(cur_xy[1]) + dy, 3)]
                    self._read_gantry_xy(gt)
                    result_data["xy"] = self.hw.get("currentXY")
                    self.hw["currentPosition"] = f"Jogged ({dx:+.1f}, {dy:+.1f}) mm"
                    msg = f"Moved arm by X {dx:+.1f} mm, Y {dy:+.1f} mm."
                elif cmd == "move_z":
                    z = int(params["z"])
                    zm.move_z(z)
                    self.hw["currentZ"] = z
                    result_data["zPosition"] = z
                    msg = f"Moved pipette height to z = {z} ({z / 10:.1f} mm)."
                elif cmd == "move_z_rel":
                    dz = int(params["dz"])
                    cur_z = int(getattr(zm, "pos", None) or self.hw.get("currentZ") or getattr(zm, "ZeusTraversePosition", 880))
                    new_z = max(500, min(2200, cur_z + dz))
                    zm.move_z(new_z)
                    self.hw["currentZ"] = new_z
                    result_data["zPosition"] = new_z
                    direction = "Lowered" if dz > 0 else "Raised"
                    msg = f"{direction} tip to z = {new_z} ({new_z / 10:.1f} mm)."
                elif cmd == "check_liquid_level":
                    pl = int(params["plate_id"])
                    ct = int(params["container_id"])
                    c = brb.plate_list[pl].containers[ct]
                    res = pt.check_volume_in_container(c)
                    surf = res[0] if isinstance(res, tuple) and len(res) >= 1 else getattr(c, "liquid_surface_height", None)
                    true_ul = (
                        round(max(0.0, ((float(c.bottomPosition) - float(surf)) / 10.0) * float(c.area)), 1)
                        if surf and hasattr(c, "bottomPosition") and hasattr(c, "area")
                        else None
                    )
                    result_data["surfaceHeightZ"] = surf
                    result_data["volumeUl"] = true_ul
                    self.hw["currentTip"] = "300ul"
                    if not surf:
                        msg = f"No liquid detected in plate{pl} pos {ct} (bottle may be empty or non-conductive solvent)."
                    else:
                        ml_str = f" (~{round(true_ul / 1000.0, 2)} mL)" if true_ul is not None else ""
                        msg = f"Measured plate{pl} pos {ct}: height z={surf}{ml_str}."
                elif cmd == "balance_door_open":
                    pt.open_balance_door()
                    msg = "Opened balance door."
                elif cmd == "balance_door_close":
                    pt.close_balance_door()
                    msg = "Closed balance door."
                elif cmd == "balance_tare":
                    pt.balance_tare()
                    msg = "Tared balance to 0.000 g."
                elif cmd == "balance_read":
                    w = pt.balance_stable_value()
                    result_data["weightGrams"] = w
                    msg = f"Balance weight: {w} g."
                elif cmd == "read_instrument_status":
                    z_pos = zm.getAbsoluteZPosition()
                    if isinstance(z_pos, (int, float)):
                        self.hw["currentZ"] = int(z_pos)
                    tip_on = bool(zm.getTipPresenceStatus())
                    err_code = zm.getErrorCode()
                    result_data = {"zPosition": z_pos, "tipPresent": tip_on, "errorCode": err_code}
                    msg = f"Zeus Z={z_pos}, tip {'attached' if tip_on else 'none'}, error={err_code or 'none'}."
                else:
                    msg = f"Completed {cmd}."

            self.hw["lastError"] = None
            return {
                "commandId": cmd_id,
                "ok": True,
                "executed": True,
                "command": cmd,
                "humanMessage": msg,
                "data": result_data,
                "hardware": self._hardware_snapshot(),
            }
        except Exception as exc:
            self.hw["lastError"] = str(exc)
            return {
                "commandId": cmd_id,
                "ok": False,
                "executed": True,
                "command": cmd,
                "humanMessage": f"Could not run {cmd}: {exc}",
                "error": str(exc),
                "hardware": self._hardware_snapshot(),
            }
        finally:
            pt_active = isinstance(self.hw.get("plateTransfer"), dict) and bool(self.hw["plateTransfer"].get("active"))
            if not pt_active:
                self.hw["busy"] = False
            if self.hw.get("connected") or self.hw.get("nanodropConnected"):
                self.hw["lastActivityMono"] = time.monotonic()
            self._hw_lock.release()

    def _is_worker_busy(self) -> bool:
        cmd_alive = self._cmd_thread is not None and self._cmd_thread.is_alive()
        pt_active = isinstance(self.hw.get("plateTransfer"), dict) and bool(self.hw["plateTransfer"].get("active"))
        return bool(cmd_alive or pt_active or self.hw.get("busy"))

    def _verify_signed_relay_item(self, item: Dict[str, Any]) -> Tuple[bool, str]:
        return verify_relay_command(
            relay_token=self.relay_token,
            cmd_id=str(item.get("id") or ""),
            command=str(item.get("command") or ""),
            params=item.get("params") if isinstance(item.get("params"), dict) else {},
            issued_at=float(item.get("issuedAt") or 0.0),
            signature=str(item.get("signature") or ""),
        )

    def _run_command_worker(self, cmd_id: str, cmd: str, params: Dict[str, Any]) -> None:
        self._active_cmd_id = cmd_id
        try:
            self._post_json("/api/robot/relay/ack", {"commandId": cmd_id, "state": "running"}, timeout=5.0)
            res = self.execute_command(cmd_id, cmd, params, verified_relay=True)
            self._post_json("/api/robot/relay/result", res, timeout=10.0)
            self._post_json("/api/robot/relay/push", {"status": self.collect_status()}, timeout=8.0)
        finally:
            if self._active_cmd_id == cmd_id:
                self._active_cmd_id = None

    def _post_json(self, path: str, body: Dict[str, Any], timeout: float = 8.0) -> Optional[Dict[str, Any]]:
        url = f"{self.server_url}{path}"
        data = json.dumps(body).encode("utf-8")
        headers = {"Content-Type": "application/json", "User-Agent": "RobowskiPcAgent/1.1"}
        if self.relay_token:
            headers["X-Robowski-Agent-Token"] = self.relay_token
        req = urllib.request.Request(url, data=data, headers=headers, method="POST")
        try:
            with urllib.request.urlopen(req, timeout=timeout) as resp:
                raw = resp.read().decode("utf-8", errors="replace")
                self._last_post_error = ""
                return json.loads(raw) if raw else {}
        except urllib.error.HTTPError as exc:
            self._last_post_error = f"HTTP {exc.code} {exc.reason}"
            return None
        except (urllib.error.URLError, TimeoutError, OSError, ValueError) as exc:
            self._last_post_error = str(exc)
            return None

    def run_forever(self) -> None:
        if not self.server_url:
            raise RuntimeError(
                "Personal PC backend URL is not configured. Save it in server_url.txt next to robot_pc_agent.py "
                "(e.g. https://your-pc.ts.net), set ROBOWSKI_BACKEND_URL, or pass --server."
            )
        if not self.relay_token:
            raise RuntimeError(
                "Relay token is required for security. Create relay_token.txt next to robot_pc_agent.py "
                "(matching relay_token.txt / ROBOWSKI_RELAY_TOKEN on your Personal PC) or pass --token."
            )

        self._last_post_error = ""
        pid_file = SCRIPT_DIR / "robot_helper.pid"
        stop_flag = SCRIPT_DIR / "stop_helper.flag"
        try:
            if stop_flag.exists():
                stop_flag.unlink()
            pid_file.write_text(str(os.getpid()), encoding="utf-8")
        except OSError:
            pass

        print(f"[Robowski Helper] Robot: {self.robot_name}")
        print(f"[Robowski Helper] Robowski main.py folder: {self._find_zeus_dir() or 'Not found yet (set ROBOWSKI_MAIN_FOLDER in .bat if using hardware buttons)'}")
        print(f"[Robowski Helper] Data folder: {self._data_dir() or 'Not set (log-tracking still works)'}")
        print(f"[Robowski Helper] Sending status every {self.interval_sec:.0f}s (0.5s while moving) to: {self.server_url}")
        if self.enable_hardware:
            print("[Robowski Helper] Hardware buttons: SIGNED-RELAY PROTECTED (PIN verified on personal PC; commands HMAC-signed)")
        else:
            print("[Robowski Helper] Hardware buttons: Safe read-only mode (add robot_pin.txt or pass --enable-hardware with relay_token.txt)")
        print("[Robowski Helper] Running! Close this window (or run stop_robot_helper_windows.bat) to stop.")

        was_offline = False
        ever_connected = False
        try:
            while True:
                if stop_flag.exists():
                    print("[Robowski Helper] Stop requested — shutting down cleanly.")
                    break
                try:
                    status = self.collect_status()
                    reply = self._post_json("/api/robot/relay/push", {"status": status})
                    if reply is None:
                        if not was_offline:
                            reason = f" ({self._last_post_error})" if self._last_post_error else ""
                            print(f"[Robowski Helper] Waiting for personal PC{reason} — will keep retrying quietly...")
                            was_offline = True
                        for _ in range(int(max(10.0, self.interval_sec))):
                            if stop_flag.exists():
                                break
                            time.sleep(1.0)
                        continue

                    if not ever_connected:
                        print(f"[Robowski Helper] Connected! Live updates are now flowing to {self.server_url}")
                        ever_connected = True
                        was_offline = False
                    elif was_offline:
                        print("[Robowski Helper] Reconnected to personal PC!")
                        was_offline = False

                    req_path = reply.get("requestedRunPath")
                    if isinstance(req_path, str) and req_path.strip():
                        self.requested_run_path = req_path.strip()

                    # Priority 1: Handle stop signals immediately on the main polling thread
                    stop_sig = reply.get("stopSignal")
                    if isinstance(stop_sig, dict) and stop_sig.get("id") and stop_sig.get("command"):
                        s_id = str(stop_sig["id"])
                        s_cmd = str(stop_sig["command"])
                        sig_ok, sig_err = self._verify_signed_relay_item(stop_sig)
                        if not sig_ok:
                            self._post_json(
                                "/api/robot/relay/result",
                                {
                                    "commandId": s_id,
                                    "ok": False,
                                    "executed": False,
                                    "command": s_cmd,
                                    "humanMessage": sig_err,
                                    "error": sig_err,
                                    "hardware": self._hardware_snapshot(),
                                },
                                timeout=8.0,
                            )
                        elif s_cmd == "emergency_stop":
                            res = self.trigger_emergency_stop(s_id)
                            self._post_json("/api/robot/relay/result", res, timeout=8.0)
                        else:
                            res = self.execute_command(
                                s_id,
                                s_cmd,
                                stop_sig.get("params") if isinstance(stop_sig.get("params"), dict) else {},
                                verified_relay=True,
                            )
                            self._post_json("/api/robot/relay/result", res, timeout=8.0)

                    # Priority 2: Launch regular commands in a worker thread so the poller stays free for Stop
                    pending = reply.get("pendingCommand")
                    if isinstance(pending, dict) and pending.get("id") and pending.get("command"):
                        p_id = str(pending["id"])
                        p_cmd = str(pending["command"])
                        p_params = pending.get("params") if isinstance(pending.get("params"), dict) else {}
                        sig_ok, sig_err = self._verify_signed_relay_item(pending)
                        if not sig_ok:
                            self._post_json(
                                "/api/robot/relay/result",
                                {
                                    "commandId": p_id,
                                    "ok": False,
                                    "executed": False,
                                    "command": p_cmd,
                                    "humanMessage": sig_err,
                                    "error": sig_err,
                                    "hardware": self._hardware_snapshot(),
                                },
                                timeout=8.0,
                            )
                        elif p_cmd == "emergency_stop":
                            res = self.trigger_emergency_stop(p_id)
                            self._post_json("/api/robot/relay/result", res, timeout=8.0)
                        elif self._cmd_thread is not None and self._cmd_thread.is_alive():
                            self._post_json(
                                "/api/robot/relay/result",
                                {
                                    "commandId": p_id,
                                    "ok": False,
                                    "executed": False,
                                    "command": p_cmd,
                                    "humanMessage": "Robot is already executing another command.",
                                    "error": "Robot busy",
                                    "hardware": self._hardware_snapshot(),
                                },
                                timeout=8.0,
                            )
                        else:
                            self._cmd_thread = threading.Thread(
                                target=self._run_command_worker,
                                args=(p_id, p_cmd, p_params),
                                daemon=True,
                            )
                            self._cmd_thread.start()

                    # Fast 0.5s polling while moving so Software Stop arrives immediately
                    wait_sec = 0.5 if self._is_worker_busy() else self.interval_sec
                    steps = max(1, int(round(wait_sec / 0.5)))
                    for _ in range(steps):
                        if stop_flag.exists():
                            break
                        time.sleep(0.5)
                        if wait_sec > 0.5 and self._is_worker_busy():
                            break
                except KeyboardInterrupt:
                    print("\n[Robowski Helper] Stopped cleanly.")
                    break
                except Exception as exc:
                    print(f"[Robowski Helper] Temporary issue: {exc}")
                    time.sleep(max(10.0, self.interval_sec))
        finally:
            self._emergency_stop_flag.set()
            self._plate_transfer_stop.set()
            if self._plate_transfer_thread is not None and self._plate_transfer_thread.is_alive():
                self._plate_transfer_thread.join(timeout=8.0)
            if self._cmd_thread is not None and self._cmd_thread.is_alive():
                self._cmd_thread.join(timeout=5.0)
            if self.hw.get("connected") or self.hw.get("nanodropConnected"):
                self._disconnect_hardware("Stopped cleanly (USB free)")
            for f in (pid_file, stop_flag):
                try:
                    if f.exists():
                        f.unlink()
                except OSError:
                    pass


def _setup_background_log(force_log: bool = False) -> None:
    if not force_log and sys.stdout is not None and sys.stderr is not None:
        return
    try:
        log_path = SCRIPT_DIR / "robot_helper.log"
        log_fp = open(log_path, "w", encoding="utf-8", buffering=1)
        sys.stdout = log_fp  # type: ignore[assignment]
        sys.stderr = log_fp  # type: ignore[assignment]
    except OSError:
        pass


def main() -> None:
    parser = argparse.ArgumentParser(description="Robowski Studio tiny Robot PC background helper")
    parser.add_argument("--server", default=DEFAULT_BACKEND_URL, help="Your personal PC Robowski backend URL (or save in server_url.txt)")
    parser.add_argument("--interval", type=float, default=5.0, help="Seconds between idle status updates (default: 5)")
    parser.add_argument(
        "--enable-hardware",
        action="store_true",
        default=os.environ.get("ROBOWSKI_ENABLE_HARDWARE", "0").strip() in {"1", "true", "yes"},
        help="Enable live hardware commands (requires relay_token.txt or robot_pin.txt)",
    )
    parser.add_argument("--repo", default="", help="Optional path to robowski folder (auto-detected automatically)")
    parser.add_argument("--token", default="", help="Shared relay token (easier: save in relay_token.txt)")
    parser.add_argument("--pin", default="", help="Optional PIN (easier: save in robot_pin.txt)")
    parser.add_argument(
        "--simulate",
        action="store_true",
        default=os.environ.get("ROBOWSKI_SIMULATE", "0").strip().lower() in {"1", "true", "yes"},
        help="Dry-run mode using virtual Zeus/gantry hardware (never opens USB/CAN ports)",
    )
    parser.add_argument("--background", action="store_true", help="Write status and errors to robot_helper.log")
    args = parser.parse_args()

    _setup_background_log(force_log=args.background)
    try:
        agent = RobotPcAgent(
            server_url=args.server,
            interval_sec=args.interval,
            enable_hardware=args.enable_hardware,
            repo_path=args.repo,
            relay_token=args.token,
            control_pin=args.pin,
            simulate=args.simulate,
        )
        agent.run_forever()
    except Exception as exc:
        import traceback

        print(f"[Robowski Helper] Startup error: {exc}")
        traceback.print_exc()
        sys.exit(1)


if __name__ == "__main__":
    main()
