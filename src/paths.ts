import { homedir } from "node:os";
import { isAbsolute, resolve } from "node:path";
import { isRoomId } from "./canonical.ts";
import type { RoomPaths } from "./types.ts";

export function roomHome(explicit?: string): string {
  const value = explicit ?? process.env.ROOM_HOME ?? resolve(homedir(), ".the-room");
  return isAbsolute(value) ? resolve(value) : resolve(process.cwd(), value);
}

export function roomPaths(roomId: string, explicitHome?: string): RoomPaths {
  if (!isRoomId(roomId)) throw new Error("Room id must be <lowercase-slug>-<8 lowercase hex characters>");
  const home = roomHome(explicitHome);
  const rooms = resolve(home, "rooms");
  const room = resolve(rooms, roomId);
  return {
    home,
    rooms,
    room,
    genesis: resolve(room, "genesis.json"),
    transcript: resolve(room, "transcript.jsonl"),
    transcriptMd: resolve(room, "transcript.md"),
    header: resolve(room, "header.md"),
    seams: resolve(room, "seams.md"),
    lock: resolve(room, ".write.lock"),
    quarantine: resolve(room, "quarantine.jsonl"),
    keys: resolve(home, "keys"),
    snapshot: (seq) => resolve(room, `seams.${seq}.md`),
  };
}
