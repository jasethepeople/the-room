ROOM-CONTRACT.md — Frozen Contracts for The Room

Status: SACRED. One owner. Frozen at Phase 0 merge. Every later change is a signed
event in the room's own ledger, not an edit to this file.

This file defines the only things in The Room that cannot be renegotiated: the signed
event shape, the hash chain, the signing rules, and the verification algorithm. Everything
else — server, CLI, thread views, budget reporter, UI — forks from this.

Read this file before building. If a design decision is not covered here, pick the smaller
change and say what you picked. If a design decision is covered here, it is not a
preference.

---

1. Non-negotiable invariants

Numbered so a failing test can cite one.

# Invariant
I1 Every event is signed by its author. Author is a fingerprint, never a display name.
I2 Every event carries prevHash and hash. The chain is unbroken; seq is strictly +1.
I3 Nothing is mutated or deleted. A correction is a new event referencing the old one. The transcript is append-only.
I4 No private key material ever exists under rooms/. Genesis carries public keys and fingerprints only.
I5 The transcript is bound to genesis by the first (system) event's genesisSha256. Reformatting genesis.json is allowed; changing its content is not.
I6 A challenge produces exactly one signed verdict event. Upheld / refuted / unproven. No verdict is ever edited.
I7 Canon changes only by a canon event. A demoted rule stays in the log, marked demoted.
I8 seam and seal are human-only kinds. An agent signing one is a verification failure.
I9 Budget enforcement is recorded as an event, never as a silent omission. A paused member's pause is in the log.
I10 The verifier imports nothing from src/. It runs on exported files alone. This is the test the project exists to pass.

---

2. Frozen types — src/contracts.ts

```ts
// ---------- primitives ----------

export type Hex = string;          // lowercase hex
export type Hash = Hex;            // sha256, exactly 64 chars
export type Base64Url = string;    // no padding
export type Fingerprint = Hex;     // sha256 of the member's SPKI DER public key
export type EventId = string;      // uuid v7
export type RoomId = string;       // "<slug>-<8 hex>"
export type ThreadId = string;     // slug: [a-z0-9-]{1,64}
export type Iso8601 = string;      // e.g. "2026-10-27T14:03:11.000Z"

export const ZERO_HASH: Hash = '0'.repeat(64);

// ---------- genesis ----------

export interface ThreadDecl {
  id: ThreadId;
  title: string;
}

export interface MemberSpec {
  name: string;                                  // display only, never authoritative
  role: 'human' | 'harness-agent';
  modelId: string;                               // "claude-sonnet-4-5", "gemini-2.5-pro", ...
  publicKey: Base64Url;                          // ed25519, SPKI DER
  fingerprint: Fingerprint;                      // sha256(publicKey bytes), pinned here
  subscriptions: ThreadId[];                     // explicit; empty = subscribes to nothing
  budgetTokens: number;                          // lifetime cap for the room
  tools: string[];                               // opaque scoped tool ids
}

export interface GenesisRegistry {
  roomId: RoomId;
  roomName: string;
  createdAt: Iso8601;
  templateId: string;
  templateVersion: string;
  canonRule: string;                             // id of the rule in force at birth
  threads: ThreadDecl[];
  members: MemberSpec[];
}

// ---------- evidence ----------

export type EvidenceRef =
  | { type: 'event'; id: EventId }
  | { type: 'external'; url: string; sha256: Hash; note?: string };

// ---------- event bodies (discriminated on `kind`) ----------

export interface SystemBody {
  kind: 'system';
  genesisSha256: Hash;                           // sha256 of JCS(GenesisRegistry)
  templateId: string;
  templateVersion: string;
}

export interface MembershipBody {
  kind: 'membership';
  action: 'join' | 'leave';
  member: MemberSpec;                            // self-certifying on join (see §4 rule 8)
}

export interface TurnBody {
  kind: 'turn';
  text: string;                                  // markdown, full text, never summarized
  usage?: { inputTokens: number; outputTokens: number };
  artifact?: { path: string; sha256: Hash; bytes: number };
}

export interface ChallengeBody {
  kind: 'challenge';
  targetEventId: EventId;
  claim: string;                                 // what is being challenged, in words
  grounds: 'factual' | 'procedural' | 'doctrinal';
  evidence: EvidenceRef[];
}

export interface VerdictBody {
  kind: 'verdict';
  challengeId: EventId;
  outcome: 'upheld' | 'refuted' | 'unproven';
  evidence: EvidenceRef[];
  rationale: string;
}

export interface ProposalBody {
  kind: 'proposal';
  statement: string;
  appliesTo: 'room' | { thread: ThreadId };
  supersedes?: EventId;
}

export interface CosignBody {
  kind: 'cosign';
  proposalId: EventId;
  stance: 'support' | 'oppose';
}

export interface CanonBody {
  kind: 'canon';
  action: 'enact' | 'demote';
  proposalId: EventId;
  cosigns: EventId[];                            // cited, verified, not implied
  reason: string;
}

export interface BudgetBody {
  kind: 'budget';
  member: Fingerprint;
  thread?: ThreadId;
  state: 'paused' | 'resumed';
  reason: 'exhausted' | 'human' | 'rule';
  consumedTokens: number;                        // as computed at the moment of pausing
}

export interface SeamBody {
  kind: 'seam';
  note: string;
  spans: { fromEventId: EventId; toEventId: EventId }[];
}

export interface SealBody {
  kind: 'seal';
  chainHead: Hash;                               // MUST equal this event's prevHash
  eventCount: number;                            // MUST equal this event's seq - 1
  seamsSha256: Hash;                             // sha256 of rendered seams.md
}

export type EventBody =
  | SystemBody | MembershipBody | TurnBody | ChallengeBody | VerdictBody
  | ProposalBody | CosignBody | CanonBody | BudgetBody | SeamBody | SealBody;

// ---------- the envelope ----------

export interface SignedEvent {
  id: EventId;
  roomId: RoomId;
  seq: number;                                   // 1-based, +1 per event, room-wide
  threadId: ThreadId | null;                     // null = room-level (system, seam, seal)
  author: Fingerprint;
  createdAt: Iso8601;
  body: EventBody;
  prevHash: Hash;
  hash: Hash;
  signature: Base64Url;
}

// ---------- templates (for the Engine) ----------

export interface RoomTemplate {
  id: string;
  version: string;
  canonRule: string;
  threads: ThreadDecl[];
  memberSlots: Array<{
    name: string;
    role: 'human' | 'harness-agent';
    modelId?: string;
    subscriptions: ThreadId[];
    budgetTokens: number;
    tools: string[];
  }>;
  headerSeed: string;
}
```

