#!/usr/bin/env python3
"""Build an arm64 DMG with a verified G2 identity and a re-signed runtime copy."""
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import time

from macos_signing import macho_files, select_identity, verify_tree


def main():
    # Fail before building or altering resources when the shared identity is absent.
    cert = select_identity(os.environ.get("BONSAI_SIGNING_IDENTITY"))
    project = Path(__file__).resolve().parent.parent
    config = json.loads((project / "src-tauri/tauri.conf.json").read_text())
    version = config["version"]
    output = project / "output/g2"
    output.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix="runtime-", dir=output) as temporary:
        runtime = Path(temporary) / "runtime"
        shutil.copytree(project / "src-tauri/runtime", runtime, symlinks=True)
        for path in macho_files(runtime):
            subprocess.run(["codesign", "--force", "--options", "runtime", "--timestamp",
                            "--sign", cert["sha1"], str(path)], check=True)
        verify_tree(runtime, cert["sha1"], arm64=True)
        override = {"bundle": {"resources": {str(runtime) + "/": "runtime/"},
                               "macOS": {"signingIdentity": cert["sha1"]}}}
        environment = os.environ.copy()
        # Notarization uses the existing local Keychain profile in a separate step.
        for key in ("APPLE_ID", "APPLE_PASSWORD", "APPLE_TEAM_ID", "APPLE_API_KEY",
                    "APPLE_API_ISSUER", "APPLE_API_KEY_PATH"):
            environment.pop(key, None)
        environment["APPLE_SIGNING_IDENTITY"] = cert["sha1"]
        environment["CARGO_TARGET_DIR"] = str(project / "src-tauri/target")
        started = time.time()
        subprocess.run(["npm", "run", "tauri", "--", "build", "--target", "aarch64-apple-darwin",
                        "--bundles", "app,dmg", "--config", json.dumps(override)],
                       cwd=project, env=environment, check=True)
    bundle = project / "src-tauri/target/aarch64-apple-darwin/release/bundle"
    app = bundle / "macos" / (config["productName"] + ".app")
    dmgs = [path for path in (bundle / "dmg").glob(f"*_{version}_*.dmg")
            if path.stat().st_mtime >= started]
    if len(dmgs) != 1:
        raise RuntimeError("Expected one freshly built arm64 DMG")
    app_report = verify_tree(app, cert["sha1"], arm64=True)
    dmg_report = verify_tree(dmgs[0], cert["sha1"])
    destination = output / f"GZ-Bonsai-27B-{version}-arm64-G2.dmg"
    shutil.copy2(dmgs[0], destination)
    report = {"version": version, "certificate": cert, "app": str(app), "dmg": str(destination),
              "appSignatures": app_report["verifiedTargets"], "dmgSignatures": dmg_report["verifiedTargets"],
              "notarized": False, "published": False}
    (output / "build-report.json").write_text(json.dumps(report, indent=2) + "\n")
    print(json.dumps(report, indent=2))


if __name__ == "__main__":
    try:
        main()
    except (RuntimeError, subprocess.CalledProcessError) as error:
        raise SystemExit(f"G2 build stopped: {error}")
