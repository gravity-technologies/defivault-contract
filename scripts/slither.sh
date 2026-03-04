#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

npx hardhat compile --force

TMP_ARTIFACTS_DIR="$(mktemp -d /tmp/slither-artifacts.XXXXXX)"
NPM_LINK_DIR="$ROOT_DIR/npm/@openzeppelin"
PROJECT_LINK="$ROOT_DIR/project"

cleanup() {
  rm -f "$PROJECT_LINK"
  rm -f "$NPM_LINK_DIR/contracts@5.4.0"
  rm -f "$NPM_LINK_DIR/contracts-upgradeable@5.4.0"
  rmdir "$NPM_LINK_DIR" 2>/dev/null || true
  rmdir "$ROOT_DIR/npm" 2>/dev/null || true
  rm -rf "$TMP_ARTIFACTS_DIR"
}
trap cleanup EXIT

mkdir -p "$TMP_ARTIFACTS_DIR/build-info"
for in_f in "$ROOT_DIR"/artifacts/build-info/*.json; do
  case "$in_f" in
    *.output.json) continue ;;
  esac

  out_f="${in_f%.json}.output.json"
  b="$(basename "$in_f")"

  node -e '
    const fs = require("fs");
    const inputJson = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
    const outputJson = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
    if (!inputJson.input) inputJson.input = {};
    if (!inputJson.input.settings) inputJson.input.settings = {};
    if (!inputJson.input.settings.optimizer) {
      inputJson.input.settings.optimizer = { enabled: false, runs: 200 };
    }
    const merged = { ...inputJson, ...outputJson };
    fs.writeFileSync(process.argv[3], JSON.stringify(merged));
  ' "$in_f" "$out_f" "$TMP_ARTIFACTS_DIR/build-info/$b"
done

mkdir -p "$NPM_LINK_DIR"
ln -sfn "$ROOT_DIR/node_modules/@openzeppelin/contracts" "$NPM_LINK_DIR/contracts@5.4.0"
ln -sfn "$ROOT_DIR/node_modules/@openzeppelin/contracts-upgradeable" "$NPM_LINK_DIR/contracts-upgradeable@5.4.0"
ln -sfn "$ROOT_DIR" "$PROJECT_LINK"

slither . --hardhat-artifacts-directory "$TMP_ARTIFACTS_DIR" --hardhat-ignore-compile "$@"
