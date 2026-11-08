export const MAX_EVENT_BYTES = 65_536;
export const MAX_TRANSCRIPT_BYTES = 52_428_800;
export const MAX_TEXT_CHARS = 16_384;
export const MAX_BUDGET_TOKENS = 1_000_000;
export const MAX_TOKENS_PER_TURN = 32_768;
export const MAX_MEMBERS = 32;
export const MAX_THREADS = 128;
export const WRITE_LOCK_TIMEOUT_MS = 2_000;

export function estimateTokens(text: string): number {
  return Math.max(1, Math.ceil(Buffer.byteLength(text, "utf8") / 4));
}
