import assert from "node:assert/strict";
import { createHash, createPublicKey } from "node:crypto";
import { readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { after, test } from "node:test";
import {
  addFixtureMember,
  assignTask,
  challengeTurn,
  cosign,
  createRoom,
  decideExit,
  enactCanon,
  getMembers,
  leaveFixtureMember,
  markSeam,
  postTurn,
  previewExit,
  propose,
  readRoom,
  releaseExit,
  requestExit,
  resolveChallenge,
  setBudgetState,
  verifyRoom,
  writeSeal,
} from "../src/index.ts";
import type { SignedEvent } from "../src/types.ts";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const verifierPath = join(projectRoot, "verify.ts");
const roots: string[] = [];

async function newHome(prefix = "the-room-test-"): Promise<string> {
  const home = await import("node:fs/promises").then(({ mkdtemp }) => mkdtemp(join(tmpdir(), prefix)));
  roots.push(home);
  return home;
}

function rootVerify(roomDir: string): { status: number | null; report: Record<string, unknown>; stderr: string } {
  const result = spawnSync(process.execPath, [verifierPath, roomDir], { cwd: projectRoot, encoding: "utf8" });
  assert.equal(result.error, undefined, result.error?.message);
  let report: Record<string, unknown>;
  try {
    report = JSON.parse(result.stdout.trim()) as Record<string, unknown>;
  } catch {
    assert.fail(`Root verifier emitted invalid output: ${result.stdout}\n${result.stderr}`);
  }
  return { status: result.status, report: report!, stderr: result.stderr };
}

async function createTestRoom(home: string, roomId = "room-test") {
  return createRoom({ roomId, roomName: "Contract migration test room", home });
}

function systemEvent(events: SignedEvent[]): SignedEvent {
  const event = events[0];
  assert.ok(event);
  assert.equal(event.body.kind, "system");
  return event;
}

after(async () => {
  await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })));
});

test("spawn writes typed genesis, a signed system event, and keeps Ed25519 keys outside the room tree", async () => {
  const home = await newHome();
  const result = await createRoom({ roomId: "spawn-test", roomName: "Spawn test", members: 3, home });
  const data = await readRoom(result.roomId, home);
  assert.match(result.roomId, /^[a-z0-9]+(?:-[a-z0-9]+)*-[0-9a-f]{8}$/);
  assert.deepEqual(data.genesis.canonRule, { id: "one-supporting-cosign", minCosigns: 1 });
  assert.equal(data.genesis.members.length, 3);
  assert.equal(data.genesis.members.filter((member) => member.role === "human").length, 1);
  assert.ok(data.genesis.members.filter((member) => member.role === "harness-agent").every((member) => member.modelId.startsWith("fixture:")));
  const event = systemEvent(data.events);
  assert.equal(event.threadId, null);
  assert.equal(event.body.kind === "system" ? event.body.templateId : "", data.genesis.templateId);
  for (const member of data.genesis.members) {
    const key = createPublicKey({ key: Buffer.from(member.publicKey, "base64url"), format: "der", type: "spki" });
    const fingerprint = createHash("sha256").update(key.export({ format: "der", type: "spki" })).digest("hex");
    assert.equal(member.fingerprint, fingerprint);
  }
  const keyFiles = await readdir(result.paths.keys);
  assert.equal(keyFiles.length, 3);
  for (const keyFile of keyFiles) {
    const path = join(result.paths.keys, keyFile);
    assert.ok(!path.startsWith(`${result.paths.room}/`));
    assert.equal((await stat(path)).mode & 0o777, 0o600);
  }
  const verified = rootVerify(result.paths.room);
  assert.equal(verified.status, 0, verified.stderr);
  assert.equal(verified.report.ok, true);
});

test("turns are exact signed envelopes and a one-byte transcript edit is rejected at that event", async () => {
  const home = await newHome();
  const room = await createTestRoom(home, "tamper-test");
  const human = room.genesis.members.find((member) => member.role === "human")!;
  const turn = await postTurn({ roomId: room.roomId, author: human.fingerprint, text: "A signed contract-shaped turn.", home });
  assert.equal(turn.body.kind, "turn");
  assert.deepEqual(Object.keys(turn).sort(), ["author", "body", "createdAt", "hash", "id", "prevHash", "roomId", "seq", "signature", "threadId"].sort());
  assert.deepEqual(Object.keys(turn.body).sort(), ["kind", "text", "usage"].sort());
  assert.deepEqual(await verifyRoom(room.roomId, home).then((value) => value.ok), true);
  const bytes = await readFile(room.paths.transcript);
  const edited = Buffer.from(bytes);
  const needle = Buffer.from("contract-shaped");
  const offset = edited.indexOf(needle);
  assert.ok(offset >= 0);
  edited[offset] = "C".charCodeAt(0);
  await writeFile(room.paths.transcript, edited);
  const rejected = rootVerify(room.paths.room);
  assert.equal(rejected.status, 1);
  assert.equal(rejected.report.ok, false);
  assert.equal((rejected.report.firstFailure as Record<string, unknown>).seq, turn.seq);
});

