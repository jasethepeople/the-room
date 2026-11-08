import assert from "node:assert/strict";
import { createHash, generateKeyPairSync, sign as signEd25519 } from "node:crypto";
import { copyFile, mkdir, mkdtemp, readFile, readdir, rm, unlink, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { after, test } from "node:test";
import type { KeyObject } from "node:crypto";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const verifierPath = join(projectRoot, "verify.ts");
const roots: string[] = [];
const zeroHash = "0".repeat(64);
let eventCounter = 0;

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

type SigningMember = { member: Member; privateKey: KeyObject };
type Event = {
  id: string;
  roomId: string;
  seq: number;
  threadId: string | null;
  author: string;
  createdAt: string;
  body: Record<string, any>;
  prevHash: string;
  hash: string;
  signature: string;
};

type Fixture = {
  root: string;
  roomDir: string;
  genesis: Record<string, any>;
  human: SigningMember;
  agent1: SigningMember;
  agent2: SigningMember;
  events: Event[];
  append: (body: Record<string, any>, author: SigningMember, threadId?: string | null) => Event;
  save: () => Promise<void>;
};

function canonicalize(value: any): string {
  if (value === null || typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value)) throw new Error("fixture values must be safe integers");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(",")}]`;
  if (typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalize(value[key])}`).join(",")}}`;
  }
  throw new Error("unsupported fixture value");
}

function sha256(value: Uint8Array | string): string {
  return createHash("sha256").update(value).digest("hex");
}

function makeMember(name: string, role: Member["role"], modelId: string): SigningMember {
  const pair = generateKeyPairSync("ed25519");
  const publicBytes = pair.publicKey.export({ format: "der", type: "spki" });
  const member: Member = {
    name,
    role,
    modelId,
    publicKey: publicBytes.toString("base64url"),
    fingerprint: sha256(publicBytes),
    subscriptions: ["main"],
    budgetTokens: 10_000,
    tools: [],
  };
  return { member, privateKey: pair.privateKey };
}

function uuid7(): string {
  eventCounter += 1;
  const timestamp = Date.parse("2026-10-28T00:00:00.000Z").toString(16).padStart(12, "0");
  const counter = eventCounter.toString(16).padStart(3, "0");
  const tail = eventCounter.toString(16).padStart(12, "0");
  return `${timestamp.slice(0, 8)}-${timestamp.slice(8)}-7${counter}-8000-${tail}`;
}

async function newRoot(prefix = "room-contract-verifier-"): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), prefix));
  roots.push(root);
  return root;
}

async function createFixture(options: { minCosigns?: number } = {}): Promise<Fixture> {
  const root = await newRoot();
  const roomDir = join(root, "room-contract-test-1234abcd");
  await mkdir(roomDir);
  const human = makeMember("Jason", "human", "human");
  const agent1 = makeMember("Harness One", "harness-agent", "fixture:one");
  const agent2 = makeMember("Harness Two", "harness-agent", "fixture:two");
  const genesis = {
    roomId: "room-contract-test-1234abcd",
    roomName: "Contract verifier test room",
    createdAt: "2026-10-28T00:00:00.000Z",
    templateId: "default",
    templateVersion: "1",
    canonRule: { id: "test-rule", minCosigns: options.minCosigns ?? 1 },
    threads: [{ id: "main", title: "Main" }],
    members: [human.member, agent1.member, agent2.member],
  };
  const events: Event[] = [];
  const append = (body: Record<string, any>, author: SigningMember, threadId: string | null = null): Event => {
    const payload = {
      id: uuid7(),
      roomId: genesis.roomId,
      seq: events.length + 1,
      threadId,
      author: author.member.fingerprint,
      createdAt: "2026-10-28T00:00:01.000Z",
      body,
      prevHash: events.at(-1)?.hash ?? zeroHash,
    };
    const canonical = canonicalize(payload);
    const event: Event = {
      ...payload,
      hash: sha256(Buffer.from(canonical, "utf8")),
      signature: signEd25519(null, Buffer.from(canonical, "utf8"), author.privateKey).toString("base64url"),
    };
    events.push(event);
    return event;
  };
  const genesisSha256 = sha256(Buffer.from(canonicalize(genesis), "utf8"));
  append({ kind: "system", genesisSha256, templateId: genesis.templateId, templateVersion: genesis.templateVersion }, human);
  const save = async () => {
    await writeFile(join(roomDir, "genesis.json"), `${JSON.stringify(genesis, null, 2)}\n`);
    await writeFile(join(roomDir, "transcript.jsonl"), `${events.map((event) => JSON.stringify(event)).join("\n")}\n`);
  };
  return { root, roomDir, genesis, human, agent1, agent2, events, append, save };
}

function runVerifier(script: string, roomDir: string): { status: number | null; report: Record<string, any>; stderr: string } {
  const result = spawnSync(process.execPath, [script, roomDir], { encoding: "utf8", cwd: dirname(script) });
  assert.equal(result.error, undefined, result.error?.message);
  let report: Record<string, any>;
  try {
    report = JSON.parse(result.stdout.trim());
  } catch {
    assert.fail(`Verifier did not emit one JSON result. stdout=${result.stdout} stderr=${result.stderr}`);
  }
  return { status: result.status, report: report!, stderr: result.stderr };
}

async function saveSeamSnapshot(fixture: Fixture, content: string): Promise<Event> {
  const seq = fixture.events.length + 1;
  await writeFile(join(fixture.roomDir, `seams.${seq}.md`), content);
  return fixture.append({
    kind: "seal",
    chainHead: fixture.events.at(-1)!.hash,
    eventCount: seq - 1,
    seamsSha256: sha256(Buffer.from(content, "utf8")),
  }, fixture.human);
}

after(async () => {
  await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })));
});

test("contract verifier runs from an empty copied directory using only exported files", async () => {
  const fixture = await createFixture();
  fixture.append({ kind: "turn", text: "A complete signed turn.", usage: { inputTokens: 2, outputTokens: 3 } }, fixture.human, "main");
  await fixture.save();

  const isolated = await newRoot("room-contract-empty-");
  const isolatedVerifier = join(isolated, "verify.ts");
  await copyFile(verifierPath, isolatedVerifier);
  const isolatedRoom = join(isolated, "export");
  await mkdir(isolatedRoom);
  await copyFile(join(fixture.roomDir, "genesis.json"), join(isolatedRoom, "genesis.json"));
  await copyFile(join(fixture.roomDir, "transcript.jsonl"), join(isolatedRoom, "transcript.jsonl"));
  assert.deepEqual((await readdir(isolated)).sort(), ["export", "verify.ts"]);
  assert.deepEqual((await readdir(isolatedRoom)).sort(), ["genesis.json", "transcript.jsonl"]);

  const result = runVerifier(isolatedVerifier, isolatedRoom);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(result.report, { ok: true, events: 2, seals: 0, warnings: ["seams.md is missing"] });
  const source = await readFile(isolatedVerifier, "utf8");
  const imports = [...source.matchAll(/^\s*import\s+.*?from\s+["']([^"']+)["'];?$/gm)].map((match) => match[1]).sort();
  assert.deepEqual(imports, ["node:crypto", "node:fs"]);
  assert.doesNotMatch(source, /\bimport\s*\(/);
});

test("genesis fingerprint mismatch is rejected before the transcript is trusted", async () => {
  const fixture = await createFixture();
  fixture.genesis.members[0]!.fingerprint = "a".repeat(64);
  await fixture.save();
  const result = runVerifier(verifierPath, fixture.roomDir);
  assert.equal(result.status, 1);
  assert.equal(result.report.ok, false);
  assert.match(result.report.firstFailure.reason, /Jason.*fingerprint mismatch/);
});

test("a one-byte payload edit fails at the named signed event", async () => {
  const fixture = await createFixture();
  const turn = fixture.append({ kind: "turn", text: "Alpha claim.", usage: { inputTokens: 0, outputTokens: 2 } }, fixture.agent1, "main");
  await fixture.save();
  const transcriptPath = join(fixture.roomDir, "transcript.jsonl");
  const lines = (await readFile(transcriptPath, "utf8")).trimEnd().split("\n");
  const changed = JSON.parse(lines[1]!);
  changed.body.text = "Alpha claiM.";
  lines[1] = JSON.stringify(changed);
  await writeFile(transcriptPath, `${lines.join("\n")}\n`);
  const result = runVerifier(verifierPath, fixture.roomDir);
  assert.equal(result.status, 1);
  assert.equal(result.report.firstFailure.id, turn.id);
  assert.match(result.report.firstFailure.reason, /hash mismatch/);
});

test("duplicate JSON keys are rejected before canonicalization", async () => {
  const genesisFixture = await createFixture();
  const genesisLine = JSON.stringify(genesisFixture.genesis);
  await genesisFixture.save();
  await writeFile(join(genesisFixture.roomDir, "genesis.json"), genesisLine.replace('"roomId":', '"roomId":"duplicate","roomId":'));
  let result = runVerifier(verifierPath, genesisFixture.roomDir);
  assert.equal(result.status, 1);
  assert.match(result.report.firstFailure.reason, /duplicate JSON property "roomId"/);

  const eventFixture = await createFixture();
  await eventFixture.save();
  const transcriptPath = join(eventFixture.roomDir, "transcript.jsonl");
  const eventLine = await readFile(transcriptPath, "utf8");
  await writeFile(transcriptPath, eventLine.replace('"seq":1', '"seq":1,"seq":1'));
  result = runVerifier(verifierPath, eventFixture.roomDir);
  assert.equal(result.status, 1);
  assert.equal(result.report.firstFailure.line, 1);
  assert.match(result.report.firstFailure.reason, /duplicate JSON property "seq"/);
});

test("self-certifying joins pin fingerprints, and agent seam events fail role resolution", async () => {
  const fixture = await createFixture();
  const newcomer = makeMember("Newcomer", "harness-agent", "fixture:new");
  const forgedMember = { ...newcomer.member, fingerprint: "b".repeat(64) };
  const join = fixture.append({ kind: "membership", action: "join", member: forgedMember }, { ...newcomer, member: forgedMember });
  await fixture.save();
  let result = runVerifier(verifierPath, fixture.roomDir);
  assert.equal(result.status, 1);
  assert.equal(result.report.firstFailure.id, join.id);
  assert.match(result.report.firstFailure.reason, /join fingerprint/);

  const validFixture = await createFixture();
  const agentSeam = validFixture.append({ kind: "seam", note: "Agent cannot mark this boundary.", spans: [] }, validFixture.agent1);
  await validFixture.save();
  result = runVerifier(verifierPath, validFixture.roomDir);
  assert.equal(result.status, 1);
  assert.equal(result.report.firstFailure.id, agentSeam.id);
  assert.match(result.report.firstFailure.reason, /not a resolved human/);
});

test("a challenge may have one verdict, and the verdict remains a signed historical event", async () => {
  const fixture = await createFixture();
  const target = fixture.append({ kind: "turn", text: "2 + 2 = 5" }, fixture.agent1, "main");
  const challenge = fixture.append({ kind: "challenge", targetEventId: target.id, claim: "The result is false.", grounds: "factual", evidence: [] }, fixture.agent2, "main");
  fixture.append({ kind: "verdict", challengeId: challenge.id, outcome: "refuted", evidence: [], rationale: "Integer addition gives four." }, fixture.human, "main");
  await fixture.save();
  let result = runVerifier(verifierPath, fixture.roomDir);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.report.events, 4);

  const duplicate = fixture.append({ kind: "verdict", challengeId: challenge.id, outcome: "upheld", evidence: [], rationale: "A second answer is not allowed." }, fixture.human, "main");
  await fixture.save();
  result = runVerifier(verifierPath, fixture.roomDir);
  assert.equal(result.status, 1);
  assert.equal(result.report.firstFailure.id, duplicate.id);
  assert.match(result.report.firstFailure.reason, /already has a verdict/);
});

test("canon replay uses typed currentRule and updates it only after a verified enactment", async () => {
  const fixture = await createFixture({ minCosigns: 1 });
  const firstProposal = fixture.append({ kind: "proposal", statement: "Require two supporting members.", appliesTo: "room" }, fixture.human, "main");
  const firstSupport = fixture.append({ kind: "cosign", proposalId: firstProposal.id, stance: "support" }, fixture.agent1, "main");
  fixture.append({ kind: "canon", action: "enact", proposalId: firstProposal.id, cosigns: [firstSupport.id], reason: "The current rule required one.", newRule: { id: "two-supports", minCosigns: 2 } }, fixture.human, "main");
  const secondProposal = fixture.append({ kind: "proposal", statement: "This proposal needs two supports.", appliesTo: { thread: "main" } }, fixture.human, "main");
  const secondSupport = fixture.append({ kind: "cosign", proposalId: secondProposal.id, stance: "support" }, fixture.agent1, "main");
  const thirdSupport = fixture.append({ kind: "cosign", proposalId: secondProposal.id, stance: "support" }, fixture.agent2, "main");
  fixture.append({ kind: "canon", action: "enact", proposalId: secondProposal.id, cosigns: [secondSupport.id, thirdSupport.id], reason: "Two distinct supporters meet the enacted rule." }, fixture.human, "main");
  await fixture.save();
  let result = runVerifier(verifierPath, fixture.roomDir);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.report.events, 8);

  const failing = await createFixture({ minCosigns: 1 });
  const p1 = failing.append({ kind: "proposal", statement: "Raise the threshold.", appliesTo: "room" }, failing.human, "main");
  const c1 = failing.append({ kind: "cosign", proposalId: p1.id, stance: "support" }, failing.agent1, "main");
  failing.append({ kind: "canon", action: "enact", proposalId: p1.id, cosigns: [c1.id], reason: "Set two.", newRule: { id: "two", minCosigns: 2 } }, failing.human, "main");
  const p2 = failing.append({ kind: "proposal", statement: "One is no longer enough.", appliesTo: "room" }, failing.human, "main");
  const c2 = failing.append({ kind: "cosign", proposalId: p2.id, stance: "support" }, failing.agent1, "main");
  const invalidCanon = failing.append({ kind: "canon", action: "enact", proposalId: p2.id, cosigns: [c2.id], reason: "This must fail under currentRule." }, failing.human, "main");
  await failing.save();
  result = runVerifier(verifierPath, failing.roomDir);
  assert.equal(result.status, 1);
  assert.equal(result.report.firstFailure.id, invalidCanon.id);
  assert.match(result.report.firstFailure.reason, /currentRule\.minCosigns/);
});

test("proposal supersedes must cite an earlier proposal", async () => {
  const fixture = await createFixture();
  const proposal = fixture.append({ kind: "proposal", statement: "Unfounded supersession.", appliesTo: "room", supersedes: uuid7() }, fixture.human, "main");
  await fixture.save();
  const result = runVerifier(verifierPath, fixture.roomDir);
  assert.equal(result.status, 1);
  assert.equal(result.report.firstFailure.id, proposal.id);
  assert.match(result.report.firstFailure.reason, /supersedes does not refer to an earlier proposal/);
});

test("seals checkpoint seams without ending the chain; latest and historical snapshots are checked separately", async () => {
  const fixture = await createFixture();
  const firstSeams = "Seam one.\n";
  await writeFile(join(fixture.roomDir, "seams.md"), firstSeams);
  const firstSeal = await saveSeamSnapshot(fixture, firstSeams);
  fixture.append({ kind: "turn", text: "A later event is legal after a seal." }, fixture.agent1, "main");
  await fixture.save();
  let result = runVerifier(verifierPath, fixture.roomDir);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.report.events, 3);
  assert.equal(result.report.seals, 1);

  const secondSeams = "Seam one.\nSeam two.\n";
  await writeFile(join(fixture.roomDir, "seams.md"), secondSeams);
  const secondSeal = await saveSeamSnapshot(fixture, secondSeams);
  fixture.append({ kind: "turn", text: "The second checkpoint is not terminal either." }, fixture.agent2, "main");
  await fixture.save();
  result = runVerifier(verifierPath, fixture.roomDir);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.report.events, 5);
  assert.equal(result.report.seals, 2);

  await unlink(join(fixture.roomDir, `seams.${firstSeal.seq}.md`));
  await unlink(join(fixture.roomDir, `seams.${secondSeal.seq}.md`));
  result = runVerifier(verifierPath, fixture.roomDir);
  assert.equal(result.status, 0, result.stderr);
  assert.ok(result.report.warnings.some((warning: string) => warning.includes(`seams.${firstSeal.seq}.md`)));
  assert.ok(result.report.warnings.some((warning: string) => warning.includes(`seams.${secondSeal.seq}.md`)));
  await unlink(join(fixture.roomDir, "seams.md"));
  result = runVerifier(verifierPath, fixture.roomDir);
  assert.equal(result.status, 0, result.stderr);
  assert.ok(result.report.warnings.includes("seams.md is missing"));
  assert.ok(result.report.warnings.includes("latest seal could not be checked against seams.md"));


  await writeFile(join(fixture.roomDir, "seams.md"), "Modified after the latest seal.\n");
  result = runVerifier(verifierPath, fixture.roomDir);
  assert.equal(result.status, 1);
  assert.equal(result.report.firstFailure.id, secondSeal.id);
  assert.match(result.report.firstFailure.reason, /latest seal seamsSha256 mismatch/);
});
