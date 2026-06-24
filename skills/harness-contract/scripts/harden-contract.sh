#!/usr/bin/env bash
set -euo pipefail

if [[ $# -ne 2 ]]; then
  echo "usage: harden-contract.sh <contract_path> <sprint_dir>" >&2
  exit 2
fi

contract_path="$1"
sprint_dir="$2"

if [[ ! -f "$contract_path" ]]; then
  echo "contract not found: $contract_path" >&2
  exit 2
fi

mkdir -p "$sprint_dir/evidence"
shasum -a 256 "$contract_path" > "$sprint_dir/evidence/approved-contract.sha256"
chmod a-w "$contract_path"

echo "hardened contract: $contract_path"
echo "checksum: $sprint_dir/evidence/approved-contract.sha256"
