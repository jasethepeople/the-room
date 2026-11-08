import { createHash, createPublicKey, verify as verifySignature } from "node:crypto";
import { closeSync, existsSync, openSync, readFileSync, readSync } from "node:fs";

type JsonObject = Record<string, any>;
type Rule = { id: string; minCosigns: number };
type Member = {
  name: string;
  role: "human" | "harness-agent";
  modelId: string;
  publicKey: string;
  fingerprint: string;
  subscriptions: string[];
  budgetTokens: number;
  tools: string[];
};
type Failure = { line?: number; seq?: number; id?: string; reason: string };

const KNOWN_KINDS = new Set([
  "system", "membership", "turn", "challenge", "verdict", "proposal",
  "cosign", "canon", "budget", "seam", "seal",
]);
const ZERO_HASH = "0".repeat(64);
const HASH_RE = /^[0-9a-f]{64}$/;
const THREAD_RE = /^[a-z0-9-]{1,64}$/;
const ROOM_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*-[0-9a-f]{8}$/;
const UUID7_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function isObject(value: unknown): value is JsonObject {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function exactKeys(value: JsonObject, required: string[], optional: string[] = []): boolean {
  const allowed = new Set([...required, ...optional]);
  const keys = Object.keys(value);
  return required.every((key) => Object.prototype.hasOwnProperty.call(value, key)) &&
    keys.every((key) => allowed.has(key));
}

function isString(value: unknown): value is string {
  return typeof value === "string";
}

function isHash(value: unknown): value is string {
  return typeof value === "string" && HASH_RE.test(value);
}

function isThreadId(value: unknown): value is string {
  return typeof value === "string" && THREAD_RE.test(value);
}

function isUuid7(value: unknown): value is string {
  return typeof value === "string" && UUID7_RE.test(value);
}

function isSafeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value);
}

function isNonNegativeInteger(value: unknown): value is number {
  return isSafeInteger(value) && value >= 0;
}

function isIso8601(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d+))?(Z|[+-]\d{2}:\d{2})$/.exec(value);
  if (!match) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = Number(match[6]);
  const zone = match[8];
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  if (month < 1 || month > 12 || day < 1 || day > days[month - 1]) return false;
  if (hour > 23 || minute > 59 || second > 59) return false;
  if (zone !== "Z") {
    const zoneHour = Number(zone.slice(1, 3));
    const zoneMinute = Number(zone.slice(4, 6));
    if (zoneHour > 23 || zoneMinute > 59) return false;
  }
  return Number.isFinite(Date.parse(value));
}

function validUnicode(value: string): boolean {
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(i + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return false;
      i++;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return false;
    }
  }
  return true;
}

