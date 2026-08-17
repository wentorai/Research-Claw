#!/usr/bin/env python3
"""Fail-closed audit for a Wentor native Windows offline installer ZIP."""

from __future__ import annotations

import argparse
import hashlib
import io
import json
import re
import stat
import sys
import tempfile
import zipfile
from pathlib import Path, PurePosixPath


RUNTIME_SHA256 = {
    "runtime/node-v22.22.2-win-x64.zip":
        "7c93e9d92bf68c07182b471aa187e35ee6cd08ef0f24ab060dfff605fcc1c57c",
    "runtime/PortableGit-2.55.0.4-64-bit.7z.exe":
        "016e84230a3767f0c6b3788e79ba0c58a17377086801719d46700fca4f7b36b5",
    "runtime/7zr.exe":
        "56b8cc9f4971cef253644fafe54063ed7fdca551d4dee0f8c6baa81b855acd72",
}
TEXT_MEMBERS = {
    "Wentor-Weifang-OneClick.cmd",
    "Install-Weifang.ps1",
    "install-windows.ps1",
    "install.sh",
    "README.txt",
}
SETUP_TOKEN = re.compile(rb"rca_[A-Za-z0-9_-]{43,}")
MODEL_KEY = re.compile(rb"(?<![A-Za-z0-9_-])sk-(?:proj-)?[A-Za-z0-9_-]{16,}")
SHA256 = re.compile(r"^[0-9a-f]{64}$")


class AuditError(RuntimeError):
    pass


