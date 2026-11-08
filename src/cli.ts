import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  addFixtureMember,
  addOllamaMember,
  assignTask,
  challengeTurn,
  cosign,
  createRoom,
  decideExit,
  enactCanon,
  getMemberStates,
  leaveFixtureMember,
  markSeam,
  postTurn,
  previewExit,
  propose,
  releaseExit,
  requestExit,
  resolveChallenge,
  runAssignedTask,
  setBudgetState,
  writeSeal,
} from "./room.ts";
import { appendIncomingEvents, quarantineMalformedInput, readRoom, roomMembers, verifyRoom } from "./ledger.ts";
import type { EvidenceRef, SignedEvent } from "./types.ts";
import { ASSUMED_USD_PER_MILLION_TOKENS } from "./strip.ts";
import type { StripReceipt } from "./strip.ts";

const FIXTURE_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "../tests/fixtures");
const STRIP_FIXTURES = new Set(["log-tail", "repeated-headers", "mixed", "filler", "protected", "frames", "padding", "combined"]);

const HELP = `The Room — local signed shared-memory core

Commands:
  spawn <room-slug> <room-name...> [--members N] [--home PATH]
  verify <room-id> [--home PATH]
  status <room-id> [--home PATH]
  members <room-id> [--home PATH]
  member-add <room-id> <fixture-name...> [--budget N] [--home PATH]
  member-add-ollama <room-id> <member-name...> --budget N [--home PATH]
  member-leave <room-id> <harness-member-or-fingerprint> [--home PATH]
  task <room-id> <human-name-or-fingerprint> <harness-member-or-fingerprint> <prompt...> [--thread ID] [--home PATH]
  run-member <room-id> <ollama-member-or-fingerprint> <assignment-event-id> [--ollama-host URL] [--model NAME] [--home PATH]
  turn <room-id> <member-name-or-fingerprint> <text...> [--thread ID] [--input-tokens N] [--output-tokens N] [--home PATH]
  strip-demo [--fixture log-tail|repeated-headers|mixed|filler|protected|frames|padding|combined] [--home PATH]
  challenge <room-id> <member> <target-event-id> <claim...> [--grounds factual|procedural|doctrinal] [--ref-event ID]... [--home PATH]
  verdict <room-id> <member> <challenge-id> <upheld|refuted|unproven> <rationale...> [--ref-event ID]... [--home PATH]
  proposal <room-id> <member> <statement...> [--thread ID] [--supersedes ID] [--home PATH]
  cosign <room-id> <member> <proposal-id> <support|oppose> [--home PATH]
  canon <room-id> <proposal-id> <cosign-id,...> <reason...> [--new-rule ID --min-cosigns N] [--home PATH]
  budget <room-id> <member> <pause|resume> [--reason human|exhausted|rule] [--thread ID] [--home PATH]
  seam <room-id> <note...> [--span FROM_EVENT_ID,TO_EVENT_ID]... [--home PATH]
  seal <room-id> [--home PATH]
  exit-request <room-id> <member> <target-event-id> <destination...> [--home PATH]
  exit-preview <room-id> <request-event-id> [--home PATH]
  exit-decide <room-id> <request-event-id> <accept|send_back|kill> <reviewed-head-hash> <note...> [--home PATH]
  exit-release <room-id> <request-event-id> [--home PATH]
  import <room-id> <event-file> [--home PATH]

All ledger entries use frozen contract event bodies. Fixture members do not call models. One explicitly added Ollama-backed member can call a local Ollama instance; A2A remains unavailable.
`;

function takeOption(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  if (index < 0) return undefined;
  const value = args[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`${name} requires a value`);
  args.splice(index, 2);
  return value;
}

function takeOptions(args: string[], name: string): string[] {
  const values: string[] = [];
  while (args.includes(name)) values.push(takeOption(args, name)!);
  return values;
}

function takeHome(args: string[]): string | undefined {
  return takeOption(args, "--home");
}

function required(args: string[], count: number, usage: string): void {
  if (args.length < count) throw new Error(`Usage: ${usage}`);
}

function integerOption(value: string | undefined, name: string): number | undefined {
  if (value === undefined) return undefined;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) throw new Error(`${name} must be a safe integer`);
  return parsed;
}

