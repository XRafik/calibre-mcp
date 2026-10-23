// #140 embed throughput probe (gate G5: candidate ≥ ⅓ of e5 chunks/s). Embed-only warm rate on
// a fixed, deterministic sample of REAL library chunk bodies, through TransformersEmbedder (same
// prefixes, BATCH and dtype the indexer uses). Models are loaded once, then timed INTERLEAVED
// (e5, cand, e5, cand, …) so background CPU load from other work hits every model alike.
// Results are noisy by nature — report the median ratio, never a single round.
//
// Usage: node --import tsx test/eval/retrieval/embed-throughput.ts \
//          --source <library.sqlite> --work-dir <scratch> [--n 120] [--rounds 3] [--models e5-small,gemma2-768,gemma2-768:q4]

import { DatabaseSync } from "node:sqlite";
import { loadConfig } from "../../../src/config.js";
import { TransformersEmbedder } from "../../../src/semantic/embedder.js";
import { CANDIDATES, type EmbeddingModelSpec } from "../../../src/semantic/model.js";

const progress = (msg: string) => process.stderr.write(`[throughput] ${msg}\n`);

function arg(name: string, fallback?: string): string {
  const i = process.argv.indexOf(`--${name}`);
  const v = i >= 0 ? process.argv[i + 1] : fallback;
  if (v === undefined) throw new Error(`--${name} is required`);
  return v;
}

/** Every k-th chunk by id → a stable sample across runs (read-only, immutable open). */
function sampleChunks(source: string, n: number): string[] {
  const db = new DatabaseSync(`file:${source}?mode=ro&immutable=1`, { readOnly: true });
  const { total } = db.prepare("SELECT count(*) AS total FROM chunks").get() as { total: number };
  const stride = Math.max(1, Math.floor(total / n));
  const rows = db
    .prepare("SELECT body FROM (SELECT body, row_number() OVER (ORDER BY id) AS rn FROM chunks) WHERE rn % ? = 0 LIMIT ?")
    .all(stride, n) as Array<{ body: string }>;
  db.close();
  return rows.map((r) => r.body);
}

/** "gemma2-768:q4" → that candidate with the dtype overridden. */
function specOf(key: string): EmbeddingModelSpec {
  const [name, dtype] = key.split(":") as [keyof typeof CANDIDATES, EmbeddingModelSpec["dtype"] | undefined];
  const base = CANDIDATES[name];
  if (!base) throw new Error(`unknown candidate ${name}`);
  return dtype ? { ...base, dtype } : base;
}

const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)]!;

async function main(): Promise<void> {
  const texts = sampleChunks(arg("source"), Number(arg("n", "120")));
  const rounds = Number(arg("rounds", "3"));
  const keys = arg("models", "e5-small,gemma2-768").split(",");
  const cfg = loadConfig({ CALIBRE_MCP_INDEX_DIR: arg("work-dir") } as NodeJS.ProcessEnv);
  progress(`${texts.length} chunks, avg ${Math.round(texts.reduce((s, t) => s + t.length, 0) / texts.length)} chars`);

  const embedders = new Map<string, TransformersEmbedder>();
  for (const k of keys) {
    const e = new TransformersEmbedder(cfg, undefined, specOf(k));
    const t0 = performance.now();
    await e.warmup();
    await e.embedPassages(texts.slice(0, 10)); // first-inference graph warmup, untimed
    progress(`${k} loaded+warm in ${((performance.now() - t0) / 1000).toFixed(1)}s`);
    embedders.set(k, e);
  }

  const rates = new Map<string, number[]>(keys.map((k) => [k, []]));
  for (let r = 0; r < rounds; r++) {
    for (const k of keys) {
      const t0 = performance.now();
      await embedders.get(k)!.embedPassages(texts);
      const rate = texts.length / ((performance.now() - t0) / 1000);
      rates.get(k)!.push(rate);
      progress(`round ${r + 1} ${k}: ${rate.toFixed(2)} chunks/s`);
    }
  }

  const base = median(rates.get(keys[0]!)!);
  const lines = ["| model | chunks/s per round | median | × " + keys[0] + " (median) |", "|---|---|---|---|"];
  for (const k of keys) {
    const rs = rates.get(k)!;
    lines.push(`| ${k} | ${rs.map((x) => x.toFixed(2)).join(" / ")} | ${median(rs).toFixed(2)} | ${(median(rs) / base).toFixed(2)} |`);
  }
  // CLI output on stdout (a script, not the stdio MCP server).
  process.stdout.write(lines.join("\n") + "\n");
}

main().catch((err: unknown) => {
  process.stderr.write(`[throughput] FAILED: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
