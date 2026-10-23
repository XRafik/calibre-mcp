// #140 embedder bake-off scorer: reads the reports bakeoff-140.sh wrote and prints the results
// tables + mechanical verdicts for gates G1–G4 and the floor calibration declared in
// thresholds.json `embedderBakeoff140` (committed BEFORE any run, D-012 protocol). G5
// (throughput, embed-throughput.ts) and G6 (ops/license) are judged in the bake-off note.
//
// Usage: node --import tsx test/eval/retrieval/bakeoff-140.ts [--reports <dir>]

import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { evaluateGate, type Thresholds } from "./gate.js";
import type { EvalReport, Mode, PerQueryRow } from "./harness.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
type Run = "on" | "off";

interface Bakeoff {
  candidates: string[];
  baseline: string;
  rrfWeights: number[];
  gates: {
    G1_ruGain: {
      fixtureOff: { vectorRuInvolvedNdcg10MinDelta: number; hybridRuInvolvedNdcg10MinDelta: number };
      fixtureOn: { vectorRuInvolvedNdcg10MinDelta: number; hybridRuInvolvedNdcg10MinDelta: number };
    };
    G2_crossLingual: { fixtureOff: { vectorCrossLingualNdcg10MinDelta: number } };
    G3_enNonRegression: {
      overallNdcg10MaxDrop: { fixtureOn: number; fixtureOff: number; modes: Mode[] };
      keywordFavouredKinds: { kinds: string[]; maxNdcg10Drop: number; maxBrokenHit1Queries: number };
      semanticParaphrase: { modes: Mode[]; maxNdcg10Drop: number };
    };
    G4_zeroBroken: { modes: Mode[] };
  };
}

const wTag = (w: number) => (Number.isInteger(w) ? w.toFixed(1) : String(w));
const f4 = (n: number | undefined) => (n === undefined ? "—" : n.toFixed(4));
const sg = (n: number) => `${n >= 0 ? "+" : ""}${n.toFixed(4)}`;
const pf = (b: boolean) => (b ? "PASS" : "FAIL");

function load(dir: string, model: string, w: number, run: Run): EvalReport {
  const suffix = `-b140-${model}-w${wTag(w)}-${run}.json`;
  const file = readdirSync(dir).filter((f) => f.endsWith(suffix)).sort().at(-1);
  if (!file) throw new Error(`no report *${suffix} in ${dir} — run bakeoff-140.sh first`);
  return JSON.parse(readFileSync(path.join(dir, file), "utf8")) as EvalReport;
}

const nd = (r: EvalReport, mode: Mode, kind?: string) =>
  (kind === undefined ? r.overall[mode] : kind === "RU" ? r.ruInvolved[mode] : r.byKind[kind]?.[mode])?.ndcg10;
const h1 = (r: EvalReport, mode: Mode, kind?: string) =>
  (kind === undefined ? r.overall[mode] : kind === "RU" ? r.ruInvolved[mode] : r.byKind[kind]?.[mode])?.hit1;

/** Queries of `kinds` in `mode` with Hit@1 in `base` but not in `cur`. */
function broken(base: EvalReport, cur: EvalReport, mode: Mode, kinds: string[]): string[] {
  const curById = new Map(cur.perQuery.filter((r) => r.mode === mode).map((r) => [r.id, r]));
  return base.perQuery
    .filter((r) => r.mode === mode && kinds.includes(r.kind) && r.metrics?.hit1 === 1)
    .filter((b) => curById.get(b.id)?.metrics?.hit1 !== 1)
    .map((b) => b.id);
}

interface ModelRuns {
  /** [weight][run] → report. w=1.0 has all modes; others hybrid only. */
  byWeight: Map<number, Record<Run, EvalReport>>;
  op: number;
}

