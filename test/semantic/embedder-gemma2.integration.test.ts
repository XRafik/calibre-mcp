// Live EmbeddingGemma 2 smoke test (#139) — GATED behind RUN_MODEL_TESTS so CI stays offline.
// Makes the gemma2 CANDIDATES entries runnable for the #140 bake-off; ACTIVE_MODEL is untouched.
// First run downloads the ~314 MB q8 text model (huggingface.co); later runs are offline.
//   RUN_MODEL_TESTS=1 pnpm vitest run test/semantic/embedder-gemma2.integration.test.ts

import { describe, expect, it } from "vitest";
import { loadConfig } from "../../src/config.js";
import { TransformersEmbedder } from "../../src/semantic/embedder.js";
import { CANDIDATES } from "../../src/semantic/model.js";
import { dot } from "../../src/semantic/vector.js";

const RUN = process.env.RUN_MODEL_TESTS === "1";

describe.skipIf(!RUN).each(["gemma2-768", "gemma2-256"] as const)("%s (live model)", (key) => {
  const spec = CANDIDATES[key];
  const embedder = new TransformersEmbedder(loadConfig(), undefined, spec);

  it("returns a unit-norm vector of the spec's stored dim", async () => {
    const v = await embedder.embedQuery("which planet is the red planet");
    expect([v.length, Number(dot(v, v).toFixed(3))]).toEqual([spec.dim, 1]);
  }, 300_000);

  it("ranks a relevant EN passage above an unrelated one", async () => {
    const q = await embedder.embedQuery("which planet is the red planet");
    const [relevant, unrelated] = await embedder.embedPassages([
      "Mars, known for its reddish appearance, is often referred to as the Red Planet.",
      "A recipe for chocolate chip cookies with brown butter.",
    ]);
    expect(dot(q, relevant!)).toBeGreaterThan(dot(q, unrelated!));
  }, 300_000);

  it("ranks a relevant RU passage above an unrelated one", async () => {
    const q = await embedder.embedQuery("книга о программировании");
    const [relevant, unrelated] = await embedder.embedPassages([
      "учебник по языку программирования и алгоритмам",
      "quantum chromodynamics and the strong nuclear force",
    ]);
    expect(dot(q, relevant!)).toBeGreaterThan(dot(q, unrelated!));
  }, 300_000);
});
