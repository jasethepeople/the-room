import { randomUUID } from "node:crypto";
import { open, rename, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { GenesisRegistry, RoomPaths, SignedEvent } from "./types.ts";

export function renderTranscript(genesis: GenesisRegistry, events: SignedEvent[]): string {
  const lines = events.map((event) => JSON.stringify(event));
  return `# ${genesis.roomName}\n\nRoom ID: ${genesis.roomId}\n\n## Genesis registry\n\n\`\`\`json\n${JSON.stringify(genesis, null, 2)}\n\`\`\`\n\n## Signed transcript (complete envelopes)\n\n\`\`\`jsonl\n${lines.join("\n")}\n\`\`\`\n`;
}

export function appendSeamView(current: string, event: SignedEvent): string {
  if (event.body.kind !== "seam") return current;
  const spans = event.body.spans.map((span) => `- ${span.fromEventId} → ${span.toEventId}`).join("\n");
  const section = `## Seam ${event.seq} · ${event.id}\n\n${event.body.note}${spans ? `\n\nSpans\n${spans}` : ""}`;
  const base = current.endsWith("\n") ? current : `${current}\n`;
  return `${base}\n${section}\n`;
}

export async function atomicWrite(path: string, content: string | Buffer): Promise<void> {
  const temporary = join(dirname(path), `.${randomUUID()}.tmp`);
  try {
    const handle = await open(temporary, "wx", 0o600);
    try {
      await handle.writeFile(content, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(temporary, path);
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => undefined);
    throw error;
  }
}

export async function refreshTranscript(paths: RoomPaths, genesis: GenesisRegistry, events: SignedEvent[]): Promise<void> {
  await atomicWrite(paths.transcriptMd, renderTranscript(genesis, events));
}