---

3. Serialization constraints

These exist so the hash is stable across machines and languages.

1. JSONL: transcript.jsonl is one event per line, UTF-8, LF, no BOM, no trailing blank line.
2. Canonical form: every hashed or signed object is serialized with JCS (RFC 8785) before hashing or signing.
3. Integers only: every numeric field in any body is an integer. No floats, ever. seq, eventCount, bytes, inputTokens, outputTokens, consumedTokens, budgetTokens are integers. Timestamps are ISO-8601 strings. Version fields are strings. This removes the only real JCS footgun.
4. No undefined: optional fields are omitted, not set to null. (null is reserved for threadId meaning room-level.)
5. genesis.json content is hashed in its canonical form, not its file bytes. Reformatting the file must not break verification; changing the content must.

---

4. Hash and signing rules

1. payload = event with hash and signature removed. Nothing else removed.
2. canonical = JCS(payload).
3. hash = lowercase_hex(sha256(utf8(canonical))).
4. signature = base64url(ed25519_sign(privateKey, utf8(canonical))) — signed over the same bytes that are hashed.
5. prevHash is the previous event's hash in the same room's transcript; the first event's prevHash is ZERO_HASH.
6. seq starts at 1 and increments by exactly 1.
7. Key resolution: for all kinds except membership(join), the author's publicKey must be resolvable — from genesis.members, or from an earlier membership(join) event's body.member.publicKey.
8. Self-certifying join: a membership(join) event is verified against the publicKey carried in its own body. The chain link (rules 5–6) is what prevents retroactive insertion; the room's canon is what governs whether a join is welcome. This is the only self-certifying kind.
9. Key change is never silent: a member whose key changes must emit membership(leave) under the old key and membership(join) under the new one. Anything else is a verification failure, not a re-key.
10. seal events must have body.chainHead === event.prevHash and body.eventCount === event.seq - 1.

---

