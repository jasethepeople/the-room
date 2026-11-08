import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { after, test } from "node:test";
import {
  addOllamaMember,
  assignTask,
  createRoom,
  postTurn,
  readRoom,
  runAssignedTask,
  verifyRoom,
} from "../src/index.ts";
import {
  OllamaUnavailableError,
  generateOllamaDraft,
  probeOllamaModels,
  resolveOllamaSettings,
  selectOllamaModel,
} from "../src/ollama.ts";

const fixtureDirectory = resolve(dirname(fileURLToPath(import.meta.url)), "fixtures");
const temporaryHomes: string[] = [];
const stubServers: Server[] = [];

after(async () => {
  await Promise.all(stubServers.map((server) => closeServer(server)));
  await Promise.all(temporaryHomes.map((home) => rm(home, { recursive: true, force: true })));
});

async function newHome(): Promise<string> {
  const home = await mkdtemp(join(tmpdir(), "the-room-live-member-test-"));
  temporaryHomes.push(home);
  return home;
}

function sendJson(response: ServerResponse, status: number, value: unknown): void {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(value));
}

async function requestBody(request: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  return JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolveClose, reject) => {
    if (!server.listening) {
      resolveClose();
      return;
    }
    server.close((error) => error ? reject(error) : resolveClose());
  });
}

async function startOllamaStub(options: {
  modelName?: string;
  responseText?: string;
  promptTokens?: number;
  outputTokens?: number;
  beforeGenerate?: () => Promise<void>;
} = {}): Promise<{ host: string; calls: Array<{ method: string; path: string; body?: Record<string, unknown> }> }> {
  const calls: Array<{ method: string; path: string; body?: Record<string, unknown> }> = [];
  const modelName = options.modelName ?? "STUB-model-not-installed";
  const server = createServer(async (request, response) => {
    try {
      if (request.method === "GET" && request.url === "/api/tags") {
        calls.push({ method: request.method, path: request.url });
        sendJson(response, 200, { models: [{ name: modelName }] });
        return;
      }
      if (request.method === "POST" && request.url === "/api/generate") {
        const body = await requestBody(request);
        calls.push({ method: request.method, path: request.url, body });
        await options.beforeGenerate?.();
        sendJson(response, 200, {
          response: options.responseText ?? "A direct result.",
          done: true,
          prompt_eval_count: options.promptTokens ?? 9,
          eval_count: options.outputTokens ?? 4,
        });
        return;
      }
      sendJson(response, 404, { error: "STUB endpoint not implemented" });
    } catch {
      if (!response.headersSent) sendJson(response, 500, { error: "STUB request handling failed" });
      else response.destroy();
    }
  });
  stubServers.push(server);
  await new Promise<void>((resolveListen, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.removeListener("error", reject);
      resolveListen();
    });
  });
  const address = server.address() as AddressInfo;
  return { host: `http://127.0.0.1:${address.port}`, calls };
}

async function closedLoopbackHost(): Promise<string> {
  const server = createServer();
  await new Promise<void>((resolveListen, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.removeListener("error", reject);
      resolveListen();
    });
  });
  const address = server.address() as AddressInfo;
  await closeServer(server);
  return `http://127.0.0.1:${address.port}`;
}

async function setupLiveMember(budgetTokens: number): Promise<{
  home: string;
  roomId: string;
  humanFingerprint: string;
  memberFingerprint: string;
}> {
  const home = await newHome();
  const room = await createRoom({ roomId: "live-member-test", roomName: "Live member test room", home });
  const human = room.members.find((member) => member.role === "human");
  assert.ok(human);
  await addOllamaMember({ roomId: room.roomId, name: "Local Ollama Member", budgetTokens, home });
  const live = (await readRoom(room.roomId, home)).genesis.members.concat(
    (await readRoom(room.roomId, home)).events.flatMap((event) => event.body.kind === "membership" && event.body.action === "join" ? [event.body.member] : []),
  ).find((member) => member.modelId === "ollama:runtime");
  assert.ok(live);
  return { home, roomId: room.roomId, humanFingerprint: human.fingerprint, memberFingerprint: live.fingerprint };
}

