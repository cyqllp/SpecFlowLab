#!/bin/zsh

set -euo pipefail

if (( $# == 2 )) && [[ "$1" == "-V" && "$2" == "/?" ]]; then
  print -r -- "OVERVIEW: LLVM Resource Converter"
  print -r -- "/no-preprocess"
  exit 0
fi

: "${SPECFLOWLAB_ZIG_BIN:?Set SPECFLOWLAB_ZIG_BIN to the Zig executable}"

typeset -a forwarded
for argument in "$@"; do
  if [[ "$argument" == "/no-preprocess" ]]; then
    forwarded+=("/:no-preprocess")
  else
    forwarded+=("$argument")
  fi
done

exec "$SPECFLOWLAB_ZIG_BIN" rc "${forwarded[@]}"
