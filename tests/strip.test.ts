import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { after, test } from "node:test";
import { canonicalJson } from "../src/canonical.ts";
import { readRoom } from "../src/ledger.ts";
import { MAX_TEXT_CHARS } from "../src/limits.ts";
import { createRoom, postTurn, setBudgetState } from "../src/room.ts";
import { ASSUMED_USD_PER_MILLION_TOKENS, HEADER_BLOCK_END, HEADER_BLOCK_START, stripPaste, type StripReceipt } from "../src/strip.ts";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const fixtureRoot = join(projectRoot, "tests/fixtures");
const roots: string[] = [];
const frozenVerifierSha256 = "888152785e0cc958dc927718f1a56a3aaf276fea423fc8b4d4211845f66503ff";
const frozenContractSha256 = "f2944f94d951af8242df27663048f3cd126b92bf963a69b67e204952318bab1e";

async function newHome(): Promise<string> {
  const home = await mkdtemp(join(tmpdir(), "the-room-strip-test-"));
  roots.push(home);
  return home;
}

function digest(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

async function loadFixture(name: string): Promise<string> {
  return readFile(join(fixtureRoot, `strip-${name}.md`), "utf8");
}

function assertSubsequence(output: string, input: string): void {
  const source = Array.from(input);
  let cursor = 0;
  for (const character of Array.from(output)) {
    const found = source.indexOf(character, cursor);
    assert.notEqual(found, -1, `Output character ${JSON.stringify(character)} is not a source subsequence`);
    cursor = found + 1;
  }
}

after(async () => {
  await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })));
});

test("log-tail fixture removes only declared trailing tool framing and keeps signal bytes exact", async () => {
  const input = await loadFixture("log-tail");
  const result = stripPaste(input);
  const expected = "Signal: keep this exact sentence.\nPunctuation remains: café — naïve; 🧭.\n";
  assert.equal(result.text, expected);
  assert.equal(result.receipt.linesRemoved, 2);
  assert.deepEqual(result.receipt.rulesApplied, ["trailing-tool-log-tail"]);
  assert.equal(result.receipt.originalSha256, digest(Buffer.from(input, "utf8")));
  assert.equal(result.receipt.strippedSha256, digest(Buffer.from(expected, "utf8")));
});

test("repeated-header fixture removes only the duplicate marked block", async () => {
  const input = await loadFixture("repeated-headers");
  const result = stripPaste(input);
  const expected = "Opening signal stays.\n<!-- ROOM HEADER START -->\nRoom: The Room\nThread: core\n<!-- ROOM HEADER END -->\nClosing signal stays byte-for-byte.\n";
  assert.equal(result.text, expected);
  assert.equal(result.receipt.linesRemoved, 4);
  assert.deepEqual(result.receipt.rulesApplied, ["duplicate-header-block"]);
  assert.equal(result.text.split("\n").filter((line) => line === "Opening signal stays." || line === "Closing signal stays byte-for-byte.").length, 2);
});

test("mixed fixture removes one duplicate header, one repeated status block, and only the trailing log tail", async () => {
  const input = await loadFixture("mixed");
  const result = stripPaste(input);
  const expected = "Mixed fixture signal: preserve this line exactly.\n<!-- ROOM HEADER START -->\nRoom: The Room\nThread: core\n<!-- ROOM HEADER END -->\n--- ROOM STATUS ---\nhead: 42\nstate: active\n--- END ROOM STATUS ---\n";
  assert.equal(result.text, expected);
  assert.equal(result.receipt.linesRemoved, 10);
  assert.deepEqual(result.receipt.rulesApplied, ["duplicate-header-block", "trailing-tool-log-tail", "duplicate-status-block"]);
  assert.equal(result.receipt.originalBytes, Buffer.byteLength(input, "utf8"));
  assert.equal(result.receipt.strippedBytes, Buffer.byteLength(expected, "utf8"));
});

test("unknown content and a very long non-matching line pass through byte-identically", () => {
  const input = `Do not interpret or rewrite this line.\r\n${"x".repeat(MAX_TEXT_CHARS + 1)}\r\nUnrecognized trailer: preserve it.\r\n`;
  const result = stripPaste(input);
  assert.equal(result.text, input);
  assert.equal(result.receipt.linesRemoved, 0);
  assert.deepEqual(result.receipt.rulesApplied, []);
  assert.equal(result.receipt.originalBytes, Buffer.byteLength(input, "utf8"));
  assert.equal(result.receipt.strippedBytes, result.receipt.originalBytes);
});

