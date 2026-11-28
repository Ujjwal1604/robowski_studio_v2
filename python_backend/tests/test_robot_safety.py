"""
Automated safety, security, and reliability tests for the Robowski Studio
robot subsystem (`robot_safety.py`, `robot_pc_agent.py`, and `app.py` relay).

Runs completely offline with fake `zeus`, `pipetter`, and `breadboard` hardware
modules so every safety guard can be verified without touching a live robot.
"""

from __future__ import annotations

import os
import sys
import threading
import time
import types
import unittest
from pathlib import Path
from unittest import mock

BACKEND_DIR = Path(__file__).resolve().parent.parent
if str(BACKEND_DIR) not in sys.path:
    sys.path.insert(0, str(BACKEND_DIR))

import robot_safety  # noqa: E402
import robot_pc_agent  # noqa: E402


class FakeContainer:
    def __init__(self, x: float, y: float) -> None:
        self.xy = [x, y]
        self.x = x
        self.y = y
        self.liquid_surface_height = 1900


class FakePlate:
    def __init__(self, count: int) -> None:
        self.containers = [FakeContainer(float(i * 10), float((i % 6) * 10)) for i in range(count)]


class FakeBreadboard:
    def __init__(self) -> None:
        self.plate_list = [
            FakePlate(54),
            FakePlate(54),
            FakePlate(54),
            FakePlate(8),
            FakePlate(8),
            FakePlate(8),
            FakePlate(2),
            FakePlate(2),
        ]
        self.trash = FakeContainer(10.0, 10.0)
        self.balance_location = FakeContainer(20.0, 20.0)
        self.nanodrop_location = FakeContainer(30.0, 30.0)


class FakeZeus:
    def __init__(self) -> None:
        self.tip_present = False
        self.tip_on_zeus = ""
        self.emergency_stop_calls: list[int] = []
        self.emergency_stop_times: list[float] = []
        self.last_z = 880

    def getTipPresenceStatus(self) -> bool:
        return self.tip_present

    def setEmergencyStop(self, value: int) -> None:
        self.emergency_stop_calls.append(int(value))
        self.emergency_stop_times.append(time.monotonic())

    def moveZDrive(self, z: int) -> None:
        self.last_z = int(z)

    def move_zeus_to_traverse_height(self) -> None:
        self.last_z = 880

    def getZPosition(self) -> int:
        return self.last_z


class FakeGantry:
    def __init__(self) -> None:
        self.homed_count = 0
        self.xy = [0.0, 0.0]
        self.alarm_killed = 0

    def home_xy(self) -> None:
        self.homed_count += 1
        self.xy = [0.0, 0.0]

    def move_to_xy(self, xy: list[float]) -> None:
        self.xy = [float(xy[0]), float(xy[1])]

    def get_xy(self) -> list[float]:
        return list(self.xy)

    def kill_alarm(self) -> None:
        self.alarm_killed += 1


class FakePipetter:
    def __init__(self, zm: FakeZeus, gt: FakeGantry, slow_transfer_event: threading.Event | None = None) -> None:
        self.zm = zm
        self.gt = gt
        self.current_tip = ""
        self.slow_transfer_event = slow_transfer_event
        self.transfer_started = threading.Event()
        self.transfers: list[dict] = []
        self.discard_calls = 0

    def move_z_to_traverse_height(self) -> None:
        self.zm.moveZDrive(880)

    def pick_tip(self, tip_type: str) -> None:
        self.current_tip = tip_type
        self.zm.tip_present = True
        self.zm.tip_on_zeus = tip_type

    def discard_tip(self) -> None:
        self.discard_calls += 1
        self.current_tip = ""
        self.zm.tip_present = False
        self.zm.tip_on_zeus = ""

    def move_to_container(self, container: FakeContainer) -> None:
        self.gt.move_to_xy(container.xy)

    def move_to_idle_position(self) -> None:
        self.gt.move_to_xy([0.0, 0.0])

    def transfer_liquid(self, **kwargs) -> None:
        self.transfer_started.set()
        if self.slow_transfer_event is not None:
            # Block until test releases or times out
            self.slow_transfer_event.wait(timeout=5.0)
        self.transfers.append(kwargs)


