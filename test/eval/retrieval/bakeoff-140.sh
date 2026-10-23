#!/usr/bin/env bash
# #140 embedder bake-off driver: for each candidate model × VECTOR_RRF_WEIGHT, temporarily
# rewrites ACTIVE_MODEL (model.ts) and the weight constant (calibre_semantic_search.ts) — both
# are code-level switches with no config surface, by design — runs the declared fixture
# measurements, then restores both files. Score with bakeoff-140.ts (gates in thresholds.json
# `embedderBakeoff140`, committed before any run).
#
# w=1.0 runs all modes (vector/keyword don't depend on the weight); other weights hybrid only.
# The eval work dir is a SCRATCH dir (never the production index): set CALIBRE_MCP_EVAL_WORK_DIR.
#
# Usage: test/eval/retrieval/bakeoff-140.sh [model ...]   (default: e5-small gemma2-768 gemma2-256)
set -euo pipefail
cd "$(dirname "$0")/../../.."
: "${CALIBRE_MCP_EVAL_WORK_DIR:?set a scratch work dir}"
MODEL_SRC=src/semantic/model.ts
SEARCH_SRC=src/tools/calibre_semantic_search.ts
OUT=test/eval/retrieval/reports/bakeoff-140
MODELS=("${@:-e5-small gemma2-768 gemma2-256}")
read -r -a MODELS <<<"${MODELS[*]}"
WEIGHTS=(1.0 1.5 2.0)

cp "$MODEL_SRC" "$MODEL_SRC.bakeoff-bak"
cp "$SEARCH_SRC" "$SEARCH_SRC.bakeoff-bak"
trap 'mv "$MODEL_SRC.bakeoff-bak" "$MODEL_SRC"; mv "$SEARCH_SRC.bakeoff-bak" "$SEARCH_SRC"' EXIT
mkdir -p "$OUT"

for m in "${MODELS[@]}"; do
  sed -E "s/^export const ACTIVE_MODEL: EmbeddingModelSpec = CANDIDATES\[\"[^\"]+\"\];/export const ACTIVE_MODEL: EmbeddingModelSpec = CANDIDATES[\"${m}\"];/" \
    "$MODEL_SRC.bakeoff-bak" >"$MODEL_SRC"
  grep -q "CANDIDATES\[\"${m}\"\];" "$MODEL_SRC" || { echo "failed to set model $m" >&2; exit 1; }
  for w in "${WEIGHTS[@]}"; do
    sed -E "s/^const VECTOR_RRF_WEIGHT = [0-9.]+;/const VECTOR_RRF_WEIGHT = ${w};/" "$SEARCH_SRC.bakeoff-bak" >"$SEARCH_SRC"
    grep -q "^const VECTOR_RRF_WEIGHT = ${w};" "$SEARCH_SRC" || { echo "failed to set weight $w" >&2; exit 1; }
    modes=hybrid
    [ "$w" = "1.0" ] && modes=hybrid,vector,keyword
    for r in on off; do
      echo "[bakeoff] model=$m w=$w rerank=$r modes=$modes" >&2
      rerank=()
      [ "$r" = off ] && rerank=(--rerank off)
      pnpm -s eval --modes "$modes" ${rerank[@]+"${rerank[@]}"} --out-dir "$OUT" --tag "b140-${m}-w${w}-${r}"
    done
  done
done