test("clean turns pass unchanged and receipts are exact, event-linked, and hash-chained", async () => {
  const home = await newHome();
  const created = await createRoom({ roomId: "strip-receipt", roomName: "Strip receipt test", home });
  const human = created.members.find((member) => member.role === "human");
  assert.ok(human);
  const clean = "A clean signal — unchanged.\nSecond line.\n";
  const firstTurn = await postTurn({ roomId: created.roomId, author: human.fingerprint, text: clean, home });
  assert.equal(firstTurn.body.kind, "turn");
  if (firstTurn.body.kind !== "turn") return;
  assert.equal(firstTurn.body.text, clean);
  const firstPath = join(created.paths.room, `receipts.${firstTurn.seq}.jsonl`);
  const firstRecord = JSON.parse(await readFile(firstPath, "utf8")) as {
    eventId: string;
    eventSeq: number;
    receipt: StripReceipt;
    previousReceiptHash: string;
    receiptHash: string;
  };
  assert.equal(firstRecord.eventId, firstTurn.id);
  assert.equal(firstRecord.eventSeq, firstTurn.seq);
  assert.deepEqual(firstRecord.receipt, {
    originalSha256: digest(Buffer.from(clean, "utf8")),
    strippedSha256: digest(Buffer.from(clean, "utf8")),
    originalBytes: Buffer.byteLength(clean, "utf8"),
    strippedBytes: Buffer.byteLength(clean, "utf8"),
    linesRemoved: 0,
    rulesApplied: [],
    ruleSet: "wrapper",
    linesBefore: 2,
    linesAfter: 2,
    estimatedTokensBefore: 11,
    estimatedTokensAfter: 11,
    estimatedCostMicroDollarsBefore: 55,
    estimatedCostMicroDollarsAfter: 55,
  });
  assert.equal(firstRecord.previousReceiptHash, "0".repeat(64));
  const firstPayload = {
    eventId: firstRecord.eventId,
    eventSeq: firstRecord.eventSeq,
    receipt: firstRecord.receipt,
    previousReceiptHash: firstRecord.previousReceiptHash,
  };
  assert.equal(firstRecord.receiptHash, digest(canonicalJson(firstPayload)));
  assert.equal(Object.hasOwn(firstRecord, "text"), false);

  const secondInput = await loadFixture("log-tail");
  const secondTurn = await postTurn({ roomId: created.roomId, author: human.fingerprint, text: secondInput, home });
  assert.equal(secondTurn.body.kind, "turn");
  if (secondTurn.body.kind !== "turn") return;
  const secondPath = join(created.paths.room, `receipts.${secondTurn.seq}.jsonl`);
  const secondRecord = JSON.parse(await readFile(secondPath, "utf8")) as typeof firstRecord;
  assert.equal(secondRecord.eventId, secondTurn.id);
  assert.equal(secondRecord.previousReceiptHash, firstRecord.receiptHash);
  assert.equal(secondRecord.receipt.originalSha256, digest(Buffer.from(secondInput, "utf8")));
  assert.equal(secondRecord.receipt.strippedSha256, digest(Buffer.from(secondTurn.body.text, "utf8")));
  assert.equal(secondRecord.receipt.originalBytes, Buffer.byteLength(secondInput, "utf8"));
  assert.equal(secondRecord.receipt.strippedBytes, Buffer.byteLength(secondTurn.body.text, "utf8"));
  const secondPayload = {
    eventId: secondRecord.eventId,
    eventSeq: secondRecord.eventSeq,
    receipt: secondRecord.receipt,
    previousReceiptHash: secondRecord.previousReceiptHash,
  };
  assert.equal(secondRecord.receiptHash, digest(canonicalJson(secondPayload)));
  const verification = await import("../src/ledger.ts").then(({ verifyRoom }) => verifyRoom(created.roomId, home));
  assert.equal(verification.ok, true, JSON.stringify(verification));
  const data = await readRoom(created.roomId, home);
  assert.equal(data.events.length, 3);
  assert.equal(ASSUMED_USD_PER_MILLION_TOKENS, 5);
});

test("oversize input is rejected before stripping even when duplicate removal would bring it under the limit", async () => {
  const home = await newHome();
  const created = await createRoom({ roomId: "strip-oversize", roomName: "Strip oversize test", home });
  const human = created.members.find((member) => member.role === "human");
  assert.ok(human);
  const block = `${HEADER_BLOCK_START}\n${"x".repeat(Math.ceil(MAX_TEXT_CHARS * 0.6))}\n${HEADER_BLOCK_END}\n`;
  const oversized = `${block}${block}`;
  assert.ok(oversized.length > MAX_TEXT_CHARS);
  assert.ok(stripPaste(oversized).text.length < MAX_TEXT_CHARS);
  await assert.rejects(postTurn({ roomId: created.roomId, author: human.fingerprint, text: oversized, home }), new RegExp(`Turn text must be 1–${MAX_TEXT_CHARS} characters`));
  const data = await readRoom(created.roomId, home);
  assert.equal(data.events.length, 1);
  assert.deepEqual((await readdir(created.paths.room)).filter((name) => name.startsWith("receipts.")), []);
});

