import { sign } from "node:crypto";
import { chmod, copyFile, mkdir, mkdtemp, open, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { canonicalJson, publicKeyFingerprint, sha256, uuid7 } from "./canonical.ts";
import { appendSeamView, atomicWrite, refreshTranscript } from "./render.ts";
import { roomPaths } from "./paths.ts";
import { MAX_EVENT_BYTES, MAX_TEXT_CHARS, MAX_TRANSCRIPT_BYTES } from "./limits.ts";
import type { AppendContext, AppendEntry, EventBody, GenesisRegistry, MemberSpec, RoomPaths, SignedEvent, VerificationResult } from "./types.ts";
import type { StripReceipt } from "./strip.ts";import { ASSUMED_USD_PER_MILLION_TOKENS } from "./strip.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const ROOT_VERIFIER = join(ROOT, "verify.ts");
const ROOM_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*-[0-9a-f]{8}$/;
const THREAD_RE = /^[a-z0-9-]{1,64}$/;
const HASH_RE = /^[0-9a-f]{64}$/;

export interface RoomData {
  paths: RoomPaths;
  genesis: GenesisRegistry;
  events: SignedEvent[];
}

export interface ReceiptAttachment {
  eventId: string;
  eventSeq: number;
  receipt: StripReceipt;
}

export interface RoomWriteOptions {
  roomId: string;
  home?: string;
  entries: AppendEntry[];
  allowEmpty?: boolean;
  allowLatestSealRefresh?: boolean;
  preflight?: (state: AppendContext) => void | Promise<void>;
  receiptAttachments?: (events: SignedEvent[]) => ReceiptAttachment[];
}

export function assertTurnPreflight(state: AppendContext, input: {
  author: string;
  threadId: string;
  text: string;
  inputTokens: number;
  outputTokens: number;
}): void {
  const candidate: SignedEvent = {
    id: `preflight-${state.seq}`,
    roomId: state.genesis.roomId,
    seq: state.seq,
    threadId: input.threadId,
    author: input.author,
    createdAt: new Date(0).toISOString(),
    body: { kind: "turn", text: input.text, usage: { inputTokens: input.inputTokens, outputTokens: input.outputTokens } },
    prevHash: state.prevHash,
    hash: "0".repeat(64),
    signature: "",
  };
  const errors = policyErrors(state.genesis, [...state.priorEvents, candidate]);
  if (errors.length) throw new Error(`local candidate check failed: ${errors.join("; ")}`);
}

function asRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function rootFailure(reason: string): VerificationResult {
  return { ok: false, events: 0, warnings: [], firstFailure: { reason } };
}

function runRootVerifier(roomDir: string): VerificationResult {
  const result = spawnSync(process.execPath, [ROOT_VERIFIER, roomDir], {
    cwd: ROOT,
    encoding: "utf8",
    timeout: 30_000,
    maxBuffer: 4 * 1024 * 1024,
  });
  const output = (result.stdout ?? "").trim().split(/\r?\n/).filter(Boolean).at(-1);
  if (!output) return rootFailure(result.error?.message ?? result.stderr?.trim() ?? "root verifier returned no report");
  try {
    return JSON.parse(output) as VerificationResult;
  } catch {
    return rootFailure("root verifier returned invalid JSON");
  }
}

export async function readRoom(roomId: string, home?: string): Promise<RoomData> {
  const paths = roomPaths(roomId, home);
  const genesis = JSON.parse(await readFile(paths.genesis, "utf8")) as GenesisRegistry;
  const transcript = await readFile(paths.transcript, "utf8");
  const lines = transcript.length === 0 ? [] : transcript.replace(/\n$/, "").split("\n");
  if (lines.some((line) => line.length === 0)) throw new Error("transcript.jsonl contains an empty line");
  const events = lines.map((line) => JSON.parse(line) as SignedEvent);
  return { paths, genesis, events };
}

export async function verifyRoom(roomId: string, home?: string): Promise<VerificationResult> {
  const paths = roomPaths(roomId, home);
  return runRootVerifier(paths.room);
}

function latestSeal(events: SignedEvent[]): SignedEvent | undefined {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    if (events[index]?.body.kind === "seal") return events[index];
  }
  return undefined;
}