test("fixture task turns, challenges, and the single permitted verdict stay in the signed log", async () => {
  const home = await newHome();
  const room = await createTestRoom(home, "challenge-test");
  const human = room.genesis.members.find((member) => member.role === "human")!;
  const fixture = room.genesis.members.find((member) => member.role === "harness-agent")!;
  const assigned = await assignTask({ roomId: room.roomId, author: human.fingerprint, recipient: fixture.fingerprint, prompt: "Check the supplied claim.", home });
  assert.equal(assigned.body.kind, "turn");
  const answer = await postTurn({ roomId: room.roomId, author: fixture.fingerprint, text: "The fixture has no live model; this is a scripted response.", home });
  const challenge = await challengeTurn({ roomId: room.roomId, author: human.fingerprint, targetEventId: answer.id, claim: "The cited statement is unsupported.", grounds: "factual", evidence: [{ type: "event", id: assigned.id }], home });
  assert.equal(challenge.body.kind, "challenge");
  const verdict = await resolveChallenge({ roomId: room.roomId, author: fixture.fingerprint, challengeId: challenge.id, outcome: "unproven", rationale: "The fixture supplies no corroborating evidence.", evidence: [{ type: "event", id: answer.id }], home });
  assert.equal(verdict.body.kind, "verdict");
  const count = (await readRoom(room.roomId, home)).events.length;
  await assert.rejects(resolveChallenge({ roomId: room.roomId, author: human.fingerprint, challengeId: challenge.id, outcome: "refuted", rationale: "A second verdict is forbidden.", home }), /one permitted verdict/);
  assert.equal((await readRoom(room.roomId, home)).events.length, count);
  const verified = rootVerify(room.paths.room);
  assert.equal(verified.status, 0, verified.stderr);
  assert.equal(verified.report.ok, true);
});

test("proposal supersedes cite an earlier proposal and canon uses the typed current rule", async () => {
  const home = await newHome();
  const room = await createRoom({ roomId: "canon-test", roomName: "Canon test", members: 3, home });
  const [human, fixture] = [room.genesis.members.find((member) => member.role === "human")!, room.genesis.members.find((member) => member.role === "harness-agent")!];
  const first = await propose({ roomId: room.roomId, author: human.fingerprint, statement: "Prefer concise evidence.", home });
  const replacement = await propose({ roomId: room.roomId, author: fixture.fingerprint, statement: "Prefer cited, concise evidence.", supersedes: first.id, home });
  assert.equal(replacement.body.kind, "proposal");
  const cosignEvent = await cosign({ roomId: room.roomId, author: fixture.fingerprint, proposalId: replacement.id, stance: "support", home });
  const enactment = await enactCanon({ roomId: room.roomId, proposalId: replacement.id, cosigns: [cosignEvent.id], reason: "The proposal met the prior rule.", newRule: { id: "two-supports", minCosigns: 2 }, home });
  assert.equal(enactment.body.kind, "canon");
  assert.deepEqual(enactment.body.kind === "canon" ? enactment.body.newRule : undefined, { id: "two-supports", minCosigns: 2 });
  const before = (await readRoom(room.roomId, home)).events.length;
  await assert.rejects(propose({ roomId: room.roomId, author: human.fingerprint, statement: "Invalid supersession.", supersedes: systemEvent((await readRoom(room.roomId, home)).events).id, home }), /earlier proposal/);
  assert.equal((await readRoom(room.roomId, home)).events.length, before);
  const next = await propose({ roomId: room.roomId, author: human.fingerprint, statement: "Another decision under the new rule.", home });
  const nextCosign = await cosign({ roomId: room.roomId, author: fixture.fingerprint, proposalId: next.id, stance: "support", home });
  const beforeRejectedCanon = (await readRoom(room.roomId, home)).events.length;
  await assert.rejects(enactCanon({ roomId: room.roomId, proposalId: next.id, cosigns: [nextCosign.id], reason: "Insufficient support.", home }), /insufficient supporting cosigns/);
  assert.equal((await readRoom(room.roomId, home)).events.length, beforeRejectedCanon);
  const verified = rootVerify(room.paths.room);
  assert.equal(verified.status, 0, verified.stderr);
  assert.equal(verified.report.ok, true);
});

