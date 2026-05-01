#!/usr/bin/env python3
# SPDX-License-Identifier: MIT

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path


PLACEHOLDER_SCOPE = "@your-npm-scope"
PACKAGE_DIR = "packages"
PACKAGE_NAMES = [
    "bodhi-sdk-core",
    "bodhi-web-sdk",
    "bodhi-widget",
]
TEXT_SUFFIXES = {".json", ".ts", ".md"}


def normalize_scope(raw: str) -> str:
    scope = raw.strip()
    if not scope:
        raise ValueError("npm scope cannot be empty")
    if scope.startswith("@"):
        scope = scope[1:]
    if "/" in scope:
        raise ValueError("pass only the npm scope, not a package name")
    return f"@{scope}"


def iter_target_files(root: Path) -> list[Path]:
    return sorted(
        path
        for path in root.rglob("*")
        if path.is_file() and path.suffix in TEXT_SUFFIXES
    )


def rewrite_scope(root: Path, scope: str) -> list[Path]:
    changed: list[Path] = []
    for path in iter_target_files(root / PACKAGE_DIR):
        original = path.read_text()
        updated = original.replace(PLACEHOLDER_SCOPE, scope)
        if updated != original:
            path.write_text(updated)
            changed.append(path)
    return changed


def load_package_json(path: Path) -> dict:
    return json.loads(path.read_text())


def validate_packages(root: Path, scope: str) -> None:
    package_paths = [root / PACKAGE_DIR / name / "package.json" for name in ("sdk-core", "web-sdk", "widget")]
    missing = [str(path) for path in package_paths if not path.exists()]
    if missing:
        raise FileNotFoundError(f"missing package manifests: {', '.join(missing)}")

    manifests = [load_package_json(path) for path in package_paths]
    expected_names = [f"{scope}/{name}" for name in PACKAGE_NAMES]

    actual_names = [manifest.get("name") for manifest in manifests]
    if actual_names != expected_names:
        raise ValueError(
            "package names do not match expected scoped names:\n"
            f"  expected: {expected_names}\n"
            f"  actual:   {actual_names}"
        )

    web_deps = manifests[1].get("dependencies", {})
    if web_deps.get(expected_names[0]) != "workspace:*":
        raise ValueError("web-sdk dependency on sdk-core is missing or incorrect")

    widget_deps = manifests[2].get("dependencies", {})
    if widget_deps.get(expected_names[0]) != "workspace:*":
        raise ValueError("widget dependency on sdk-core is missing or incorrect")
    if widget_deps.get(expected_names[1]) != "workspace:*":
        raise ValueError("widget dependency on web-sdk is missing or incorrect")


def print_next_steps(scope: str) -> None:
    package_specs = [
        f"{scope}/bodhi-sdk-core",
        f"{scope}/bodhi-web-sdk",
        f"{scope}/bodhi-widget",
    ]
    print("\nReady to publish these packages:")
    for spec in package_specs:
        print(f"  - {spec}")

    print("\nNext commands:")
    print('  export NPM_TOKEN="npm_xxxx"')
    print('  printf "//registry.npmjs.org/:_authToken=%s\\n" "$NPM_TOKEN" > .npmrc')
    print("  pnpm -r --filter './packages/*' run test")
    print("  pnpm -r --filter './packages/*' run typecheck")
    print("  pnpm exec biome check packages/")
    print("  pnpm -r --filter './packages/*' run build")
    print("  pnpm --filter ./packages/sdk-core publish --access public --no-git-checks")
    print("  pnpm --filter ./packages/web-sdk publish --access public --no-git-checks")
    print("  pnpm --filter ./packages/widget publish --access public --no-git-checks")
    print("  rm -f .npmrc")


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Apply your npm scope to the thin Bodhi client packages."
    )
    parser.add_argument(
        "--scope",
        required=True,
        help="Your npm scope or username, for example 'myname' or '@myname'",
    )
    parser.add_argument(
        "--check",
        action="store_true",
        help="Validate current files without rewriting them",
    )
    args = parser.parse_args()

    root = Path(__file__).resolve().parent.parent
    scope = normalize_scope(args.scope)

    try:
        changed: list[Path] = []
        if not args.check:
            changed = rewrite_scope(root, scope)
        validate_packages(root, scope)
    except Exception as exc:  # noqa: BLE001
        print(f"error: {exc}", file=sys.stderr)
        return 1

    if args.check:
        print(f"Validated package scope setup for {scope}.")
    else:
        print(f"Applied scope {scope}.")
        if changed:
            print("Updated files:")
            for path in changed:
                print(f"  - {path.relative_to(root)}")
        else:
            print("No files needed changes.")

    print_next_steps(scope)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
