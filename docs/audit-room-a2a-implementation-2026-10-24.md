# Audit: The Room on integration-gateway-a2a — independent verification

**Date:** 2026-10-24. **Bundle:** `integration-gateway-a2a-room-bundle_0_0zov.zip`
(relayed by Jason; extracted to `~/workspace/room-verify/integration-gateway-a2a/`).
**Referee:** agent-archive v0.2.0 CLI + server, from the independently verified
tree at `~/workspace/agent-archive-v02-inspect/v02/agent-archive-v0.2.0/`
(itself verified 13/13 Node + 37/37 Python on 2026-10-23).
**Verdict: ACCEPTANCE MET.** Every claim in Zo's 04:32 report re-ran true,
plus one independent probe the suite does not contain.

## 1. Bundle contents (as received)

- Engine + A2A layer (the 27-file kit) plus new `src/room/` (7 files,
  ~1,250 lines: `molt.ts`, `store.ts`, `client.ts`, `types.ts`,
  `identity.ts`, `archive.ts`, `index.ts`).
- New tests: `tests/room.test.ts`, `tests/room-a2a.test.ts` (10 tests).
- New docs: `docs/ROOM.md`, plus a project `AGENTS.md` stating the house
  rules (A2A only, no browser tabs; MOLT-CORE must match agent-archive;
  loopback by default; no GitHub push without Jason's word).
- Registry fixture: **1,208** `component.json` files (8 real modules +
  1,200 clearly-named synthetics), same fixture as the baseline gate.
- `package.json` has **no `dependencies` key at all** — devDependencies
  only (vitest, vite, tsx, typescript, ajv). The npm-audit question is
  therefore closed: all 6 findings are dev-tree-only, zero production
  exposure. Leaving versions unchanged for verification fidelity was
  correct; the Vitest 5 major upgrade is hygiene, not a gate.

## 2. Baseline integrity (diffed, not assumed)

- All 5 original test files **byte-identical** to the fork's originals:
  `a2a`, `e2e`, `helpers`, `loader`, `router`.
- `src/loader.ts` **byte-identical**; the 64-in-flight bound intact
  (comment + literal `64` present).
- `src/server.ts` diff vs the fork: **additions only** — RoomStore,
  `/api/rooms/*` routes, room app card (`room.create`, `room.append`,
  `room.invoke-tool`), RoomError handling. No existing route modified.
- The non-A2A `integration-gateway` was not in the bundle and was not
  touched. Nothing was pushed to GitHub by either side.

## 3. Code read: the signing rule is the corrected one

`src/room/molt.ts` `signEvent`:

```ts
const bytes = canonicalBytes(unsigned);   // event minus {event_id, signature}
const eventId = sha256(bytes);
const signature = sign(null, bytes, privateKey);   // signs the BYTES, not the digest
```

Verification recomputes the bytes, checks the hash against `event_id`,
then verifies the signature over those bytes against the registry key.
Canonicalization matches MOLT-CORE §4 (sorted keys in UTF-16 order, no
whitespace, int64 range, -0 rejected, unpaired surrogates rejected,
512 nesting cap). Field set is exactly the 8 MOLT-CORE fields. Timestamps
are strict RFC 3339 whole seconds with a real-calendar check. The Forge
drill dialect appears nowhere in the Room layer.

`src/room/store.ts` enforces, on every read and every append:

- Canonical JSONL lines, full MOLT re-verification, genesis.json match,
  header-hash match, derived `transcript.md`/`seams.md` views must equal
  the stored views (editing the markdown fails verification).
- Genesis: room_id match, ≥2 participants, participants == registry
  exactly, ≥1 human + ≥1 agent, genesis signer is human, doctrine rule
  min ≥ 2 with distinct signers and reachable.
- Turns: thread subscription + text limits. Challenges: existing
  `room.turn` + reason. Verdicts: matching challenge + target, one
  verdict per challenge. Seams/seals: human-role only. Seal must bind
  the current head event id AND the exact seams bytes. Sealed rooms are
  immutable; a seal that is not the last event fails verification.
- Doctrine: proposal needs the active rule hash + unique id; co-sign
  must be distinct, once, under the active rule, not already canon;
  demotion only for canon doctrine (demoted doctrine stays in the log,
  it is never deleted).
- Artifacts: bytes required, filename safe, thread subscription,
  length + SHA-256 match, 4 MiB cap, content-addressed by event id.
- Tool requests: thread subscription, `allowed_tools` allowlist, input
  bound by SHA-256 of canonical input bytes — the transcript stores the
  hash, never the input (the A2A test asserts the input string appears
  nowhere in the stored events or markdown).
- Appends are serialized per room with atomic writes and rollback
  (JSONL truncate + view restore + artifact removal on failure).
- `validateArchiveProof` is strict: exactly 2 events, MOLT-verified,
  genesis by the human sealer with ONLY that actor pinned, genesis type
  `archive.genesis` + `history.create`, anchor payload keys exact,
  output/policy hashes and `room|<id>|<seal>` labels must match.

`src/room/identity.ts`: `agent-archive-identity/v2` format, mode 0600
enforced on load and write, public key must match the private seed.
`src/room/archive.ts`: proof submission validates the Archive's
acknowledgement per event and its verify response (valid + count 2 +
head). Non-loopback Archive URLs require HTTPS +
`ROOM_ARCHIVE_ALLOW_REMOTE=true`.

## 4. Test runs (independent, from a clean extraction)

```
npm ci        -> 57 packages, clean
npm run build -> tsc --noEmit, clean
npm test      -> 6 files, 35/35 passed, ~6 s
  (AGENT_ARCHIVE_ROOT pointed at the verified v0.2 tree)
```

Room tests, all passing by name:

- reconstructs plain-text history, verifies signed challenge, seam,
  artifact, and seal
- rejects a one-byte transcript edit at the changed turn
- rejects a re-signed tail at the human's original seal
- makes doctrine canon only after a distinct signed co-signature
  under the active rule
- verifies the Room history and signed archive anchor with
  agent-archive's standalone CLI
- advertises a Room app card alongside the registry skills
- appends a member-signed turn with message/send, reads it with
  tasks/get
- records an authorized tool request before executing the loader
  target
- seals through A2A and anchors the signed hashes in Agent Archive
  (real v0.2 archive server spun up in-process, proof submitted over
  HTTP, archive's own verify endpoint confirms valid + count 2)
- cancels a still-working A2A task and preserves canceled state
  through tasks/get

## 5. Independent probe (not in the suite; my hands, the archive's eyes)

Built a small Room history with the Room's client (genesis → turn →
seal) and judged it ONLY with the standalone v0.2 Archive CLI:

1. Good history → **VALID** under the archive CLI.
2. One-byte tamper, signature untouched → **REJECTED**:
   "recomputed event_id does not match claimed value."
3. Re-signed tail reusing the ORIGINAL seal → **REJECTED**:
   "parent event not in history" — the seal's `prev_event_id` points
   to the original turn, which is no longer in the history. This is
   the re-sign attack (RT-1 S5) failing at the seal, judged by the
   independent referee rather than the Room's own verifier.

Two independent verifiers (Room's `verifyMoltHistory` and the
archive's CLI) now agree on Room histories in both directions:
acceptance of good histories, rejection of tampered and re-signed
ones. That agreement is the substance of the independence claim.

## 6. Honest limits (carried forward, unchanged by this result)

- Identity files hold unencrypted Ed25519 seeds (mode 0600), inherited
  from the archive's identity format. Same caveat as agent-archive.
- The server has no login or per-room read authorization (ROOM.md says
  so explicitly). Signatures prove possession of a pinned key, not
  real-world identity or truth of a claim. Keep it loopback-local
  unless an access-control layer is added and reviewed.
- The "live anchor" is loopback-local: the archive service runs on
  127.0.0.1 (default :8080). There is no public deployment and no
  published anchor. Independence (verification outside the room) is
  proven; publicity is a separate, later decision.
- The registry in the bundle is the fixture, not the full 246 MB
  registry. Swapping in the full registry is future work; the project
  AGENTS.md states the constraint (preserve tests + loader bound).
- Roles are declarations signed into genesis. Nothing in the Room
  proves a member's real-world independence.

## 7. What this closes

The Room plan's Phase 3 acceptance tests (reconstructability, tamper,
independence) all pass under independent re-run, and the Room's
signing rule is the corrected MOLT-CORE rule, confirmed in code and
in cross-verification. The Room is no longer "reported" — it is
verified, within the limits above. Next decisions are Jason's:
deployment/security review, real witness independence, the Vitest
upgrade, and the full-registry swap.
