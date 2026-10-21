// Text-only loading for multimodal embedding repos (#139): EmbeddingGemma 2's ONNX repo also
// ships vision/audio encoders, and AutoModel loads every encoder whose config is present —
// so the embedder must null the spec's dropConfigKeys before the model load. The module
// loader is injected (the optional-dep boundary) so no model is downloaded.

import { describe, expect, it } from "vitest";
import { loadConfig } from "../../src/config.js";
import { TransformersEmbedder } from "../../src/semantic/embedder.js";
import { CANDIDATES } from "../../src/semantic/model.js";

const cfg = loadConfig({ CALIBRE_MCP_INDEX_DIR: "/tmp/unused-index" } as NodeJS.ProcessEnv);

/** Baked-in-path stand-in that records the options AutoModel was loaded with. */
function fakeMultimodalModule(seen: { config?: Record<string, unknown> }) {
  const tokenizer = Object.assign(() => ({}), { encode: (t: string) => t.split(" ") });
  const row = Array.from({ length: 768 }, (_, i) => (i === 0 ? 1 : 0));
  return {
    env: {},
    AutoTokenizer: { from_pretrained: async () => tokenizer },
    AutoConfig: {
      from_pretrained: async () => ({ text_config: {}, vision_config: {}, audio_config: {} }),
    },
    AutoModel: {
      from_pretrained: async (_id: string, opts: { config?: Record<string, unknown> }) => {
        seen.config = opts.config;
        return async () => ({ sentence_embedding: { tolist: () => [row] } });
      },
    },
  } as unknown as typeof import("@huggingface/transformers");
}

describe("TransformersEmbedder multimodal text-only load", () => {
  it("should_null_vision_and_audio_configs_when_spec_drops_them", async () => {
    const seen: { config?: Record<string, unknown> } = {};
    const embedder = new TransformersEmbedder(
      cfg,
      async () => fakeMultimodalModule(seen),
      CANDIDATES["gemma2-768"],
    );

    await embedder.warmup();

    expect(seen.config).toEqual({ text_config: {}, vision_config: null, audio_config: null });
  });

  it("should_store_mrl_truncated_vectors_for_gemma2_256", async () => {
    const embedder = new TransformersEmbedder(
      cfg,
      async () => fakeMultimodalModule({}),
      CANDIDATES["gemma2-256"],
    );

    const v = await embedder.embedQuery("red planet");

    expect(v.length).toBe(256);
  });
});