def _install_fake_hardware_on_agent(
    agent: robot_pc_agent.RobotPcAgent,
    *,
    connected: bool = True,
    homed: bool = True,
    tip_present: bool = False,
    slow_transfer_event: threading.Event | None = None,
):
    zm = FakeZeus()
    zm.tip_present = tip_present
    gt = FakeGantry()
    pt = FakePipetter(zm, gt, slow_transfer_event=slow_transfer_event)
    brb = FakeBreadboard()
    agent.hw.update(
        {
            "zm": zm if connected else None,
            "gt": gt if connected else None,
            "pt": pt if connected else None,
            "brb": brb if connected else None,
            "connected": connected,
            "homed": homed,
            "lastActivityMono": time.monotonic(),
        }
    )
    return zm, gt, pt, brb


class TestSharedValidationAndAuth(unittest.TestCase):
    def test_unknown_solvent_is_rejected_not_silently_ethanol(self) -> None:
        with self.assertRaises(ValueError):
            robot_safety.validate_solvent("acetone_unknown")
        with self.assertRaises(ValueError):
            robot_safety.validate_solvent("")
        with self.assertRaises(ValueError):
            robot_safety.validate_robot_command_params(
                "single_transfer",
                {"solvent": "magic_liquid", "volume_ul": 100, "tip_type": "auto"},
            )
        with self.assertRaises(ValueError):
            robot_safety.validate_robot_command_params(
                "plate_transfer_start",
                {
                    "src_plate": 0,
                    "dst_plate": 1,
                    "solvent": "invalid_solvent",
                    "volume_ul": 50,
                    "wells": [0],
                },
            )
        self.assertEqual(robot_safety.validate_solvent("DMF"), "DMF")

    def test_tip_capacity_and_single_pass_volume_limits(self) -> None:
        # 50 uL tip cannot hold 100 uL
        with self.assertRaises(ValueError):
            robot_safety.resolve_and_validate_tip_and_volume(100, "50ul")
        # 300 uL tip cannot hold 500 uL
        with self.assertRaises(ValueError):
            robot_safety.resolve_and_validate_tip_and_volume(500, "300ul")
        # > 1000 uL single-pass rejected even with auto or 1000ul
        with self.assertRaises(ValueError):
            robot_safety.resolve_and_validate_tip_and_volume(1200, "auto")
        with self.assertRaises(ValueError):
            robot_safety.resolve_and_validate_tip_and_volume(1500, "1000ul")
        # Valid boundaries succeed
        self.assertEqual(robot_safety.resolve_and_validate_tip_and_volume(50, "50ul"), (50.0, "50ul", "50ul"))
        self.assertEqual(robot_safety.resolve_and_validate_tip_and_volume(250, "auto"), (250.0, "auto", "300ul"))
        self.assertEqual(robot_safety.resolve_and_validate_tip_and_volume(1000, "auto"), (1000.0, "auto", "1000ul"))

    def test_pin_rate_limiter_locks_after_5_wrong_attempts_for_5_minutes(self) -> None:
        limiter = robot_safety.PinRateLimiter(max_attempts=5, lockout_sec=300.0)
        t0 = 1000.0
        for i in range(4):
            fails, lock = limiter.record_failure("clientA", now_mono=t0 + i)
            self.assertEqual(fails, i + 1)
            self.assertIsNone(lock)
            self.assertIsNone(limiter.check_locked("clientA", now_mono=t0 + i))

        # 5th failure locks for 300 seconds
        fails, lock = limiter.record_failure("clientA", now_mono=t0 + 4)
        self.assertEqual(fails, 5)
        self.assertEqual(lock, 300)
        self.assertGreater(limiter.check_locked("clientA", now_mono=t0 + 100) or 0, 190)

        # Unlocks after 300 seconds
        self.assertIsNone(limiter.check_locked("clientA", now_mono=t0 + 305))

        # Success resets failure count
        limiter.record_failure("clientB", now_mono=t0)
        limiter.record_success("clientB")
        self.assertIsNone(limiter.check_locked("clientB", now_mono=t0 + 1))

    def test_relay_command_hmac_signing_and_tamper_rejection(self) -> None:
        token = "shared-lab-secret-token-2026"
        issued = 1700000000.0
        params = {"src_plate": 3, "dst_plate": 0, "volume_ul": 100.0, "solvent": "ethanol"}
        sig = robot_safety.sign_relay_command(token, "cmd-1", "single_transfer", params, issued)

        ok, msg = robot_safety.verify_relay_command(
            token, "cmd-1", "single_transfer", params, issued, sig, now_ts=issued + 5.0
        )
        self.assertTrue(ok, msg)

        # Tampering with params fails
        tampered = dict(params, volume_ul=999.0)
        ok_tamper, _ = robot_safety.verify_relay_command(
            token, "cmd-1", "single_transfer", tampered, issued, sig, now_ts=issued + 5.0
        )
        self.assertFalse(ok_tamper)

        # Wrong token fails
        ok_wrong, _ = robot_safety.verify_relay_command(
            "wrong-token", "cmd-1", "single_transfer", params, issued, sig, now_ts=issued + 5.0
        )
        self.assertFalse(ok_wrong)

        # Expired (> 60 s) fails
        ok_exp, _ = robot_safety.verify_relay_command(
            token, "cmd-1", "single_transfer", params, issued, sig, now_ts=issued + 120.0
        )
        self.assertFalse(ok_exp)

    def test_custom_plate_3_corner_geometry_and_validation(self) -> None:
        preset = robot_safety.normalize_plate_preset(
            {
                "name": "96-well Corning",
                "plate_slot": 1,
                "rows": 8,
                "cols": 12,
                "corner_a1": [100.0, 200.0],
                "corner_top_right": [199.0, 200.0],  # 9.0 mm pitch × 11
                "corner_bottom_left": [100.0, 263.0],  # 9.0 mm pitch × 7
                "default_z": 1950,
            }
        )
        self.assertAlmostEqual(preset["colPitchMm"], 9.0, places=2)
        self.assertAlmostEqual(preset["rowPitchMm"], 9.0, places=2)
        # Well H12 is index 95 -> (199.0, 263.0)
        self.assertEqual(robot_safety.compute_preset_well_xy(preset, 95), (199.0, 263.0))
        # Well B2 is index 13 -> (109.0, 209.0)
        self.assertEqual(robot_safety.compute_preset_well_xy(preset, 13), (109.0, 209.0))

        # Impossible pitch (< 2 mm) rejected
        with self.assertRaises(ValueError):
            robot_safety.normalize_plate_preset(
                {
                    "name": "Bad Pitch",
                    "plate_slot": 0,
                    "rows": 8,
                    "cols": 12,
                    "corner_a1": [100.0, 200.0],
                    "corner_top_right": [105.0, 200.0],
                    "corner_bottom_left": [100.0, 263.0],
                }
            )