function printEvent(event: SignedEvent): void {
  console.log(JSON.stringify({ id: event.id, seq: event.seq, kind: event.body.kind, hash: event.hash }, null, 2));
}

function formatMicroDollars(value: number): string {
  const whole = Math.floor(value / 1_000_000);
  const fraction = String(value % 1_000_000).padStart(6, "0");
  return `${whole}.${fraction}`;
}

function parseSpans(values: string[]): Array<{ fromEventId: string; toEventId: string }> {
  return values.map((value) => {
    const split = value.indexOf(",");
    if (split < 1 || split === value.length - 1) throw new Error("Each --span must be FROM_EVENT_ID,TO_EVENT_ID");
    return { fromEventId: value.slice(0, split), toEventId: value.slice(split + 1) };
  });
}

function parseEvidence(values: string[]): EvidenceRef[] {
  return values.map((id) => ({ type: "event", id }));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

async function importFile(roomId: string, path: string, home?: string): Promise<void> {
  let raw = "";
  let parsed = false;
  try {
    raw = await readFile(path, "utf8");
    const value = JSON.parse(raw) as unknown;
    parsed = true;
    const incoming = Array.isArray(value) ? value : [value];
    if (incoming.length === 0 || incoming.some((event) => !isRecord(event) || !isRecord(event.body) || typeof event.body.kind !== "string")) {
      throw new Error("Incoming file must contain one contract event or a nonempty array of contract events");
    }
    const appended = await appendIncomingEvents({ roomId, home, events: incoming as SignedEvent[] });
    for (const event of appended) printEvent(event);
  } catch (error) {
    if (!parsed) {
      await quarantineMalformedInput(roomId, raw, error instanceof Error ? error.message : String(error), home);
    } else if (error instanceof Error && error.message.startsWith("Incoming file must contain")) {
      await quarantineMalformedInput(roomId, raw, error.message, home);
    }
    throw error;
  }
}

async function runStripDemo(fixtureName: string, requestedHome?: string): Promise<void> {
  if (!STRIP_FIXTURES.has(fixtureName)) throw new Error(`Unknown strip fixture: ${fixtureName}`);
  const fixtureText = await readFile(join(FIXTURE_DIR, `strip-${fixtureName}.md`), "utf8");
  let home = requestedHome;
  let temporaryHome: string | undefined;
  if (!home) {
    temporaryHome = await mkdtemp(join(tmpdir(), "the-room-strip-demo-"));
    home = temporaryHome;
  }
  try {
    const created = await createRoom({ roomId: "strip-demo", roomName: "Room admission strip demo", home });
    const human = created.members.find((member) => member.role === "human");
    if (!human) throw new Error("Strip demo room has no human member");
    const event = await postTurn({ roomId: created.roomId, author: human.fingerprint, text: fixtureText, home });
    if (event.body.kind !== "turn") throw new Error("Strip demo did not append a turn");
    const verification = await verifyRoom(created.roomId, home);
    if (!verification.ok) throw new Error(`Strip demo room failed root verification: ${verification.firstFailure?.reason ?? "unknown"}`);
    const sidecarPath = join(created.paths.room, `receipts.${event.seq}.jsonl`);
    const sidecar = JSON.parse((await readFile(sidecarPath, "utf8")).trim()) as {
      eventId: string;
      eventSeq: number;
      receipt: StripReceipt;
      previousReceiptHash: string;
      receiptHash: string;
    };
    if (sidecar.eventId !== event.id || sidecar.eventSeq !== event.seq) throw new Error("Strip demo receipt names a different event");
    console.log(`Fixture: ${fixtureName}`);
    console.log(`Room ID: ${created.roomId}`);
    console.log(`Before text: ${JSON.stringify(fixtureText)}`);
    console.log(`After text: ${JSON.stringify(event.body.text)}`);
    console.log(`Bytes: ${sidecar.receipt.originalBytes} -> ${sidecar.receipt.strippedBytes}`);
    console.log(`Lines: ${sidecar.receipt.linesBefore} -> ${sidecar.receipt.linesAfter} (${sidecar.receipt.linesRemoved} removed)`);
    console.log(`Tokens ESTIMATE (chars/4): ${sidecar.receipt.estimatedTokensBefore} -> ${sidecar.receipt.estimatedTokensAfter}`);
    console.log(`Dollars ESTIMATE (ASSUMPTION: $${ASSUMED_USD_PER_MILLION_TOKENS}/1M estimated tokens; integer micro-dollar arithmetic): $${formatMicroDollars(sidecar.receipt.estimatedCostMicroDollarsBefore)} -> $${formatMicroDollars(sidecar.receipt.estimatedCostMicroDollarsAfter)}`);
    console.log(`Rule set: ${sidecar.receipt.ruleSet}`);
    console.log(`Receipt: ${JSON.stringify(sidecar.receipt, null, 2)}`);
    console.log(`Root verify.ts: PASS (${verification.events} events)`);
  } finally {
    if (temporaryHome) await rm(temporaryHome, { recursive: true, force: true });
  }
}

async function main(): Promise<void> {
  const [command, ...rawArgs] = process.argv.slice(2);
  const args = [...rawArgs];
  if (!command || command === "help" || command === "--help" || command === "-h") {
    console.log(HELP);
    return;
  }
  const home = takeHome(args);
  switch (command) {
    case "strip-demo": {
      const fixtureName = takeOption(args, "--fixture") ?? "mixed";
      if (args.length > 0) throw new Error("Usage: room strip-demo [--fixture log-tail|repeated-headers|mixed|filler|protected|frames|padding|combined] [--home PATH]");
      await runStripDemo(fixtureName, home);
      return;
    }

    case "spawn": {
      const members = integerOption(takeOption(args, "--members"), "--members");
      required(args, 2, "room spawn <room-slug> <room-name...>");
      const [roomId, ...roomName] = args;
      const result = await createRoom({ roomId: roomId!, roomName: roomName.join(" "), members, home });
      console.log(JSON.stringify({
        roomId: result.roomId,
        roomPath: result.paths.room,
        members: result.members.map(({ name, role, modelId, fingerprint }) => ({ name, role, modelId, fingerprint })),
        verification: result.verification,
      }, null, 2));
      return;
    }
    case "verify": {
      required(args, 1, "room verify <room-id>");
      const result = await verifyRoom(args[0]!, home);
      console.log(JSON.stringify(result, null, 2));
      if (!result.ok) throw new Error(`ALERT JASON: room verification failed: ${result.firstFailure?.reason ?? "unknown"}`);
      return;
    }
    case "status": {
      required(args, 1, "room status <room-id>");
      const data = await readRoom(args[0]!, home);
      const states = await getMemberStates(args[0]!, home);
      console.log(JSON.stringify({
        roomId: data.genesis.roomId,
        roomName: data.genesis.roomName,
        eventCount: data.events.length,
        headHash: data.events.at(-1)?.hash ?? null,
        currentRule: data.genesis.canonRule,
        threads: data.genesis.threads,
        members: states.map(({ member, present, consumedTokens, paused }) => ({ name: member.name, role: member.role, fingerprint: member.fingerprint, present, consumedTokens, paused })),
      }, null, 2));
      return;
    }
    case "members": {
      required(args, 1, "room members <room-id>");
      const data = await readRoom(args[0]!, home);
      console.log(JSON.stringify(roomMembers(data).map(({ name, role, modelId, fingerprint, subscriptions, budgetTokens, tools }) => ({ name, role, modelId, fingerprint, subscriptions, budgetTokens, tools })), null, 2));
      return;
    }
    case "member-add": {
      const budgetTokens = integerOption(takeOption(args, "--budget"), "--budget");
      required(args, 2, "room member-add <room-id> <fixture-name...>");
      const [roomId, ...name] = args;
      printEvent(await addFixtureMember({ roomId: roomId!, name: name.join(" "), budgetTokens, home }));
      return;
    }
    case "member-add-ollama": {
      const budgetTokens = integerOption(takeOption(args, "--budget"), "--budget");
      if (budgetTokens === undefined) throw new Error("--budget is required for an Ollama member");
      required(args, 2, "room member-add-ollama <room-id> <member-name...> --budget N");
      const [roomId, ...name] = args;
      printEvent(await addOllamaMember({ roomId: roomId!, name: name.join(" "), budgetTokens, home }));
      return;
    }
    case "member-leave": {
      required(args, 2, "room member-leave <room-id> <harness-member-or-fingerprint>");
      printEvent(await leaveFixtureMember({ roomId: args[0]!, member: args[1]!, home }));
      return;
    }
    case "task": {
      const threadId = takeOption(args, "--thread");
      required(args, 4, "room task <room-id> <human> <harness-member> <prompt...>");
      const [roomId, author, recipient, ...prompt] = args;
      printEvent(await assignTask({ roomId: roomId!, author: author!, recipient: recipient!, prompt: prompt.join(" "), threadId, home }));
      return;
    }
    case "run-member": {
      const ollamaHost = takeOption(args, "--ollama-host");
      const modelName = takeOption(args, "--model");
      required(args, 3, "room run-member <room-id> <ollama-member> <assignment-event-id> [--ollama-host URL] [--model NAME]");
      if (args.length !== 3) throw new Error("Usage: room run-member <room-id> <ollama-member> <assignment-event-id> [--ollama-host URL] [--model NAME] [--home PATH]");
      const result = await runAssignedTask({ roomId: args[0]!, member: args[1]!, assignmentEventId: args[2]!, ollamaHost, model: modelName, home });
      if (result.status === "not-available") {
        console.log(`NOT AVAILABLE: ${result.reason}`);
        return;
      }
      console.log(JSON.stringify({
        status: "TURN ADMITTED; pending human exit review",
        model: result.model,
        assignmentEventId: result.assignmentEventId,
        event: { id: result.event.id, seq: result.event.seq, hash: result.event.hash },
      }, null, 2));
      return;
    }
    case "turn": {
      const threadId = takeOption(args, "--thread");
      const inputTokens = integerOption(takeOption(args, "--input-tokens"), "--input-tokens");
      const outputTokens = integerOption(takeOption(args, "--output-tokens"), "--output-tokens");
      required(args, 3, "room turn <room-id> <member> <text...>");
      const [roomId, author, ...text] = args;
      printEvent(await postTurn({ roomId: roomId!, author: author!, text: text.join(" "), threadId, inputTokens, outputTokens, home }));
      return;
    }
    case "challenge": {
      const grounds = takeOption(args, "--grounds") as "factual" | "procedural" | "doctrinal" | undefined;
      const evidence = parseEvidence(takeOptions(args, "--ref-event"));
      required(args, 4, "room challenge <room-id> <member> <target-event-id> <claim...>");
      const [roomId, author, targetEventId, ...claim] = args;
      printEvent(await challengeTurn({ roomId: roomId!, author: author!, targetEventId: targetEventId!, claim: claim.join(" "), grounds, evidence, home }));
      return;
    }
    case "verdict": {
      const evidence = parseEvidence(takeOptions(args, "--ref-event"));
      required(args, 5, "room verdict <room-id> <member> <challenge-id> <upheld|refuted|unproven> <rationale...>");
      const [roomId, author, challengeId, outcome, ...rationale] = args;
      if (!["upheld", "refuted", "unproven"].includes(outcome!)) throw new Error("Verdict outcome must be upheld, refuted, or unproven");
      printEvent(await resolveChallenge({ roomId: roomId!, author: author!, challengeId: challengeId!, outcome: outcome as "upheld" | "refuted" | "unproven", rationale: rationale.join(" "), evidence, home }));
      return;
    }
    case "proposal": {
      const thread = takeOption(args, "--thread");
      const supersedes = takeOption(args, "--supersedes");
      required(args, 3, "room proposal <room-id> <member> <statement...>");
      const [roomId, author, ...statement] = args;
      printEvent(await propose({ roomId: roomId!, author: author!, statement: statement.join(" "), appliesTo: thread ? { thread } : "room", supersedes, home }));
      return;
    }
    case "cosign": {
      required(args, 4, "room cosign <room-id> <member> <proposal-id> <support|oppose>");
      const [roomId, author, proposalId, stance] = args;
      if (stance !== "support" && stance !== "oppose") throw new Error("Cosign stance must be support or oppose");
      printEvent(await cosign({ roomId: roomId!, author: author!, proposalId: proposalId!, stance, home }));
      return;
    }
    case "canon": {
      const newRuleId = takeOption(args, "--new-rule");
      const minCosigns = integerOption(takeOption(args, "--min-cosigns"), "--min-cosigns");
      const action = takeOption(args, "--action") as "enact" | "demote" | undefined;
      required(args, 4, "room canon <room-id> <proposal-id> <cosign-id,...> <reason...>");
      const [roomId, proposalId, ids, ...reason] = args;
      if ((newRuleId === undefined) !== (minCosigns === undefined)) throw new Error("--new-rule and --min-cosigns must be supplied together");
      if (action && action !== "enact" && action !== "demote") throw new Error("Canon action must be enact or demote");
      const cosigns = ids === "-" ? [] : ids!.split(",").filter(Boolean);
      const newRule = newRuleId === undefined ? undefined : { id: newRuleId, minCosigns: minCosigns! };
      printEvent(await enactCanon({ roomId: roomId!, proposalId: proposalId!, cosigns, reason: reason.join(" "), newRule, action, home }));
      return;
    }
    case "budget": {
      const reason = (takeOption(args, "--reason") ?? "human") as "human" | "exhausted" | "rule";
      const threadId = takeOption(args, "--thread");
      required(args, 3, "room budget <room-id> <member> <pause|resume>");
      const [roomId, member, action] = args;
      if (action !== "pause" && action !== "resume") throw new Error("Budget action must be pause or resume");
      if (!["human", "exhausted", "rule"].includes(reason)) throw new Error("Budget reason must be human, exhausted, or rule");
      printEvent(await setBudgetState({ roomId: roomId!, member: member!, state: action === "pause" ? "paused" : "resumed", reason, threadId, home }));
      return;
    }
    case "seam": {
      const spans = parseSpans(takeOptions(args, "--span"));
      required(args, 2, "room seam <room-id> <note...>");
      const [roomId, ...note] = args;
      const result = await markSeam({ roomId: roomId!, note: note.join(" "), spans, home });
      console.log(JSON.stringify({ seam: { id: result.seam.id, seq: result.seam.seq, hash: result.seam.hash }, seal: { id: result.seal.id, seq: result.seal.seq, hash: result.seal.hash } }, null, 2));
      return;
    }
    case "seal": {
      required(args, 1, "room seal <room-id>");
      printEvent(await writeSeal({ roomId: args[0]!, home }));
      return;
    }
    case "exit-request": {
      required(args, 4, "room exit-request <room-id> <member> <target-event-id> <destination...>");
      const [roomId, author, targetEventId, ...destination] = args;
      printEvent(await requestExit({ roomId: roomId!, author: author!, targetEventId: targetEventId!, destination: destination.join(" "), home }));
      return;
    }
    case "exit-preview": {
      required(args, 2, "room exit-preview <room-id> <request-event-id>");
      console.log(JSON.stringify(await previewExit(args[0]!, args[1]!, home), null, 2));
      return;
    }
    case "exit-decide": {
      required(args, 5, "room exit-decide <room-id> <request-event-id> <accept|send_back|kill> <reviewed-head-hash> <note...>");
      const [roomId, requestEventId, decision, reviewedHeadHash, ...note] = args;
      if (!["accept", "send_back", "kill"].includes(decision!)) throw new Error("Exit decision must be accept, send_back, or kill");
      printEvent(await decideExit({ roomId: roomId!, requestEventId: requestEventId!, decision: decision as "accept" | "send_back" | "kill", reviewedHeadHash: reviewedHeadHash!, note: note.join(" "), home }));
      return;
    }
    case "exit-release": {
      required(args, 2, "room exit-release <room-id> <request-event-id>");
      const result = await releaseExit({ roomId: args[0]!, requestEventId: args[1]!, home });
      console.log(`--- HUMAN-APPROVED RELEASE ---\nSource event: ${result.sourceEventId}\nRelease event: ${result.event.id}\nVerified chain head: ${result.headHash}\n\n${result.text}`);
      return;
    }
    case "import": {
      required(args, 2, "room import <room-id> <event-file>");
      await importFile(args[0]!, args[1]!, home);
      return;
    }
    default:
      throw new Error(`Unknown command: ${command}\n\n${HELP}`);
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
