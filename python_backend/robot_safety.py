"""
Shared robot safety, validation, PIN rate-limiting, relay command signing,
and multi-format plate geometry helpers for Robowski Studio.

Imported by both `app.py` (Personal Lab PC backend) and `robot_pc_agent.py`
(Robot PC helper) so safety bounds and validation rules never drift apart.
"""

from __future__ import annotations

import hashlib
import hmac
import json
import math
import re
import threading
import time
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional, Tuple

ALLOWED_COMMANDS = frozenset(
    {
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
        "move_to_nanodrop",
        "move_xy_rel",
        "move_z",
        "move_z_rel",
        "check_liquid_level",
        "single_transfer",
        "plate_transfer_start",
        "plate_transfer_stop",
        "save_plate_preset",
        "delete_plate_preset",
        "move_to_plate_well",
        "read_xy_position",
        "balance_door_open",
        "balance_door_close",
        "balance_tare",
        "balance_read",
        "read_instrument_status",
        "nanodrop_connect",
        "nanodrop_disconnect",
        "nanodrop_lid_open",
        "nanodrop_lid_close",
        "nanodrop_lid_half_open",
        "nanodrop_flush",
        "nanodrop_dry",
        "nanodrop_wash_cycle",
        "nanodrop_close_all",
    }
)

# Commands that may safely run without requiring prior XY homing (e.g. emergency
# stop, tip sensor check, discarding a stuck tip, raising Z, or calibration read).
COMMANDS_ALLOWED_WITHOUT_HOMING = frozenset(
    {
        "init_hardware",
        "disconnect_hardware",
        "home_xy",
        "move_z_traverse",
        "kill_alarm",
        "emergency_stop",
        "discard_tip",
        "check_tip_status",
        "read_instrument_status",
        "read_xy_position",
        "reload_tip_rack",
        "mark_tips_used",
        "save_plate_preset",
        "delete_plate_preset",
        "plate_transfer_stop",
        "nanodrop_connect",
        "nanodrop_disconnect",
        "nanodrop_lid_open",
        "nanodrop_lid_close",
        "nanodrop_lid_half_open",
        "nanodrop_flush",
        "nanodrop_dry",
        "nanodrop_wash_cycle",
        "nanodrop_close_all",
    }
)

