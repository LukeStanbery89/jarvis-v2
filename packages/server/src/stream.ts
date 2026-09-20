/**
 * Returns the tokens streamed back to the client for a given prompt.
 *
 * The prompt is accepted but not yet used — the response is always
 * "Hello, World!". This is the seam where real AI response generation will
 * slot in later.
 */
export function responseTokens(prompt: string): string[] {
    return ["Hello,", " World!"];
}
