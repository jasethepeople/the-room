import { mkdir, open, readFile, rm } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { canonicalJson, newRoomId, sha256 } from "./canonical.ts";
import { createIdentity, loadIdentity } from "./identity.ts";
import { appendRoomEvent, appendRoomEvents, assertTurnPreflight, findEvent, readRoom, resolveMember, roomMembers, totalUsage, verifyRoom } from "./ledger.ts";
import { stripPaste } from "./strip.ts";
import type { StripReceipt } from "./strip.ts";
import { estimateTokens, MAX_BUDGET_TOKENS, MAX_MEMBERS, MAX_TEXT_CHARS, MAX_TOKENS_PER_TURN } from "./limits.ts";
import {
  OLLAMA_MEMBER_MODEL_ID,
  OllamaUnavailableError,
  generateOllamaDraft,
  probeOllamaModels,
  resolveOllamaSettings,
  selectOllamaModel,
} from "./ollama.ts";
import type { OllamaDraft } from "./ollama.ts";
import { roomHome, roomPaths } from "./paths.ts";
import type { CanonRule, EventId, EvidenceRef, GenesisRegistry, MemberSpec, RoomMemberState, RoomPaths, RoomTemplate, SignedEvent, VerificationResult } from "./types.ts";

const TEMPLATE_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "../template/default");
const EXIT_REQUEST_PREFIX = "[[room:exit-request:v1]] ";
const EXIT_DECISION_PREFIX = "[[room:exit-decision:v1]] ";

