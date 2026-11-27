#!/usr/bin/env python3
"""
Robowski Studio — Tiny Robot PC Background Helper
=================================================
Run this single file on the ROBOT PC (just double-click start_robot_helper_windows.bat).

How PIN unlock works (no command-line flags needed!):
  - Create a 1-line text file named `robot_pin.txt` right next to this file containing your chosen PIN (e.g. `4829`).
  - Hardware buttons are then automatically unlocked whenever you type that same PIN in the Robot tab in your browser.
  - Without `robot_pin.txt` (or `ROBOWSKI_CONTROL_PIN`), the helper stays in safe read-only monitor mode.

How it finds your active Excel run:
  1. Automatically reads the exact `.xlsx` file Robowski itself just opened from `main_roboski2.log`
     (even if you saved that Excel file on your Desktop or anywhere else!).
  2. Also scans `ROBOCHEM_DATA_PATH` and any extra folders listed in an optional `watch_folders.txt` next to this file.
  3. Live buttons and tip-rack counts work completely fine even if there is no Excel file at all.
"""

from __future__ import annotations

import argparse
import hmac
import json
import os
import re
import sys
import time
import urllib.error
import urllib.request
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, List, Optional

try:
    import openpyxl  # Already installed on Robowski PCs
except ImportError:
    openpyxl = None  # type: ignore

SCRIPT_DIR = Path(__file__).resolve().parent

DEFAULT_BACKEND_URL = os.environ.get(
    "ROBOWSKI_BACKEND_URL", "https://91474-p02.tail4c9e6a.ts.net"
).strip().rstrip("/")

_BOTTLE_BOTTOM_Z = 2180.0
_BOTTLE_AREA_MM2 = (24.6 ** 2) * 3.14 / 4.0  # 475.0506 mm^2 (breadboard.py)
_JAR_BOTTOM_Z = 2120.0
_JAR_AREA_MM2 = 2122.0

_ALLOWED_COMMANDS = {
    "init_hardware",
    "disconnect_hardware",
    "home_xy",
    "move_idle",
    "move_z_traverse",
    "kill_alarm",
    "emergency_stop",
    "pick_tip",
    "discard_tip",
    "change_tip",
    "check_tip_status",
    "reload_tip_rack",
    "mark_tips_used",
    "move_to_container",
    "move_to_trash",
    "move_to_balance",
    "move_xy_rel",
    "move_z",
    "move_z_rel",
    "check_liquid_level",
    "balance_door_open",
    "balance_door_close",
    "balance_tare",
    "balance_read",
    "read_instrument_status",
}


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


