#!/usr/bin/env bash
set -euo pipefail

if [[ $# -ne 1 || ! -f "$1" ]]; then
  echo "Usage: $0 /chemin/vers/NAJIB.xlsx" >&2
  exit 2
fi
: "${CARD_ENCRYPTION_KEY:?CARD_ENCRYPTION_KEY manquant}"
: "${CARD_HMAC_KEY:?CARD_HMAC_KEY manquant}"
: "${PIN_ENCRYPTION_KEY:?PIN_ENCRYPTION_KEY manquant}"

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
project_dir="$(cd -- "$script_dir/.." && pwd)"
source_file="$(realpath "$1")"
source_name="$(basename "$source_file")"
source_sha256="$(sha256sum "$source_file" | awk '{print $1}')"

{
  sed '/-- Le flux de données/,$d' "$project_dir/sql/003_import_najib.sql"
  python3 "$script_dir/xlsx_to_copy.py" "$source_file"
  printf '\\.\n'
  sed '1,2d' "$project_dir/sql/004_finalize_najib_import.sql"
} | psql \
  -v ON_ERROR_STOP=1 \
  -v source_name="$source_name" \
  -v source_sha256="$source_sha256" \
  -v card_encryption_key="$CARD_ENCRYPTION_KEY" \
  -v card_hmac_key="$CARD_HMAC_KEY" \
  -v pin_encryption_key="$PIN_ENCRYPTION_KEY"
