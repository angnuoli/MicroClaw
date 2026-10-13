import base64
import json
import re
import shutil
import subprocess
import unittest
from pathlib import Path

from deployer.openclaw_version import (
    NODE_FALLBACK_VERSION,
    OPENCLAW_TARGET_VERSION,
    is_supported_node_version,
)

ROOT = Path(__file__).resolve().parents[1]
POWERSHELL = shutil.which("pwsh") or shutil.which("powershell")


class RuntimeGateTests(unittest.TestCase):
    def test_legacy_helper_uses_exact_pin_and_supported_node_floor(self):
        script = (ROOT / "scripts" / "windows" / "setup-dependencies.ps1").read_text(
            encoding="utf-8"
        )

        self.assertIn(f'[string]$OpenClawTag = "{OPENCLAW_TARGET_VERSION}"', script)
        self.assertIn(f'$nodeVersion = "{NODE_FALLBACK_VERSION}"', script)
        self.assertIn("function Test-SupportedNodeVersion", script)
        self.assertIn("$parsed.Major -ge 26", script)

    @unittest.skipUnless(POWERSHELL, "PowerShell is required to execute runtime gates")
    def test_powershell_gates_match_python_node_policy(self):
        script = (ROOT / "scripts" / "windows" / "setup-dependencies.ps1").read_text(
            encoding="utf-8"
        )
        helper = re.search(r"(?ms)^function Test-SupportedNodeVersion \{.*?^\}", script)
        self.assertIsNotNone(helper)
        gates = [helper[0]]
        for name in ("pr-build.yml", "release.yml"):
            workflow = (ROOT / ".github" / "workflows" / name).read_text(encoding="utf-8")
            expressions = re.findall(
                r"(?m)^          \$supported =\n(?:            .*\n)+", workflow
            )
            self.assertEqual(len(expressions), 2 if name == "pr-build.yml" else 1)
            gates.extend(
                "function Test-SupportedNodeVersion { param([string]$Version)\n"
                "$parsed = [version]$Version.TrimStart('v')\n" + expression + "return $supported\n}"
                for expression in expressions
            )
        versions = [
            "20.20.0",
            "v22.22.3",
            "23.10.0",
            "24.15.9",
            "v24.16.0",
            "24.18.0",
            "25.9.0",
            "25.99.0",
            "26.0.9",
            "26.1.0",
            "27.0.0",
        ]
        for index, gate in enumerate(gates):
            with self.subTest(gate=index):
                command = (
                    "$ErrorActionPreference = 'Stop'\n" + gate + "\n"
                    f"$versions = '{json.dumps(versions)}' | ConvertFrom-Json\n"
                    "$results = @($versions | ForEach-Object { Test-SupportedNodeVersion $_ })\n"
                    "ConvertTo-Json -InputObject $results -Compress"
                )
                result = subprocess.run(
                    [
                        POWERSHELL,
                        "-NoProfile",
                        "-NonInteractive",
                        "-EncodedCommand",
                        base64.b64encode(command.encode("utf-16-le")).decode("ascii"),
                    ],
                    capture_output=True,
                    text=True,
                    check=True,
                    timeout=30,
                )
                self.assertEqual(
                    json.loads(result.stdout),
                    [is_supported_node_version(version) for version in versions],
                )

    def test_legacy_helper_refuses_nontransactional_existing_upgrade(self):
        script = (ROOT / "scripts" / "windows" / "setup-dependencies.ps1").read_text(
            encoding="utf-8"
        )

        self.assertIn("requires transactional upgrade", script)
        self.assertIn("Run the MicroClaw installer", script)

    def test_ci_enforces_openclaw_node_range_in_both_jobs(self):
        workflow = (ROOT / ".github" / "workflows" / "pr-build.yml").read_text(encoding="utf-8")

        self.assertEqual(workflow.count("24.16.0"), 2)
        self.assertEqual(workflow.count("26.1.0"), 2)
        self.assertEqual(workflow.count(f"is unsupported by OpenClaw {OPENCLAW_TARGET_VERSION}"), 2)

    def test_hosted_ci_installs_supported_node(self):
        for name in ("release.yml", "pr-security-check.yml"):
            with self.subTest(workflow=name):
                workflow = (ROOT / ".github" / "workflows" / name).read_text(encoding="utf-8")
                self.assertIn('node-version: "24.16.0"', workflow)

    def test_ci_runs_python_unit_tests(self):
        workflow = (ROOT / ".github" / "workflows" / "pr-build.yml").read_text(encoding="utf-8")

        self.assertIn("python -m unittest discover -s tests -v", workflow)

    def test_build_uses_uv_only_for_a_real_uv_project(self):
        build_script = (ROOT / "build.ps1").read_text(encoding="utf-8")

        self.assertIn("$hasUvProject", build_script)
        self.assertIn("if ($hasUvProject)", build_script)
        self.assertIn(
            'python -m pip install -r "$root\\requirements.txt"',
            build_script,
        )
        self.assertIn("$pipExitCode = $LASTEXITCODE", build_script)

    def test_installer_spec_uses_staged_weixin_runtime(self):
        spec = (ROOT / "MicroClawDeployer.spec").read_text(encoding="utf-8")

        self.assertIn(
            "weixin_plugin_datas = [('dist/openclaw-weixin', 'plugins/openclaw-weixin')]",
            spec,
        )
        self.assertNotIn("collect_plugin_files", spec)
        self.assertNotIn("('plugins', 'plugins')", spec)

    def test_build_stages_pinned_weixin_archives_offline(self):
        build_script = (ROOT / "build.ps1").read_text(encoding="utf-8")
        vendor = ROOT / "plugins" / "openclaw-weixin" / "vendor"

        for archive in (
            "tencent-weixin-openclaw-weixin-2.4.6.tgz",
            "zod-4.4.3.tgz",
            "qrcode-terminal-0.12.0.tgz",
        ):
            self.assertIn(archive, build_script)
            self.assertTrue((vendor / archive).is_file())
        self.assertIn("Get-FileHash", build_script)
        self.assertIn("--offline", build_script)
        self.assertIn("stage-weixin-runtime.mjs", build_script)
        self.assertIn('throw "Weixin SDK compatibility staging failed"', build_script)

    def test_nsis_build_declares_utf8_input_charset(self):
        build_script = (ROOT / "build.ps1").read_text(encoding="utf-8")

        self.assertIn('"/INPUTCHARSET"', build_script)
        self.assertIn('"UTF8"', build_script)


if __name__ == "__main__":
    unittest.main()
