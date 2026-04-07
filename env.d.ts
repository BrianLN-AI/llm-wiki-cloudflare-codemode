/* eslint-disable */
// Augments the generated Cloudflare.Env (worker-configuration.d.ts) with secret/variable
// bindings that are not declared as wrangler.jsonc bindings.
// Re-run `npm run types` after changing wrangler.jsonc to regenerate worker-configuration.d.ts.
declare namespace Cloudflare {
  interface Env {
    /** Override the default Workers AI model (e.g. "@cf/meta/llama-3.3-70b-instruct") */
    WORKERS_AI_MODEL?: string;
    /**
     * Public origin of this Worker (e.g. "https://llm-wiki.workers.dev").
     * Required for CDN cache eviction from DurableObjects.
     */
    HOST?: string;
    /**
     * Optional API key for protecting write endpoints and MCP.
     * When set, callers must send `Authorization: Bearer <key>`.
     * Reads (GET) remain public.
     */
    API_KEY?: string;
  }
}

type StringifyValues<EnvType extends Record<string, unknown>> = {
  [Binding in keyof EnvType]: EnvType[Binding] extends string
    ? EnvType[Binding]
    : string;
};
declare namespace NodeJS {
  interface ProcessEnv
    extends StringifyValues<
      Pick<Cloudflare.Env, "WORKERS_AI_MODEL" | "HOST" | "API_KEY">
    > {}
}