/** #142's selection rule on one model's own sweep (fixture-only — see thresholds operatingPoint). */
function operatingPoint(runs: ModelRuns["byWeight"], b: Bakeoff, out: string[]): number {
  const kf = b.gates.G3_enNonRegression.keywordFavouredKinds;
  const base = runs.get(1.0)!;
  let best = 1.0;
  let bestRu = nd(base.off, "hybrid", "RU") ?? 0;
  for (const w of b.rrfWeights) {
    const cur = runs.get(w)!;
    let ok = true;
    const notes: string[] = [];
    for (const run of ["on", "off"] as Run[]) {
      for (const k of kf.kinds) {
        const drop = (nd(base[run], "hybrid", k) ?? 0) - (nd(cur[run], "hybrid", k) ?? 0);
        const br = broken(base[run], cur[run], "hybrid", [k]);
        if (drop > kf.maxNdcg10Drop + 1e-9 || br.length > kf.maxBrokenHit1Queries) {
          ok = false;
          notes.push(`${run} ${k} drop ${drop.toFixed(4)} broken [${br.join(", ")}]`);
        }
      }
    }
    const ru = nd(cur.off, "hybrid", "RU") ?? 0;
    out.push(
      `| ${w} | ${f4(nd(cur.on, "hybrid"))} / ${f4(nd(cur.on, "hybrid", "RU"))} / ${f4(nd(cur.on, "hybrid", "cross-lingual"))} | ` +
        `${f4(nd(cur.off, "hybrid"))} / ${f4(ru)} / ${f4(nd(cur.off, "hybrid", "cross-lingual"))} | ` +
        `${f4(nd(cur.on, "hybrid", "exact-identifier"))} / ${f4(nd(cur.off, "hybrid", "exact-identifier"))} | ` +
        `${f4(nd(cur.on, "hybrid", "front-matter-trap"))} / ${f4(nd(cur.off, "hybrid", "front-matter-trap"))} | ${ok ? "ok" : `EN ✗ (${notes.join("; ")})`} |`,
    );
    if (ok && ru > bestRu + 1e-9) {
      best = w;
      bestRu = ru;
    }
  }
  return best;
}

/** Floor that separates negatives from positives on a per-query max score (see thresholds.floors). */
function separate(pos: number[], neg: number[]): { floor: number; posFlagged: number; gap: boolean } {
  const maxNeg = Math.max(...neg);
  const minPos = Math.min(...pos);
  if (maxNeg < minPos) return { floor: Math.round(((maxNeg + minPos) / 2) * 100) / 100, posFlagged: 0, gap: true };
  // No gap: flag every negative, flag as few positives as possible.
  const floor = Math.ceil((maxNeg + 1e-6) * 100) / 100;
  return { floor, posFlagged: pos.filter((p) => p < floor).length, gap: false };
}

const range = (xs: number[]) => (xs.length ? `${Math.min(...xs).toFixed(3)}–${Math.max(...xs).toFixed(3)}` : "—");

function libraryTextRows(r: EvalReport, mode: Mode): PerQueryRow[] {
  return r.perQuery.filter((q) => q.mode === mode && q.scope === "library" && (q.target ?? "text") === "text");
}