test("a policy-rejected turn remains rejected before its strip receipt can be admitted", async () => {
  const home = await newHome();
  const created = await createRoom({ roomId: "strip-paused", roomName: "Strip paused test", home });
  const human = created.members.find((member) => member.role === "human");
  assert.ok(human);
  await setBudgetState({ roomId: created.roomId, member: human.fingerprint, state: "paused", reason: "human", home });
  const input = await loadFixture("mixed");
  await assert.rejects(postTurn({ roomId: created.roomId, author: human.fingerprint, text: input, home }), /member budget is paused/);
  const data = await readRoom(created.roomId, home);
  assert.equal(data.events.length, 2);
  assert.deepEqual((await readdir(created.paths.room)).filter((name) => name.startsWith("receipts.")), []);
});

test("strip-demo spawns a room that the frozen root verifier accepts", async () => {
  const home = await newHome();
  const cli = spawnSync(process.execPath, [join(projectRoot, "src/cli.ts"), "strip-demo", "--fixture", "log-tail", "--home", home], {
    cwd: projectRoot,
    encoding: "utf8",
  });
  assert.equal(cli.error, undefined, cli.error?.message);
  assert.equal(cli.status, 0, `${cli.stdout}\n${cli.stderr}`);
  assert.match(cli.stdout, /Tokens ESTIMATE \(chars\/4\):/);
  assert.match(cli.stdout, /Dollars ESTIMATE \(ASSUMPTION: \$5\/1M estimated tokens; integer micro-dollar arithmetic\): \$0\.000/);
  const roomId = cli.stdout.match(/^Room ID: (.+)$/m)?.[1];
  assert.ok(roomId);
  const roomPath = join(home, "rooms", roomId);
  const verifier = spawnSync(process.execPath, [join(projectRoot, "verify.ts"), roomPath], {
    cwd: projectRoot,
    encoding: "utf8",
  });
  assert.equal(verifier.error, undefined, verifier.error?.message);
  assert.equal(verifier.status, 0, `${verifier.stdout}\n${verifier.stderr}`);
  const report = JSON.parse(verifier.stdout.trim()) as { ok: boolean; events: number };
  assert.deepEqual(report.ok, true);
  assert.equal(report.events, 2);
  assert.equal(digest(await readFile(join(projectRoot, "verify.ts"))), frozenVerifierSha256);
  assert.equal(digest(await readFile(join(projectRoot, "ROOM-CONTRACT.md"))), frozenContractSha256);
});

test("filler fixture strips the specified leading, request, and trailing frames without capitalization", async () => {
  const input = await loadFixture("filler");
  const result = stripPaste(input);
  assert.equal(result.text, "update the readme");
  assert.deepEqual(result.receipt.rulesApplied, ["F1", "F2", "F3"]);
  assert.equal(result.receipt.ruleSet, "filler");
  assertSubsequence(result.text, input);
});

test("protected fixture preserves code, quotes, URLs, paths, filenames, identifiers, and JSON", async () => {
  const input = await loadFixture("protected");
  const expected = [
    "preserve these exact literals:",
    "Inline code: `please`.",
    "Fenced code:",
    "```text",
    "please, could you leave this code alone",
    "```",
    "Quoted values: \"please\" and 'thanks'.",
    "URL: https://example.test/please/thanks?please=thanks",
    "Paths and names: ./docs/please/README.md and /tmp/please.txt",
    "Identifiers: pleaseCamelCase and PleasePascalCase.",
    'JSON: {"request":"please","status":"thanks","note":"could you please keep"}',
  ].join("\n");
  const result = stripPaste(input);
  assert.equal(result.text, expected);
  assert.deepEqual(result.receipt.rulesApplied, ["F1", "F2"]);
  assert.equal(result.receipt.ruleSet, "filler");
  assertSubsequence(result.text, input);
});

test("softener fixture removes each declared F3 phrase exactly", async () => {
  const input = await loadFixture("frames");
  const expected = [
    "check the first log.",
    "read the note.",
    "update the index.",
    "confirm the path.",
    "run the tests.",
    "copy the receipt.",
    "verify the chain.",
    "count the lines.",
    "inspect the tree.",
  ].join("\n");
  const result = stripPaste(input);
  assert.equal(result.text, expected);
  assert.deepEqual(result.receipt.rulesApplied, ["F3"]);
  assert.equal(result.receipt.ruleSet, "filler");
  assertSubsequence(result.text, input);
});