async function makeAssignment(input: {
  home: string;
  roomId: string;
  humanFingerprint: string;
  memberFingerprint: string;
  prompt: string;
}): Promise<string> {
  const assignment = await assignTask({
    roomId: input.roomId,
    author: input.humanFingerprint,
    recipient: input.memberFingerprint,
    prompt: input.prompt,
    home: input.home,
  });
  return assignment.id;
}

test("a room refuses a second Ollama-backed member", async () => {
  const context = await setupLiveMember(1000);
  const before = await readRoom(context.roomId, context.home);
  await assert.rejects(addOllamaMember({ roomId: context.roomId, name: "Second Local Member", budgetTokens: 1000, home: context.home }), /already has its one Ollama-backed member/);
  assert.equal((await readRoom(context.roomId, context.home)).events.length, before.events.length);
});

test("STUB Ollama draft flows from the existing assignment to one admitted signed turn", async () => {
  const context = await setupLiveMember(1000);
  const assignmentEventId = await makeAssignment({ ...context, prompt: "Review the assigned note." });
  const stub = await startOllamaStub();
  const result = await runAssignedTask({
    roomId: context.roomId,
    member: context.memberFingerprint,
    assignmentEventId,
    ollamaHost: stub.host,
    home: context.home,
  });
  assert.equal(result.status, "admitted");
  if (result.status !== "admitted") return;
  assert.equal(result.model, "STUB-model-not-installed");
  assert.equal(result.assignmentEventId, assignmentEventId);
  assert.equal(result.event.body.kind, "turn");
  if (result.event.body.kind !== "turn") return;
  assert.equal(result.event.body.text, "A direct result.");
  assert.deepEqual(result.event.body.usage, { inputTokens: 9, outputTokens: 4 });
  assert.deepEqual(stub.calls.map((call) => call.path), ["/api/tags", "/api/generate"]);
  assert.equal(stub.calls.filter((call) => call.path === "/api/generate").length, 1);
  assert.equal(stub.calls[1]?.body?.model, "STUB-model-not-installed");
  assert.equal(stub.calls[1]?.body?.prompt, "Review the assigned note.");
  const data = await readRoom(context.roomId, context.home);
  assert.ok(data.events.some((event) => event.id === result.event.id && event.author === context.memberFingerprint));
  assert.equal((await verifyRoom(context.roomId, context.home)).ok, true);
});

test("STUB Ollama measured usage beyond the assigned member budget is rejected without admission or retry", async () => {
  const context = await setupLiveMember(8);
  const assignmentEventId = await makeAssignment({ ...context, prompt: "Short task." });
  const before = await readRoom(context.roomId, context.home);
  const stub = await startOllamaStub({ promptTokens: 7, outputTokens: 2 });
  await assert.rejects(runAssignedTask({
    roomId: context.roomId,
    member: context.memberFingerprint,
    assignmentEventId,
    ollamaHost: stub.host,
    home: context.home,
  }), /assigned token budget/);
  const after = await readRoom(context.roomId, context.home);
  assert.equal(after.events.length, before.events.length);
  assert.equal(stub.calls.filter((call) => call.path === "/api/generate").length, 1);
  const options = stub.calls.find((call) => call.path === "/api/generate")?.body?.options as Record<string, unknown> | undefined;
  assert.equal(options?.num_predict, 5);
});

test("STUB Ollama draft loses a concurrent budget race and the locked ledger rejects admission", async () => {
  const context = await setupLiveMember(20);
  const assignmentEventId = await makeAssignment({ ...context, prompt: "Short task." });
  const before = await readRoom(context.roomId, context.home);
  const stub = await startOllamaStub({
    promptTokens: 7,
    outputTokens: 2,
    beforeGenerate: async () => {
      await postTurn({
        roomId: context.roomId,
        author: context.memberFingerprint,
        text: "Concurrent budget use.",
        inputTokens: 10,
        outputTokens: 6,
        home: context.home,
      });
    },
  });
  await assert.rejects(runAssignedTask({
    roomId: context.roomId,
    member: context.memberFingerprint,
    assignmentEventId,
    ollamaHost: stub.host,
    home: context.home,
  }), /member token budget exceeded/);
  const after = await readRoom(context.roomId, context.home);
  assert.equal(after.events.length, before.events.length + 1);
  const latest = after.events.at(-1);
  assert.equal(latest?.body.kind, "turn");
  if (latest?.body.kind === "turn") assert.equal(latest.body.text, "Concurrent budget use.");
  assert.equal(stub.calls.filter((call) => call.path === "/api/generate").length, 1);
});

