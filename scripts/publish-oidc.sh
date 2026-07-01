#!/usr/bin/env bash

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DRY_RUN="${DRY_RUN:-0}"

PACKAGES=(
  "packages/api-core"
  "packages/api-client"
  "packages/api-orpc"
  "packages/cloudflare-service"
)

read_package_field() {
  local package_json="$1"
  local field="$2"
  node -p "require(process.argv[1])[process.argv[2]]" "$package_json" "$field"
}

publish_package() {
  local package_dir="$1"
  local package_json="${package_dir}/package.json"
  local package_name
  local package_version
  local package_main
  local publish_log
  local publish_args=("--access" "public")

  package_name="$(read_package_field "$package_json" "name")"
  package_version="$(read_package_field "$package_json" "version")"
  package_main="$(node -p 'require(process.argv[1]).main ?? ""' "$package_json")"

  if [[ "$package_main" == dist/* && ! -f "${package_dir}/${package_main}" ]]; then
    echo "Refusing to publish ${package_name}@${package_version}; missing ${package_main}. Run build first."
    return 1
  fi

  if npm view "${package_name}@${package_version}" version >/dev/null 2>&1; then
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