test("budget pauses are signed, failed output is quarantined without changing the ledger, and fixture membership is self-certified", async () => {
  const home = await newHome();
  const room = await createTestRoom(home, "budget-test");
  const human = room.genesis.members.find((member) => member.role === "human")!;
  const fixture = room.genesis.members.find((member) => member.role === "harness-agent")!;
  const pause = await setBudgetState({ roomId: room.roomId, member: fixture.fingerprint, state: "paused", reason: "human", home });
  assert.equal(pause.body.kind, "budget");
  const before = await readFile(room.paths.transcript);
  await assert.rejects(postTurn({ roomId: room.roomId, author: fixture.fingerprint, text: "Do not leak this rejected text.", home }), /budget is paused/);
  assert.deepEqual(await readFile(room.paths.transcript), before);
  const quarantine = await readFile(room.paths.quarantine, "utf8");
  assert.match(quarantine, /inputSha256/);
  assert.doesNotMatch(quarantine, /Do not leak this rejected text/);
  await setBudgetState({ roomId: room.roomId, member: fixture.fingerprint, state: "resumed", reason: "human", home });
  const output = await postTurn({ roomId: room.roomId, author: fixture.fingerprint, text: "Resumed fixture turn.", home });
  assert.equal(output.body.kind, "turn");
  const joined = await addFixtureMember({ roomId: room.roomId, name: "Temporary fixture", home });
  assert.equal(joined.body.kind, "membership");
  const joinedMember = joined.body.kind === "membership" ? joined.body.member : undefined;
  assert.ok(joinedMember);
  const left = await leaveFixtureMember({ roomId: room.roomId, member: joinedMember.fingerprint, home });
  assert.equal(left.body.kind, "membership");
  const present = await getMembers(room.roomId, home);
  assert.ok(!present.some((member) => member.fingerprint === joinedMember.fingerprint));
  const verified = rootVerify(room.paths.room);
  assert.equal(verified.status, 0, verified.stderr);
  assert.equal(verified.report.ok, true);
  assert.equal(human.role, "human");
});

test("seam checkpoints snapshot the exact current seams before append and re-seal validates latest and historical snapshots", async () => {
  const home = await newHome();
  const room = await createTestRoom(home, "seal-test");
  const first = await markSeam({ roomId: room.roomId, note: "The room changes from speculation to evidence.", spans: [{ fromEventId: systemEvent((await readRoom(room.roomId, home)).events).id, toEventId: systemEvent((await readRoom(room.roomId, home)).events).id }], home });
  assert.equal(first.seam.body.kind, "seam");
  assert.equal(first.seal.body.kind, "seal");
  const snapshotPath = room.paths.snapshot(first.seal.seq);
  assert.deepEqual(await readFile(snapshotPath), await readFile(room.paths.seams));
  assert.equal((await verifyRoom(room.roomId, home)).ok, true);
  const historical = await readFile(snapshotPath);
  const editedSeams = Buffer.from("# Checkpoint note\r\nA later human-maintained seam note — café 🌱\r\n", "utf8");
  await writeFile(room.paths.seams, editedSeams);
  const stale = await verifyRoom(room.roomId, home);
  assert.equal(stale.ok, false);
  assert.match(stale.firstFailure?.reason ?? "", /latest seal seamsSha256 mismatch/);
  const reseal = await writeSeal({ roomId: room.roomId, home });
  assert.equal(reseal.body.kind, "seal");
  assert.deepEqual(await readFile(room.paths.snapshot(reseal.seq)), editedSeams);
  assert.deepEqual(await readFile(snapshotPath), historical);
  assert.equal((await verifyRoom(room.roomId, home)).ok, true);
  const before = await readFile(room.paths.transcript);
  const occupied = room.paths.snapshot((await readRoom(room.roomId, home)).events.length + 1);
  await writeFile(occupied, "preexisting file");
  await assert.rejects(writeSeal({ roomId: room.roomId, home }), /snapshot already exists/);
  assert.deepEqual(await readFile(room.paths.transcript), before);
  const verified = rootVerify(room.paths.room);
  assert.equal(verified.status, 0, verified.stderr);
  assert.equal(verified.report.ok, true);
});

test("exit release requires signed human acceptance and only returns the post-write verified turn", async () => {
  const home = await newHome();
  const room = await createTestRoom(home, "exit-test");
  const human = room.genesis.members.find((member) => member.role === "human")!;
  const fixture = room.genesis.members.find((member) => member.role === "harness-agent")!;
  const output = await postTurn({ roomId: room.roomId, author: fixture.fingerprint, text: "Fixture output to be reviewed.", home });
  const request = await requestExit({ roomId: room.roomId, author: fixture.fingerprint, targetEventId: output.id, destination: "local review", home });
  const preview = await previewExit(room.roomId, request.id, home);
  assert.equal(preview.output, "Fixture output to be reviewed.");
  await assert.rejects(releaseExit({ roomId: room.roomId, requestEventId: request.id, home }), /prior signed acceptance/);
  const decision = await decideExit({ roomId: room.roomId, requestEventId: request.id, decision: "accept", reviewedHeadHash: preview.reviewedHeadHash, note: "Reviewed locally.", home });
  assert.equal(decision.body.kind, "turn");
  const released = await releaseExit({ roomId: room.roomId, requestEventId: request.id, home });
  assert.equal(released.event.body.kind, "turn");
  assert.equal(released.text, output.body.kind === "turn" ? output.body.text : "");
  assert.equal((await verifyRoom(room.roomId, home)).ok, true);
  assert.equal(human.role, "human");
});
