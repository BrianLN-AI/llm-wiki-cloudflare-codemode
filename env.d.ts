/* eslint-disable */
// Run `npm run types` to regenerate after wrangler.jsonc changes
declare namespace Cloudflare {
  interface GlobalProps {
    mainModule: typeof import("./src/server");
    durableNamespaces: "WikiAgent" | "IngestAgent" | "LintAgent";
  }
  interface Env {
    // Durable Objects
    WikiAgent: DurableObjectNamespace<import("./src/server").WikiAgent>;
    IngestAgent: DurableObjectNamespace<import("./src/agents/ingest-agent").IngestAgent>;
    LintAgent: DurableObjectNamespace<import("./src/agents/lint-agent").LintAgent>;

    // R2 – raw document storage
    RAW_DOCS: R2Bucket;

    // Vectorize – semantic search (384-dim, bge-small-en-v1.5)
    WIKI_VECTORS: VectorizeIndex;

    // Workers AI – LLM + embeddings
    AI: Ai;

    // Dynamic Worker Loader – isolated CodeMode sandboxes
    LOADER: WorkerLoader;

    // Secrets / vars
    /** Override the default Workers AI model (e.g. "@cf/meta/llama-3.3-70b-instruct") */
    WORKERS_AI_MODEL?: string;
    /**
     * Public origin of this Worker (e.g. "https://llm-wiki.workers.dev").
     * Required for CDN cache eviction from DurableObjects.
     */
    HOST?: string;
  }
}
interface Env extends Cloudflare.Env {}

type StringifyValues<EnvType extends Record<string, unknown>> = {
  [Binding in keyof EnvType]: EnvType[Binding] extends string
    ? EnvType[Binding]
    : string;
};
declare namespace NodeJS {
  interface ProcessEnv
    extends StringifyValues<
      Pick<Cloudflare.Env, "WORKERS_AI_MODEL" | "HOST">
    > {}
}
