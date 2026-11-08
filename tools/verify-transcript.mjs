import { createHash, createPublicKey, verify } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

const MAX_EVENT_BYTES = 65_536;
const MAX_TRANSCRIPT_BYTES = 52_428_800;
const MAX_TEXT_CHARS = 16_384;
const MAX_MEMBERS = 32;
const MAX_THREADS = 128;
const MAX_BUDGET_TOKENS = 1_000_000;
const MAX_TOKENS_PER_TURN = 32_768;
const MAX_TURNS_PER_SESSION = 128;
const MAX_RUN_MS = 120_000;
const memberIdPattern = /^[a-z0-9][a-z0-9-]{0,47}$/;
const threadIdPattern = /^[a-z0-9][a-z0-9-]{0,47}$/;
const hashPattern = /^[0-9a-f]{64}$/;

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function exactKeys(value, expected) {
  return Object.keys(value).length === expected.length && expected.every((key) => Object.hasOwn(value, key));
}

function canonical(value) {
  if (value === null || typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number" && Number.isFinite(value)) return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (isRecord(value)) return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
  throw new Error("Unsupported canonical value");
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function fingerprint(publicKey) {
  return `sha256:${sha256(createPublicKey(publicKey).export({ format: "der", type: "spki" }))}`;
}

function signatureValid(publicKey, bytes, signature) {
  try {
    return verify(null, bytes, createPublicKey(publicKey), Buffer.from(signature, "base64"));
  } catch {
    return false;
  }
}

function participantValid(member, knownThreads, expectedRole) {
  if (!isRecord(member) || !exactKeys(member, ["id", "name", "role", "modelId", "publicKey", "fingerprint", "subscriptions", "budgets", "limits"]) || !memberIdPattern.test(member.id ?? "")) return false;
  if ((member.role !== "human" && member.role !== "agent") || member.role !== expectedRole || typeof member.name !== "string" || !member.name.trim() || member.name.length > 120) return false;
  if (typeof member.modelId !== "string" || !member.modelId || member.modelId.length > 120) return false;
  if (typeof member.publicKey !== "string" || member.publicKey.length < 80 || member.publicKey.length > 2048) return false;
  if (typeof member.fingerprint !== "string" || !/^sha256:[0-9a-f]{64}$/.test(member.fingerprint)) return false;
  if (!Array.isArray(member.subscriptions) || !member.subscriptions.length || member.subscriptions.length > MAX_THREADS || !member.subscriptions.includes("main")) return false;
  if (new Set(member.subscriptions).size !== member.subscriptions.length || member.subscriptions.some((thread) => typeof thread !== "string" || !threadIdPattern.test(thread) || !knownThreads.has(thread))) return false;
  if (!isRecord(member.budgets) || Object.keys(member.budgets).length !== member.subscriptions.length || !isRecord(member.limits)) return false;
  for (const thread of member.subscriptions) {
    const budget = member.budgets[thread];
    if (!Number.isInteger(budget) || budget < 1 || budget > MAX_BUDGET_TOKENS || budget > member.limits.maxTokensPerThread) return false;
  }
  const limits = member.limits;
  return Number.isInteger(limits.maxTokensPerThread) && limits.maxTokensPerThread > 0 && limits.maxTokensPerThread <= MAX_BUDGET_TOKENS &&
    Number.isInteger(limits.maxTokensPerTurn) && limits.maxTokensPerTurn > 0 && limits.maxTokensPerTurn <= MAX_TOKENS_PER_TURN &&
    Number.isInteger(limits.maxTurnsPerSession) && limits.maxTurnsPerSession > 0 && limits.maxTurnsPerSession <= MAX_TURNS_PER_SESSION &&
    Number.isInteger(limits.maxRunMs) && limits.maxRunMs > 0 && limits.maxRunMs <= MAX_RUN_MS;
}

function eventBody(event) {
  return {
    schemaVersion: event.schemaVersion,
    seq: event.seq,
    roomId: event.roomId,
    threadId: event.threadId,
    kind: event.kind,
    authorId: event.authorId,
    occurredAt: event.occurredAt,
    previousHash: event.previousHash,
    usageTokens: event.usageTokens,
    usageCharges: event.usageCharges,
    payload: event.payload,
  };
}

function eventValid(event) {
  return isRecord(event) && exactKeys(event, ["schemaVersion", "seq", "roomId", "threadId", "kind", "authorId", "occurredAt", "previousHash", "usageTokens", "usageCharges", "payload", "eventId", "hash", "signature"]) && isRecord(event.payload) && event.schemaVersion === 1 && Number.isInteger(event.seq) && event.seq > 0 &&
    typeof event.eventId === "string" && /^evt_[0-9]{6}_[0-9a-f]{24}$/.test(event.eventId) &&
    typeof event.roomId === "string" && memberIdPattern.test(event.roomId) && typeof event.threadId === "string" && threadIdPattern.test(event.threadId) &&
    typeof event.authorId === "string" && memberIdPattern.test(event.authorId) &&
    ["turn", "task_assigned", "member_added", "thread_open", "subscription_change", "challenge", "verdict", "seam", "exit_request", "exit_decision", "exit_release"].includes(event.kind) &&
    typeof event.occurredAt === "string" && Number.isFinite(Date.parse(event.occurredAt)) && typeof event.previousHash === "string" && hashPattern.test(event.previousHash) &&
    Number.isInteger(event.usageTokens) && event.usageTokens >= 0 && event.usageTokens <= MAX_TOKENS_PER_TURN && Array.isArray(event.usageCharges) && event.usageCharges.length <= 16 &&
    event.usageCharges.every((charge) => isRecord(charge) && exactKeys(charge, ["memberId", "tokens"]) && typeof charge.memberId === "string" && memberIdPattern.test(charge.memberId) && Number.isInteger(charge.tokens) && charge.tokens > 0 && charge.tokens <= MAX_TOKENS_PER_TURN) &&
    typeof event.hash === "string" && hashPattern.test(event.hash) && typeof event.signature === "string" && event.signature.length >= 80 && event.signature.length <= 256;
}

function genesisPolicy(genesis, roomId) {
  const payload = genesis?.payload;
  if (!isRecord(payload) || !exactKeys(genesis, ["payload", "hash", "signedBy", "signature"]) || !exactKeys(payload, ["schemaVersion", "roomId", "createdAt", "ownerId", "topic", "participants"]) || payload.schemaVersion !== 1 || payload.roomId !== roomId || !memberIdPattern.test(roomId)) return false;
  if (typeof payload.topic !== "string" || payload.topic.trim().length < 1 || payload.topic.length > 240 || typeof payload.createdAt !== "string" || !Number.isFinite(Date.parse(payload.createdAt)) || genesis.signedBy !== payload.ownerId) return false;
  if (!Array.isArray(payload.participants) || payload.participants.length < 2 || payload.participants.length > MAX_MEMBERS) return false;
  const threads = new Set(["main"]);
  const ids = new Set();
  let humanCount = 0;
  for (const member of payload.participants) {
    if (!participantValid(member, threads, member?.role)) return false;
    if (ids.has(member.id) || !member.subscriptions.includes("main")) return false;
    ids.add(member.id);
    if (member.role === "human") humanCount += 1;
  }
  return humanCount === 1 && payload.ownerId && ids.has(payload.ownerId) && payload.participants.find((member) => member.id === payload.ownerId)?.role === "human";
}

function verifyCryptography(genesis, events, roomId) {
  const errors = [];
  const members = new Map((genesis?.payload?.participants ?? []).filter((member) => member && typeof member.id === "string").map((member) => [member.id, member]));
  try {
    if (sha256(canonical(genesis.payload)) !== genesis.hash) errors.push("genesis hash mismatch");
    const owner = members.get(genesis.signedBy);
    if (!owner || !signatureValid(owner.publicKey, Buffer.from(genesis.hash, "hex"), genesis.signature)) errors.push("genesis owner signature invalid");
    for (const member of members.values()) if (fingerprint(member.publicKey) !== member.fingerprint) errors.push(`genesis key fingerprint mismatch for ${member.id}`);
  } catch (error) {
    errors.push(`genesis cryptographic check failed: ${error.message}`);
  }
  let previousHash = genesis?.hash;
  for (let index = 0; index < events.length; index += 1) {
    const event = events[index];
    const label = `event ${index + 1} (${event?.eventId ?? "unknown"})`;
    try {
      if (!eventValid(event)) {
        errors.push(`${label}: malformed event envelope`);
        continue;
      }
      if (event.roomId !== roomId || event.seq !== index + 1) errors.push(`${label}: room or sequence mismatch`);
      if (event.previousHash !== previousHash) errors.push(`${label}: previous hash mismatch`);
      if (sha256(canonical(eventBody(event))) !== event.hash) errors.push(`${label}: event hash mismatch`);
      if (event.eventId !== `evt_${String(event.seq).padStart(6, "0")}_${event.hash.slice(0, 24)}`) errors.push(`${label}: event id mismatch`);
      const author = members.get(event.authorId);
      if (!author || !signatureValid(author.publicKey, Buffer.from(event.hash, "hex"), event.signature)) errors.push(`${label}: signer is not an admitted member or signature is invalid`);
      if (event.kind === "member_added" && author) {
        const candidate = event.payload.participant;
        if (!isRecord(candidate) || typeof event.payload.proofOfPossession !== "string") errors.push(`${label}: member proof is missing`);
        else {
          if (!signatureValid(candidate.publicKey, Buffer.from(canonical({ roomId, participant: candidate }), "utf8"), event.payload.proofOfPossession)) errors.push(`${label}: candidate proof of possession invalid`);
          if (fingerprint(candidate.publicKey) !== candidate.fingerprint) errors.push(`${label}: candidate fingerprint mismatch`);
          if (members.has(candidate.id)) errors.push(`${label}: duplicate member identity`);
          else members.set(candidate.id, candidate);
        }
      }
      previousHash = event.hash;
    } catch (error) {
      errors.push(`${label}: cryptographic check failed: ${error.message}`);
    }
  }
  return errors;
}

function verifyPolicy(genesis, events, roomId) {
  const errors = [];
  if (!genesisPolicy(genesis, roomId)) errors.push("genesis schema or membership policy invalid");
  const members = new Map((genesis?.payload?.participants ?? []).map((member) => [member.id, structuredClone(member)]));
  const threads = new Set(["main"]);
  const used = new Map();
  const seen = new Map();
  const tasks = new Map();
  const completedTasks = new Set();
  const challenges = new Map();
  const resolved = new Set();
  const requests = new Map();
  const decisions = new Map();
  const releases = new Set();
  let previousHash = genesis?.hash;
  for (let index = 0; index < events.length; index += 1) {
    const event = events[index];
    const label = `event ${index + 1} (${event?.eventId ?? "unknown"})`;
    if (!eventValid(event)) {
      errors.push(`${label}: policy/schema check rejected event`);
      continue;
    }
    if (event.roomId !== roomId || event.seq !== index + 1 || event.previousHash !== previousHash) errors.push(`${label}: event does not continue expected room chain`);
    const author = members.get(event.authorId);
    if (!author) errors.push(`${label}: author is not admitted`);
    if (!threads.has(event.threadId) || !author?.subscriptions.includes(event.threadId)) errors.push(`${label}: author is not subscribed to an open thread`);
    const usageKey = (memberId, thread) => JSON.stringify([memberId, thread]);
    if (author) {
      const key = usageKey(author.id, event.threadId);
      const next = (used.get(key) ?? 0) + event.usageTokens;
      if (event.usageTokens > author.limits.maxTokensPerTurn || next > author.budgets[event.threadId]) errors.push(`${label}: author exceeded finite budget`);
      used.set(key, next);
    }
    if (event.kind !== "task_assigned" && event.usageCharges.length) errors.push(`${label}: unexpected token charges`);
    const chargeIds = new Set();
    for (const charge of event.usageCharges) {
      if (chargeIds.has(charge.memberId)) errors.push(`${label}: duplicate input-token charge`);
      chargeIds.add(charge.memberId);
      const recipient = members.get(charge.memberId);
      if (!recipient || !recipient.subscriptions.includes(event.threadId)) errors.push(`${label}: charge recipient lacks thread standing`);
      else {
        const key = usageKey(recipient.id, event.threadId);
        const next = (used.get(key) ?? 0) + charge.tokens;
        if (charge.tokens > recipient.limits.maxTokensPerTurn || next > recipient.budgets[event.threadId]) errors.push(`${label}: recipient exceeded finite budget`);
        used.set(key, next);
      }
    }
    switch (event.kind) {
      case "turn": {
        if (typeof event.payload.text !== "string" || !event.payload.text.trim() || event.payload.text.length > MAX_TEXT_CHARS || event.usageTokens < 1) errors.push(`${label}: turn text or output accounting invalid`);
        if (author?.role === "agent") {
          const taskId = event.payload.taskId;
          const task = typeof taskId === "string" ? tasks.get(taskId) : undefined;
          if (!task || task.recipientId !== author.id || task.threadId !== event.threadId || completedTasks.has(taskId)) errors.push(`${label}: agent turn has no eligible assigned task`);
          else {
            task.turnCount += 1;
            if (task.turnCount > author.limits.maxTurnsPerSession || (event.payload.final !== true && event.payload.final !== false)) errors.push(`${label}: agent turn/session limit invalid`);
            if (event.payload.final === true) completedTasks.add(taskId);
          }
        }
        break;
      }
      case "task_assigned": {
        const taskId = event.payload.taskId;
        const recipient = members.get(String(event.payload.recipientId));
        const prompt = event.payload.prompt;
        if (typeof taskId !== "string" || !taskId || tasks.has(taskId) || !recipient || recipient.role !== "agent" || recipient.id === event.authorId || !recipient.subscriptions.includes(event.threadId)) errors.push(`${label}: task assignment invalid`);
        if (!recipient || typeof prompt !== "string" || !prompt.trim() || prompt.length > MAX_TEXT_CHARS) errors.push(`${label}: task prompt invalid`);
        else {
          const expectedAuthorTokens = author?.role === "agent" ? Math.max(1, Math.ceil(Buffer.byteLength(prompt, "utf8") / 4)) : 0;
          const expectedInputTokens = Math.max(1, Math.ceil(Buffer.byteLength(prompt, "utf8") / 4));
          if (event.usageTokens !== expectedAuthorTokens || event.usageCharges.length !== 1 || event.usageCharges[0]?.memberId !== recipient.id || event.usageCharges[0]?.tokens !== expectedInputTokens) errors.push(`${label}: task token accounting invalid`);
          if (event.payload.maxTurns !== recipient.limits.maxTurnsPerSession || event.payload.maxRunMs !== recipient.limits.maxRunMs) errors.push(`${label}: task turn/runtime caps invalid`);
          if (typeof taskId === "string" && !tasks.has(taskId)) tasks.set(taskId, { recipientId: recipient.id, threadId: event.threadId, turnCount: 0 });
        }
        break;
      }
      case "thread_open": {
        const id = event.payload.newThreadId;
        const budget = event.payload.humanBudgetTokens;
        if (event.authorId !== genesis.payload.ownerId || typeof id !== "string" || !threadIdPattern.test(id) || threads.has(id) || threads.size >= MAX_THREADS || typeof event.payload.title !== "string" || !event.payload.title.trim() || event.payload.title.length > 160) errors.push(`${label}: thread open invalid`);
        const owner = members.get(genesis.payload.ownerId);
        if (!Number.isInteger(budget) || !owner || budget < 1 || budget > owner.limits.maxTokensPerThread) errors.push(`${label}: thread budget invalid`);
        else if (typeof id === "string" && !threads.has(id)) {
          threads.add(id);
          owner.subscriptions.push(id);
          owner.budgets[id] = budget;
        }
        break;
      }
      case "subscription_change": {
        const member = members.get(String(event.payload.memberId));
        const thread = event.payload.threadId;
        const budget = event.payload.budgetTokens;
        if (event.authorId !== genesis.payload.ownerId || !member || member.role !== "agent" || typeof thread !== "string" || !threads.has(thread) || member.subscriptions.includes(thread) || !Number.isInteger(budget) || budget < 1 || budget > member.limits.maxTokensPerThread) errors.push(`${label}: subscription change invalid`);
        else {
          member.subscriptions.push(thread);
          member.budgets[thread] = budget;
        }
        break;
      }
      case "member_added": {
        const candidate = event.payload.participant;
        if (event.authorId !== genesis.payload.ownerId || members.size >= MAX_MEMBERS || !participantValid(candidate, threads, "agent") || members.has(candidate.id)) errors.push(`${label}: member admission invalid`);
        else members.set(candidate.id, structuredClone(candidate));
        break;
      }
      case "challenge": {
        const target = seen.get(String(event.payload.targetEventId));
        if (typeof event.payload.claim !== "string" || !event.payload.claim.trim() || event.payload.claim.length > MAX_TEXT_CHARS || event.payload.evidenceRequired !== true || !target || target.kind !== "turn" || target.threadId !== event.threadId) errors.push(`${label}: challenge invalid`);        if (author && typeof event.payload.claim === "string" && event.usageTokens !== (author.role === "agent" ? Math.max(1, Math.ceil(Buffer.byteLength(event.payload.claim, "utf8") / 4)) : 0)) errors.push(`${label}: challenge token accounting invalid`);
        challenges.set(event.eventId, event);
        break;
      }
      case "verdict": {
        const challenge = challenges.get(String(event.payload.challengeEventId));
        const refs = event.payload.evidenceRefs;
        if (!challenge || resolved.has(challenge.eventId) || challenge.authorId === event.authorId || !["upheld", "refuted", "unproven"].includes(event.payload.verdict) || typeof event.payload.evidence !== "string" || !event.payload.evidence.trim() || event.payload.evidence.length > MAX_TEXT_CHARS || !Array.isArray(refs) || !refs.length || refs.length > 16 || refs.some((id) => !seen.has(String(id)) || seen.get(String(id)).kind !== "turn" || seen.get(String(id)).threadId !== event.threadId)) errors.push(`${label}: verdict/evidence invalid`);        if (author && typeof event.payload.evidence === "string" && event.usageTokens !== (author.role === "agent" ? Math.max(1, Math.ceil(Buffer.byteLength(event.payload.evidence, "utf8") / 4)) : 0)) errors.push(`${label}: verdict token accounting invalid`);
        if (challenge) resolved.add(challenge.eventId);
        break;
      }
      case "seam":
        if (event.authorId !== genesis.payload.ownerId || typeof event.payload.pivot !== "string" || !event.payload.pivot.trim() || event.payload.pivot.length > MAX_TEXT_CHARS) errors.push(`${label}: seam invalid`);
        break;
      case "exit_request": {
        const target = seen.get(String(event.payload.targetEventId));
        if (typeof event.payload.destination !== "string" || !event.payload.destination.trim() || event.payload.destination.length > 240 || !target || target.kind !== "turn" || target.threadId !== event.threadId) errors.push(`${label}: exit request invalid`);
        if (author && typeof event.payload.destination === "string" && event.usageTokens !== (author.role === "agent" ? Math.max(1, Math.ceil(Buffer.byteLength(event.payload.destination, "utf8") / 4)) : 0)) errors.push(`${label}: exit-request token accounting invalid`);
        requests.set(event.eventId, event);
        break;
      }
      case "exit_decision": {
        const requestId = String(event.payload.requestEventId);
        if (event.authorId !== genesis.payload.ownerId || !requests.has(requestId) || decisions.has(requestId) || !["accept", "send_back", "kill"].includes(event.payload.decision) || typeof event.payload.note !== "string" || event.payload.note.length > MAX_TEXT_CHARS || event.payload.reviewedHeadHash !== event.previousHash || typeof event.payload.reviewedHeadHash !== "string" || !hashPattern.test(event.payload.reviewedHeadHash)) errors.push(`${label}: exit decision invalid`);
        else decisions.set(requestId, event.payload.decision);
        break;
      }
      case "exit_release": {
        const requestId = String(event.payload.requestEventId);
        const request = requests.get(requestId);
        const target = request && seen.get(String(request.payload.targetEventId));
        if (event.authorId !== genesis.payload.ownerId || decisions.get(requestId) !== "accept" || releases.has(requestId) || !target || typeof target.payload.text !== "string" || event.payload.contentHash !== sha256(target.payload.text)) errors.push(`${label}: release not approved or content hash mismatch`);
        releases.add(requestId);
        break;
      }
    }
    seen.set(event.eventId, event);
    previousHash = event.hash;
  }
  return errors;
}

async function main() {
  const roomDirectory = resolve(process.argv[2] ?? "");
  if (!process.argv[2]) throw new Error("Usage: node tools/verify-transcript.mjs <room-directory>");
  const genesis = JSON.parse(await readFile(resolve(roomDirectory, "genesis.json"), "utf8"));
  const rawEvents = await readFile(resolve(roomDirectory, "transcript.jsonl"));
  if (rawEvents.byteLength > MAX_TRANSCRIPT_BYTES) throw new Error("Transcript exceeds 50 MiB");
  const text = rawEvents.toString("utf8");
  const lines = text.length ? text.split("\n") : [];
  if (lines.at(-1) === "") lines.pop();
  const events = lines.map((line, index) => {
    if (!line.trim() || Buffer.byteLength(line, "utf8") > MAX_EVENT_BYTES) throw new Error(`Invalid or oversized transcript row ${index + 1}`);
    return JSON.parse(line);
  });
  const roomId = genesis?.payload?.roomId ?? "unknown";
  const cryptoErrors = verifyCryptography(genesis, events, roomId);
  const policyErrors = verifyPolicy(genesis, events, roomId);
  const checks = [
    { name: "cryptographic", ok: cryptoErrors.length === 0, errors: cryptoErrors },
    { name: "policy", ok: policyErrors.length === 0, errors: policyErrors },
  ];
  const result = { ok: checks.every((check) => check.ok), roomId, eventCount: events.length, headHash: events.at(-1)?.hash ?? genesis.hash, checks };
  console.log(JSON.stringify(result));
  if (!result.ok) process.exitCode = 1;
}

main().catch((error) => {
  console.error(JSON.stringify({ ok: false, error: error instanceof Error ? error.message : String(error) }));
  process.exitCode = 1;
});
