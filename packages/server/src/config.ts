/**
 * Resolves the LLM base URL and model name from the environment.
 *
 * Defaults match the local LM Studio OpenAI-compatible server, overridable
 * via the `LLM_BASE_URL` and `LLM_MODEL` environment variables.
 */
export function getLlmConfig(): { baseUrl: string; model: string } {
    return {
        baseUrl: process.env.LLM_BASE_URL ?? "http://localhost:1234/v1",
        model: process.env.LLM_MODEL ?? "qwen/qwen3-4b-2507",
    };
}