class TestRobotPcAgentSafety(unittest.TestCase):
    def _make_agent(self, **kwargs) -> robot_pc_agent.RobotPcAgent:
        with mock.patch.object(robot_pc_agent, "_read_optional_text_file", return_value=""):
            with mock.patch.dict(os.environ, {}, clear=False):
                os.environ.pop("ROBOWSKI_CONTROL_PIN", None)
                os.environ.pop("ROBOWSKI_RELAY_TOKEN", None)
                return robot_pc_agent.RobotPcAgent(
                    server_url="https://example-lab-pc.local",
                    **kwargs,
                )

    def test_pinless_hardware_backdoor_is_closed(self) -> None:
        # Starting with enable_hardware=True and NO pin and NO relay_token must keep hardware locked
        agent = self._make_agent(enable_hardware=True, control_pin="", relay_token="")
        self.assertFalse(agent.enable_hardware)
        res = agent.execute_command("c1", "home_xy", {})
        self.assertFalse(res["ok"])
        self.assertFalse(res["executed"])

    def test_unknown_solvent_and_tip_overflow_rejected_by_agent(self) -> None:
        agent = self._make_agent(enable_hardware=True, relay_token="secret-token")
        _install_fake_hardware_on_agent(agent, connected=True, homed=True)

        bad_solv = agent.execute_command(
            "c-solv",
            "single_transfer",
            {"src_plate": 3, "src_slot": 0, "dst_plate": 0, "dst_slot": 0, "volume_ul": 50, "solvent": "bad_solvent"},
            verified_relay=True,
        )
        self.assertFalse(bad_solv["ok"])
        self.assertIn("Unsupported solvent", bad_solv["humanMessage"])

        bad_tip = agent.execute_command(
            "c-tip",
            "single_transfer",
            {"src_plate": 3, "src_slot": 0, "dst_plate": 0, "dst_slot": 0, "volume_ul": 200, "tip_type": "50ul", "solvent": "ethanol"},
            verified_relay=True,
        )
        self.assertFalse(bad_tip["ok"])
        self.assertIn("exceeds the capacity", bad_tip["humanMessage"])

    def test_preemptive_software_stop_interrupts_during_busy_transfer(self) -> None:
        agent = self._make_agent(enable_hardware=True, relay_token="secret-token")
        release_transfer = threading.Event()
        zm, _gt, pt, _brb = _install_fake_hardware_on_agent(
            agent, connected=True, homed=True, tip_present=True, slow_transfer_event=release_transfer
        )
        zm.tip_on_zeus = "300ul"

        # Start a slow transfer in a worker thread (holding agent._hw_lock)
        worker_out: dict = {}

        def _run_transfer():
            worker_out["res"] = agent.execute_command(
                "c-move",
                "single_transfer",
                {
                    "src_plate": 3,
                    "src_slot": 0,
                    "dst_plate": 0,
                    "dst_slot": 0,
                    "volume_ul": 100,
                    "solvent": "ethanol",
                    "tip_type": "300ul",
                    "pick_tip": False,
                    "drop_tip": False,
                },
                verified_relay=True,
            )

        t = threading.Thread(target=_run_transfer, daemon=True)
        t.start()
        self.assertTrue(pt.transfer_started.wait(timeout=2.0), "Transfer should start inside worker thread")

        # Now fire Software Stop while the worker thread STILL holds _hw_lock!
        t_start = time.monotonic()
        stop_res = agent.execute_command("c-stop", "emergency_stop", {}, verified_relay=True)
        elapsed = time.monotonic() - t_start

        try:
            self.assertTrue(stop_res["ok"])
            self.assertTrue(stop_res["executed"])
            self.assertEqual(zm.emergency_stop_calls, [1])
            self.assertLess(elapsed, 0.5, "Software Stop must NOT wait behind the busy worker lock")
        finally:
            release_transfer.set()
            t.join(timeout=2.0)

    def test_no_silent_auto_home_and_refuse_home_with_tip_attached(self) -> None:
        agent = self._make_agent(enable_hardware=True, relay_token="secret-token")
        zm, gt, pt, _brb = _install_fake_hardware_on_agent(
            agent, connected=True, homed=False, tip_present=True
        )

        # 1. Motion command while unhomed must be refused (no silent auto-home)
        move_res = agent.execute_command(
            "c-unhomed",
            "move_to_container",
            {"plate_id": 3, "container_id": 0},
            verified_relay=True,
        )
        self.assertFalse(move_res["ok"])
        self.assertEqual(gt.homed_count, 0)
        self.assertIn("homed", move_res["humanMessage"].lower())

        # 2. Explicit home_xy must refuse while a tip is detected by Zeus
        home_blocked = agent.execute_command("c-home-tip", "home_xy", {}, verified_relay=True)
        self.assertFalse(home_blocked["ok"])
        self.assertEqual(gt.homed_count, 0)
        self.assertIn("tip", home_blocked["humanMessage"].lower())

        # 3. discard_tip IS allowed without prior homing so user can drop the stuck tip
        drop_res = agent.execute_command("c-drop", "discard_tip", {}, verified_relay=True)
        self.assertTrue(drop_res["ok"])
        self.assertEqual(pt.discard_calls, 1)
        self.assertFalse(zm.tip_present)

        # 4. Now home_xy succeeds cleanly and marks homed=True
        home_ok = agent.execute_command("c-home-ok", "home_xy", {}, verified_relay=True)
        self.assertTrue(home_ok["ok"])
        self.assertEqual(gt.homed_count, 1)
        self.assertTrue(agent.hw["homed"])

        # 5. Disconnected robot also refuses motion commands without auto-connecting & auto-homing
        agent.hw["connected"] = False
        agent.hw["homed"] = False
        disc_res = agent.execute_command(
            "c-disc",
            "move_to_container",
            {"plate_id": 3, "container_id": 0},
            verified_relay=True,
        )
        self.assertFalse(disc_res["ok"])
        self.assertIn("connect & home", disc_res["humanMessage"].lower())

    def test_direct_pin_lockout_on_agent(self) -> None:
        agent = self._make_agent(enable_hardware=True, control_pin="LabPin2026")
        _install_fake_hardware_on_agent(agent, connected=True, homed=True)

        for _ in range(4):
            r = agent.execute_command("bad", "check_tip_status", {}, supplied_pin="wrong", verified_relay=False)
            self.assertFalse(r["ok"])
            self.assertEqual(r.get("error"), "Invalid PIN")

        # 5th wrong PIN triggers lockout
        r5 = agent.execute_command("bad5", "check_tip_status", {}, supplied_pin="wrong", verified_relay=False)
        self.assertFalse(r5["ok"])
        self.assertIn("Locked", r5["humanMessage"])

        # Even the right PIN is blocked while locked out
        r_good = agent.execute_command("good", "check_tip_status", {}, supplied_pin="LabPin2026", verified_relay=False)
        self.assertFalse(r_good["ok"])
        self.assertEqual(r_good.get("error"), "PIN locked")

    def test_simulate_dry_run_mode_works_without_real_hardware(self) -> None:
        agent = self._make_agent(simulate=True, relay_token="dry-run-secret")
        self.assertTrue(agent.simulate)
        self.assertTrue(agent.enable_hardware)
        self.assertIn("Dry-Run Simulator", agent.robot_name)

        # Unhomed move refused even in dry-run mode
        r0 = agent.execute_command("s0", "move_to_container", {"plate_id": 3, "container_id": 0}, verified_relay=True)
        self.assertFalse(r0["ok"])

        # Connect & Home succeeds using built-in virtual hardware (no USB/CAN modules needed)
        r1 = agent.execute_command("s1", "init_hardware", {}, verified_relay=True)
        self.assertTrue(r1["ok"])
        self.assertTrue(r1["hardware"]["simulated"])
        self.assertTrue(r1["hardware"]["homed"])

        # Single transfer succeeds cleanly against virtual breadboard/pipetter
        r2 = agent.execute_command(
            "s2",
            "single_transfer",
            {
                "src_plate": 3,
                "src_slot": 0,
                "dst_plate": 0,
                "dst_slot": 0,
                "volume_ul": 120,
                "solvent": "ethanol",
                "tip_type": "auto",
                "src_z": 1900,
                "dst_z": 2100,
            },
            verified_relay=True,
        )
        self.assertTrue(r2["ok"], r2.get("humanMessage"))

        # Sideways XY jog while Z is lowered is blocked as crash prevention
        self.assertTrue(agent.execute_command("s3", "move_z", {"z": 1600}, verified_relay=True)["ok"])
        r4 = agent.execute_command("s4", "move_xy_rel", {"dx": 10, "dy": 0}, verified_relay=True)
        self.assertFalse(r4["ok"])
        self.assertIn("crash", r4["humanMessage"].lower())