def digest(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def fail(message: str) -> None:
    raise AuditError(message)


def expected_members(package_name: str) -> set[str]:
    root = f"{package_name}/"
    return {
        root,
        f"{root}runtime/",
        *(f"{root}{name}" for name in TEXT_MEMBERS),
        *(f"{root}{name}" for name in RUNTIME_SHA256),
    }


def validate_name(name: str, package_name: str) -> None:
    if not name or "\\" in name or "\x00" in name:
        fail("invalid ZIP member name")
    if name.startswith(("/", "__MACOSX/")) or "/__MACOSX/" in name:
        fail("forbidden ZIP member namespace")
    if name.startswith("._") or "/._" in name:
        fail("AppleDouble member is forbidden")
    path = PurePosixPath(name.rstrip("/"))
    if path.is_absolute() or any(part in {"", ".", ".."} for part in path.parts):
        fail("non-canonical ZIP member path")
    if not name.startswith(f"{package_name}/"):
        fail("member is outside the exact package root")


def audit_zip(
    archive: Path,
    package_name: str,
    install_sh_sha: str,
    runtime_sha256: dict[str, str] = RUNTIME_SHA256,
) -> dict[str, object]:
    if not SHA256.fullmatch(install_sh_sha):
        fail("install.sh SHA-256 argument is invalid")
    metadata = archive.lstat()
    if not stat.S_ISREG(metadata.st_mode) or metadata.st_nlink != 1:
        fail("archive must be one regular, non-hardlinked file")

    with zipfile.ZipFile(archive, "r") as bundle:
        records = bundle.infolist()
        names = [record.filename for record in records]
        for name in names:
            validate_name(name, package_name)
        if len(names) != len(set(names)) or len(names) != len({name.casefold() for name in names}):
            fail("duplicate or case-colliding ZIP member")
        if set(names) != expected_members(package_name):
            fail("ZIP member set does not match the offline package contract")
        if bundle.testzip() is not None:
            fail("ZIP CRC verification failed")

        payloads: dict[str, bytes] = {}
        prefix = f"{package_name}/"
        for record in records:
            relative = record.filename[len(prefix):]
            expected_directory = relative in {"", "runtime/"}
            if record.is_dir() != expected_directory:
                fail("ZIP member type does not match the package contract")
            if record.flag_bits & 0x1:
                fail("encrypted ZIP members are forbidden")
            unix_mode = (record.external_attr >> 16) & 0xFFFF
            if unix_mode and stat.S_IFMT(unix_mode) == stat.S_IFLNK:
                fail("symlink ZIP members are forbidden")
            if not expected_directory:
                payloads[relative] = bundle.read(record)

    for relative, expected in runtime_sha256.items():
        if digest(payloads[relative]) != expected:
            fail("pinned runtime asset SHA-256 mismatch")
    if digest(payloads["install.sh"]) != install_sh_sha:
        fail("install.sh ZIP member SHA-256 mismatch")

    for relative in TEXT_MEMBERS:
        data = payloads[relative]
        if b"\x00" in data:
            fail("NUL byte in text member")
        try:
            text = data.decode("utf-8-sig" if relative.endswith(".ps1") else "utf-8")
        except UnicodeDecodeError as error:
            raise AuditError("text member is not strict UTF-8") from error
        if "\ufffd" in text:
            fail("Unicode replacement character in text member")
        if relative.endswith(".ps1") and not data.startswith(b"\xef\xbb\xbf"):
            fail("PowerShell member is not UTF-8 with BOM")
        if relative.endswith(".cmd") and any(
            byte not in {9, 10, 13} and not 32 <= byte <= 126 for byte in data
        ):
            fail("CMD launcher is not ASCII-only")

    install_windows = payloads["install-windows.ps1"].decode("utf-8-sig")
    pin = re.search(r"\$InstallShSha256\s*=\s*'([0-9a-f]{64})'", install_windows)
    if not pin or pin.group(1) != install_sh_sha:
        fail("install-windows.ps1 install.sh SHA pin mismatch")

    text_payload = b"\n".join(payloads[name] for name in sorted(TEXT_MEMBERS))
    if len(SETUP_TOKEN.findall(text_payload)) != 1:
        fail("private package must contain exactly one Setup Token")
    if MODEL_KEY.search(text_payload):
        fail("private package must contain zero embedded model API keys")

    return {
        "ok": True,
        "packageName": package_name,
        "archiveSha256": digest(archive.read_bytes()),
        "members": len(names),
        "installShSha256": install_sh_sha,
        "setupTokenCount": 1,
        "modelKeyCount": 0,
    }


def write_fixture(
    target: Path,
    package_name: str,
    install_sh: bytes,
    runtime_payloads: dict[str, bytes],
    overrides: dict[str, bytes] | None = None,
    extra: tuple[str, bytes] | None = None,
) -> None:
    members = {
        "Wentor-Weifang-OneClick.cmd": b"@echo off\r\nexit /b 0\r\n",
        "Install-Weifang.ps1": (
            b"\xef\xbb\xbf$setupToken = 'rca_" + b"A" * 43 + b"'\r\n"
        ),
        "install-windows.ps1": (
            b"\xef\xbb\xbf$InstallShSha256 = '" + digest(install_sh).encode() + b"'\r\n"
        ),
        "install.sh": install_sh,
        "README.txt": "Wentor offline fixture\n".encode(),
        **runtime_payloads,
    }
    members.update(overrides or {})
    with zipfile.ZipFile(target, "w", zipfile.ZIP_DEFLATED) as bundle:
        bundle.writestr(f"{package_name}/", b"")
        bundle.writestr(f"{package_name}/runtime/", b"")
        for name, data in members.items():
            bundle.writestr(f"{package_name}/{name}", data)
        if extra:
            bundle.writestr(extra[0], extra[1])


def self_test() -> dict[str, object]:
    package_name = "Wentor-Weifang-RC-0.8.3-Windows-Native-Offline-selftest"
    install_sh = b"#!/usr/bin/env bash\nexit 0\n"
    runtimes = {name: f"fixture:{name}".encode() for name in RUNTIME_SHA256}
    runtime_hashes = {name: digest(data) for name, data in runtimes.items()}
    cases = 0
    with tempfile.TemporaryDirectory(prefix="wentor-bundle-audit-") as root:
        archive = Path(root) / "bundle.zip"
        write_fixture(archive, package_name, install_sh, runtimes)
        audit_zip(archive, package_name, digest(install_sh), runtime_hashes)
        cases += 1

        invalid = [
            ({"Install-Weifang.ps1": b"$setupToken = 'rca_" + b"A" * 43 + b"'\n"}, None),
            ({"Wentor-Weifang-OneClick.cmd": "@echo off\n\u4e2d\n".encode()}, None),
            ({"README.txt": b"sk-" + b"B" * 20 + b"\n"}, None),
            ({"Install-Weifang.ps1": b"\xef\xbb\xbf$setupToken = $null\n"}, None),
            ({}, (f"{package_name}/../escape.txt", b"escape")),
            ({}, (f"{package_name}/README.TXT", b"collision")),
        ]
        for index, (overrides, extra) in enumerate(invalid):
            candidate = Path(root) / f"invalid-{index}.zip"
            write_fixture(candidate, package_name, install_sh, runtimes, overrides, extra)
            try:
                audit_zip(candidate, package_name, digest(install_sh), runtime_hashes)
            except AuditError:
                cases += 1
            else:
                fail("bundle auditor self-test accepted an invalid fixture")
    return {"ok": True, "cases": cases}


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("archive", nargs="?", type=Path)
    parser.add_argument("--package-name")
    parser.add_argument("--install-sh-sha")
    parser.add_argument("--self-test", action="store_true")
    args = parser.parse_args()
    try:
        if args.self_test:
            result = self_test()
        else:
            if args.archive is None or not args.package_name or not args.install_sh_sha:
                parser.error("archive, --package-name, and --install-sh-sha are required")
            result = audit_zip(args.archive, args.package_name, args.install_sh_sha)
        print(json.dumps(result, sort_keys=True))
        return 0
    except (AuditError, OSError, zipfile.BadZipFile) as error:
        print(f"WINDOWS_BUNDLE_AUDIT_FAILED: {error}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
