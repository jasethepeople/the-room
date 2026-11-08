import { createHash, createPublicKey, randomBytes } from "node:crypto";
import type { EventId, Fingerprint, RoomId } from "./types.ts";

function validUnicode(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return false;
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return false;
    }
  }
  return true;
}

export function canonicalJson(value: unknown): string {
  if (value === null || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "string") {
    if (!validUnicode(value)) throw new Error("Invalid Unicode string");
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value)) throw new Error("Canonical room data permits safe integers only");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    const keys = Object.keys(record).sort();
    for (const key of keys) if (!validUnicode(key)) throw new Error("Invalid Unicode object key");
    return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(",")}}`;
  }
  throw new Error("Unsupported canonical JSON value");
}

export function sha256(value: Uint8Array | string): string {
  return createHash("sha256").update(value).digest("hex");
}

export function decodeBase64Url(value: string): Buffer {
  if (!value || !/^[A-Za-z0-9_-]+$/.test(value)) throw new Error("Expected unpadded base64url");
  const bytes = Buffer.from(value, "base64url");
  if (bytes.toString("base64url") !== value) throw new Error("Non-canonical base64url");
  return bytes;
}

export function publicKeyFingerprint(publicKey: string): Fingerprint {
  const der = decodeBase64Url(publicKey);
  const key = createPublicKey({ key: der, format: "der", type: "spki" });
  if (key.asymmetricKeyType !== "ed25519") throw new Error("Expected an Ed25519 public key");
  return sha256(der);
}

export function uuid7(): EventId {
  const bytes = randomBytes(16);
  let timestamp = BigInt(Date.now());
  for (let index = 5; index >= 0; index -= 1) {
    bytes[index] = Number(timestamp & 0xffn);
    timestamp >>= 8n;
  }
  bytes[6] = (bytes[6]! & 0x0f) | 0x70;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export function isRoomId(value: string): value is RoomId {
  return /^[a-z0-9]+(?:-[a-z0-9]+)*-[0-9a-f]{8}$/.test(value);
}

export function newRoomId(value: string): RoomId {
  const slug = value.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  if (!slug) throw new Error("Room id must contain at least one lowercase letter or number");
  const id = isRoomId(slug) ? slug : `${slug}-${randomBytes(4).toString("hex")}`;
  if (!isRoomId(id)) throw new Error("Room id does not match the frozen contract format");
  return id;
}
