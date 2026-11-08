import { createPrivateKey, createPublicKey, generateKeyPairSync } from "node:crypto";
import { chmod, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { publicKeyFingerprint } from "./canonical.ts";
import type { Fingerprint, Identity, MemberSpec, RoomId } from "./types.ts";

function privatePath(keysDirectory: string, roomId: RoomId, fingerprint: Fingerprint): string {
  return join(keysDirectory, `${roomId}.${fingerprint}.private.pem`);
}

export async function createIdentity(keysDirectory: string, roomId: RoomId): Promise<Identity> {
  await mkdir(keysDirectory, { recursive: true, mode: 0o700 });
  await chmod(keysDirectory, 0o700);
  const pair = generateKeyPairSync("ed25519");
  const publicDer = pair.publicKey.export({ format: "der", type: "spki" });
  const publicKey = publicDer.toString("base64url");
  const fingerprint = publicKeyFingerprint(publicKey);
  const privateKeyPath = privatePath(keysDirectory, roomId, fingerprint);
  const pem = pair.privateKey.export({ format: "pem", type: "pkcs8" }).toString();
  await writeFile(privateKeyPath, pem, { encoding: "utf8", flag: "wx", mode: 0o600 });
  await chmod(privateKeyPath, 0o600);
  return { fingerprint, publicKey, privateKey: pair.privateKey, privateKeyPath };
}

export async function loadIdentity(keysDirectory: string, roomId: RoomId, member: MemberSpec): Promise<Identity> {
  const privateKeyPath = privatePath(keysDirectory, roomId, member.fingerprint);
  const info = await stat(privateKeyPath);
  if ((info.mode & 0o077) !== 0) throw new Error("Private identity file permissions are too open");
  const pem = await readFile(privateKeyPath, "utf8");
  const privateKey = createPrivateKey(pem);
  const publicKeyObject = createPublicKey(privateKey);
  const publicDer = publicKeyObject.export({ format: "der", type: "spki" });
  const publicKey = publicDer.toString("base64url");
  const fingerprint = publicKeyFingerprint(publicKey);
  if (fingerprint !== member.fingerprint || publicKey !== member.publicKey) throw new Error("Private identity does not match the member's public key and fingerprint");
  return { fingerprint, publicKey, privateKey, privateKeyPath };
}
