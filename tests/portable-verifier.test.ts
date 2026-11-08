import assert from "node:assert/strict";
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { copyFile, mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";

function canonical(value: unknown): string {
  if (value === null || typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number" && Number.isFinite(value)) return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonical(record[key])}`).join(",")}}`;
  }
  throw new Error("Unsupported legacy fixture value");
}

function hash(value: Uint8Array | string): string {
  return createHash("sha256").update(value).digest("hex");
}

test("legacy scaffold verifier runs from an empty copied directory with only genesis and transcript", async () => {
  const root = await mkdtemp(join(tmpdir(), "the-room-portable-legacy-"));
  try {
    const roomDirectory = join(root, "room");
    await mkdir(roomDirectory);
    const humanKeys = generateKeyPairSync("ed25519");
    const fixtureKeys = generateKeyPairSync("ed25519");
    const makeMember = (id: string, name: string, role: "human" | "agent", keys: ReturnType<typeof generateKeyPairSync>) => {
      const publicDer = keys.publicKey.export({ format: "der", type: "spki" });
      return {
        member: {
          id,
          name,
          role,
          modelId: role === "human" ? "human" : "fixture:portable",
          publicKey: keys.publicKey.export({ format: "pem", type: "spki" }).toString(),
          fingerprint: `sha256:${hash(publicDer)}`,
          subscriptions: ["main"],
          budgets: { main: 1000 },
          limits: { maxTokensPerThread: 1000, maxTokensPerTurn: 100, maxTurnsPerSession: 8, maxRunMs: 10000 },
        },
        privateKey: keys.privateKey,
      };
    };
    const human = makeMember("human", "Human", "human", humanKeys);
    const fixture = makeMember("fixture-1", "Fixture", "agent", fixtureKeys);
    const genesisPayload = {
      schemaVersion: 1,
      roomId: "portable-legacy",
      createdAt: new Date().toISOString(),
      ownerId: human.member.id,
      topic: "Portable verifier test",
      participants: [human.member, fixture.member],
    };
    const genesisHash = hash(canonical(genesisPayload));
    const genesis = {
      payload: genesisPayload,
      hash: genesisHash,
      signedBy: human.member.id,
      signature: sign(null, Buffer.from(genesisHash, "hex"), human.privateKey).toString("base64"),
    };
    const body = {
      schemaVersion: 1,
      seq: 1,
      roomId: genesisPayload.roomId,
      threadId: "main",
      kind: "turn",
      authorId: human.member.id,
      occurredAt: new Date().toISOString(),
      previousHash: genesisHash,
      usageTokens: 1,
      usageCharges: [],
      payload: { text: "Portable legacy fixture turn." },
    };
    const eventHash = hash(canonical(body));
    const event = {
      ...body,
      eventId: `evt_000001_${eventHash.slice(0, 24)}`,
      hash: eventHash,
      signature: sign(null, Buffer.from(eventHash, "hex"), human.privateKey).toString("base64"),
    };
    await writeFile(join(roomDirectory, "genesis.json"), `${JSON.stringify(genesis)}\n`);
    await writeFile(join(roomDirectory, "transcript.jsonl"), `${JSON.stringify(event)}\n`);
    const verifier = new URL("../tools/verify-transcript.mjs", import.meta.url);
    const isolatedVerifier = join(root, "verify-transcript.mjs");
    await copyFile(verifier, isolatedVerifier);
    assert.deepEqual((await readdir(roomDirectory)).sort(), ["genesis.json", "transcript.jsonl"]);
    const output = execFileSync(process.execPath, [isolatedVerifier, roomDirectory], { cwd: root, encoding: "utf8" });
    const report = JSON.parse(output) as { ok: boolean; eventCount: number; checks: { name: string; ok: boolean; errors: string[] }[] };
    assert.equal(report.ok, true, JSON.stringify(report));
    assert.equal(report.eventCount, 1);
    assert.deepEqual(report.checks.map((check) => check.name), ["cryptographic", "policy"]);
    assert.ok(report.checks.every((check) => check.ok));
    assert.deepEqual((await readdir(root)).sort(), ["room", "verify-transcript.mjs"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