ALLOWED_SOLVENTS = frozenset(
    {
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
)

TIP_CAPACITY_UL: Dict[str, float] = {
    "50ul": 50.0,
    "300ul": 300.0,
    "1000ul": 1000.0,
}

MAX_SINGLE_PASS_TRANSFER_UL = 1000.0
WELL_ROW_LETTERS = "ABCDEFGHIJKLMNOP"
MAX_CUSTOM_PRESETS = 50
_PRESET_ID_RE = re.compile(r"^[a-zA-Z0-9_-]{1,64}$")


def validate_solvent(raw_solvent: Any) -> str:
    solvent = str(raw_solvent if raw_solvent is not None else "").strip()
    if solvent not in ALLOWED_SOLVENTS:
        allowed_preview = ", ".join(sorted(ALLOWED_SOLVENTS))
        raise ValueError(
            f"Unsupported solvent '{solvent or '(empty)'}'. Choose a supported liquid class ({allowed_preview})."
        )
    return solvent


def resolve_and_validate_tip_and_volume(raw_volume: Any, raw_tip_type: Any) -> Tuple[float, str, str]:
    """
    Validates transfer volume (1–1000 µL single-pass cap) and ensures the chosen
    pipette tip can physically hold the requested volume.
    Returns (volume_ul, normalized_tip_setting, resolved_tip_type).
    """
    try:
        vol_ul = float(raw_volume)
    except Exception as exc:
        raise ValueError("Transfer volume must be a valid number.") from exc
    if not math.isfinite(vol_ul):
        raise ValueError("Transfer volume must be a finite number.")
    if vol_ul < 1.0:
        raise ValueError("Transfer volume must be at least 1 µL.")
    if vol_ul > MAX_SINGLE_PASS_TRANSFER_UL:
        raise ValueError(
            f"Transfer volume ({vol_ul:g} µL) exceeds the 1000 µL maximum single-pass tip capacity. "
            "Split larger volumes into two transfers."
        )

    tip_setting = str(raw_tip_type if raw_tip_type is not None else "auto").strip()
    if tip_setting not in {"auto", "50ul", "300ul", "1000ul"}:
        raise ValueError("tip_type must be auto, 50ul, 300ul, or 1000ul.")

    if tip_setting == "auto":
        resolved = "50ul" if vol_ul <= 50.0 else ("300ul" if vol_ul <= 300.0 else "1000ul")
    else:
        resolved = tip_setting
        cap = TIP_CAPACITY_UL[resolved]
        if vol_ul > cap:
            raise ValueError(
                f"Requested {vol_ul:g} µL exceeds the capacity of a {int(cap)} µL tip. "
                "Select a larger tip size or set Tip size to Auto."
            )

    return (round(vol_ul, 2), tip_setting, resolved)


def format_well_name(well_idx: int, cols: int) -> str:
    safe_cols = max(1, int(cols))
    r = well_idx // safe_cols
    c = (well_idx % safe_cols) + 1
    row_lbl = WELL_ROW_LETTERS[r] if 0 <= r < len(WELL_ROW_LETTERS) else f"R{r + 1}"
    return f"{row_lbl}{c}"


def parse_xy_pair(raw: Any, label: str) -> List[float]:
    if not isinstance(raw, (list, tuple)) or len(raw) != 2:
        raise ValueError(f"{label} must be an [X, Y] coordinate pair in mm.")
    try:
        x = float(raw[0])
        y = float(raw[1])
    except Exception as exc:
        raise ValueError(f"{label} must contain valid numbers.") from exc
    if not (math.isfinite(x) and math.isfinite(y)):
        raise ValueError(f"{label} must contain finite numbers.")
    if not (-600.0 <= x <= 600.0 and -600.0 <= y <= 600.0):
        raise ValueError(f"{label} ({x}, {y}) is outside the safe deck range (-600 to 600 mm).")
    return [round(x, 3), round(y, 3)]


def normalize_plate_preset(raw: Dict[str, Any]) -> Dict[str, Any]:
    name = str(raw.get("name", "")).strip()
    if not name or len(name) > 60:
        raise ValueError("Preset name must be between 1 and 60 characters.")
    try:
        plate_slot = int(raw.get("plate_slot", raw.get("plateSlot", 0)))
        rows = int(raw.get("rows", 8))
        cols = int(raw.get("cols", 12))
        default_z = int(raw.get("default_z", raw.get("defaultZ", 1900)))
    except Exception as exc:
        raise ValueError("plate_slot, rows, cols, and default_z must be integers.") from exc
    if plate_slot not in {0, 1, 2}:
        raise ValueError("plate_slot must be 0, 1, or 2 (plate0, plate1, or plate2).")
    if not (1 <= rows <= 16 and 1 <= cols <= 24) or (rows * cols > 384):
        raise ValueError("Grid dimensions must be 1–16 rows × 1–24 columns (max 384 wells).")
    if not (880 <= default_z <= 2190):
        raise ValueError("default_z must be between 880 and 2190.")
    a1 = parse_xy_pair(raw.get("corner_a1", raw.get("cornerA1")), "Corner A1")
    tr = parse_xy_pair(raw.get("corner_top_right", raw.get("cornerTopRight")), "Top-Right corner")
    bl = parse_xy_pair(raw.get("corner_bottom_left", raw.get("cornerBottomLeft")), "Bottom-Left corner")

    col_pitch = 0.0
    if cols > 1:
        col_pitch = math.hypot(tr[0] - a1[0], tr[1] - a1[1]) / float(cols - 1)
        if not (2.0 <= col_pitch <= 80.0):
            raise ValueError(
                f"Detected column spacing ({col_pitch:.2f} mm) is outside the safe 2–80 mm range. Check A1 and Top-Right."
            )
    row_pitch = 0.0
    if rows > 1:
        row_pitch = math.hypot(bl[0] - a1[0], bl[1] - a1[1]) / float(rows - 1)
        if not (2.0 <= row_pitch <= 80.0):
            raise ValueError(
                f"Detected row spacing ({row_pitch:.2f} mm) is outside the safe 2–80 mm range. Check A1 and Bottom-Left."
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


def compute_preset_well_xy(preset: Dict[str, Any], well_idx: int) -> Tuple[float, float]:
    rows = int(preset["rows"])
    cols = int(preset["cols"])
    if not (0 <= well_idx < rows * cols):
        raise ValueError(f"Well index {well_idx} is out of range for {rows}×{cols} plate.")
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


def apply_custom_xy_to_container(container: Any, xy: Tuple[float, float]) -> Any:
    orig_xy = getattr(container, "xy", None)
    if isinstance(orig_xy, list):
        container.xy = [xy[0], xy[1]]
    else:
        container.xy = (xy[0], xy[1])
    if hasattr(container, "x"):
        try:
            container.x = xy[0]
        except Exception:
            pass
    if hasattr(container, "y"):
        try:
            container.y = xy[1]
        except Exception:
            pass
    return container


def validate_robot_command_params(cmd: str, params: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
    """
    Shared strict parameter validator used by both `app.py` and `robot_pc_agent.py`.
    Raises ValueError on any invalid, out-of-range, or unsupported parameter.
    """
    if cmd not in ALLOWED_COMMANDS:
        raise ValueError(f"Unknown or unsupported robot command: '{cmd}'")
    p = params if isinstance(params, dict) else {}
    clean: Dict[str, Any] = {}

    if cmd in {"pick_tip", "change_tip", "reload_tip_rack", "mark_tips_used"}:
        tt = str(p.get("tip_type", "300ul")).strip()
        if tt not in TIP_CAPACITY_UL:
            raise ValueError("tip_type must be 50ul, 300ul, or 1000ul")
        clean["tip_type"] = tt

    if cmd == "mark_tips_used":
        try:
            cnt = int(p.get("count", 1))
        except Exception as exc:
            raise ValueError("count must be an integer between 1 and 96") from exc
        if not (1 <= cnt <= 96):
            raise ValueError("count must be between 1 and 96")
        clean["count"] = cnt

    if cmd in {"move_to_container", "check_liquid_level"}:
        try:
            plate_id = int(p.get("plate_id", 0))
            container_id = int(p.get("container_id", 0))
        except Exception as exc:
            raise ValueError("plate_id and container_id must be integers") from exc
        if not (0 <= plate_id <= 7):
            raise ValueError("plate_id must be between 0 and 7")
        max_c = 53 if plate_id <= 2 else (7 if plate_id <= 5 else 1)
        if not (0 <= container_id <= max_c):
            raise ValueError(f"container_id for plate{plate_id} must be between 0 and {max_c}")
        clean["plate_id"] = plate_id
        clean["container_id"] = container_id

    if cmd == "move_xy_rel":
        try:
            dx = float(p.get("dx", 0))
            dy = float(p.get("dy", 0))
        except Exception as exc:
            raise ValueError("dx and dy must be numbers") from exc
        if not (math.isfinite(dx) and math.isfinite(dy)):
            raise ValueError("dx and dy must be finite numbers")
        if not (-100.0 <= dx <= 100.0 and -100.0 <= dy <= 100.0):
            raise ValueError("Relative jog must stay within ±100 mm per click for safety")
        clean["dx"] = round(dx, 2)
        clean["dy"] = round(dy, 2)

    if cmd == "move_z":
        try:
            z = int(p.get("z", 880))
        except Exception as exc:
            raise ValueError("z must be an integer between 500 and 2200") from exc
        if not (500 <= z <= 2200):
            raise ValueError("Z height must stay between 500 (top) and 2200 (just above bottom) for safety")
        clean["z"] = z

    if cmd == "move_z_rel":
        try:
            dz = int(p.get("dz", 0))
        except Exception as exc:
            raise ValueError("dz must be an integer between -300 and +300") from exc
        if not (-300 <= dz <= 300):
            raise ValueError("Z step must stay within ±30 mm (±300 units) per click for safety")
        clean["dz"] = dz

    if cmd == "single_transfer":
        try:
            src_plate = int(p.get("src_plate", 3))
            src_slot = int(p.get("src_slot", 0))
            dst_plate = int(p.get("dst_plate", 0))
            dst_slot = int(p.get("dst_slot", 0))
            src_z = int(p.get("src_z", 1900))
            dst_z = int(p.get("dst_z", 2100))
        except Exception as exc:
            raise ValueError("Invalid numeric transfer parameters.") from exc
        if not (0 <= src_plate <= 7 and 0 <= dst_plate <= 7):
            raise ValueError("Source and destination plates must be between 0 and 7.")
        src_preset_id = str(p.get("src_preset_id", "default_54")).strip() or "default_54"
        dst_preset_id = str(p.get("dst_preset_id", "default_54")).strip() or "default_54"
        if not _PRESET_ID_RE.match(src_preset_id) or not _PRESET_ID_RE.match(dst_preset_id):
            raise ValueError("Invalid plate preset ID.")
        src_max = (383 if src_preset_id != "default_54" else 53) if src_plate <= 2 else (7 if src_plate <= 5 else 1)
        dst_max = (383 if dst_preset_id != "default_54" else 53) if dst_plate <= 2 else (7 if dst_plate <= 5 else 1)
        if not (0 <= src_slot <= src_max and 0 <= dst_slot <= dst_max):
            raise ValueError("Source or destination slot is out of range for that plate.")
        if not (880 <= src_z <= 2190 and 880 <= dst_z <= 2190):
            raise ValueError("Liquid surface Z heights must be between 880 and 2190.")
        solvent = validate_solvent(p.get("solvent", "ethanol"))
        vol_ul, tip_setting, _resolved = resolve_and_validate_tip_and_volume(
            p.get("volume_ul", 100.0), p.get("tip_type", "auto")
        )
        clean.update(
            {
                "src_plate": src_plate,
                "src_slot": src_slot,
                "src_preset_id": src_preset_id,
                "dst_plate": dst_plate,
                "dst_slot": dst_slot,
                "dst_preset_id": dst_preset_id,
                "volume_ul": vol_ul,
                "solvent": solvent,
                "tip_type": tip_setting,
                "src_z": src_z,
                "dst_z": dst_z,
                "pick_tip": bool(p.get("pick_tip", True)),
                "prewet": bool(p.get("prewet", False)),
                "mix_after": bool(p.get("mix_after", False)),
                "drop_tip": bool(p.get("drop_tip", True)),
            }
        )

    if cmd == "plate_transfer_start":
        try:
            src_plate = int(p.get("src_plate", 0))
            dst_plate = int(p.get("dst_plate", 1))
            src_z = int(p.get("src_z", 2100))
            dst_z = int(p.get("dst_z", 2100))
        except Exception as exc:
            raise ValueError("Invalid numeric plate transfer parameters.") from exc
        if src_plate not in {0, 1, 2} or dst_plate not in {0, 1, 2}:
            raise ValueError("Plate-to-plate transfer uses plates 0, 1, or 2.")
        if src_plate == dst_plate:
            raise ValueError("Source plate and destination plate must be different.")
        src_preset_id = str(p.get("src_preset_id", "default_54")).strip() or "default_54"
        dst_preset_id = str(p.get("dst_preset_id", "default_54")).strip() or "default_54"
        if not _PRESET_ID_RE.match(src_preset_id) or not _PRESET_ID_RE.match(dst_preset_id):
            raise ValueError("Invalid plate preset ID.")
        if not (880 <= src_z <= 2190 and 880 <= dst_z <= 2190):
            raise ValueError("Liquid surface Z heights must be between 880 and 2190.")
        solvent = validate_solvent(p.get("solvent", "ethanol"))
        vol_ul, tip_setting, _resolved = resolve_and_validate_tip_and_volume(
            p.get("volume_ul", 50.0), p.get("tip_type", "auto")
        )

        raw_pairs = p.get("pairs")
        pairs: List[List[int]] = []
        if isinstance(raw_pairs, list) and len(raw_pairs) > 0:
            if len(raw_pairs) > 384:
                raise ValueError("Maximum 384 well transfers per job.")
            seen_p: set[tuple[int, int]] = set()
            for item in raw_pairs:
                if not isinstance(item, (list, tuple)) or len(item) != 2:
                    raise ValueError("Each transfer pair must be [srcWell, dstWell].")
                try:
                    sw, dw = int(item[0]), int(item[1])
                except Exception as exc:
                    raise ValueError("Well indices must be integers.") from exc
                if not (0 <= sw <= 383 and 0 <= dw <= 383):
                    raise ValueError("Well indices must be between 0 and 383.")
                if (sw, dw) not in seen_p:
                    seen_p.add((sw, dw))
                    pairs.append([sw, dw])
            wells = [pair[0] for pair in pairs]
        else:
            raw_wells = p.get("wells")
            if raw_wells is None:
                wells = list(range(54))
            elif isinstance(raw_wells, list):
                wells_set = set()
                for w in raw_wells:
                    try:
                        wi = int(w)
                    except Exception as exc:
                        raise ValueError("Well indices must be integers.") from exc
                    if not (0 <= wi <= 383):
                        raise ValueError("Well indices must be between 0 and 383.")
                    wells_set.add(wi)
                wells = sorted(wells_set)
            else:
                raise ValueError("wells must be a list of well indices.")
            pairs = [[w, w] for w in wells]
        if not pairs:
            raise ValueError("Select at least one well to transfer.")

        clean.update(
            {
                "src_plate": src_plate,
                "dst_plate": dst_plate,
                "src_preset_id": src_preset_id,
                "dst_preset_id": dst_preset_id,
                "wells": wells,
                "pairs": pairs,
                "volume_ul": vol_ul,
                "solvent": solvent,
                "tip_type": tip_setting,
                "src_z": src_z,
                "dst_z": dst_z,
                "change_tip_each_vial": bool(p.get("change_tip_each_vial", True)),
                "prewet": bool(p.get("prewet", False)),
                "mix_after": bool(p.get("mix_after", False)),
                "drop_tip_at_end": bool(p.get("drop_tip_at_end", True)),
            }
        )

    if cmd == "save_plate_preset":
        norm = normalize_plate_preset(p)
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
        pid = str(p.get("id", "")).strip()
        if not pid or not _PRESET_ID_RE.match(pid):
            raise ValueError("Invalid plate preset ID.")
        clean["id"] = pid

    if cmd == "move_to_plate_well":
        try:
            pl = int(p.get("plate_id", 0))
            wi = int(p.get("well_index", 0))
        except Exception as exc:
            raise ValueError("plate_id and well_index must be integers.") from exc
        if pl not in {0, 1, 2}:
            raise ValueError("plate_id must be 0, 1, or 2.")
        if not (0 <= wi <= 383):
            raise ValueError("well_index must be between 0 and 383.")
        clean["plate_id"] = pl
        clean["well_index"] = wi
        if (
            p.get("corner_a1") is not None
            and p.get("corner_top_right") is not None
            and p.get("corner_bottom_left") is not None
        ):
            norm = normalize_plate_preset(
                {
                    "name": "Test preview",
                    "plate_slot": pl,
                    "rows": p.get("rows", 8),
                    "cols": p.get("cols", 12),
                    "corner_a1": p.get("corner_a1"),
                    "corner_top_right": p.get("corner_top_right"),
                    "corner_bottom_left": p.get("corner_bottom_left"),
                    "default_z": p.get("default_z", 1900),
                }
            )
            if wi >= norm["rows"] * norm["cols"]:
                raise ValueError("well_index exceeds rows × cols.")
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
            pid = str(p.get("preset_id", "default_54")).strip() or "default_54"
            if not _PRESET_ID_RE.match(pid):
                raise ValueError("Invalid preset_id.")
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
        nd_id = str(p.get("nd_id", "nd_2000c")).strip()
        if nd_id not in {"nd_2000c", "nd_2000"}:
            raise ValueError("nd_id must be nd_2000c or nd_2000.")
        clean["nd_id"] = nd_id

    return clean


class PinRateLimiter:
    """
    Thread-safe PIN brute-force protection: locks a client key for `lockout_sec`
    after `max_attempts` consecutive wrong PINs.
    """

    def __init__(self, max_attempts: int = 5, lockout_sec: float = 300.0) -> None:
        self.max_attempts = max(1, int(max_attempts))
        self.lockout_sec = max(1.0, float(lockout_sec))
        self._lock = threading.Lock()
        self._state: Dict[str, Dict[str, Any]] = {}

    def check_locked(self, client_key: str, now_mono: Optional[float] = None) -> Optional[int]:
        now = time.monotonic() if now_mono is None else float(now_mono)
        with self._lock:
            entry = self._state.get(client_key)
            if not entry:
                return None
            locked_until = float(entry.get("lockedUntil", 0.0))
            if locked_until > now:
                return max(1, int(math.ceil(locked_until - now)))
            if locked_until > 0.0:
                entry["lockedUntil"] = 0.0
                entry["failures"] = 0
            return None

    def record_failure(self, client_key: str, now_mono: Optional[float] = None) -> Tuple[int, Optional[int]]:
        now = time.monotonic() if now_mono is None else float(now_mono)
        with self._lock:
            entry = self._state.setdefault(client_key, {"failures": 0, "lockedUntil": 0.0})
            if float(entry["lockedUntil"]) > now:
                rem = max(1, int(math.ceil(float(entry["lockedUntil"]) - now)))
                return (int(entry["failures"]), rem)
            entry["failures"] = int(entry["failures"]) + 1
            if entry["failures"] >= self.max_attempts:
                entry["lockedUntil"] = now + self.lockout_sec
                return (entry["failures"], int(math.ceil(self.lockout_sec)))
            return (entry["failures"], None)

    def record_success(self, client_key: str) -> None:
        with self._lock:
            self._state.pop(client_key, None)


def _canonical_relay_payload(cmd_id: str, command: str, params: Dict[str, Any], issued_at: float) -> bytes:
    canonical = json.dumps(
        {
            "id": str(cmd_id),
            "command": str(command),
            "params": params if isinstance(params, dict) else {},
            "issuedAt": round(float(issued_at), 3),
        },
        sort_keys=True,
        separators=(",", ":"),
        ensure_ascii=False,
    )
    return canonical.encode("utf-8")


def sign_relay_command(
    relay_token: str,
    cmd_id: str,
    command: str,
    params: Dict[str, Any],
    issued_at: float,
) -> str:
    """
    Produces an HMAC-SHA256 signature proving the personal PC backend authenticated
    the user's PIN and issued this exact command—without ever transmitting the PIN
    over the relay payload.
    """
    secret = (relay_token or "").strip()
    if not secret:
        raise ValueError("Relay token is required to sign relayed robot commands.")
    msg = _canonical_relay_payload(cmd_id, command, params, issued_at)
    return hmac.new(secret.encode("utf-8"), msg, hashlib.sha256).hexdigest()


def verify_relay_command(
    relay_token: str,
    cmd_id: str,
    command: str,
    params: Dict[str, Any],
    issued_at: float,
    signature: str,
    now_ts: Optional[float] = None,
    max_age_sec: float = 60.0,
) -> Tuple[bool, str]:
    secret = (relay_token or "").strip()
    if not secret:
        return (False, "Relay token is not configured on the Robot PC.")
    sig = (signature or "").strip()
    if not sig:
        return (False, "Missing signed command token from personal PC backend.")
    now = time.time() if now_ts is None else float(now_ts)
    age = abs(now - float(issued_at))
    if age > max_age_sec:
        return (False, f"Relayed command expired ({int(age)}s old).")
    expected = sign_relay_command(secret, cmd_id, command, params, issued_at)
    if not hmac.compare_digest(sig, expected):
        return (False, "Invalid command signature — check that relay_token.txt matches on both PCs.")
    return (True, "OK")