class TestBackendRelayHardening(unittest.TestCase):
    """Tests app.py relay endpoints directly when FastAPI is installed in the test Python env."""

    @classmethod
    def setUpClass(cls) -> None:
        cls.app_mod = None
        cls.client = None
        try:
            from fastapi.testclient import TestClient  # type: ignore
            import app as backend_app  # type: ignore

            cls.app_mod = backend_app
            cls.client = TestClient(backend_app.app)
        except Exception:
            cls.app_mod = None
            cls.client = None

    def setUp(self) -> None:
        if self.app_mod is None:
            self.skipTest("FastAPI / app dependencies not installed in this Python runtime")
        # Reset relay state & PIN limiter cleanly for each test
        mod = self.app_mod
        with mod._RELAY_LOCK:
            mod._RELAY_STATE["lastPushAt"] = 0.0
            mod._RELAY_STATE["statusPayload"] = None
            mod._RELAY_STATE["pendingCommand"] = None
            mod._RELAY_STATE["stopSignal"] = None
            mod._RELAY_STATE["activeCommandId"] = None
            mod._RELAY_STATE["commands"].clear()
            mod._RELAY_STATE["results"].clear()
            mod._RELAY_STATE["events"].clear()
        mod._PIN_RATE_LIMITER = robot_safety.PinRateLimiter(max_attempts=5, lockout_sec=300.0)

    def test_relay_requires_token_and_never_exposes_pin(self) -> None:
        mod = self.app_mod
        assert mod is not None and self.client is not None

        # Without relay token configured -> HTTP 503
        with mock.patch.object(mod, "_get_relay_token", return_value=""):
            r = self.client.post("/api/robot/relay/push", json={"status": {"state": "idle"}})
            self.assertEqual(r.status_code, 503)

        # With token configured, wrong token -> HTTP 403
        with mock.patch.object(mod, "_get_relay_token", return_value="top-secret-relay"):
            r_bad = self.client.post(
                "/api/robot/relay/push",
                headers={"X-Robowski-Relay-Token": "wrong"},
                json={"status": {"state": "idle"}},
            )
            self.assertEqual(r_bad.status_code, 403)

            # Valid push seeds relay status with controlEnabled=True
            r_ok = self.client.post(
                "/api/robot/relay/push",
                headers={"X-Robowski-Relay-Token": "top-secret-relay"},
                json={"status": {"state": "idle", "hardware": {"controlEnabled": True, "connected": True, "homed": True}}},
            )
            self.assertEqual(r_ok.status_code, 200)

            # Queue a command from browser with PIN in a background thread so we can inspect relay/push
            with mock.patch.object(mod, "_get_control_pin", return_value="LabSecret99"):
                cmd_resp_holder: dict = {}

                def _send_cmd():
                    cmd_resp_holder["resp"] = self.client.post(
                        "/api/robot/command",
                        headers={"X-Robowski-Pin": "LabSecret99"},
                        json={"command": "check_tip_status", "params": {}},
                    )

                t = threading.Thread(target=_send_cmd, daemon=True)
                t.start()

                # Wait briefly until queued
                pending = None
                for _ in range(30):
                    push_r = self.client.post(
                        "/api/robot/relay/push",
                        headers={"X-Robowski-Relay-Token": "top-secret-relay"},
                        json={"status": {"state": "idle", "hardware": {"controlEnabled": True, "connected": True, "homed": True}}},
                    )
                    pending = push_r.json().get("pendingCommand")
                    if pending:
                        break
                    time.sleep(0.05)

                self.assertIsNotNone(pending)
                # CRITICAL: PIN must NEVER appear in the relay push payload!
                self.assertNotIn("pin", pending)
                self.assertIn("signature", pending)
                self.assertIn("issuedAt", pending)
                # Verify HMAC signature matches
                sig_ok, _ = robot_safety.verify_relay_command(
                    "top-secret-relay",
                    pending["id"],
                    pending["command"],
                    pending["params"],
                    pending["issuedAt"],
                    pending["signature"],
                )
                self.assertTrue(sig_ok)

                # Ack running, then post result
                ack_r = self.client.post(
                    "/api/robot/relay/ack",
                    headers={"X-Robowski-Relay-Token": "top-secret-relay"},
                    json={"commandId": pending["id"], "state": "running"},
                )
                self.assertEqual(ack_r.status_code, 200)

                st_r = self.client.get(f"/api/robot/command/{pending['id']}")
                self.assertEqual(st_r.json()["state"], "running")

                res_r = self.client.post(
                    "/api/robot/relay/result",
                    headers={"X-Robowski-Relay-Token": "top-secret-relay"},
                    json={
                        "commandId": pending["id"],
                        "ok": True,
                        "executed": True,
                        "command": "check_tip_status",
                        "humanMessage": "No tip attached",
                    },
                )
                self.assertEqual(res_r.status_code, 200)
                t.join(timeout=3.0)
                self.assertEqual(cmd_resp_holder["resp"].status_code, 200)
                self.assertTrue(cmd_resp_holder["resp"].json()["executed"])

    def test_cancel_queued_command_and_pin_lockout(self) -> None:
        mod = self.app_mod
        assert mod is not None and self.client is not None

        with (
            mock.patch.object(mod, "_get_relay_token", return_value="top-secret-relay"),
            mock.patch.object(mod, "_get_control_pin", return_value="LabSecret99"),
        ):
            # Seed online relay
            self.client.post(
                "/api/robot/relay/push",
                headers={"X-Robowski-Relay-Token": "top-secret-relay"},
                json={"status": {"state": "idle", "hardware": {"controlEnabled": True, "connected": True, "homed": True}}},
            )

            # 5 wrong PINs trigger HTTP 429 lockout
            for _ in range(4):
                r = self.client.post(
                    "/api/robot/command",
                    headers={"X-Robowski-Pin": "wrong"},
                    json={"command": "check_tip_status", "params": {}},
                )
                self.assertEqual(r.status_code, 403)
            r5 = self.client.post(
                "/api/robot/command",
                headers={"X-Robowski-Pin": "wrong"},
                json={"command": "check_tip_status", "params": {}},
            )
            self.assertEqual(r5.status_code, 429)

            # Reset limiter, queue a command, and cancel it before the agent picks it up
            mod._PIN_RATE_LIMITER = robot_safety.PinRateLimiter(max_attempts=5, lockout_sec=300.0)
            cmd_resp_holder: dict = {}

            def _send_cmd():
                cmd_resp_holder["resp"] = self.client.post(
                    "/api/robot/command",
                    headers={"X-Robowski-Pin": "LabSecret99"},
                    json={"command": "move_idle", "params": {}},
                )

            t = threading.Thread(target=_send_cmd, daemon=True)
            t.start()

            cmd_id = None
            for _ in range(30):
                with mod._RELAY_LOCK:
                    pc = mod._RELAY_STATE.get("pendingCommand")
                    if pc:
                        cmd_id = pc["id"]
                        break
                time.sleep(0.05)

            self.assertIsNotNone(cmd_id)
            cancel_r = self.client.post(
                f"/api/robot/command/{cmd_id}/cancel",
                headers={"X-Robowski-Pin": "LabSecret99"},
            )
            self.assertEqual(cancel_r.status_code, 200)
            self.assertTrue(cancel_r.json()["cancelled"])

            t.join(timeout=3.0)
            self.assertEqual(cmd_resp_holder["resp"].status_code, 200)
            self.assertEqual(cmd_resp_holder["resp"].json().get("state"), "cancelled")


if __name__ == "__main__":
    unittest.main()