function canonicalize(value: any): string {
  if (value === null) return "null";
  if (typeof value === "string") {
    if (!validUnicode(value)) throw new Error("invalid Unicode string");
    return JSON.stringify(value);
  }
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("non-finite number");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map((item) => canonicalize(item)).join(",")}]`;
  if (isObject(value)) {
    const keys = Object.keys(value).sort();
    for (const key of keys) {
      if (!validUnicode(key)) throw new Error("invalid Unicode object key");
    }
    return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalize(value[key])}`).join(",")}}`;
  }
  throw new Error("unsupported JSON value");
}

function duplicateJsonProperty(source: string): string | null {
  let index = 0;
  const skipWhitespace = (): void => {
    while (index < source.length && /[\u0009\u000a\u000d\u0020]/.test(source[index]!)) index++;
  };
  const parseStringToken = (): string => {
    const start = index++;
    while (index < source.length) {
      const current = source[index++]!;
      if (current.charCodeAt(0) === 92) {
        index++;
      } else if (current.charCodeAt(0) === 34) {
        return JSON.parse(source.slice(start, index)) as string;
      }
    }
    throw new Error("invalid JSON string");
  };
  let duplicate: string | null = null;
  const parseValue = (depth: number): void => {
    if (depth > 512) throw new Error("JSON nesting exceeds 512 levels");
    skipWhitespace();
    const current = source[index];
    if (current?.charCodeAt(0) === 34) {
      parseStringToken();
      return;
    }
    if (current === "{") {
      index++;
      skipWhitespace();
      if (source[index] === "}") {
        index++;
        return;
      }
      const keys = new Set<string>();
      while (index < source.length) {
        skipWhitespace();
        if (source[index]?.charCodeAt(0) !== 34) throw new Error("invalid JSON object key");
        const key = parseStringToken();
        if (keys.has(key)) duplicate ??= key;
        keys.add(key);
        skipWhitespace();
        if (source[index++] !== ":") throw new Error("invalid JSON object separator");
        parseValue(depth + 1);
        skipWhitespace();
        const separator = source[index++];
        if (separator === "}") return;
        if (separator !== ",") throw new Error("invalid JSON object delimiter");
      }
      throw new Error("unterminated JSON object");
    }
    if (current === "[") {
      index++;
      skipWhitespace();
      if (source[index] === "]") {
        index++;
        return;
      }
      while (index < source.length) {
        parseValue(depth + 1);
        skipWhitespace();
        const separator = source[index++];
        if (separator === "]") return;
        if (separator !== ",") throw new Error("invalid JSON array delimiter");
      }
      throw new Error("unterminated JSON array");
    }
    const start = index;
    while (index < source.length) {
      const code = source.charCodeAt(index);
      if (code === 9 || code === 10 || code === 13 || code === 32 || code === 44 || code === 93 || code === 125) break;
      index++;
    }
    if (index === start) throw new Error("invalid JSON value");
    JSON.parse(source.slice(start, index));
  };
  parseValue(0);
  skipWhitespace();
  if (index !== source.length) throw new Error("trailing JSON data");
  return duplicate;
}

function integerOnly(value: any): boolean {
  if (typeof value === "number") return Number.isSafeInteger(value);
  if (Array.isArray(value)) return value.every(integerOnly);
  if (isObject(value)) return Object.values(value).every(integerOnly);
  return true;
}

function decodeBase64Url(value: unknown): Buffer | null {
  if (typeof value !== "string" || value.length === 0 || !/^[A-Za-z0-9_-]+$/.test(value)) return null;
  try {
    const bytes = Buffer.from(value, "base64url");
    return bytes.length > 0 && bytes.toString("base64url") === value ? bytes : null;
  } catch {
    return null;
  }
}

function sha256(bytes: Uint8Array | string): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function keyFromMember(member: Member): { bytes: Buffer; key: ReturnType<typeof createPublicKey> } | null {
  const bytes = decodeBase64Url(member.publicKey);
  if (!bytes) return null;
  try {
    const key = createPublicKey({ key: bytes, format: "der", type: "spki" });
    if (key.asymmetricKeyType !== "ed25519") return null;
    return { bytes, key };
  } catch {
    return null;
  }
}

function validRule(value: unknown): value is Rule {
  return isObject(value) && exactKeys(value, ["id", "minCosigns"]) &&
    isString(value.id) && isNonNegativeInteger(value.minCosigns);
}

function validMember(value: unknown): value is Member {
  if (!isObject(value) || !exactKeys(value, [
    "name", "role", "modelId", "publicKey", "fingerprint", "subscriptions", "budgetTokens", "tools",
  ])) return false;
  return isString(value.name) &&
    (value.role === "human" || value.role === "harness-agent") &&
    isString(value.modelId) && typeof value.publicKey === "string" &&
    isHash(value.fingerprint) && Array.isArray(value.subscriptions) &&
    value.subscriptions.every(isThreadId) && isNonNegativeInteger(value.budgetTokens) &&
    Array.isArray(value.tools) && value.tools.every(isString);
}

function fingerprintMatches(member: Member): boolean {
  const bytes = decodeBase64Url(member.publicKey);
  return bytes !== null && sha256(bytes) === member.fingerprint;
}

function validateGenesis(value: unknown): { genesis?: JsonObject; error?: string; keys?: Map<string, { bytes: Buffer; key: ReturnType<typeof createPublicKey> }>; members?: Map<string, Member> } {
  if (!isObject(value) || !exactKeys(value, [
    "roomId", "roomName", "createdAt", "templateId", "templateVersion", "canonRule", "threads", "members",
  ])) return { error: "genesis structural mismatch" };
  if (!isString(value.roomId) || !ROOM_RE.test(value.roomId)) return { error: "genesis roomId format mismatch" };
  if (!isString(value.roomName) || !isIso8601(value.createdAt) || !isString(value.templateId) ||
      !isString(value.templateVersion) || !validRule(value.canonRule) || !Array.isArray(value.threads) ||
      !Array.isArray(value.members)) return { error: "genesis structural mismatch" };
  if (!integerOnly(value)) return { error: "genesis contains a non-integer number" };
  const threadIds = new Set<string>();
  for (const thread of value.threads) {
    if (!isObject(thread) || !exactKeys(thread, ["id", "title"]) || !isThreadId(thread.id) || !isString(thread.title)) {
      return { error: "genesis thread structural mismatch" };
    }
    if (threadIds.has(thread.id)) return { error: `duplicate genesis thread id ${thread.id}` };
    threadIds.add(thread.id);
  }
  const keys = new Map<string, { bytes: Buffer; key: ReturnType<typeof createPublicKey> }>();
  const members = new Map<string, Member>();
  for (const member of value.members) {
    if (!validMember(member)) return { error: "genesis member structural mismatch" };
    if (!fingerprintMatches(member)) return { error: `genesis member ${JSON.stringify(member.name)} fingerprint mismatch` };
    const resolved = keyFromMember(member);
    if (!resolved) return { error: `genesis member ${JSON.stringify(member.name)} has an invalid Ed25519 public key` };
    if (keys.has(member.fingerprint)) return { error: `duplicate genesis member fingerprint ${member.fingerprint}` };
    keys.set(member.fingerprint, resolved);
    members.set(member.fingerprint, member);
  }
  try {
    canonicalize(value);
  } catch {
    return { error: "genesis cannot be JCS-serialized" };
  }
  return { genesis: value, keys, members };
}

function evidenceRef(value: unknown): boolean {
  if (!isObject(value) || !isString(value.type)) return false;
  if (value.type === "event") return exactKeys(value, ["type", "id"]) && isUuid7(value.id);
  if (value.type === "external") {
    return exactKeys(value, ["type", "url", "sha256"], ["note"]) && isString(value.url) &&
      isHash(value.sha256) && (!Object.prototype.hasOwnProperty.call(value, "note") || isString(value.note));
  }
  return false;
}

function validBody(body: unknown): string | null {
  if (!isObject(body) || !isString(body.kind) || !KNOWN_KINDS.has(body.kind)) return "unknown or malformed body.kind";
  switch (body.kind) {
    case "system":
      return exactKeys(body, ["kind", "genesisSha256", "templateId", "templateVersion"]) &&
        isHash(body.genesisSha256) && isString(body.templateId) && isString(body.templateVersion)
        ? null : "system body structural mismatch";
    case "membership":
      return exactKeys(body, ["kind", "action", "member"]) &&
        (body.action === "join" || body.action === "leave") && validMember(body.member)
        ? null : "membership body structural mismatch";
    case "turn": {
      if (!exactKeys(body, ["kind", "text"], ["usage", "artifact"]) || !isString(body.text)) return "turn body structural mismatch";
      if (Object.prototype.hasOwnProperty.call(body, "usage")) {
        const usage = body.usage;
        if (!isObject(usage) || !exactKeys(usage, ["inputTokens", "outputTokens"]) ||
            !isNonNegativeInteger(usage.inputTokens) || !isNonNegativeInteger(usage.outputTokens)) return "turn usage structural mismatch";
      }
      if (Object.prototype.hasOwnProperty.call(body, "artifact")) {
        const artifact = body.artifact;
        if (!isObject(artifact) || !exactKeys(artifact, ["path", "sha256", "bytes"]) ||
            !isString(artifact.path) || !isHash(artifact.sha256) || !isNonNegativeInteger(artifact.bytes)) return "turn artifact structural mismatch";
      }
      return null;
    }
    case "challenge":
      return exactKeys(body, ["kind", "targetEventId", "claim", "grounds", "evidence"]) &&
        isUuid7(body.targetEventId) && isString(body.claim) &&
        ["factual", "procedural", "doctrinal"].includes(body.grounds) &&
        Array.isArray(body.evidence) && body.evidence.every(evidenceRef)
        ? null : "challenge body structural mismatch";
    case "verdict":
      return exactKeys(body, ["kind", "challengeId", "outcome", "evidence", "rationale"]) &&
        isUuid7(body.challengeId) && ["upheld", "refuted", "unproven"].includes(body.outcome) &&
        Array.isArray(body.evidence) && body.evidence.every(evidenceRef) && isString(body.rationale)
        ? null : "verdict body structural mismatch";
    case "proposal": {
      if (!exactKeys(body, ["kind", "statement", "appliesTo"], ["supersedes"]) || !isString(body.statement)) return "proposal body structural mismatch";
      const scopeValid = body.appliesTo === "room" ||
        (isObject(body.appliesTo) && exactKeys(body.appliesTo, ["thread"]) && isThreadId(body.appliesTo.thread));
      if (!scopeValid || (Object.prototype.hasOwnProperty.call(body, "supersedes") && !isUuid7(body.supersedes))) return "proposal body structural mismatch";
      return null;
    }
    case "cosign":
      return exactKeys(body, ["kind", "proposalId", "stance"]) && isUuid7(body.proposalId) &&
        ["support", "oppose"].includes(body.stance) ? null : "cosign body structural mismatch";
    case "canon":
      return exactKeys(body, ["kind", "action", "proposalId", "cosigns", "reason"], ["newRule"]) &&
        ["enact", "demote"].includes(body.action) && isUuid7(body.proposalId) &&
        Array.isArray(body.cosigns) && body.cosigns.every(isUuid7) && isString(body.reason) &&
        (!Object.prototype.hasOwnProperty.call(body, "newRule") || (body.action === "enact" && validRule(body.newRule)))
        ? null : "canon body structural mismatch";
    case "budget":
      return exactKeys(body, ["kind", "member", "state", "reason", "consumedTokens"], ["thread"]) &&
        isHash(body.member) && ["paused", "resumed"].includes(body.state) &&
        ["exhausted", "human", "rule"].includes(body.reason) && isNonNegativeInteger(body.consumedTokens) &&
        (!Object.prototype.hasOwnProperty.call(body, "thread") || isThreadId(body.thread))
        ? null : "budget body structural mismatch";
    case "seam":
      return exactKeys(body, ["kind", "note", "spans"]) && isString(body.note) && Array.isArray(body.spans) &&
        body.spans.every((span: unknown) => isObject(span) && exactKeys(span, ["fromEventId", "toEventId"]) &&
          isUuid7(span.fromEventId) && isUuid7(span.toEventId))
        ? null : "seam body structural mismatch";
    case "seal":
      return exactKeys(body, ["kind", "chainHead", "eventCount", "seamsSha256"]) && isHash(body.chainHead) &&
        isNonNegativeInteger(body.eventCount) && isHash(body.seamsSha256)
        ? null : "seal body structural mismatch";
    default:
      return "unknown body.kind";
  }
}

function eventStructure(event: unknown): string | null {
  if (!isObject(event) || !exactKeys(event, [
    "id", "roomId", "seq", "threadId", "author", "createdAt", "body", "prevHash", "hash", "signature",
  ])) return "envelope structural mismatch";
  if (!isUuid7(event.id)) return "id is not a UUID v7";
  if (!isString(event.roomId) || !ROOM_RE.test(event.roomId)) return "roomId format mismatch";
  if (!isSafeInteger(event.seq) || event.seq < 1) return "seq must be a positive integer";
  if (event.threadId !== null && !isThreadId(event.threadId)) return "threadId format mismatch";
  if (!isHash(event.author)) return "author fingerprint format mismatch";
  if (!isIso8601(event.createdAt)) return "createdAt is not a valid ISO-8601 timestamp";
  if (!isHash(event.prevHash) || !isHash(event.hash)) return "hash field format mismatch";
  if (typeof event.signature !== "string" || !decodeBase64Url(event.signature)) return "signature is not unpadded base64url";
  const bodyError = validBody(event.body);
  if (bodyError) return bodyError;
  if (!integerOnly(event.body)) return "body contains a non-integer number";
  if (["system", "seam", "seal"].includes(event.body.kind) && event.threadId !== null) return `${event.body.kind} event must be room-level`;
  try {
    canonicalize(event);
  } catch {
    return "event cannot be JCS-serialized";
  }
  return null;
}

function getPayloadCanonical(event: JsonObject): string {
  const payload: JsonObject = { ...event };
  delete payload.hash;
  delete payload.signature;
  return canonicalize(payload);
}

function readUtf8(path: string): string {
  const bytes = readFileSync(path);
  return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
}

class TranscriptInputError extends Error {
  readonly lineNumber: number;

  constructor(lineNumber: number, message: string) {
    super(message);
    this.lineNumber = lineNumber;
  }
}

function* readTranscriptLines(path: string): Generator<{ line: string; lineNumber: number }> {
  const descriptor = openSync(path, "r");
  const chunk = Buffer.allocUnsafe(64 * 1024);
  let pending = Buffer.alloc(0);
  let lineNumber = 0;
  const decode = (bytes: Buffer, number: number): string => {
    if (bytes.includes(0x0d)) throw new TranscriptInputError(number, "transcript.jsonl must use LF line endings");
    let line: string;
    try {
      line = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
    } catch {
      throw new TranscriptInputError(number, `line ${number} is not valid UTF-8`);
    }
    if (number === 1 && line.charCodeAt(0) === 0xfeff) throw new TranscriptInputError(number, "transcript.jsonl must not have a BOM");
    return line;
  };
  try {
    let bytesRead = 0;
    while ((bytesRead = readSync(descriptor, chunk, 0, chunk.length, null)) > 0) {
      pending = Buffer.concat([pending, chunk.subarray(0, bytesRead)]);
      let delimiter = pending.indexOf(0x0a);
      while (delimiter >= 0) {
        lineNumber++;
        const line = decode(pending.subarray(0, delimiter), lineNumber);
        pending = pending.subarray(delimiter + 1);
        yield { line, lineNumber };
        delimiter = pending.indexOf(0x0a);
      }
    }
    if (pending.length > 0) {
      lineNumber++;
      yield { line: decode(pending, lineNumber), lineNumber };
    }
  } finally {
    closeSync(descriptor);
  }
}

function filePath(directory: string, filename: string): string {
  const base = directory.replace(/[\\/]+$/, "");
  return `${base}/${filename}`;
}

function emitFailure(events: number, failure: Failure): never {
  process.stdout.write(`${JSON.stringify({ ok: false, events, firstFailure: failure })}\n`);
  process.exitCode = 1;
  throw new Error("VERIFIER_STOP");
}

function eventFailure(events: number, event: unknown, reason: string): never {
  const failure: Failure = { reason };
  if (isObject(event)) {
    if (isSafeInteger(event.seq)) failure.seq = event.seq;
    if (isString(event.id)) failure.id = event.id;
  }
  emitFailure(events, failure);
}

function main(): void {
  const directory = process.argv[2];
  if (!directory || process.argv.length !== 3) {
    emitFailure(0, { reason: "usage: node verify.ts <room-dir>" });
  }

  let genesisRaw: string;
  try {
    genesisRaw = readUtf8(filePath(directory, "genesis.json"));
  } catch {
    emitFailure(0, { reason: "cannot read genesis.json as UTF-8" });
  }

  let duplicateGenesisKey: string | null = null;
  try {
    duplicateGenesisKey = duplicateJsonProperty(genesisRaw!);
  } catch {}
  if (duplicateGenesisKey !== null) emitFailure(0, { reason: `genesis contains duplicate JSON property ${JSON.stringify(duplicateGenesisKey)}` });

  let genesisValue: unknown;
  try {
    genesisValue = JSON.parse(genesisRaw!);
  } catch {
    emitFailure(0, { reason: "genesis.json parse error" });
  }

  const validatedGenesis = validateGenesis(genesisValue!);
  if (validatedGenesis.error) emitFailure(0, { reason: validatedGenesis.error });
  const genesis = validatedGenesis.genesis!;
  const knownKeys = validatedGenesis.keys!;
  const knownMembers = validatedGenesis.members!;
  const present = new Set<string>(knownMembers.keys());
  let currentRule: Rule = { ...genesis.canonRule };
  let genesisSha: string;
  try {
    genesisSha = sha256(Buffer.from(canonicalize(genesis), "utf8"));
  } catch {
    emitFailure(0, { reason: "genesis cannot be JCS-serialized" });
  }

  const transcriptIterator = readTranscriptLines(filePath(directory, "transcript.jsonl"));
  const priorEvents = new Map<string, JsonObject>();
  const verdictChallengeIds = new Set<string>();
  const cosignedBy = new Set<string>();
  const seals: JsonObject[] = [];
  let previousSeq = 0;
  let previousHash = ZERO_HASH;
  let eventCount = 0;

  while (true) {
    let next: IteratorResult<{ line: string; lineNumber: number }>;
    try {
      next = transcriptIterator.next();
    } catch (error) {
      if (error instanceof TranscriptInputError) emitFailure(eventCount, { line: error.lineNumber, reason: error.message });
      emitFailure(eventCount, { reason: "cannot read transcript.jsonl" });
    }
    if (next.done) break;
    const { line, lineNumber } = next.value;
    if (line.length === 0) emitFailure(eventCount, { line: lineNumber, reason: "transcript.jsonl contains an empty line" });
    let duplicateEventKey: string | null = null;
    try {
      duplicateEventKey = duplicateJsonProperty(line);
    } catch {}
    if (duplicateEventKey !== null) emitFailure(eventCount, { line: lineNumber, reason: `line ${lineNumber} contains duplicate JSON property ${JSON.stringify(duplicateEventKey)}` });
    let event: unknown;
    try {
      event = JSON.parse(line);
    } catch {
      emitFailure(eventCount, { line: lineNumber, reason: `line ${lineNumber} parse error` });
    }
    const structuralError = eventStructure(event);
    if (structuralError) eventFailure(eventCount, event, structuralError);
    const current = event as JsonObject;

    if (eventCount === 0 && current.body.kind !== "system") eventFailure(eventCount, current, "first event must be system");
    if (eventCount > 0 && current.body.kind === "system") eventFailure(eventCount, current, "system event may appear only once");
    if (current.seq !== previousSeq + 1) eventFailure(eventCount, current, "seq is not the previous seq plus one");
    if (current.prevHash !== previousHash) eventFailure(eventCount, current, "prevHash mismatch");
    if (current.roomId !== genesis.roomId) eventFailure(eventCount, current, "roomId does not match genesis");

    let canonical: string;
    try {
      canonical = getPayloadCanonical(current);
    } catch {
      eventFailure(eventCount, current, "payload cannot be JCS-serialized");
    }
    const computedHash = sha256(Buffer.from(canonical!, "utf8"));
    if (current.hash !== computedHash) eventFailure(eventCount, current, "hash mismatch");

    let resolvedKey: { bytes: Buffer; key: ReturnType<typeof createPublicKey> } | undefined;
    if (current.body.kind === "membership" && current.body.action === "join") {
      const member = current.body.member as Member;
      if (!fingerprintMatches(member)) eventFailure(eventCount, current, "membership join fingerprint does not match its public key");
      if (member.fingerprint !== current.author) eventFailure(eventCount, current, "membership join author does not match member fingerprint");
      resolvedKey = keyFromMember(member) ?? undefined;
      if (!resolvedKey) eventFailure(eventCount, current, "membership join has an invalid Ed25519 public key");
    } else {
      resolvedKey = knownKeys.get(current.author);
      if (!resolvedKey) eventFailure(eventCount, current, "unknown author fingerprint");
    }

    let signatureBytes = decodeBase64Url(current.signature);
    let signatureValid = false;
    try {
      signatureValid = !!signatureBytes && verifySignature(null, Buffer.from(canonical!, "utf8"), resolvedKey!.key, signatureBytes);
    } catch {
      signatureValid = false;
    }
    if (!signatureValid) eventFailure(eventCount, current, "signature verification failed");

    const body = current.body;
    switch (body.kind) {
      case "system":
        if (body.genesisSha256 !== genesisSha) eventFailure(eventCount, current, "system genesisSha256 mismatch");
        if (body.templateId !== genesis.templateId || body.templateVersion !== genesis.templateVersion) {
          eventFailure(eventCount, current, "system template does not match genesis");
        }
        break;
      case "membership": {
        if (body.action === "join") {
          const member = body.member as Member;
          if (present.has(member.fingerprint)) eventFailure(eventCount, current, "membership join for a member already present");
          const oldKey = knownKeys.get(member.fingerprint);
          const newKey = resolvedKey!;
          if (oldKey && !oldKey.bytes.equals(newKey.bytes)) eventFailure(eventCount, current, "member public key changed without a new fingerprint");
          knownKeys.set(member.fingerprint, newKey);
          knownMembers.set(member.fingerprint, member);
          present.add(member.fingerprint);
        } else {
          const member = body.member as Member;
          if (!present.has(current.author)) eventFailure(eventCount, current, "membership leave author is not currently present");
          if (member.fingerprint !== current.author || !fingerprintMatches(member)) {
            eventFailure(eventCount, current, "membership leave member does not match its author fingerprint and key");
          }
          const knownKey = knownKeys.get(current.author);
          const leaveKey = keyFromMember(member);
          if (!knownKey || !leaveKey || !knownKey.bytes.equals(leaveKey.bytes)) {
            eventFailure(eventCount, current, "membership leave key does not match the member's resolved key");
          }
          present.delete(current.author);
        }
        break;
      }
      case "challenge":
        if (!priorEvents.has(body.targetEventId)) eventFailure(eventCount, current, "challenge target is not an earlier event");
        
        break;
      case "verdict": {
        const challenge = priorEvents.get(body.challengeId);
        if (!challenge || challenge.body.kind !== "challenge") eventFailure(eventCount, current, "verdict does not refer to an earlier challenge");
        if (verdictChallengeIds.has(body.challengeId)) eventFailure(eventCount, current, "challenge already has a verdict");
        verdictChallengeIds.add(body.challengeId);
        break;
      }
      case "proposal":
        if (Object.prototype.hasOwnProperty.call(body, "supersedes")) {
          const superseded = priorEvents.get(body.supersedes);
          if (!superseded || superseded.body.kind !== "proposal") eventFailure(eventCount, current, "supersedes does not refer to an earlier proposal");
        }
        break;
      case "cosign": {
        const proposal = priorEvents.get(body.proposalId);
        if (!proposal || proposal.body.kind !== "proposal") eventFailure(eventCount, current, "cosign does not refer to an earlier proposal");
        const key = `${body.proposalId}\u0000${current.author}`;
        if (cosignedBy.has(key)) eventFailure(eventCount, current, "author already cosigned this proposal");
        cosignedBy.add(key);
        break;
      }
      case "canon": {
        const proposal = priorEvents.get(body.proposalId);
        if (!proposal || proposal.body.kind !== "proposal") eventFailure(eventCount, current, "canon does not refer to an earlier proposal");
        const cited = new Set<string>();
        let supporting = 0;
        for (const cosignId of body.cosigns as string[]) {
          if (cited.has(cosignId)) continue;
          const cosignEvent = priorEvents.get(cosignId);
          if (!cosignEvent || cosignEvent.body.kind !== "cosign" || cosignEvent.body.proposalId !== body.proposalId) {
            eventFailure(eventCount, current, "canon cites a cosign that is not an earlier cosign of its proposal");
          }
          cited.add(cosignId);
          if (cosignEvent.body.stance === "support") supporting++;
        }
        if (supporting < currentRule.minCosigns) eventFailure(eventCount, current, "distinct supporting cosigns do not meet currentRule.minCosigns");
        if (Object.prototype.hasOwnProperty.call(body, "newRule")) currentRule = { ...body.newRule };
        break;
      }
      case "budget":
        if (!knownMembers.has(body.member)) eventFailure(eventCount, current, "budget member fingerprint is unknown");
        break;
      case "seam":
        if (knownMembers.get(current.author)?.role !== "human") eventFailure(eventCount, current, "seam author is not a resolved human");
        break;
      case "seal":
        if (knownMembers.get(current.author)?.role !== "human") eventFailure(eventCount, current, "seal author is not a resolved human");
        if (body.chainHead !== current.prevHash || body.eventCount !== current.seq - 1) {
          eventFailure(eventCount, current, "seal checkpoint does not match its chain prefix");
        }
        seals.push(current);
        break;
      case "turn":
        break;
    }

    if (priorEvents.has(current.id)) eventFailure(eventCount, current, "duplicate event id");
    priorEvents.set(current.id, current);
    previousSeq = current.seq;
    previousHash = current.hash;
    eventCount++;
  }

  if (eventCount === 0) emitFailure(0, { line: 1, reason: "transcript.jsonl contains no events" });

  const warnings: string[] = [];
  const seamsPath = filePath(directory, "seams.md");
  const hasCurrentSeams = existsSync(seamsPath);
  if (!hasCurrentSeams) {
    warnings.push("seams.md is missing");
    if (seals.length > 0) warnings.push("latest seal could not be checked against seams.md");
  }
  if (seals.length > 0 && hasCurrentSeams) {
    const latest = seals[seals.length - 1];
    let currentSeamsHash: string;
    try {
      currentSeamsHash = sha256(readFileSync(seamsPath));
    } catch {
      eventFailure(eventCount, latest, "cannot read seams.md for latest seal verification");
    }
    if (latest.body.seamsSha256 !== currentSeamsHash!) eventFailure(eventCount, latest, "latest seal seamsSha256 mismatch");
  }

  for (const seal of seals) {
    const snapshotPath = filePath(directory, `seams.${seal.seq}.md`);
    if (!existsSync(snapshotPath)) {
      warnings.push(`snapshot seams.${seal.seq}.md is missing for seal seq ${seal.seq}`);
      continue;
    }
    let snapshotHash: string;
    try {
      snapshotHash = sha256(readFileSync(snapshotPath));
    } catch {
      eventFailure(eventCount, seal, `cannot read seams.${seal.seq}.md for seal verification`);
    }
    if (seal.body.seamsSha256 !== snapshotHash!) eventFailure(eventCount, seal, `seal seamsSha256 mismatch for snapshot seams.${seal.seq}.md`);
  }

  process.stdout.write(`${JSON.stringify({ ok: true, events: eventCount, seals: seals.length, warnings })}\n`);
  process.exitCode = 0;
}

try {
  main();
} catch (error) {
  if (!(error instanceof Error) || error.message !== "VERIFIER_STOP") {
    process.stdout.write(`${JSON.stringify({ ok: false, events: 0, firstFailure: { reason: "verifier internal or filesystem failure" } })}\n`);
    process.exitCode = 1;
  }
}
