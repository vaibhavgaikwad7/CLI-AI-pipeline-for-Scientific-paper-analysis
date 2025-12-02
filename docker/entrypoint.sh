#!/bin/sh
set -eu

PDF="${PDF_FILE:-./reference-docs/ssrn-5298091.pdf}"
OUT="${OUT_FILE:-./out.json}"

ARGS="--pdf \"$PDF\" --out \"$OUT\""

# Optional provider/model/env flags
[ -n "${PROVIDER:-}" ] && ARGS="$ARGS --provider \"$PROVIDER\""
[ -n "${MODEL:-}" ] && ARGS="$ARGS --model \"$MODEL\""
[ -n "${DEBUG:-}" ] && ARGS="$ARGS --debug"

# shellcheck disable=SC2086
eval node dist/cli.js $ARGS
echo "Wrote $OUT"