test("padding fixture applies F4 and deletion-only punctuation and whitespace repairs", async () => {
  const input = await loadFixture("padding");
  const expected = [
    "keep this text.",
    "read the file.",
    "verify the chain.",
    "to preserve evidence, store the receipt.",
    "keep this",
  ].join("\n");
  const result = stripPaste(input);
  assert.equal(result.text, expected);
  assert.deepEqual(result.receipt.rulesApplied, ["F1", "F2", "F4"]);
  assert.equal(result.receipt.ruleSet, "filler");
  assert.equal(result.receipt.linesBefore, 6);
  assert.equal(result.receipt.linesAfter, 5);
  assertSubsequence(result.text, input);
});

test("combined fixture applies wrapper stripping before filler stripping and records both rule sets", async () => {
  const input = await loadFixture("combined");
  const expected = [
    "read the room note",
    "<!-- ROOM HEADER START -->",
    "Room: The Room",
    "Thread: core",
    "<!-- ROOM HEADER END -->",
  ].join("\n");
  const result = stripPaste(input);
  assert.equal(result.text, expected);
  assert.deepEqual(result.receipt.rulesApplied, ["duplicate-header-block", "trailing-tool-log-tail", "F1", "F2", "F3"]);
  assert.equal(result.receipt.ruleSet, "both");
  assert.equal(result.receipt.linesRemoved, 6);
  assertSubsequence(result.text, input);
});

test("every wrapper, filler, and combined fixture output is an exact input subsequence", async () => {
  for (const name of ["log-tail", "repeated-headers", "mixed", "filler", "protected", "frames", "padding", "combined"]) {
    const input = await loadFixture(name);
    assertSubsequence(stripPaste(input).text, input);
  }
});

test("strip-demo accepts filler and combined fixtures and their rooms pass the frozen verifier", async () => {
  for (const fixture of ["filler", "combined"]) {
    const home = await newHome();
    const cli = spawnSync(process.execPath, [join(projectRoot, "src/cli.ts"), "strip-demo", "--fixture", fixture, "--home", home], {
      cwd: projectRoot,
      encoding: "utf8",
    });
    assert.equal(cli.error, undefined, cli.error?.message);
    assert.equal(cli.status, 0, `${fixture}: ${cli.stdout}\n${cli.stderr}`);
    assert.match(cli.stdout, new RegExp(`Rule set: ${fixture === "combined" ? "both" : "filler"}`));
    assert.match(cli.stdout, /Dollars ESTIMATE \(ASSUMPTION: \$5\/1M estimated tokens; integer micro-dollar arithmetic\): \$\d+\.\d{6} -> \$\d+\.\d{6}/);
    assert.doesNotMatch(cli.stdout, /saved \$/);
    const roomId = cli.stdout.match(/^Room ID: (.+)$/m)?.[1];
    assert.ok(roomId);
    const verifier = spawnSync(process.execPath, [join(projectRoot, "verify.ts"), join(home, "rooms", roomId)], {
      cwd: projectRoot,
      encoding: "utf8",
    });
    assert.equal(verifier.error, undefined, verifier.error?.message);
    assert.equal(verifier.status, 0, `${fixture}: ${verifier.stdout}\n${verifier.stderr}`);
    assert.deepEqual((JSON.parse(verifier.stdout.trim()) as { ok: boolean }).ok, true);
  }
});

test("F1/F2 variants are case-insensitive and whole-phrase while preserving every kept character", () => {
  for (const frame of ["could you please", "can you please", "would you please", "will you please", "would you mind", "could you", "can you", "would you", "will you", "kindly", "please"]) {
    const input = `Earlier text.\n${frame} send it.`;
    const result = stripPaste(input);
    assert.equal(result.text, "Earlier text.\nsend it.", frame);
    assert.ok(result.receipt.rulesApplied.includes("F2"), frame);
    assertSubsequence(result.text, input);
  }

  const uppercase = "Earlier text.\nCOULD YOU PLEASE send it.";
  const uppercaseResult = stripPaste(uppercase);
  assert.equal(uppercaseResult.text, "Earlier text.\nsend it.");
  assertSubsequence(uppercaseResult.text, uppercase);

  const leading = "PLEASE, keep this casing.";
  const leadingResult = stripPaste(leading);
  assert.equal(leadingResult.text, "keep this casing.");
  assertSubsequence(leadingResult.text, leading);

  for (const courtesy of ["thanks", "thanks!", "thanks.", "thank you", "thank you!", "thank you so much", "thank you so much.", "thanks so much", "thanks so much!"]) {
    const input = `Keep this ${courtesy}`;
    const result = stripPaste(input);
    assert.equal(result.text, "Keep this", courtesy);
    assert.ok(result.receipt.rulesApplied.includes("F1"), courtesy);
    assertSubsequence(result.text, input);
  }

  for (const input of ["A pleased reader.", "We say please in the note."]) {
    const result = stripPaste(input);
    assert.equal(result.text, input);
    assert.deepEqual(result.receipt.rulesApplied, []);
  }
});