async function withTempRoom<T>(paths: RoomPaths, genesis: GenesisRegistry, events: SignedEvent[], seamsBytes: Buffer, snapshots: Map<number, Buffer>, work: (directory: string) => Promise<T>): Promise<T> {
  const directory = await mkdtemp(join(tmpdir(), "the-room-verify-"));
  try {
    await writeFile(join(directory, "genesis.json"), `${JSON.stringify(genesis)}\n`, { mode: 0o600 });
    const transcript = events.map((event) => JSON.stringify(event)).join("\n");
    await writeFile(join(directory, "transcript.jsonl"), transcript.length ? `${transcript}\n` : "", { mode: 0o600 });
    await writeFile(join(directory, "seams.md"), seamsBytes, { mode: 0o600 });
    let names: string[] = [];
    try {
      names = await readdir(paths.room);
    } catch {}
    for (const name of names) {
      const match = /^seams\.(\d+)\.md$/.exec(name);
      if (!match) continue;
      const seq = Number(match[1]);
      if (snapshots.has(seq)) continue;
      await copyFile(join(paths.room, name), join(directory, name));
    }
    for (const [seq, text] of snapshots) {
      await writeFile(join(directory, `seams.${seq}.md`), text, { mode: 0o600 });
    }
    return await work(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

async function verifyPriorState(data: RoomData, allowLatestSealRefresh: boolean): Promise<VerificationResult> {
  const current = runRootVerifier(data.paths.room);
  if (current.ok || !allowLatestSealRefresh) return current;
  const failure = current.firstFailure?.reason ?? "";
  if (!failure.includes("latest seal seamsSha256 mismatch")) return current;
  const seal = latestSeal(data.events);
  if (!seal || seal.body.kind !== "seal") return current;
  try {
    const snapshot = await readFile(data.paths.snapshot(seal.seq));
    return await withTempRoom(data.paths, data.genesis, data.events, snapshot, new Map(), async (directory) => runRootVerifier(directory));
  } catch {
    return current;
  }
}

function memberMaps(genesis: GenesisRegistry, events: SignedEvent[]): { members: Map<string, MemberSpec>; present: Set<string> } {
  const members = new Map(genesis.members.map((member) => [member.fingerprint, member]));
  const present = new Set(members.keys());
  for (const event of events) {
    if (event.body.kind === "membership") {
      if (event.body.action === "join") {
        members.set(event.body.member.fingerprint, event.body.member);
        present.add(event.body.member.fingerprint);
      } else {
        present.delete(event.body.member.fingerprint);
      }
    }
  }
  return { members, present };
}

function eventUsage(event: SignedEvent): number {
  return event.body.kind === "turn" ? (event.body.usage?.inputTokens ?? 0) + (event.body.usage?.outputTokens ?? 0) : 0;
}

function policyErrors(genesis: GenesisRegistry, events: SignedEvent[]): string[] {
  const errors: string[] = [];
  const members = new Map(genesis.members.map((member) => [member.fingerprint, member]));
  const present = new Set(members.keys());
  const threads = new Map(genesis.threads.map((thread) => [thread.id, thread]));
  const prior = new Map<string, SignedEvent>();
  const verdicts = new Set<string>();
  const cosigns = new Set<string>();
  const consumed = new Map<string, number>();
  const paused = new Set<string>();
  let rule = { ...genesis.canonRule };
  let previousHash = "0".repeat(64);
  for (let index = 0; index < events.length; index += 1) {
    const event = events[index]!;
    const label = `event ${index + 1}`;
    if (!ROOM_RE.test(event.roomId) || event.roomId !== genesis.roomId || event.seq !== index + 1 || event.prevHash !== previousHash) errors.push(`${label}: chain envelope mismatch`);
    if (!HASH_RE.test(event.author) || !Number.isSafeInteger(event.seq)) errors.push(`${label}: invalid author or sequence`);
    if (event.threadId !== null && (!THREAD_RE.test(event.threadId) || !threads.has(event.threadId))) errors.push(`${label}: unknown thread`);
    const body = event.body as EventBody;
    if (!asRecord(body) || typeof body.kind !== "string") {
      errors.push(`${label}: missing typed body`);
      previousHash = event.hash;
      continue;
    }
    if (body.kind === "system") {
      if (index !== 0 || body.genesisSha256 !== sha256(canonicalJson(genesis)) || body.templateId !== genesis.templateId || body.templateVersion !== genesis.templateVersion) errors.push(`${label}: invalid system event`);
    } else if (body.kind === "membership" && body.action === "join") {
      const member = body.member;
      if (event.author !== member.fingerprint || publicKeyFingerprint(member.publicKey) !== member.fingerprint || present.has(member.fingerprint)) errors.push(`${label}: invalid self-certifying join`);
      else {
        members.set(member.fingerprint, member);
        present.add(member.fingerprint);
      }
    } else {
      const member = members.get(event.author);
      if (!member || !present.has(event.author)) errors.push(`${label}: author is not a present key-resolved member`);
      if (body.kind === "membership" && body.action === "leave") {
        if (!member || body.member.fingerprint !== event.author || body.member.publicKey !== member.publicKey) errors.push(`${label}: invalid membership leave`);
        else present.delete(event.author);
      }
      if (["seam", "seal", "system"].includes(body.kind) && member?.role !== "human") errors.push(`${label}: room-level event requires a resolved human`);
      if (event.threadId && member && !member.subscriptions.includes(event.threadId)) errors.push(`${label}: author is not subscribed to this thread`);
      if (body.kind === "turn") {
        if (!body.text.trim() || body.text.length > MAX_TEXT_CHARS) errors.push(`${label}: turn text length is invalid`);
        const used = eventUsage(event);
        const total = (consumed.get(event.author) ?? 0) + used;
        if (paused.has(`${event.author}:*`) || (event.threadId && paused.has(`${event.author}:${event.threadId}`))) errors.push(`${label}: member budget is paused`);
        if (total > member?.budgetTokens!) errors.push(`${label}: member token budget exceeded`);
        consumed.set(event.author, total);
      }
      if (body.kind === "challenge") {
        if (!prior.has(body.targetEventId)) errors.push(`${label}: challenge target is not earlier in the chain`);
        for (const ref of body.evidence) if (ref.type === "event" && !prior.has(ref.id)) errors.push(`${label}: challenge evidence is not earlier in the chain`);
      }
      if (body.kind === "verdict") {
        const challenge = prior.get(body.challengeId);
        if (!challenge || challenge.body.kind !== "challenge" || verdicts.has(body.challengeId)) errors.push(`${label}: verdict is duplicate or has no earlier challenge`);
        verdicts.add(body.challengeId);
        for (const ref of body.evidence) if (ref.type === "event" && !prior.has(ref.id)) errors.push(`${label}: verdict evidence is not earlier in the chain`);
      }
      if (body.kind === "proposal" && body.supersedes) {
        if (prior.get(body.supersedes)?.body.kind !== "proposal") errors.push(`${label}: supersedes is not an earlier proposal`);
      }
      if (body.kind === "cosign") {
        if (prior.get(body.proposalId)?.body.kind !== "proposal") errors.push(`${label}: cosign is not attached to an earlier proposal`);
        const key = `${body.proposalId}:${event.author}`;
        if (cosigns.has(key)) errors.push(`${label}: duplicate cosign`);
        cosigns.add(key);
      }
      if (body.kind === "canon") {
        if (member?.role !== "human") errors.push(`${label}: canon change must be authored by a human`);
        if (prior.get(body.proposalId)?.body.kind !== "proposal") errors.push(`${label}: canon does not cite an earlier proposal`);
        const cited = new Set<string>();
        let support = 0;
        for (const id of body.cosigns) {
          const cosign = prior.get(id);
          if (cited.has(id)) continue;
          if (!cosign || cosign.body.kind !== "cosign" || cosign.body.proposalId !== body.proposalId) errors.push(`${label}: canon cites an invalid cosign`);
          else if (cosign.body.stance === "support") support += 1;
          cited.add(id);
        }
        if (support < rule.minCosigns) errors.push(`${label}: insufficient supporting cosigns`);
        if (body.newRule) rule = body.newRule;
      }
      if (body.kind === "budget") {
        if (member?.role !== "human" || !members.has(body.member)) errors.push(`${label}: budget change requires a human and known member`);
        const key = `${body.member}:${body.thread ?? "*"}`;
        if (body.state === "paused") paused.add(key);
        else paused.delete(key);
      }
      if (body.kind === "seal" && (body.chainHead !== event.prevHash || body.eventCount !== event.seq - 1)) errors.push(`${label}: seal checkpoint mismatch`);
    }
    if (prior.has(event.id)) errors.push(`${label}: duplicate event id`);
    prior.set(event.id, event);
    previousHash = event.hash;
  }
  return errors;
}

async function acquireLock(path: string): Promise<Awaited<ReturnType<typeof open>>> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  try {
    return await open(path, "wx", 0o600);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "EEXIST") throw new Error("Room is busy: another writer holds the append lock");
    throw error;
  }
}

async function writeExclusive(path: string, content: string | Buffer): Promise<void> {
  const handle = await open(path, "wx", 0o600);
  try {
    await handle.writeFile(content, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function recordQuarantine(paths: RoomPaths, roomId: string, digestInput: string, reason: string): Promise<void> {
  await mkdir(paths.room, { recursive: true, mode: 0o700 });
  const record = { at: new Date().toISOString(), roomId, inputSha256: sha256(digestInput), reason };
  const handle = await open(paths.quarantine, "a", 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(record)}\n`, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  await chmod(paths.quarantine, 0o600);
}

function reportMessage(result: VerificationResult): string {
  return result.firstFailure?.reason ?? "root verifier rejected the candidate";
}

async function stageFile(path: string, content: string | Buffer, exclusive: boolean): Promise<{ path: string; before: Buffer | null }> {
  let before: Buffer | null = null;
  try {
    before = await readFile(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  if (exclusive && before) throw new Error(`Checkpoint snapshot already exists: ${path}`);
  if (exclusive) await writeExclusive(path, content);
  else await atomicWrite(path, content);
  return { path, before };
}

async function restoreFiles(files: Array<{ path: string; before: Buffer | null }>): Promise<void> {
  for (const file of [...files].reverse()) {
    if (file.before === null) await rm(file.path, { force: true });
    else await writeFile(file.path, file.before);
  }
}

const RECEIPT_ZERO_HASH = "0".repeat(64);

function validReceiptBase(value: Record<string, unknown>): boolean {
  return typeof value.originalSha256 === "string" && HASH_RE.test(value.originalSha256)
    && typeof value.strippedSha256 === "string" && HASH_RE.test(value.strippedSha256)
    && Number.isSafeInteger(value.originalBytes) && (value.originalBytes as number) >= 0
    && Number.isSafeInteger(value.strippedBytes) && (value.strippedBytes as number) >= 0
    && Number.isSafeInteger(value.linesRemoved) && (value.linesRemoved as number) >= 0
    && Array.isArray(value.rulesApplied) && value.rulesApplied.every((rule) => typeof rule === "string");
}

function isStripReceipt(value: unknown): value is StripReceipt {
  if (!asRecord(value)) return false;
  const keys = Object.keys(value).sort().join(",");
  return keys === "estimatedCostMicroDollarsAfter,estimatedCostMicroDollarsBefore,estimatedTokensAfter,estimatedTokensBefore,linesAfter,linesBefore,linesRemoved,originalBytes,originalSha256,ruleSet,rulesApplied,strippedBytes,strippedSha256"
    && validReceiptBase(value)
    && (value.ruleSet === "wrapper" || value.ruleSet === "filler" || value.ruleSet === "both")
    && Number.isSafeInteger(value.linesBefore) && (value.linesBefore as number) >= 0
    && Number.isSafeInteger(value.linesAfter) && (value.linesAfter as number) >= 0
    && Number.isSafeInteger(value.estimatedTokensBefore) && (value.estimatedTokensBefore as number) >= 0
    && Number.isSafeInteger(value.estimatedTokensAfter) && (value.estimatedTokensAfter as number) >= 0
    && Number.isSafeInteger(value.estimatedCostMicroDollarsBefore) && (value.estimatedCostMicroDollarsBefore as number) >= 0
    && Number.isSafeInteger(value.estimatedCostMicroDollarsAfter) && (value.estimatedCostMicroDollarsAfter as number) >= 0
    && value.estimatedCostMicroDollarsBefore === (value.estimatedTokensBefore as number) * ASSUMED_USD_PER_MILLION_TOKENS
    && value.estimatedCostMicroDollarsAfter === (value.estimatedTokensAfter as number) * ASSUMED_USD_PER_MILLION_TOKENS;
}

function isStoredStripReceipt(value: unknown): boolean {
  if (!asRecord(value)) return false;
  if (isStripReceipt(value)) return true;
  const keys = Object.keys(value).sort().join(",");
  return keys === "linesRemoved,originalBytes,originalSha256,rulesApplied,strippedBytes,strippedSha256" && validReceiptBase(value);
}

async function prepareReceiptSidecars(
  paths: RoomPaths,
  existingEvents: SignedEvent[],
  createdEvents: SignedEvent[],
  attachments: ReceiptAttachment[],
): Promise<Array<{ path: string; content: string; exclusive: true }>> {
  const entries = await readdir(paths.room, { withFileTypes: true });
  const receiptFiles = entries.flatMap((entry) => {
    const match = /^receipts\.(\d+)\.jsonl$/.exec(entry.name);
    if (!match) return [];
    if (!entry.isFile()) throw new Error(`Receipt sidecar is not a regular file: ${entry.name}`);
    const eventSeq = Number(match[1]);
    if (!Number.isSafeInteger(eventSeq) || eventSeq < 1) throw new Error(`Invalid receipt sidecar sequence: ${entry.name}`);
    return [{ eventSeq, path: resolve(paths.room, entry.name) }];
  }).sort((left, right) => left.eventSeq - right.eventSeq);

  let previousReceiptHash = RECEIPT_ZERO_HASH;
  for (const file of receiptFiles) {
    const content = await readFile(file.path, "utf8");
    if (!content.endsWith("\n") || content.slice(0, -1).includes("\n")) throw new Error(`Receipt sidecar must contain one JSONL record: ${file.path}`);
    let parsed: unknown;
    try {
      parsed = JSON.parse(content.slice(0, -1));
    } catch {
      throw new Error(`Receipt sidecar is invalid JSON: ${file.path}`);
    }
    if (!asRecord(parsed) || Object.keys(parsed).sort().join(",") !== "eventId,eventSeq,previousReceiptHash,receipt,receiptHash") {
      throw new Error(`Receipt sidecar shape is invalid: ${file.path}`);
    }
    if (parsed.eventSeq !== file.eventSeq || typeof parsed.eventId !== "string" || !isStoredStripReceipt(parsed.receipt)
      || parsed.previousReceiptHash !== previousReceiptHash || typeof parsed.receiptHash !== "string" || !HASH_RE.test(parsed.receiptHash)) {
      throw new Error(`Receipt sidecar chain fields are invalid: ${file.path}`);
    }
    const event = existingEvents[file.eventSeq - 1];
    if (!event || event.seq !== file.eventSeq || event.id !== parsed.eventId || event.body.kind !== "turn") {
      throw new Error(`Receipt sidecar does not name an existing turn event: ${file.path}`);
    }
    const payload = {
      eventId: parsed.eventId,
      eventSeq: parsed.eventSeq,
      receipt: parsed.receipt,
      previousReceiptHash: parsed.previousReceiptHash,
    };
    if (sha256(canonicalJson(payload)) !== parsed.receiptHash) throw new Error(`Receipt sidecar hash mismatch: ${file.path}`);
    previousReceiptHash = parsed.receiptHash;
  }

  const staged: Array<{ path: string; content: string; exclusive: true }> = [];
  const ordered = [...attachments].sort((left, right) => left.eventSeq - right.eventSeq);
  for (const attachment of ordered) {
    const event = createdEvents.find((candidate) => candidate.seq === attachment.eventSeq && candidate.id === attachment.eventId);
    if (!event || event.body.kind !== "turn" || !isStripReceipt(attachment.receipt)) throw new Error("Receipt attachment does not describe a newly signed turn");
    const strippedBytes = Buffer.byteLength(event.body.text, "utf8");
    if (attachment.receipt.strippedBytes !== strippedBytes || attachment.receipt.strippedSha256 !== sha256(Buffer.from(event.body.text, "utf8"))
      || attachment.receipt.originalBytes < strippedBytes) throw new Error("Receipt does not match the signed turn text");
    const payload = {
      eventId: event.id,
      eventSeq: event.seq,
      receipt: attachment.receipt,
      previousReceiptHash,
    };
    const record = { ...payload, receiptHash: sha256(canonicalJson(payload)) };
    staged.push({
      path: resolve(paths.room, `receipts.${event.seq}.jsonl`),
      content: `${JSON.stringify(record)}\n`,
      exclusive: true,
    });
    previousReceiptHash = record.receiptHash;
  }
  return staged;
}

async function verifyStagedCandidate(paths: RoomPaths, genesis: GenesisRegistry, events: SignedEvent[], seamsBytes: Buffer, snapshots: Map<number, Buffer>): Promise<VerificationResult> {
  return withTempRoom(paths, genesis, events, seamsBytes, snapshots, async (directory) => runRootVerifier(directory));
}

type LockedState = AppendContext;

async function appendCore(input: {
  roomId: string;
  home?: string;
  allowEmpty?: boolean;
  allowLatestSealRefresh?: boolean;
  preflight?: (state: LockedState) => void | Promise<void>;
  receiptAttachments?: (events: SignedEvent[]) => ReceiptAttachment[];
  build: (state: LockedState) => Promise<SignedEvent[]>;
}): Promise<SignedEvent[]> {
  const paths = roomPaths(input.roomId, input.home);
  await mkdir(paths.room, { recursive: true, mode: 0o700 });
  const lock = await acquireLock(paths.lock);
  let oldTranscript = Buffer.alloc(0);
  const staged: Array<{ path: string; before: Buffer | null }> = [];
  let candidateDigest = `${input.roomId}:${Date.now()}`;
  let appended = false;
  try {
    const data = await readRoom(input.roomId, input.home);
    oldTranscript = await readFile(paths.transcript);
    const originalSeamsBytes = await readFile(paths.seams);
    const originalSeams = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(originalSeamsBytes);
    if (data.events.length === 0 && !input.allowEmpty) throw new Error("Room has no signed system event");
    if (data.events.length > 0) {
      const policy = policyErrors(data.genesis, data.events);
      if (policy.length) throw new Error(`local replay check failed: ${policy.join("; ")}`);
      const existing = await verifyPriorState(data, input.allowLatestSealRefresh ?? false);
      if (!existing.ok) throw new Error(`root verifier rejected current room: ${reportMessage(existing)}`);
    }
    const seq = data.events.length + 1;
    const prevHash = data.events.at(-1)?.hash ?? "0".repeat(64);
    const initialContext: LockedState = {
      paths,
      genesis: data.genesis,
      priorEvents: data.events,
      events: data.events,
      seq,
      prevHash,
      seamsText: originalSeams,
      seamsBytes: originalSeamsBytes,
    };
    await input.preflight?.(initialContext);
    const created = await input.build(initialContext);
    if (created.length === 0) throw new Error("No signed event was built");
    candidateDigest = created.map((event) => canonicalJson(event.body)).join("\n");
    const allEvents = [...data.events, ...created];
    let seamsText = originalSeams;
    let seamsBytes = originalSeamsBytes;
    const snapshots = new Map<number, Buffer>();
    for (const event of created) {
      if (event.body.kind === "seam") {
        seamsText = appendSeamView(seamsText, event);
        seamsBytes = Buffer.from(seamsText, "utf8");
      }
      if (event.body.kind === "seal") snapshots.set(event.seq, Buffer.from(seamsBytes));
    }
    const policy = policyErrors(data.genesis, allEvents);
    if (policy.length) throw new Error(`local candidate check failed: ${policy.join("; ")}`);
    const bytes = Buffer.from(`${created.map((event) => JSON.stringify(event)).join("\n")}\n`, "utf8");
    if (bytes.byteLength > MAX_TRANSCRIPT_BYTES || oldTranscript.byteLength + bytes.byteLength > MAX_TRANSCRIPT_BYTES) throw new Error("Transcript size limit exceeded");
    for (const event of created) if (Buffer.byteLength(JSON.stringify(event), "utf8") > MAX_EVENT_BYTES) throw new Error(`Event ${event.id} exceeds the local event size limit`);
    const stagedSeams = seamsBytes.equals(originalSeamsBytes) ? [] : [{ path: paths.seams, content: seamsBytes, exclusive: false }];
    const stagedSnapshots = [...snapshots].map(([eventSeq, content]) => ({ path: paths.snapshot(eventSeq), content, exclusive: true }));
    const stagedPlan: Array<{ path: string; content: string | Buffer; exclusive: boolean }> = [...stagedSeams, ...stagedSnapshots];
    const candidate = await verifyStagedCandidate(paths, data.genesis, allEvents, seamsBytes, snapshots);
    if (!candidate.ok) throw new Error(`root verifier rejected candidate: ${reportMessage(candidate)}`);
    if (input.receiptAttachments) {
      const attachments = input.receiptAttachments(created);
      if (attachments.length === 0) throw new Error("Turn admission did not produce a receipt attachment");
      stagedPlan.push(...await prepareReceiptSidecars(paths, data.events, created, attachments));
    }
    try {
      for (const item of stagedPlan) staged.push(await stageFile(item.path, item.content, item.exclusive));
      const appendHandle = await open(paths.transcript, "a");
      try {
        if (oldTranscript.length > 0 && oldTranscript.at(-1) !== 0x0a) await appendHandle.writeFile("\n");
        await appendHandle.writeFile(bytes);
        await appendHandle.sync();
      } finally {
        await appendHandle.close();
      }
      appended = true;
    } catch (error) {
      await restoreFiles(staged);
      throw error;
    }
    const postWrite = runRootVerifier(paths.room);
    if (!postWrite.ok) {
      await writeFile(paths.transcript, oldTranscript);
      await restoreFiles(staged);
      appended = false;
      throw new Error(`post-write root verification failed: ${reportMessage(postWrite)}`);
    }
    try {
      await refreshTranscript(paths, data.genesis, allEvents);
    } catch (error) {
      console.error(`ALERT JASON: signed ledger is valid, but transcript.md refresh failed: ${error instanceof Error ? error.message : String(error)}`);
    }
    return created;
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    if (appended) {
      try {
        await writeFile(paths.transcript, oldTranscript);
        await restoreFiles(staged);
      } catch (rollbackError) {
        console.error(`ALERT JASON: append rollback failed: ${rollbackError instanceof Error ? rollbackError.message : String(rollbackError)}`);
      }
    }
    try {
      await recordQuarantine(paths, input.roomId, candidateDigest, reason);
    } catch (quarantineError) {
      console.error(`ALERT JASON: quarantine metadata could not be written: ${quarantineError instanceof Error ? quarantineError.message : String(quarantineError)}`);
    }
    console.error(`ALERT JASON: event admission rejected; accepted transcript unchanged: ${reason}`);
    throw error;
  } finally {
    try {
      await lock.close();
    } finally {
      await rm(paths.lock, { force: true });
    }
  }
}

function signEvent(entry: AppendEntry, context: AppendContext): SignedEvent {
  const identity = entry.identity;
  if (publicKeyFingerprint(identity.publicKey) !== identity.fingerprint) throw new Error("Signing identity fingerprint does not match its public key");
  const body = entry.body;
  if (typeof body === "function") throw new Error("Event body factory must be resolved before signing");
  const payload = {
    id: uuid7(),
    roomId: context.genesis.roomId,
    seq: context.seq,
    threadId: entry.threadId,
    author: identity.fingerprint,
    createdAt: new Date().toISOString(),
    body,
    prevHash: context.prevHash,
  };
  const canonical = Buffer.from(canonicalJson(payload), "utf8");
  return {
    ...payload,
    hash: sha256(canonical),
    signature: sign(null, canonical, identity.privateKey).toString("base64url"),
  };
}

export async function appendRoomEvents(input: RoomWriteOptions): Promise<SignedEvent[]> {
  return appendCore({
    roomId: input.roomId,
    home: input.home,
    allowEmpty: input.allowEmpty,
    allowLatestSealRefresh: input.allowLatestSealRefresh,
    preflight: input.preflight,
    receiptAttachments: input.receiptAttachments,
    build: async (state) => {
      const events: SignedEvent[] = [];
      let seamsText = state.seamsText;
      let seamsBytes = state.seamsBytes;
      for (const entry of input.entries) {
        const priorEvents = [...state.priorEvents, ...events];
        const context: AppendContext = {
          genesis: state.genesis,
          priorEvents,
          events: priorEvents,
          seq: priorEvents.length + 1,
          prevHash: priorEvents.at(-1)?.hash ?? "0".repeat(64),
          seamsText,
          seamsBytes,
          paths: state.paths,
        };
        const body = typeof entry.body === "function" ? await entry.body(context) : entry.body;
        const resolvedEntry: AppendEntry = { ...entry, body };
        const event = signEvent(resolvedEntry, context);
        events.push(event);
        if (body.kind === "seam") {
          seamsText = appendSeamView(seamsText, event);
          seamsBytes = Buffer.from(seamsText, "utf8");
        }
      }
      return events;
    },
  });
}

export async function appendRoomEvent(input: RoomWriteOptions): Promise<SignedEvent> {
  const [event] = await appendRoomEvents(input);
  if (!event) throw new Error("No event was appended");
  return event;
}

export async function appendIncomingEvents(input: { roomId: string; home?: string; events: SignedEvent[] }): Promise<SignedEvent[]> {
  return appendCore({
    roomId: input.roomId,
    home: input.home,
    allowLatestSealRefresh: input.events.some((event) => event.body.kind === "seal"),
    build: async (state) => {
      const expectedSeq = state.priorEvents.length + 1;
      const first = input.events[0];
      if (!first || first.seq !== expectedSeq || first.roomId !== input.roomId || first.prevHash !== (state.priorEvents.at(-1)?.hash ?? "0".repeat(64))) {
        throw new Error("Incoming event does not continue the accepted room chain");
      }
      return input.events;
    },
  });
}

export async function quarantineMalformedInput(roomId: string, raw: string, reason: string, home?: string): Promise<void> {
  const paths = roomPaths(roomId, home);
  await mkdir(paths.room, { recursive: true, mode: 0o700 });
  await recordQuarantine(paths, roomId, raw, reason);
  console.error(`ALERT JASON: malformed incoming data quarantined without payload: ${reason}`);
}

export function verificationErrors(result: VerificationResult): string[] {
  return result.ok ? [] : [reportMessage(result)];
}

export function roomMembers(data: RoomData, includeDeparted = false): MemberSpec[] {
  const { members, present } = memberMaps(data.genesis, data.events);
  return [...members.values()].filter((member) => includeDeparted || present.has(member.fingerprint));
}

export function resolveMember(data: RoomData, selector: string): MemberSpec {
  const matches = roomMembers(data).filter((member) => member.fingerprint === selector || member.name.toLowerCase() === selector.toLowerCase());
  if (matches.length === 0) throw new Error(`No present room member matches ${selector}`);
  if (matches.length > 1) throw new Error(`Member name ${selector} is ambiguous; use the fingerprint`);
  return matches[0]!;
}

export function findEvent(events: SignedEvent[], eventId: string): SignedEvent | undefined {
  return events.find((event) => event.id === eventId);
}

export function totalUsage(events: SignedEvent[], fingerprint: string): number {
  return events.filter((event) => event.author === fingerprint).reduce((total, event) => total + eventUsage(event), 0);
}