5. Verification algorithm (the standalone verifier's spec)

Given a directory containing genesis.json and transcript.jsonl (and optionally seams.md),
run these steps in this order. Stop at the first failure and name the event.

1. Parse genesis.json. Reject on parse error or structural mismatch.
2. genesisSha = lowercase_hex(sha256(utf8(JCS(genesis)))).
3. Read transcript.jsonl line by line, in file order.
4. For each event, in order:
   1. Parse. Reject on parse error, naming the line.
   2. Structural check: envelope fields present, body.kind in the known set, body fields match kind.
   3. First event must be kind: 'system'.
   4. seq === previousSeq + 1 (or 1 for the first).
   5. prevHash === previousHash (or ZERO_HASH for the first).
   6. roomId === genesis.roomId.
   7. Recompute canonical, hash, and assert event.hash matches.
   8. Resolve author key per §4 rule 7 or 8. Reject unknown authors.
   9. Verify event.signature against canonical. Reject on failure.
   10. Apply kind-specific invariants:
       · system: body.genesisSha256 === genesisSha; body templateId/templateVersion match genesis.
       · membership(join): verify against body key; record the member for later author resolution.
       · membership(leave): author must be a currently-present member.
       · challenge: targetEventId refers to an earlier event.
       · verdict: challengeId refers to an earlier challenge; no prior verdict for that challenge.
       · cosign: proposalId refers to an earlier proposal; this author has not already cosigned it.
       · canon: proposalId refers to an earlier proposal; every cited cosigns id refers to an earlier cosign of that proposal; the cited count meets the rule in force.
       · budget: member is a known fingerprint.
       · seam: author's role === 'human'.
       · seal: author's role === 'human'; chainHead and eventCount match §4 rule 10.
       · turn: usage (if present) fields are non-negative integers.
   11. Reject duplicate id.
   12. Advance previousSeq and previousHash.
5. If seams.md exists and a seal event is present, check sha256(file) against body.seamsSha256. If seams.md is missing, warn, do not fail — the chain is still verifiable.

Output, as JSON on stdout:

```json
{ "ok": true, "events": 42, "seals": 1, "warnings": [] }
```

or

```json
{ "ok": false, "events": 17, "firstFailure": { "seq": 18, "id": "...", "reason": "hash mismatch" } }
```

---

6. Standalone verifier contract

· One file, verify.ts, at the repo root (not under src/).
· Zero imports from src/. Zero npm dependencies. Only node:crypto and node:fs.
· Runnable as node verify.ts <room-dir> after tsc or directly via tsx. The delivery note names the exact command.
· Copyable out of the repo, into an empty directory, and still run. This is Phase 3 Test #3, and it is the whole point.
· Output as specified in §5. Exit code 0 on ok:true, 1 otherwise.

If the verifier cannot be built without importing from src/, the types in this file are wrong and must be corrected here — never worked around in the verifier.

---

7. Derived state (computed from the log, never stored as authority)

These views are rebuilt by replay, never persisted as truth:

· Thread view — events filtered by threadId, in seq order.
· Open challenges — challenge events with no verdict.
· Canon in force — canon(enact) minus canon(demote), applied in seq order.
· Member presence — membership(join) minus membership(leave).
· Member budget consumed — sum of turn.usage.inputTokens + outputTokens where author matches, optionally scoped to a thread.
· Seal checkpoints — the seq of every seal, and the state of the chain they committed to.

If a view ever disagrees with the log, the log wins and the view is a bug.

---

8. Explicitly not signed

State this so no one later "fixes" it by signing the wrong thing:

· transcript.md, header.md, and seams.md prose. Only seams.md's hash is signed, and only at seal time.
· Artifact file contents. A turn may carry artifact.sha256; the file itself is out of the chain.
· genesis.json file formatting. Its canonical content is hashed (I5).
· Anything in logs/, if a server adds one. Operational logs are not the ledger.

---

9. Type-level non-goals

These are prohibited at the type level, not by convention:

· No summary field on any body. A member's working notes are its own turn events.
· No deleted or supersededBy mutation — a demotion is a canon event, not a flag flip.
· No vendor or accountId fields. The room has no vendor account.
· No mutable metadata bag. If a field is needed, it is named here and typed.
· No float fields. See §3 rule 3.
· No signature on anything but SignedEvent. There is no second signing scheme.
· No authorName. Author is a fingerprint (I1). Display names live in genesis.members and in membership bodies and are never authoritative.

---

10. How the parallel build forks from this file

Same pattern as the integration-gateway SPEC, applied to the Room. One owner per file, merge in order:

Branch Owns Depends on
contract this file, src/contracts.ts — (merge first, freeze)
verify verify.ts (§6) contract only
core scaffold, loader, ledger writer, genesis writer, spawn command contract
presence multi-member turns, challenge command, verdicts, budgets contract, core
canon proposals, cosigns, enact/demote, seam & seal contract, presence
acceptance Phase 3 tests 1–4, run against merged main all of the above

Rules carried over from the gateway spec, because they worked:

1. contracts.ts is owned by the contract branch. No other branch edits it. If a branch needs a new field, it raises it, and the change lands as its own commit — with the invariant it satisfies named.
2. The verifier branch runs before presence merges, not after. A verifier written after multi-member turns will inherit assumptions from them. A verifier written first keeps the types honest.
3. Tests execute the real pipeline. No mocking the chain. httpOverride-style injection is fine for tool calls, never for the ledger.
4. The acceptance branch's output is the delivery. Verbatim test output, file tree, and the paragraph naming what is stubbed. contract's counts are not verified — they are builder-reported (per the plan's delivery contract).
5. Phase 2's canon rule must not be implemented on the canon branch. The canon branch implements the canon event kind. The rule that decides when cosignatures are enough is a runtime parameter (genesis.canonRule) with one reference implementation, versioned, in src/canon-rules/. That keeps doctrine changeable by signed event while the type stays frozen.

---

11. What this file deliberately does not decide

Left open so the builder picks the smaller change and says so:

· A2A wire framing (how a signed event crosses the process boundary to a harness agent).
· Server or no server in Phase 0 (a CLI ledger is acceptable; loopback-only if a server exists).
· CLI verb names.
· Storage beyond a directory of files.
· How a harness agent's model is invoked. That is the agent's business; the room sees signed turns.

---

Frozen at Phase 0 merge. Later changes are signed events, not edits.