function main(): void {
  const argv = process.argv.slice(2);
  const i = argv.indexOf("--reports");
  const dir = i >= 0 && argv[i + 1] ? argv[i + 1]! : path.join(HERE, "reports", "bakeoff-140");
  const all = JSON.parse(readFileSync(path.join(HERE, "thresholds.json"), "utf8")) as Thresholds & {
    embedderBakeoff140: Bakeoff;
  };
  const b = all.embedderBakeoff140;
  const out: string[] = [];

  const models = new Map<string, ModelRuns>();
  for (const m of b.candidates) {
    const byWeight = new Map<number, Record<Run, EvalReport>>();
    for (const w of b.rrfWeights) byWeight.set(w, { on: load(dir, m, w, "on"), off: load(dir, m, w, "off") });
    out.push(`## ${m} — RRF weight sweep (hybrid nDCG@10)`, "");
    out.push("| VECTOR_RRF_WEIGHT | ON overall / RU / xl | OFF overall / RU / xl | exact-id ON / OFF | front-matter ON / OFF | EN vs own w=1.0 |");
    out.push("|---|---|---|---|---|---|");
    const op = operatingPoint(byWeight, b, out);
    out.push("", `Operating point: **w=${op}**`, "");
    models.set(m, { byWeight, op });
  }

  // Headline comparison at operating points (vector/keyword from w=1.0 — weight-independent).
  const at = (m: string, run: Run, mode: Mode) =>
    mode === "hybrid" ? models.get(m)!.byWeight.get(models.get(m)!.op)![run] : models.get(m)!.byWeight.get(1.0)![run];
  for (const run of ["on", "off"] as Run[]) {
    out.push(`## Comparison at operating points — rerank ${run.toUpperCase()} (nDCG@10 / Hit@1)`, "");
    out.push("| model (w) | hybrid overall | hybrid RU | hybrid xl | vector overall | vector RU | vector xl | keyword overall |");
    out.push("|---|---|---|---|---|---|---|---|");
    for (const m of b.candidates) {
      const c = (mode: Mode, k?: string) => `${f4(nd(at(m, run, mode), mode, k))} / ${f4(h1(at(m, run, mode), mode, k))}`;
      out.push(
        `| ${m} (${models.get(m)!.op}) | ${c("hybrid")} | ${c("hybrid", "RU")} | ${c("hybrid", "cross-lingual")} | ${c("vector")} | ${c("vector", "RU")} | ${c("vector", "cross-lingual")} | ${c("keyword")} |`,
      );
    }
    out.push("");
    out.push("Per-kind nDCG@10 (hybrid / vector):", "");
    const kinds = Object.keys(at(b.baseline, run, "vector").byKind).sort();
    out.push(`| model | ${kinds.join(" | ")} |`, `|---|${kinds.map(() => "---").join("|")}|`);
    for (const m of b.candidates) {
      out.push(`| ${m} | ${kinds.map((k) => `${f4(nd(at(m, run, "hybrid"), "hybrid", k))} / ${f4(nd(at(m, run, "vector"), "vector", k))}`).join(" | ")} |`);
    }
    out.push("");
  }

  // Gates G1–G4 per candidate vs the baseline at operating points.
  const g = b.gates;
  const nonRegression = Object.fromEntries(g.G4_zeroBroken.modes.map((m) => [m, all.nonRegression[m]])) as Thresholds["nonRegression"];
  const gateBaseline = JSON.parse(readFileSync(path.join(HERE, all.baselineReport), "utf8")) as EvalReport;
  const g4 = (m: string) => {
    const r = evaluateGate(models.get(m)!.byWeight.get(1.0)!.on, gateBaseline, { ...all, nonRegression });
    return { pass: r.pass, failed: r.checks.filter((c) => c.active && !c.pass).map((c) => `${c.name}: ${c.detail ?? ""}`) };
  };
  out.push("## Gates G1–G4 (vs e5-small at its operating point)", "");
  const e5g4 = g4(b.baseline);
  out.push(`- e5-small (4.3.1) G4 zero-broken vs the frozen gate baseline: ${pf(e5g4.pass)}${e5g4.failed.length ? ` — ${e5g4.failed.join("; ")}` : ""}`, "");
  for (const m of b.candidates.filter((x) => x !== b.baseline)) {
    const checks: Array<[string, boolean, string]> = [];
    for (const run of ["off", "on"] as Run[]) {
      const G1 = run === "off" ? g.G1_ruGain.fixtureOff : g.G1_ruGain.fixtureOn;
      for (const mode of ["vector", "hybrid"] as Mode[]) {
        const need = mode === "vector" ? G1.vectorRuInvolvedNdcg10MinDelta : G1.hybridRuInvolvedNdcg10MinDelta;
        const d = (nd(at(m, run, mode), mode, "RU") ?? 0) - (nd(at(b.baseline, run, mode), mode, "RU") ?? 0);
        checks.push([`G1 ${run} ${mode} RU`, d >= need - 1e-9, `${sg(d)} (need ≥${sg(need)})`]);
      }
    }
    const dx = (nd(at(m, "off", "vector"), "vector", "cross-lingual") ?? 0) - (nd(at(b.baseline, "off", "vector"), "vector", "cross-lingual") ?? 0);
    const needX = g.G2_crossLingual.fixtureOff.vectorCrossLingualNdcg10MinDelta;
    checks.push(["G2 off vector cross-lingual", dx >= needX - 1e-9, `${sg(dx)} (need ≥${sg(needX)})`]);
    const G3 = g.G3_enNonRegression;
    for (const run of ["on", "off"] as Run[]) {
      const maxDrop = run === "on" ? G3.overallNdcg10MaxDrop.fixtureOn : G3.overallNdcg10MaxDrop.fixtureOff;
      for (const mode of G3.overallNdcg10MaxDrop.modes) {
        const drop = (nd(at(b.baseline, run, mode), mode) ?? 0) - (nd(at(m, run, mode), mode) ?? 0);
        checks.push([`G3 ${run} ${mode} overall`, drop <= maxDrop + 1e-9, `drop ${drop.toFixed(4)} (≤${maxDrop})`]);
      }
      for (const k of G3.keywordFavouredKinds.kinds) {
        const base = at(b.baseline, run, "hybrid");
        const cur = at(m, run, "hybrid");
        const drop = (nd(base, "hybrid", k) ?? 0) - (nd(cur, "hybrid", k) ?? 0);
        const br = broken(base, cur, "hybrid", [k]);
        const ok = drop <= G3.keywordFavouredKinds.maxNdcg10Drop + 1e-9 && br.length <= G3.keywordFavouredKinds.maxBrokenHit1Queries;
        checks.push([`G3 ${run} hybrid ${k}`, ok, `drop ${drop.toFixed(4)}, broken Hit@1 [${br.join(", ")}]`]);
      }
      for (const mode of G3.semanticParaphrase.modes) {
        const drop = (nd(at(b.baseline, run, mode), mode, "semantic-paraphrase") ?? 0) - (nd(at(m, run, mode), mode, "semantic-paraphrase") ?? 0);
        checks.push([`G3 ${run} ${mode} semantic-paraphrase`, drop <= G3.semanticParaphrase.maxNdcg10Drop + 1e-9, `drop ${drop.toFixed(4)}`]);
      }
    }
    const z = g4(m);
    checks.push(["G4 zero-broken (on, w=1.0)", z.pass, z.pass ? "PASS" : z.failed.join("; ")]);
    out.push(`### ${m} (w=${models.get(m)!.op}) — G1–G4 ${pf(checks.every((c) => c[1]))}`);
    for (const [name, ok, detail] of checks) out.push(`- [${pf(ok)}] ${name} — ${detail}`);
    out.push("");
  }

  // Floors.
  out.push("## Floors", "", "| model | vector maxScore positives | negatives | semanticFloor (rule) | positives flagged | rerank max positives | negatives | negatives < 0.3 | positives < 0.3 |");
  out.push("|---|---|---|---|---|---|---|---|---|");
  for (const m of b.candidates) {
    const rows = libraryTextRows(models.get(m)!.byWeight.get(1.0)!.off, "vector");
    const pos = rows.filter((r) => r.kind !== "negative").map((r) => r.maxScore).filter((x): x is number => x !== undefined);
    const neg = rows.filter((r) => r.kind === "negative").map((r) => r.maxScore).filter((x): x is number => x !== undefined);
    const s = separate(pos, neg);
    const onRows = [...libraryTextRows(models.get(m)!.byWeight.get(1.0)!.on, "hybrid"), ...libraryTextRows(models.get(m)!.byWeight.get(1.0)!.on, "vector")];
    const rp = onRows.filter((r) => r.kind !== "negative").map((r) => r.maxRerank).filter((x): x is number => x !== undefined);
    const rn = onRows.filter((r) => r.kind === "negative").map((r) => r.maxRerank).filter((x): x is number => x !== undefined);
    out.push(
      `| ${m} | ${range(pos)} | ${range(neg)} | ${s.floor.toFixed(2)} (${s.gap ? "gap midpoint" : "no gap"}) | ${s.posFlagged}/${pos.length} | ${range(rp)} | ${range(rn)} | ${rn.filter((x) => x < 0.3).length}/${rn.length} | ${rp.filter((x) => x < 0.3).length}/${rp.length} |`,
    );
  }
  // CLI output on stdout (a script, not the stdio MCP server).
  process.stdout.write(out.join("\n") + "\n");
}

main();
