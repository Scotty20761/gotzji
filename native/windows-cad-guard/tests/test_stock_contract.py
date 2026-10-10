"""Windows-local contract with the real stock multiCAD; skipped where its venv is absent (CI)."""
import json
import os
import subprocess
import sys
import unittest

STOCK = os.environ.get("CAD_GUARD_STOCK", r"E:\Tools\multiCAD-mcp-upstream")
PYTHON = os.path.join(STOCK, ".venv", "Scripts", "python.exe")
PROBE = os.path.join(os.path.dirname(os.path.abspath(__file__)), "stock_probe.py")


@unittest.skipUnless(sys.platform == "win32" and os.path.exists(PYTHON), "needs the stock multiCAD venv on Windows")
class StockContractTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        run = subprocess.run([PYTHON, "-X", "utf8", PROBE, os.path.join(STOCK, "src")], capture_output=True, text=True, timeout=120)
        cls.report = json.loads(run.stdout.strip().splitlines()[-1])

    def test_the_guard_serves_every_stock_tool_with_its_own_schema_plus_cad_window(self) -> None:
        stock_tools = ["draw_entities", "export_data", "manage_blocks", "manage_entities", "manage_files", "manage_layers", "manage_session"]
        self.assertEqual(self.report["tools"], stock_tools)
        self.assertEqual(self.report["served"], sorted(stock_tools + ["cad_window"]))
        self.assertTrue(self.report["sameSchemas"])

    def test_stock_loads_the_guard_config(self) -> None:
        self.assertEqual(self.report["configCad"], ["zwcad"])
        self.assertFalse(self.report["arbitrary"])
        self.assertTrue(self.report["output"].endswith("sandbox"))

    def test_the_guard_reads_actions_with_stocks_own_parsers(self) -> None:
        parse = self.report["parse"]
        self.assertEqual(parse["close"], [{"action": "close"}])
        self.assertEqual(parse["shorthand"], [{"action": "list"}])

    def test_every_com_entry_point_that_could_attach_or_start_zwcad_is_refused(self) -> None:
        entry = dict(self.report["entryPoints"])
        self.assertTrue(entry.pop("CoCreateInstanceEx is patched"))
        self.assertEqual({label: result for label, result in entry.items() if result != "refused"}, {})
        self.assertEqual(self.report["newZwcad"], [])

    def test_the_guards_tables_and_save_targets_match_stock(self) -> None:
        self.assertTrue(all(self.report["knownMatchesStock"].values()), self.report["knownMatchesStock"])
        self.assertTrue(all(self.report["saveTargetMatchesStock"].values()), self.report["saveTargetMatchesStock"])
        self.assertEqual(self.report["parse"]["sessionStripped"], [{"action": "status"}])
        self.assertEqual(self.report["parse"]["garbage"][0]["action"], "{")

    def test_with_nothing_selected_stock_can_neither_attach_nor_start_a_zwcad(self) -> None:
        # The 2026-10-08 PID 41640 incident: stock's Dispatch fallback started a hidden ZWCAD inside a call that was then killed.
        self.assertIn("Could not connect", self.report["unboundResult"])
        self.assertLess(self.report["unboundSeconds"], 5)
        self.assertIn("Dispatch('ZWCAD.Application')", self.report["refusals"])
        self.assertIn("HOST_BIND_REFUSED", self.report["dispatch"])
        self.assertEqual(self.report["newZwcad"], [])


if __name__ == "__main__":
    unittest.main()