class RobotPcAgent:
    def __init__(
        self,
        server_url: str,
        interval_sec: float = 5.0,
        enable_hardware: bool = False,
        repo_path: str = "",
        relay_token: str = "",
        control_pin: str = "",
    ) -> None:
        self.server_url = server_url.strip().rstrip("/")
        self.interval_sec = max(2.0, float(interval_sec))
        self.control_pin = (
            control_pin.strip()
            or os.environ.get("ROBOWSKI_CONTROL_PIN", "").strip()
            or _read_optional_text_file("robot_pin.txt")
        )
        # Setting a PIN automatically enables PIN-protected live hardware control (no CLI flag needed!)
        self.enable_hardware = bool(enable_hardware or self.control_pin)
        self.repo_path = (
            repo_path.strip()
            or os.environ.get("ROBOWSKI_MAIN_FOLDER", "").strip()
            or os.environ.get("ROBOWSKI_REPO_PATH", "").strip()
            or _read_optional_text_file("robowski_folder.txt")
            or _read_optional_text_file("robowski_repo.txt")
        ).strip('"').strip("'")
        self._zeus_dir_checked = False
        self._cached_zeus_dir: Optional[Path] = None
        self.relay_token = relay_token.strip() or os.environ.get("ROBOWSKI_RELAY_TOKEN", "").strip()
        self.robot_name = os.environ.get("PIPETTER_NAME", "Robowski#2").strip() or "Robowski#2"
        self.requested_run_path: Optional[str] = None
        self.hw: Dict[str, Any] = {
            "zm": None,
            "gt": None,
            "pt": None,
            "brb": None,
            "connected": False,
            "busy": False,
            "currentTip": "",
            "currentPosition": "Unknown",
            "currentZ": None,
            "lastCommand": None,
            "lastCommandAt": None,
            "lastError": None,
        }

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

    def _hardware_snapshot(self) -> Dict[str, Any]:
        return {
            "controlEnabled": self.enable_hardware,
            "pinProtected": bool(self.control_pin),
            "connected": bool(self.hw["connected"]),
            "busy": bool(self.hw["busy"]),
            "currentTip": str(self.hw["currentTip"] or ""),
            "currentPosition": str(self.hw["currentPosition"] or "Unknown"),
            "currentZ": self.hw.get("currentZ"),
            "lastCommand": self.hw["lastCommand"],
            "lastCommandAt": self.hw["lastCommandAt"],
            "lastError": self.hw["lastError"],
        }

    def collect_status(self) -> Dict[str, Any]:
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

    def _ensure_hardware(self) -> None:
        if self.hw["connected"] and self.hw["pt"] is not None:
            return
        zeus_dir = self._find_zeus_dir()
        if zeus_dir is not None:
            if str(zeus_dir) not in sys.path:
                sys.path.insert(0, str(zeus_dir))
            if zeus_dir.name.lower() == "zeus-pipetter" and str(zeus_dir.parent) not in sys.path:
                sys.path.insert(0, str(zeus_dir.parent))
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
        gt.home_xy()
        pt = pipetter.Pipetter(zeus=zm, gantry=gt)
        self.hw.update(
            {
                "zm": zm,
                "gt": gt,
                "pt": pt,
                "brb": brb,
                "connected": True,
                "currentTip": getattr(zm, "tip_on_zeus", "") or "",
                "currentPosition": "Home (0, 0)",
                "currentZ": getattr(zm, "pos", getattr(zm, "ZeusTraversePosition", 880)),
                "lastError": None,
            }
        )

    def execute_command(self, cmd_id: str, cmd: str, params: Dict[str, Any], supplied_pin: str = "") -> Dict[str, Any]:
        if not self.enable_hardware or cmd not in _ALLOWED_COMMANDS:
            return {
                "commandId": cmd_id,
                "ok": False,
                "executed": False,
                "command": cmd,
                "humanMessage": "Live robot buttons are locked. Add your PIN in robot_pin.txt on the robot PC to unlock them.",
                "hardware": self._hardware_snapshot(),
            }

        if self.control_pin:
            if not hmac.compare_digest(supplied_pin.strip(), self.control_pin):
                return {
                    "commandId": cmd_id,
                    "ok": False,
                    "executed": False,
                    "command": cmd,
                    "humanMessage": "Wrong or missing PIN. Type the PIN from robot_pin.txt into the PIN box at the top right of Robot Commands.",
                    "error": "Invalid PIN",
                    "hardware": self._hardware_snapshot(),
                }

        self.hw["busy"] = True
        self.hw["lastCommand"] = cmd
        self.hw["lastCommandAt"] = datetime.now(timezone.utc).isoformat()
        result_data: Dict[str, Any] = {}
        try:
            data_dir = self._data_dir()
            if cmd == "disconnect_hardware":
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
                        "currentPosition": "Disconnected (USB free for main.py)",
                        "lastError": None,
                    }
                )
                msg = "Released robot USB & CAN ports — you can now run main.py or diluter.py normally."
            elif cmd in {"reload_tip_rack", "mark_tips_used"} and not self.hw["connected"]:
                rack_path = self._find_tip_rack_json(data_dir)
                if rack_path is None:
                    raise RuntimeError("tip_rack.json not found on the robot PC.")
                rack_data = json.loads(rack_path.read_text(encoding="utf-8"))
                tt = str(params.get("tip_type", "300ul"))
                if tt not in {"50ul", "300ul", "1000ul"} or tt not in rack_data:
                    raise RuntimeError(f"Invalid tip rack '{tt}'.")
                if cmd == "reload_tip_rack":
                    for tip in rack_data[tt]["tips"]:
                        tip["exists"] = True
                    msg = f"Marked {tt.replace('ul', ' µL')} tip rack as full (96/96)."
                else:
                    cnt = max(1, min(96, int(params.get("count", 1))))
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
            else:
                self._ensure_hardware()
                zm, gt, pt, brb = self.hw["zm"], self.hw["gt"], self.hw["pt"], self.hw["brb"]
                if cmd == "init_hardware":
                    msg = f"Connected to {self.robot_name} and homed arm to (0, 0)."
                elif cmd == "home_xy":
                    gt.home_xy()
                    self.hw["currentPosition"] = "Home (0, 0)"
                    msg = "Moved arm back to home (0, 0)."
                elif cmd == "move_idle":
                    gt.move_to_idle_position()
                    self.hw["currentPosition"] = "Park / Idle"
                    msg = "Parked pipetter arm safely out of the way."
                elif cmd == "move_z_traverse":
                    zm.move_zeus_to_traverse_height()
                    self.hw["currentZ"] = int(getattr(zm, "pos", None) or getattr(zm, "ZeusTraversePosition", 880))
                    msg = "Raised pipette head to safe travel height."
                elif cmd == "kill_alarm":
                    gt.kill_alarm()
                    msg = "Cleared gantry alarm lock."
                elif cmd == "emergency_stop":
                    zm.setEmergencyStop(1)
                    msg = "Emergency stop triggered on Zeus pipetter."
                elif cmd == "pick_tip":
                    tt = str(params.get("tip_type", "300ul"))
                    pt.pick_tip(tt)
                    self.hw["currentTip"] = tt
                    msg = f"Picked up a fresh {tt.replace('ul', ' µL')} tip."
                elif cmd == "discard_tip":
                    pt.discard_tip()
                    self.hw["currentTip"] = ""
                    self.hw["currentPosition"] = "Trash bin"
                    msg = "Dropped pipette tip into the waste bin."
                elif cmd == "change_tip":
                    tt = str(params.get("tip_type", "300ul"))
                    pt.change_tip(tt)
                    self.hw["currentTip"] = tt
                    msg = f"Switched to a fresh {tt.replace('ul', ' µL')} tip."
                elif cmd == "check_tip_status":
                    present = bool(zm.getTipPresenceStatus())
                    result_data["tipPresent"] = present
                    msg = "Tip sensor: a tip IS attached." if present else "Tip sensor: no tip attached."
                elif cmd == "reload_tip_rack":
                    tt = str(params.get("tip_type", "300ul"))
                    brb.load_new_tip_rack(tt)
                    msg = f"Reset {tt.replace('ul', ' µL')} tip rack to full (96/96)."
                elif cmd == "mark_tips_used":
                    tt = str(params.get("tip_type", "300ul"))
                    cnt = max(1, min(96, int(params.get("count", 1))))
                    brb.mark_next_n_tip_as_used(tt, cnt)
                    msg = f"Skipped {cnt} used tip(s) in {tt.replace('ul', ' µL')} rack."
                elif cmd == "move_to_container":
                    pl = max(0, min(7, int(params.get("plate_id", 0))))
                    max_c = 53 if pl <= 2 else (7 if pl <= 5 else 1)
                    ct = max(0, min(max_c, int(params.get("container_id", 0))))
                    c = brb.plate_list[pl].containers[ct]
                    gt.move_xy(c.xy, ensure_traverse_height=True)
                    self.hw["currentPosition"] = f"plate{pl}, pos {ct}"
                    self.hw["currentZ"] = int(getattr(zm, "pos", None) or getattr(zm, "ZeusTraversePosition", 880))
                    msg = f"Moved arm over plate{pl}, position {ct}."
                elif cmd == "move_to_trash":
                    gt.move_to_trash_bin()
                    self.hw["currentPosition"] = "Trash bin"
                    msg = "Moved arm over the tip waste bin."
                elif cmd == "move_to_balance":
                    pt.move_to_balance()
                    self.hw["currentPosition"] = "Balance cuvette"
                    msg = "Moved arm over the balance cuvette."
                elif cmd == "move_xy_rel":
                    dx = max(-100.0, min(100.0, float(params.get("dx", 0))))
                    dy = max(-100.0, min(100.0, float(params.get("dy", 0))))
                    gt.move_xy_rel((dx, dy))
                    self.hw["currentPosition"] = f"Jogged ({dx:+.1f}, {dy:+.1f}) mm"
                    msg = f"Moved arm by X {dx:+.1f} mm, Y {dy:+.1f} mm."
                elif cmd == "move_z":
                    z = max(500, min(2200, int(params.get("z", 880))))
                    zm.move_z(z)
                    self.hw["currentZ"] = z
                    result_data["zPosition"] = z
                    msg = f"Moved pipette height to z = {z} ({z / 10:.1f} mm)."
                elif cmd == "move_z_rel":
                    dz = max(-300, min(300, int(params.get("dz", 0))))
                    cur_z = int(getattr(zm, "pos", None) or self.hw.get("currentZ") or getattr(zm, "ZeusTraversePosition", 880))
                    new_z = max(500, min(2200, cur_z + dz))
                    zm.move_z(new_z)
                    self.hw["currentZ"] = new_z
                    result_data["zPosition"] = new_z
                    direction = "Lowered" if dz > 0 else "Raised"
                    msg = f"{direction} tip to z = {new_z} ({new_z / 10:.1f} mm)."
                elif cmd == "check_liquid_level":
                    pl = max(0, min(7, int(params.get("plate_id", 3))))
                    max_c = 53 if pl <= 2 else (7 if pl <= 5 else 1)
                    ct = max(0, min(max_c, int(params.get("container_id", 0))))
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
            self.hw["busy"] = False

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
        print(f"[Robowski Helper] Sending status every {self.interval_sec:.0f}s to: {self.server_url}")
        if self.control_pin:
            print("[Robowski Helper] Hardware buttons: PIN-PROTECTED (type your PIN in the browser to move the robot)")
        elif self.enable_hardware:
            print("[Robowski Helper] Hardware buttons: ENABLED")
        else:
            print("[Robowski Helper] Hardware buttons: Safe read-only mode (add robot_pin.txt to unlock with a PIN)")
        print("[Robowski Helper] Running! You can minimize this window — close it (or run stop_robot_helper_windows.bat) to stop.")

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

                    pending = reply.get("pendingCommand")
                    if isinstance(pending, dict) and pending.get("id") and pending.get("command"):
                        res = self.execute_command(
                            str(pending["id"]),
                            str(pending["command"]),
                            pending.get("params") if isinstance(pending.get("params"), dict) else {},
                            str(pending.get("pin") or ""),
                        )
                        self._post_json("/api/robot/relay/result", res, timeout=10.0)
                        self._post_json("/api/robot/relay/push", {"status": self.collect_status()})

                    for _ in range(max(1, int(self.interval_sec))):
                        if stop_flag.exists():
                            break
                        time.sleep(1.0)
                except KeyboardInterrupt:
                    print("\n[Robowski Helper] Stopped cleanly.")
                    break
                except Exception as exc:
                    print(f"[Robowski Helper] Temporary issue: {exc}")
                    time.sleep(max(10.0, self.interval_sec))
        finally:
            if self.hw.get("connected"):
                try:
                    if self.hw.get("pt") is not None and hasattr(self.hw["pt"], "close_ports_and_zeus"):
                        self.hw["pt"].close_ports_and_zeus()
                    if self.hw.get("gt") is not None and hasattr(self.hw["gt"], "close_gantry"):
                        self.hw["gt"].close_gantry()
                except Exception:
                    pass
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
    parser.add_argument("--server", default=DEFAULT_BACKEND_URL, help="Your personal PC Robowski backend URL")
    parser.add_argument("--interval", type=float, default=5.0, help="Seconds between status updates (default: 5)")
    parser.add_argument(
        "--enable-hardware",
        action="store_true",
        default=os.environ.get("ROBOWSKI_ENABLE_HARDWARE", "0").strip() in {"1", "true", "yes"},
        help="Optional flag (not needed if you create robot_pin.txt)",
    )
    parser.add_argument("--repo", default="", help="Optional path to robowski folder (auto-detected automatically)")
    parser.add_argument("--token", default="", help="Optional shared secret if ROBOWSKI_RELAY_TOKEN is set on personal PC")
    parser.add_argument("--pin", default="", help="Optional PIN (easier: just save it in robot_pin.txt)")
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
        )
        agent.run_forever()
    except Exception as exc:
        import traceback

        print(f"[Robowski Helper] Startup error: {exc}")
        traceback.print_exc()
        sys.exit(1)


if __name__ == "__main__":
    main()