test("STUB Ollama down path reports NOT AVAILABLE and writes nothing to the ledger", async () => {
  const context = await setupLiveMember(1000);
  const assignmentEventId = await makeAssignment({ ...context, prompt: "Review the assigned note." });
  const before = await readRoom(context.roomId, context.home);
  const result = await runAssignedTask({
    roomId: context.roomId,
    member: context.memberFingerprint,
    assignmentEventId,
    ollamaHost: await closedLoopbackHost(),
    home: context.home,
  });
  assert.equal(result.status, "not-available");
  if (result.status === "not-available") assert.match(result.reason, /not reachable/i);
  assert.equal((await readRoom(context.roomId, context.home)).events.length, before.events.length);
});

test("live member verifies the assignment chain before contacting Ollama", async () => {
  const context = await setupLiveMember(1000);
  const assignmentEventId = await makeAssignment({ ...context, prompt: "Review the assigned note." });
  const transcriptPath = (await readRoom(context.roomId, context.home)).paths.transcript;
  const acceptedTranscript = await readFile(transcriptPath, "utf8");
  const corruptedTranscript = acceptedTranscript.replace("Review the assigned note.", "Review the assigned note!");
  assert.notEqual(corruptedTranscript, acceptedTranscript);
  await import("node:fs/promises").then(({ writeFile }) => writeFile(transcriptPath, corruptedTranscript));
  const stub = await startOllamaStub();
  await assert.rejects(runAssignedTask({
    roomId: context.roomId,
    member: context.memberFingerprint,
    assignmentEventId,
    ollamaHost: stub.host,
    home: context.home,
  }), /room verification failed/);
  assert.equal(stub.calls.length, 0);
  assert.equal(await readFile(transcriptPath, "utf8"), corruptedTranscript);
});

test("STUB Ollama admissions retain wrapper stripping before filler stripping", async () => {
  const context = await setupLiveMember(1000);
  const assignmentEventId = await makeAssignment({ ...context, prompt: "Apply the normal admission rules." });
  const responseText = await readFile(join(fixtureDirectory, "strip-combined.md"), "utf8");
  const stub = await startOllamaStub({ responseText });
  const result = await runAssignedTask({
    roomId: context.roomId,
    member: context.memberFingerprint,
    assignmentEventId,
    ollamaHost: stub.host,
    home: context.home,
  });
  assert.equal(result.status, "admitted");
  if (result.status !== "admitted" || result.event.body.kind !== "turn") return;
  assert.equal(result.event.body.text, "read the room note\n<!-- ROOM HEADER START -->\nRoom: The Room\nThread: core\n<!-- ROOM HEADER END -->");
  const sidecarPath = join((await readRoom(context.roomId, context.home)).paths.room, `receipts.${result.event.seq}.jsonl`);
  const sidecar = JSON.parse(await readFile(sidecarPath, "utf8")) as { receipt: { ruleSet: string; rulesApplied: string[] } };
  assert.equal(sidecar.receipt.ruleSet, "both");
  assert.ok(sidecar.receipt.rulesApplied.includes("duplicate-header-block"));
  assert.ok(sidecar.receipt.rulesApplied.includes("F1"));
  assert.equal((await verifyRoom(context.roomId, context.home)).ok, true);
});

test("optional live Ollama generation reports NOT RUN when no usable local model is available", async (context) => {
  const settings = resolveOllamaSettings({});
  let models: string[];
  try {
    models = await probeOllamaModels(settings.host);
  } catch (error) {
    if (!(error instanceof OllamaUnavailableError)) throw error;
    context.skip(`NOT RUN: ${error.message}`);
    return;
  }
  let model: string;
  try {
    model = selectOllamaModel(models, settings.model);
  } catch (error) {
    if (!(error instanceof OllamaUnavailableError)) throw error;
    context.skip(`NOT RUN: ${error.message}`);
    return;
  }
  const draft = await generateOllamaDraft({
    host: settings.host,
    model,
    prompt: "Reply with a brief acknowledgement.",
    maxOutputTokens: 16,
  });
  assert.ok(draft.text.trim());
  assert.ok(Number.isSafeInteger(draft.usage.inputTokens));
  assert.ok(Number.isSafeInteger(draft.usage.outputTokens));
});
