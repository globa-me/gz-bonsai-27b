#!/usr/bin/env python3
"""Public certificate checks for the Bonsai macOS release; never exports keys."""
import argparse
import datetime
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import tempfile

TEAM = "BN3D9H4C7J"
NAME = f"Developer ID Application: Gennadiy Zakharov ({TEAM})"


def run(*args, input=None):
    result = subprocess.run(args, input=input, text=True, capture_output=True)
    if result.returncode:
        raise RuntimeError(result.stderr.strip() or result.stdout.strip() or f"{args[0]} failed")
    return result.stdout


def certificate(pem):
    info = run("openssl", "x509", "-noout", "-issuer", "-subject", "-dates",
               "-fingerprint", "-sha1", "-nameopt", "RFC2253", input=pem)
    fields = dict(line.split("=", 1) for line in info.splitlines() if "=" in line)
    return {
        "sha1": next(value for key, value in fields.items() if key.lower().replace(" ", "") == "sha1fingerprint").replace(":", "").upper(),
        "subject": fields["subject"].strip(),
        "issuer": fields["issuer"].strip(),
        "notBefore": fields["notBefore"],
        "notAfter": fields["notAfter"],
    }


def validate(cert):
    if not re.fullmatch(r"[0-9A-F]{40}", cert["sha1"]):
        raise RuntimeError("Invalid certificate SHA-1")
    if not re.search(r"(?:^|,)OU=G2(?:,|$)", cert["issuer"]):
        raise RuntimeError("Developer ID certificate must have issuer OU=G2")
    if not re.search(rf"(?:^|,)OU={TEAM}(?:,|$)", cert["subject"]):
        raise RuntimeError(f"Developer ID certificate must belong to team {TEAM}")
    if not re.search(r"(?:^|,)CN=" + re.escape(NAME) + r"(?:,|$)", cert["subject"]):
        raise RuntimeError("Expected Developer ID Application certificate")
    now = datetime.datetime.now(datetime.timezone.utc)
    for field, before in [("notBefore", True), ("notAfter", False)]:
        date = datetime.datetime.strptime(cert[field], "%b %d %H:%M:%S %Y GMT").replace(tzinfo=datetime.timezone.utc)
        if (before and now < date) or (not before and now >= date):
            raise RuntimeError("Developer ID certificate is outside its validity period")


def select_identity(requested=None):
    if requested and not re.fullmatch(r"[0-9a-fA-F]{40}", requested):
        raise RuntimeError("BONSAI_SIGNING_IDENTITY must be a SHA-1 fingerprint, not a certificate name")
    identities = run("security", "find-identity", "-v", "-p", "codesigning")
    valid = {match.group(1) for line in identities.splitlines()
             if "CSSMERR" not in line
             for match in [re.search(r"\b([0-9A-F]{40}) \"" + re.escape(NAME) + r"\"", line)] if match}
    pem = run("security", "find-certificate", "-a", "-c", NAME, "-p")
    candidates = []
    for block in re.findall(r"-----BEGIN CERTIFICATE-----.*?-----END CERTIFICATE-----", pem, re.S):
        cert = certificate(block)
        try:
            validate(cert)
        except RuntimeError:
            continue
        if cert["sha1"] in valid and (not requested or cert["sha1"] == requested.upper()):
            candidates.append(cert)
    if len(candidates) != 1:
        raise RuntimeError(f"Expected one usable G2 Developer ID for team {TEAM}; found {len(candidates)}. "
                           "Install the shared G2 certificate with its private key, or select its SHA-1 via BONSAI_SIGNING_IDENTITY.")
    return candidates[0]


def require_timestamp(details):
    if not re.search(r"^Timestamp=.+$", details, re.M):
        raise RuntimeError("Secure timestamp is missing (Signed Time alone is insufficient)")


def verify_signature(path, expected=None):
    run("codesign", "--verify", "--strict", str(path))
    result = subprocess.run(["codesign", "-dvvv", str(path)], text=True, capture_output=True, check=True)
    require_timestamp(result.stderr)
    with tempfile.TemporaryDirectory(prefix="bonsai-public-cert-") as temporary:
        prefix = str(Path(temporary) / "cert-")
        run("codesign", "-d", "--extract-certificates=" + prefix, str(path))
        pem = run("openssl", "x509", "-inform", "DER", "-in", prefix + "0", "-outform", "PEM")
        cert = certificate(pem)
    validate(cert)
    if expected and cert["sha1"] != expected.upper():
        raise RuntimeError(f"Unexpected signing certificate for {path}")
    return cert


def macho_files(root):
    return [path for path in sorted(root.rglob("*"))
            if path.is_file() and not path.is_symlink()
            and "Mach-O" in run("file", "--brief", str(path))]


def verify_tree(path, expected=None, arm64=False):
    if path.suffix == ".app":
        run("codesign", "--verify", "--deep", "--strict", str(path))
    targets = ([path] if path.is_file() or path.suffix == ".app" else [])
    files = macho_files(path) if path.is_dir() else ([path] if path.is_file() and "Mach-O" in run("file", "--brief", str(path)) else [])
    if arm64:
        for file in files:
            if run("lipo", "-archs", str(file)).strip() != "arm64":
                raise RuntimeError(f"Expected only arm64: {file}")
    if path.is_dir():
        targets += files
    if not targets:
        raise RuntimeError("No signed targets found")
    cert = None
    for target in targets:
        cert = verify_signature(target, expected)
    return {"verifiedTargets": len(targets), "certificate": cert}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("command", choices=["identity", "verify", "sign-runtime"])
    parser.add_argument("path", nargs="?", type=Path)
    parser.add_argument("--sha1")
    parser.add_argument("--arm64", action="store_true")
    args = parser.parse_args()
    if args.command == "identity":
        print(json.dumps(select_identity(args.sha1 or os.environ.get("BONSAI_SIGNING_IDENTITY")), indent=2))
    elif args.command == "verify":
        if not args.path:
            parser.error("verify requires a path")
        print(json.dumps(verify_tree(args.path, args.sha1, args.arm64), indent=2))
    else:
        if not args.path or not args.path.is_dir():
            parser.error("sign-runtime requires a copied runtime directory")
        cert = select_identity(args.sha1 or os.environ.get("BONSAI_SIGNING_IDENTITY"))
        targets = macho_files(args.path)
        if not targets:
            raise RuntimeError("No Mach-O files found in runtime")
        for path in targets:
            run("codesign", "--force", "--options", "runtime", "--timestamp", "--sign", cert["sha1"], str(path))
        print(json.dumps(verify_tree(args.path, cert["sha1"]), indent=2))


if __name__ == "__main__":
    try:
        main()
    except (RuntimeError, subprocess.CalledProcessError) as error:
        print(f"Signing check failed: {error}", file=sys.stderr)
        sys.exit(1)
