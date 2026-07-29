#!/usr/bin/env bash

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DRY_RUN="${DRY_RUN:-0}"

PACKAGES=(
  "packages/api-core"
  "packages/api-client"
  "packages/api-orpc"
  "packages/api-cloudflare-service"
)

read_package_field() {
  local package_json="$1"
  local field="$2"
  node -p "require(process.argv[1])[process.argv[2]]" "$package_json" "$field"
}

validate_package_exports() {
  local package_json="$1"
  local package_dir="$2"

  node - "$package_json" "$package_dir" <<'NODE'
const fs = require("node:fs");
const path = require("node:path");

const packageJsonPath = process.argv[2];
const packageDir = fs.realpathSync(process.argv[3]);
const manifest = JSON.parse(fs.readFileSync(packageJsonPath, "utf8"));

function exportTargets(value) {
  if (typeof value === "string") return [value];
  if (!value || typeof value !== "object") return [];
  return Object.values(value).flatMap(exportTargets);
}

const targets = exportTargets(manifest.exports).filter((target) => target.startsWith("./"));
if (targets.length === 0) {
  console.error(`[${manifest.name}] No relative package export targets are configured.`);
  process.exit(1);
}

const invalid = [];
const missing = [];
for (const target of targets) {
  const resolved = path.resolve(packageDir, target);
  if (!isWithinPackage(resolved, packageDir)) {
    invalid.push(target);
    continue;
  }
  if (!fs.existsSync(resolved)) {
    missing.push(target);
    continue;
  }
  if (!isWithinPackage(fs.realpathSync(resolved), packageDir)) {
    invalid.push(target);
  }
}

if (invalid.length > 0) {
  console.error(`[${manifest.name}] Package export targets escape the package root: ${invalid.join(", ")}`);
  process.exit(1);
}

if (missing.length > 0) {
  console.error(`[${manifest.name}] Missing package export targets: ${missing.join(", ")}`);
  process.exit(1);
}

function isWithinPackage(candidate, root) {
  return candidate === root || candidate.startsWith(`${root}${path.sep}`);
}
NODE
}

publish_package() {
  local package_dir="$1"
  local package_json="${package_dir}/package.json"
  local package_name
  local package_version
  local publish_log
  local publish_args=("--access" "public")

  package_name="$(read_package_field "$package_json" "name")"
  package_version="$(read_package_field "$package_json" "version")"
  if ! validate_package_exports "$package_json" "$package_dir"; then
    return 1
  fi

  if [[ "$DRY_RUN" != "1" ]] && npm view "${package_name}@${package_version}" version >/dev/null 2>&1; then
    echo "Skipping ${package_name}@${package_version}; version already exists on npm."
    return
  fi

  if [[ "$DRY_RUN" == "1" ]]; then
    publish_args+=("--dry-run")
  fi

  echo "Publishing ${package_name}@${package_version}..."
  publish_log="$(mktemp)"

  if (
    cd "$package_dir"
    npm publish "${publish_args[@]}"
  ) >"$publish_log" 2>&1; then
    cat "$publish_log"
    rm -f "$publish_log"
    return
  fi

  cat "$publish_log"

  if grep -q "previously published versions" "$publish_log"; then
    echo "Skipping ${package_name}@${package_version}; version was already published."
    rm -f "$publish_log"
    return
  fi

  rm -f "$publish_log"
  return 1
}

for package_path in "${PACKAGES[@]}"; do
  publish_package "${ROOT_DIR}/${package_path}"
done