async function createFile(path: string, content: string): Promise<void> {
  const handle = await open(path, "wx", 0o600);
  try {
    await handle.writeFile(content, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function loadTemplate(): Promise<RoomTemplate> {
  const value = JSON.parse(await readFile(resolve(TEMPLATE_DIR, "template.json"), "utf8")) as RoomTemplate;
  if (!value || typeof value.id !== "string" || !value.id || typeof value.version !== "string" || !value.version) throw new Error("Default room template has invalid identity");
  if (!value.canonRule || typeof value.canonRule.id !== "string" || !value.canonRule.id || !Number.isSafeInteger(value.canonRule.minCosigns) || value.canonRule.minCosigns < 0) throw new Error("Default room template has an invalid typed canonRule");
  if (!Array.isArray(value.threads) || value.threads.length < 1 || !value.threads.some((thread) => thread.id === "main")) throw new Error("Default room template must declare main");
  if (!Array.isArray(value.memberSlots) || !value.memberSlots.some((member) => member.role === "human") || !value.memberSlots.some((member) => member.role === "harness-agent")) throw new Error("Default room template must declare one human and a fixture member");
  if (value.memberSlots.filter((member) => member.role === "human").length !== 1) throw new Error("Default room template must declare exactly one human");
  if (typeof value.headerSeed !== "string") throw new Error("Default room template headerSeed must be text");
  return value;
}

function validBudget(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 1 && value <= MAX_BUDGET_TOKENS;
}

function humanMember(genesis: GenesisRegistry): MemberSpec {
  const member = genesis.members.find((entry) => entry.role === "human");
  if (!member) throw new Error("Room has no human member");
  return member;
}

function exitRequest(text: string): { targetEventId: string; destination: string } | undefined {
  if (!text.startsWith(EXIT_REQUEST_PREFIX)) return undefined;
  try {
    const value = JSON.parse(text.slice(EXIT_REQUEST_PREFIX.length)) as unknown;
    if (typeof value === "object" && value !== null && !Array.isArray(value) &&
        typeof (value as Record<string, unknown>).targetEventId === "string" && typeof (value as Record<string, unknown>).destination === "string") {
      return value as { targetEventId: string; destination: string };
    }
  } catch {}
  return undefined;
}

function exitDecision(text: string): { requestEventId: string; decision: "accept" | "send_back" | "kill"; reviewedHeadHash: string; note: string } | undefined {
  if (!text.startsWith(EXIT_DECISION_PREFIX)) return undefined;
  try {
    const value = JSON.parse(text.slice(EXIT_DECISION_PREFIX.length)) as unknown;
    if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
    const record = value as Record<string, unknown>;
    if (typeof record.requestEventId !== "string" || !["accept", "send_back", "kill"].includes(String(record.decision)) ||
        typeof record.reviewedHeadHash !== "string" || typeof record.note !== "string") return undefined;
    return value as { requestEventId: string; decision: "accept" | "send_back" | "kill"; reviewedHeadHash: string; note: string };
  } catch {
    return undefined;
  }
}

export async function createRoom(input: {
  roomId: string;
  roomName: string;
  members?: number;
  home?: string;
}): Promise<{ roomId: string; paths: RoomPaths; genesis: GenesisRegistry; members: MemberSpec[]; verification: VerificationResult }> {
  if (typeof input.roomName !== "string" || input.roomName.trim().length < 1 || input.roomName.length > 240) throw new Error("Room name must be 1–240 characters");
  const template = await loadTemplate();
  const memberCount = input.members ?? template.memberSlots.length;
  if (!Number.isSafeInteger(memberCount) || memberCount < 2 || memberCount > MAX_MEMBERS) throw new Error(`Spawn member count must be 2–${MAX_MEMBERS}, including the human`);
  const roomId = newRoomId(input.roomId);
  const home = roomHome(input.home);
  const paths = roomPaths(roomId, home);
  const generatedKeys: string[] = [];
  let roomCreated = false;
  await mkdir(paths.home, { recursive: true, mode: 0o700 });
  await mkdir(paths.keys, { recursive: true, mode: 0o700 });
  await mkdir(paths.rooms, { recursive: true, mode: 0o700 });
  try {
    await mkdir(paths.room, { mode: 0o700 });
    roomCreated = true;
    const humanSlot = template.memberSlots.find((member) => member.role === "human")!;
    const fixtureSlots = template.memberSlots.filter((member) => member.role === "harness-agent");
    const slots = [humanSlot, ...Array.from({ length: memberCount - 1 }, (_, index) => fixtureSlots[index % fixtureSlots.length]!)];
    const members: MemberSpec[] = [];
    const identities = new Map<string, Awaited<ReturnType<typeof createIdentity>>>();
    for (let index = 0; index < slots.length; index += 1) {
      const slot = slots[index]!;
      const identity = await createIdentity(paths.keys, roomId);
      generatedKeys.push(identity.privateKeyPath);
      const repeated = index > 0 && slots.slice(1, index).some((prior) => prior.name === slot.name);
      const name = repeated ? `${slot.name} ${index + 1}` : slot.name;
      const modelId = slot.role === "human" ? slot.modelId ?? "human" : slot.modelId ?? `fixture:scripted-${index}`;
      if (slot.role === "harness-agent" && !modelId.startsWith("fixture:")) throw new Error("Fixture member modelId must use the fixture: namespace");
      const member: MemberSpec = {
        name,
        role: slot.role,
        modelId,
        publicKey: identity.publicKey,
        fingerprint: identity.fingerprint,
        subscriptions: [...slot.subscriptions],
        budgetTokens: slot.budgetTokens,
        tools: [...slot.tools],
      };
      if (!validBudget(member.budgetTokens)) throw new Error(`Template budget for ${member.name} is invalid`);
      members.push(member);
      identities.set(member.fingerprint, identity);
    }
    const genesis: GenesisRegistry = {
      roomId,
      roomName: input.roomName.trim(),
      createdAt: new Date().toISOString(),
      templateId: template.id,
      templateVersion: template.version,
      canonRule: template.canonRule,
      threads: template.threads,
      members,
    };
    const header = template.headerSeed.replaceAll("{{ROOM_NAME}}", genesis.roomName);
    const seams = await readFile(resolve(TEMPLATE_DIR, "seams.md"), "utf8");
    await createFile(paths.genesis, `${JSON.stringify(genesis, null, 2)}\n`);
    await createFile(paths.transcript, "");
    await createFile(paths.header, header);
    await createFile(paths.seams, seams);
    const owner = humanMember(genesis);
    const ownerIdentity = identities.get(owner.fingerprint)!;
    await appendRoomEvent({
      roomId,
      home,
      allowEmpty: true,
      entries: [{
        identity: ownerIdentity,
        threadId: null,
        body: {
          kind: "system",
          genesisSha256: sha256(Buffer.from(canonicalJson(genesis), "utf8")),
          templateId: genesis.templateId,
          templateVersion: genesis.templateVersion,
        },
      }],
    });
    const verification = await verifyRoom(roomId, home);
    if (!verification.ok) throw new Error(`New room failed root verification: ${verification.firstFailure?.reason ?? "unknown verifier failure"}`);
    return { roomId, paths, genesis, members, verification };
  } catch (error) {
    if (roomCreated) await rm(paths.room, { recursive: true, force: true });
    await Promise.all(generatedKeys.map((path) => rm(path, { force: true })));
    throw error;
  }
}

export async function addFixtureMember(input: {
  roomId: string;
  name: string;
  home?: string;
  budgetTokens?: number;
  subscriptions?: string[];
}): Promise<SignedEvent> {
  const data = await readRoom(input.roomId, input.home);
  const current = roomMembers(data, true);
  if (current.length >= MAX_MEMBERS) throw new Error(`Room has reached the ${MAX_MEMBERS}-member limit`);
  const budgetTokens = input.budgetTokens ?? 12_000;
  if (!validBudget(budgetTokens)) throw new Error(`Fixture budget must be 1–${MAX_BUDGET_TOKENS}`);
  const subscriptions = input.subscriptions ?? ["main"];
  if (subscriptions.length === 0 || new Set(subscriptions).size !== subscriptions.length || subscriptions.some((id) => !data.genesis.threads.some((thread) => thread.id === id))) throw new Error("Fixture subscriptions must name distinct genesis threads");
  const identity = await createIdentity(data.paths.keys, data.genesis.roomId);
  const member: MemberSpec = {
    name: input.name.trim(),
    role: "harness-agent",
    modelId: `fixture:scripted-${current.filter((entry) => entry.role === "harness-agent").length + 1}`,
    publicKey: identity.publicKey,
    fingerprint: identity.fingerprint,
    subscriptions,
    budgetTokens,
    tools: [],
  };
  try {
    return await appendRoomEvent({
      roomId: input.roomId,
      home: input.home,
      entries: [{ identity, threadId: null, body: { kind: "membership", action: "join", member } }],
    });
  } catch (error) {
    await rm(identity.privateKeyPath, { force: true });
    throw error;
  }
}

export async function addOllamaMember(input: {
  roomId: string;
  name: string;
  budgetTokens: number;
  home?: string;
  subscriptions?: string[];
}): Promise<SignedEvent> {
  const data = await readRoom(input.roomId, input.home);
  const current = roomMembers(data, true);
  if (current.length >= MAX_MEMBERS) throw new Error(`Room has reached the ${MAX_MEMBERS}-member limit`);
  if (current.some((member) => member.modelId === OLLAMA_MEMBER_MODEL_ID)) throw new Error("This room already has its one Ollama-backed member");
  if (typeof input.name !== "string" || !input.name.trim()) throw new Error("Ollama member name must not be empty");
  if (!validBudget(input.budgetTokens)) throw new Error(`Ollama member budget must be a safe integer from 1 to ${MAX_BUDGET_TOKENS}`);
  const subscriptions = input.subscriptions ?? ["main"];
  if (subscriptions.length === 0 || new Set(subscriptions).size !== subscriptions.length || subscriptions.some((id) => !data.genesis.threads.some((thread) => thread.id === id))) throw new Error("Ollama member subscriptions must name distinct genesis threads");
  const identity = await createIdentity(data.paths.keys, data.genesis.roomId);
  const member: MemberSpec = {
    name: input.name.trim(),
    role: "harness-agent",
    modelId: OLLAMA_MEMBER_MODEL_ID,
    publicKey: identity.publicKey,
    fingerprint: identity.fingerprint,
    subscriptions,
    budgetTokens: input.budgetTokens,
    tools: [],
  };
  try {
    return await appendRoomEvent({
      roomId: input.roomId,
      home: input.home,
      entries: [{ identity, threadId: null, body: { kind: "membership", action: "join", member } }],
    });
  } catch (error) {
    await rm(identity.privateKeyPath, { force: true });
    throw error;
  }
}

export async function leaveFixtureMember(input: { roomId: string; member: string; home?: string }): Promise<SignedEvent> {
  const data = await readRoom(input.roomId, input.home);
  const member = resolveMember(data, input.member);
  if (member.role !== "harness-agent") throw new Error("Only a harness-agent member can leave through this command");
  const identity = await loadIdentity(data.paths.keys, data.genesis.roomId, member);
  return appendRoomEvent({
    roomId: input.roomId,
    home: input.home,
    entries: [{ identity, threadId: null, body: { kind: "membership", action: "leave", member } }],
  });
}

export async function postTurn(input: {
  roomId: string;
  author: string;
  text: string;
  threadId?: string;
  inputTokens?: number;
  outputTokens?: number;
  home?: string;
}): Promise<SignedEvent> {
  if (typeof input.text !== "string" || !input.text.trim() || input.text.length > MAX_TEXT_CHARS) throw new Error(`Turn text must be 1–${MAX_TEXT_CHARS} characters`);
  for (const [name, value] of [["inputTokens", input.inputTokens ?? 0], ["outputTokens", input.outputTokens ?? estimateTokens(input.text)]] as const) {
    if (!Number.isSafeInteger(value) || value < 0 || value > MAX_TOKENS_PER_TURN) throw new Error(`${name} must be a non-negative safe integer up to ${MAX_TOKENS_PER_TURN}`);
  }
  const data = await readRoom(input.roomId, input.home);
  const member = resolveMember(data, input.author);
  const identity = await loadIdentity(data.paths.keys, data.genesis.roomId, member);
  const threadId = input.threadId ?? "main";
  const inputTokens = input.inputTokens ?? 0;
  const outputTokens = input.outputTokens ?? estimateTokens(input.text);
  let receipt: StripReceipt | undefined;
  return appendRoomEvent({
    roomId: input.roomId,
    home: input.home,
    preflight: (state) => assertTurnPreflight(state, {
      author: identity.fingerprint,
      threadId,
      text: input.text,
      inputTokens,
      outputTokens,
    }),
    receiptAttachments: (events) => {
      const event = events[0];
      if (!event || !receipt) throw new Error("Turn admission did not produce a strip receipt");
      return [{ eventId: event.id, eventSeq: event.seq, receipt }];
    },
    entries: [{
      identity,
      threadId,
      body: () => {
        const stripped = stripPaste(input.text);
        receipt = stripped.receipt;
        return {
          kind: "turn",
          text: stripped.text,
          usage: { inputTokens, outputTokens },
        };
      },
    }],
  });
}

export async function assignTask(input: {
  roomId: string;
  author: string;
  recipient: string;
  prompt: string;
  threadId?: string;
  home?: string;
}): Promise<SignedEvent> {
  const data = await readRoom(input.roomId, input.home);
  const recipient = resolveMember(data, input.recipient);
  if (recipient.role !== "harness-agent") throw new Error("Assignments can target harness-agent members only");
  const text = `Assignment for ${recipient.name} (${recipient.fingerprint}):\n\n${input.prompt}`;
  return postTurn({ roomId: input.roomId, author: input.author, text, threadId: input.threadId, inputTokens: estimateTokens(input.prompt), outputTokens: 0, home: input.home });
}

function memberBudgetPaused(events: SignedEvent[], member: string, threadId: string): boolean {
  const states = new Map<string, boolean>();
  for (const event of events) {
    if (event.body.kind === "budget" && event.body.member === member) {
      states.set(`${member}:${event.body.thread ?? "*"}`, event.body.state === "paused");
    }
  }
  return states.get(`${member}:*`) === true || states.get(`${member}:${threadId}`) === true;
}

export async function runAssignedTask(input: {
  roomId: string;
  member: string;
  assignmentEventId: EventId;
  home?: string;
  ollamaHost?: string;
  model?: string;
}): Promise<{ status: "admitted"; model: string; assignmentEventId: EventId; event: SignedEvent } | { status: "not-available"; reason: string }> {
  const initial = await readRoom(input.roomId, input.home);
  const verification = await verifyRoom(input.roomId, input.home);
  if (!verification.ok) throw new Error(`Live member stopped: room verification failed: ${verification.firstFailure?.reason ?? "unknown verifier failure"}`);
  const data = await readRoom(input.roomId, input.home);
  if (data.events.length !== verification.events || initial.events.length !== verification.events
    || data.events.at(-1)?.hash !== initial.events.at(-1)?.hash) {
    throw new Error("Live member stopped: room changed during preflight verification");
  }
  const member = resolveMember(data, input.member);
  const liveMembers = roomMembers(data, true).filter((candidate) => candidate.modelId === OLLAMA_MEMBER_MODEL_ID);
  if (liveMembers.length !== 1 || liveMembers[0]?.fingerprint !== member.fingerprint || member.role !== "harness-agent") {
    throw new Error("The selected member is not the room's one Ollama-backed harness member");
  }
  const assignment = findEvent(data.events, input.assignmentEventId);
  if (!assignment || assignment.body.kind !== "turn" || assignment.threadId === null) throw new Error("Assignment must identify an existing threaded turn");
  const assignmentAuthor = roomMembers(data, true).find((candidate) => candidate.fingerprint === assignment.author);
  const presentMembers = new Set(roomMembers(data).map((candidate) => candidate.fingerprint));
  if (!assignmentAuthor || assignmentAuthor.role !== "human" || !presentMembers.has(assignment.author)) throw new Error("Assignment must be authored by a present human member");
  if (!member.subscriptions.includes(assignment.threadId)) throw new Error("Ollama member is not subscribed to the assignment thread");
  const prefix = `Assignment for ${member.name} (${member.fingerprint}):\n\n`;
  if (!assignment.body.text.startsWith(prefix)) throw new Error("Selected turn is not an assignment for this Ollama member");
  const prompt = assignment.body.text.slice(prefix.length);
  if (!prompt.trim()) throw new Error("Assignment prompt must not be empty");
  if (memberBudgetPaused(data.events, member.fingerprint, assignment.threadId)) throw new Error("Live member stopped: its assignment-thread budget is paused");
  const remainingTokens = member.budgetTokens - totalUsage(data.events, member.fingerprint);
  const estimatedInputTokens = estimateTokens(prompt);
  const maxOutputTokens = Math.min(MAX_TOKENS_PER_TURN - estimatedInputTokens, remainingTokens - estimatedInputTokens);
  if (!Number.isSafeInteger(remainingTokens) || maxOutputTokens < 1) throw new Error("Live member stopped: its assigned token budget has no remaining capacity for this turn");

  const settings = resolveOllamaSettings({ host: input.ollamaHost, model: input.model });
  let model: string;
  try {
    const models = await probeOllamaModels(settings.host);
    model = selectOllamaModel(models, settings.model);
  } catch (error) {
    if (error instanceof OllamaUnavailableError) return { status: "not-available", reason: error.message };
    throw error;
  }

  let draft: OllamaDraft;
  try {
    draft = await generateOllamaDraft({
      host: settings.host,
      model,
      prompt,
      maxOutputTokens,
    });
  } catch (error) {
    if (error instanceof OllamaUnavailableError) return { status: "not-available", reason: error.message };
    throw error;
  }
  const measuredUsage = draft.usage.inputTokens + draft.usage.outputTokens;
  if (!Number.isSafeInteger(measuredUsage) || measuredUsage > remainingTokens || measuredUsage > MAX_TOKENS_PER_TURN) {
    throw new Error("Live member stopped: measured Ollama usage exceeds its assigned token budget; draft was not admitted");
  }
  const event = await postTurn({
    roomId: input.roomId,
    author: member.fingerprint,
    text: draft.text,
    threadId: assignment.threadId,
    inputTokens: draft.usage.inputTokens,
    outputTokens: draft.usage.outputTokens,
    home: input.home,
  });
  return { status: "admitted", model, assignmentEventId: assignment.id, event };
}

export async function challengeTurn(input: {
  roomId: string;
  author: string;
  targetEventId: EventId;
  claim: string;
  grounds?: "factual" | "procedural" | "doctrinal";
  evidence?: EvidenceRef[];
  threadId?: string;
  home?: string;
}): Promise<SignedEvent> {
  const data = await readRoom(input.roomId, input.home);
  const member = resolveMember(data, input.author);
  const identity = await loadIdentity(data.paths.keys, data.genesis.roomId, member);
  const target = findEvent(data.events, input.targetEventId);
  const threadId = input.threadId ?? target?.threadId ?? "main";
  return appendRoomEvent({
    roomId: input.roomId,
    home: input.home,
    entries: [{
      identity,
      threadId,
      body: {
        kind: "challenge",
        targetEventId: input.targetEventId,
        claim: input.claim,
        grounds: input.grounds ?? "factual",
        evidence: input.evidence ?? [],
      },
    }],
  });
}

export async function resolveChallenge(input: {
  roomId: string;
  author: string;
  challengeId: EventId;
  outcome: "upheld" | "refuted" | "unproven";
  rationale: string;
  evidence?: EvidenceRef[];
  home?: string;
}): Promise<SignedEvent> {
  const data = await readRoom(input.roomId, input.home);
  const challenge = findEvent(data.events, input.challengeId);
  if (!challenge || challenge.body.kind !== "challenge") throw new Error("Verdict must cite an earlier challenge");
  if (data.events.some((event) => event.body.kind === "verdict" && event.body.challengeId === input.challengeId)) throw new Error("This challenge already has its one permitted verdict");
  const member = resolveMember(data, input.author);
  const identity = await loadIdentity(data.paths.keys, data.genesis.roomId, member);
  return appendRoomEvent({
    roomId: input.roomId,
    home: input.home,
    entries: [{
      identity,
      threadId: challenge.threadId,
      body: {
        kind: "verdict",
        challengeId: input.challengeId,
        outcome: input.outcome,
        evidence: input.evidence ?? [],
        rationale: input.rationale,
      },
    }],
  });
}

export async function propose(input: {
  roomId: string;
  author: string;
  statement: string;
  appliesTo?: "room" | { thread: string };
  supersedes?: EventId;
  home?: string;
}): Promise<SignedEvent> {
  const data = await readRoom(input.roomId, input.home);
  if (input.supersedes && data.events.find((event) => event.id === input.supersedes)?.body.kind !== "proposal") throw new Error("A superseding proposal must cite an earlier proposal event");
  const member = resolveMember(data, input.author);
  const identity = await loadIdentity(data.paths.keys, data.genesis.roomId, member);
  const body = {
    kind: "proposal" as const,
    statement: input.statement,
    appliesTo: input.appliesTo ?? "room" as const,
    ...(input.supersedes ? { supersedes: input.supersedes } : {}),
  };
  return appendRoomEvent({ roomId: input.roomId, home: input.home, entries: [{ identity, threadId: "main", body }] });
}

export async function cosign(input: {
  roomId: string;
  author: string;
  proposalId: EventId;
  stance: "support" | "oppose";
  home?: string;
}): Promise<SignedEvent> {
  const data = await readRoom(input.roomId, input.home);
  if (findEvent(data.events, input.proposalId)?.body.kind !== "proposal") throw new Error("Cosign must cite an earlier proposal event");
  const member = resolveMember(data, input.author);
  if (data.events.some((event) => event.body.kind === "cosign" && event.body.proposalId === input.proposalId && event.author === member.fingerprint)) throw new Error("A member may cosign a proposal only once");
  const identity = await loadIdentity(data.paths.keys, data.genesis.roomId, member);
  return appendRoomEvent({
    roomId: input.roomId,
    home: input.home,
    entries: [{ identity, threadId: "main", body: { kind: "cosign", proposalId: input.proposalId, stance: input.stance } }],
  });
}

export async function enactCanon(input: {
  roomId: string;
  proposalId: EventId;
  cosigns: EventId[];
  reason: string;
  newRule?: CanonRule;
  action?: "enact" | "demote";
  home?: string;
}): Promise<SignedEvent> {
  const data = await readRoom(input.roomId, input.home);
  const human = humanMember(data.genesis);
  const identity = await loadIdentity(data.paths.keys, data.genesis.roomId, human);
  const body = {
    kind: "canon" as const,
    action: input.action ?? "enact" as const,
    proposalId: input.proposalId,
    cosigns: input.cosigns,
    reason: input.reason,
    ...(input.newRule ? { newRule: input.newRule } : {}),
  };
  return appendRoomEvent({ roomId: input.roomId, home: input.home, entries: [{ identity, threadId: "main", body }] });
}

export async function setBudgetState(input: {
  roomId: string;
  member: string;
  state: "paused" | "resumed";
  reason: "exhausted" | "human" | "rule";
  threadId?: string;
  home?: string;
}): Promise<SignedEvent> {
  const data = await readRoom(input.roomId, input.home);
  const target = resolveMember(data, input.member);
  const human = humanMember(data.genesis);
  const identity = await loadIdentity(data.paths.keys, data.genesis.roomId, human);
  return appendRoomEvent({
    roomId: input.roomId,
    home: input.home,
    entries: [{
      identity,
      threadId: input.threadId ?? null,
      body: (context) => ({
        kind: "budget",
        member: target.fingerprint,
        ...(input.threadId ? { thread: input.threadId } : {}),
        state: input.state,
        reason: input.reason,
        consumedTokens: totalUsage(context.priorEvents, target.fingerprint),
      }),
    }],
  });
}

export async function markSeam(input: {
  roomId: string;
  note: string;
  spans?: { fromEventId: EventId; toEventId: EventId }[];
  home?: string;
}): Promise<{ seam: SignedEvent; seal: SignedEvent }> {
  const data = await readRoom(input.roomId, input.home);
  const human = humanMember(data.genesis);
  const identity = await loadIdentity(data.paths.keys, data.genesis.roomId, human);
  const events = await appendRoomEvents({
    roomId: input.roomId,
    home: input.home,
    allowLatestSealRefresh: true,
    entries: [
      { identity, threadId: null, body: { kind: "seam", note: input.note, spans: input.spans ?? [] } },
      {
        identity,
        threadId: null,
        body: (context) => ({
          kind: "seal",
          chainHead: context.prevHash,
          eventCount: context.priorEvents.length,
          seamsSha256: sha256(context.seamsBytes),
        }),
      },
    ],
  });
  const seam = events[0];
  const seal = events[1];
  if (!seam || !seal) throw new Error("Seam checkpoint did not append both events");
  return { seam, seal };
}

export async function writeSeal(input: { roomId: string; home?: string }): Promise<SignedEvent> {
  const data = await readRoom(input.roomId, input.home);
  const human = humanMember(data.genesis);
  const identity = await loadIdentity(data.paths.keys, data.genesis.roomId, human);
  return appendRoomEvent({
    roomId: input.roomId,
    home: input.home,
    allowLatestSealRefresh: true,
    entries: [{
      identity,
      threadId: null,
      body: (context) => ({
        kind: "seal",
        chainHead: context.prevHash,
        eventCount: context.priorEvents.length,
        seamsSha256: sha256(context.seamsBytes),
      }),
    }],
  });
}

export async function getMembers(roomId: string, home?: string): Promise<MemberSpec[]> {
  const data = await readRoom(roomId, home);
  return roomMembers(data);
}

export async function getMemberStates(roomId: string, home?: string): Promise<RoomMemberState[]> {
  const data = await readRoom(roomId, home);
  const present = new Set(roomMembers(data).map((member) => member.fingerprint));
  const states = new Map<string, boolean>();
  for (const event of data.events) {
    if (event.body.kind === "budget") states.set(`${event.body.member}:${event.body.thread ?? "*"}`, event.body.state === "paused");
  }
  return roomMembers(data, true).map((member) => ({
    member,
    present: present.has(member.fingerprint),
    consumedTokens: totalUsage(data.events, member.fingerprint),
    paused: states.get(`${member.fingerprint}:*`) === true || [...states].some(([key, value]) => value && key.startsWith(`${member.fingerprint}:`)),
  }));
}

export function defaultRoomHome(explicit?: string): string {
  return roomHome(explicit);
}

export async function requestExit(input: {
  roomId: string;
  author: string;
  targetEventId: EventId;
  destination: string;
  home?: string;
}): Promise<SignedEvent> {
  const data = await readRoom(input.roomId, input.home);
  const target = findEvent(data.events, input.targetEventId);
  if (!target || target.body.kind !== "turn") throw new Error("Exit target must be an earlier signed turn");
  const member = resolveMember(data, input.author);
  if (target.author !== member.fingerprint) throw new Error("A fixture may request release only for its own signed turn");
  const identity = await loadIdentity(data.paths.keys, data.genesis.roomId, member);
  const text = `${EXIT_REQUEST_PREFIX}${JSON.stringify({ targetEventId: input.targetEventId, destination: input.destination })}`;
  return appendRoomEvent({
    roomId: input.roomId,
    home: input.home,
    entries: [{ identity, threadId: target.threadId, body: { kind: "turn", text, usage: { inputTokens: 0, outputTokens: 0 } } }],
  });
}

export async function previewExit(roomId: string, requestEventId: EventId, home?: string): Promise<{
  roomId: string;
  requestEventId: string;
  destination: string;
  targetEventId: EventId;
  output: string;
  reviewedHeadHash: string;
  chain: Array<Pick<SignedEvent, "seq" | "id" | "hash" | "author" | "threadId"> & { kind: EventBodyKind }>;
}> {
  const verification = await verifyRoom(roomId, home);
  if (!verification.ok) throw new Error(`ALERT JASON: exit preview withheld; root verifier rejected room: ${verification.firstFailure?.reason ?? "unknown"}`);
  const data = await readRoom(roomId, home);
  const request = findEvent(data.events, requestEventId);
  const requestBody = request?.body.kind === "turn" ? exitRequest(request.body.text) : undefined;
  if (!request || !requestBody) throw new Error("Signed exit-request turn not found in verified room history");
  const target = findEvent(data.events, requestBody.targetEventId);
  if (!target || target.body.kind !== "turn" || target.author !== request.author) throw new Error("Exit target is not the requesting fixture's earlier signed turn");
  const head = data.events.at(-1)?.hash ?? "0".repeat(64);
  return {
    roomId,
    requestEventId,
    destination: requestBody.destination,
    targetEventId: target.id,
    output: target.body.text,
    reviewedHeadHash: head,
    chain: data.events.map((event) => ({ seq: event.seq, id: event.id, hash: event.hash, author: event.author, threadId: event.threadId, kind: event.body.kind })),
  };
}

type EventBodyKind = SignedEvent["body"]["kind"];

export async function decideExit(input: {
  roomId: string;
  requestEventId: EventId;
  decision: "accept" | "send_back" | "kill";
  reviewedHeadHash: string;
  note?: string;
  home?: string;
}): Promise<SignedEvent> {
  const data = await readRoom(input.roomId, input.home);
  const request = findEvent(data.events, input.requestEventId);
  if (!request || request.body.kind !== "turn" || !exitRequest(request.body.text)) throw new Error("Signed exit request not found");
  if ((data.events.at(-1)?.hash ?? "0".repeat(64)) !== input.reviewedHeadHash) throw new Error("Exit review is stale; preview the current chain again");
  const human = humanMember(data.genesis);
  const identity = await loadIdentity(data.paths.keys, data.genesis.roomId, human);
  const text = `${EXIT_DECISION_PREFIX}${JSON.stringify({
    requestEventId: input.requestEventId,
    decision: input.decision,
    reviewedHeadHash: input.reviewedHeadHash,
    note: input.note ?? "",
  })}`;
  return appendRoomEvent({
    roomId: input.roomId,
    home: input.home,
    entries: [{ identity, threadId: request.threadId, body: (context) => {
      if (context.prevHash !== input.reviewedHeadHash) throw new Error("Exit review became stale before the signed decision could be appended");
      return { kind: "turn", text, usage: { inputTokens: 0, outputTokens: 0 } };
    } }],
  });
}

export async function releaseExit(input: {
  roomId: string;
  requestEventId: EventId;
  home?: string;
}): Promise<{ event: SignedEvent; text: string; sourceEventId: EventId; headHash: string }> {
  const data = await readRoom(input.roomId, input.home);
  const preflight = await verifyRoom(input.roomId, input.home);
  if (!preflight.ok) throw new Error(`ALERT JASON: exit release withheld; root verifier rejected room: ${preflight.firstFailure?.reason ?? "unknown"}`);
  const request = findEvent(data.events, input.requestEventId);
  const requestBody = request?.body.kind === "turn" ? exitRequest(request.body.text) : undefined;
  if (!request || !requestBody) throw new Error("Signed exit request not found");
  const target = findEvent(data.events, requestBody.targetEventId);
  if (!target || target.body.kind !== "turn" || target.author !== request.author) throw new Error("Verified target turn not found");
  const targetText = target.body.text;
  const human = humanMember(data.genesis);
  const requestIndex = data.events.findIndex((event) => event.id === input.requestEventId);
  const decisions = data.events.slice(requestIndex + 1).flatMap((event) => {
    if (event.author !== human.fingerprint || event.body.kind !== "turn") return [];
    const body = exitDecision(event.body.text);
    return body?.requestEventId === input.requestEventId ? [{ event, body }] : [];
  });
  const accepted = decisions.at(-1);
  if (!accepted || accepted.body.decision !== "accept") throw new Error("Exit release requires Jason's prior signed acceptance");
  const decisionIndex = data.events.findIndex((event) => event.id === accepted.event.id);
  const reviewedHead = data.events[decisionIndex - 1]?.hash ?? "0".repeat(64);
  if (accepted.body.reviewedHeadHash !== reviewedHead || decisionIndex !== data.events.length - 1) throw new Error("Exit acceptance is stale; no output was released");
  const member = resolveMember(data, request.author);
  const identity = await loadIdentity(data.paths.keys, data.genesis.roomId, member);
  const event = await appendRoomEvent({
    roomId: input.roomId,
    home: input.home,
    entries: [{ identity, threadId: target.threadId, body: (context) => {
      if (context.priorEvents.at(-1)?.id !== accepted.event.id) throw new Error("Exit acceptance is no longer the chain head; output withheld");
      return { kind: "turn", text: targetText, usage: { inputTokens: 0, outputTokens: 0 } };
    } }],
  });
  const postWrite = await verifyRoom(input.roomId, input.home);
  const after = await readRoom(input.roomId, input.home);
  const appended = findEvent(after.events, event.id);
  if (!postWrite.ok || !appended || appended.body.kind !== "turn" || appended.body.text !== targetText) {
    throw new Error("ALERT JASON: post-write verification failed; output withheld");
  }
  return { event: appended, text: targetText, sourceEventId: target.id, headHash: appended.hash };
}
