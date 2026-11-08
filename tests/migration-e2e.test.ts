import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { after, test } from "node:test";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const roots: string[] = [];
const frozenVerifierSha256 = "888152785e0cc958dc927718f1a56a3aaf276fea423fc8b4d4211845f66503ff";

async function newHome(): Promise<string> {
  const home = await mkdtemp(join(tmpdir(), "the-room-cli-e2e-"));
  roots.push(home);
  return home;
}

after(async () => {
  await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })));
});

test("migrated CLI-spawned room passes the unchanged root verifier", async () => {
  const home = await newHome();
  const spawned = spawnSync(process.execPath, [join(projectRoot, "src/cli.ts"), "spawn", "migration-e2e", "CLI spawned room", "--home", home], {
    cwd: projectRoot,
    encoding: "utf8",
  });
  assert.equal(spawned.error, undefined, spawned.error?.message);
  assert.equal(spawned.status, 0, `${spawned.stdout}\n${spawned.stderr}`);
  const result = JSON.parse(spawned.stdout.trim()) as { roomId: string; roomPath: string; verification: { ok: boolean } };
  assert.match(result.roomId, /^[a-z0-9]+(?:-[a-z0-9]+)*-[0-9a-f]{8}$/);
  assert.equal(result.verification.ok, true);

  const verifier = spawnSync(process.execPath, [join(projectRoot, "verify.ts"), result.roomPath], {
    cwd: projectRoot,
    encoding: "utf8",
  });
  assert.equal(verifier.error, undefined, verifier.error?.message);
  assert.equal(verifier.status, 0, `${verifier.stdout}\n${verifier.stderr}`);
  const report = JSON.parse(verifier.stdout.trim()) as { ok: boolean; events: number; firstFailure?: unknown };
  assert.equal(report.ok, true, JSON.stringify(report));
  assert.equal(report.events, 1);

  const verifierBytes = await readFile(join(projectRoot, "verify.ts"));
  assert.equal(createHash("sha256").update(verifierBytes).digest("hex"), frozenVerifierSha256);
});
