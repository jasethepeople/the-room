ROOM-CONTRACT — AMENDMENT PASTE (2026-10-28). Companion to ROOM-CONTRACT.md. One paste, before core hardens.

=== 1. CHECKPOINT RULING ===

Checkpoint. Confirmed, and it was already written that way — §5 step 4.10 allows events after a seal, and §4 rule 10 only binds the seal to the chain prefix. A room you return to needs to commit to what happened without ending.

Two consequences to state explicitly, because checkpoint semantics are not free:

1. §5 step 5 must become "latest seal." A seal hashes seams.md as it stood at seal time. If the human appends seams between seals, the file's hash changes and every historical seal's seamsSha256 fails against the current file. Fix: the room snapshots seams.<seq>.md at each seal; the verifier hard-checks the latest seal against seams.md, and checks earlier seals against their snapshot if present — warning, not failure, if absent. Without snapshots, historical seal hashes are decorative.
2. A seal is not a terminal state. Anything after it is legal. The verifier's output should report seals as a count, not as an end-of-chain marker.

=== 2. AMENDMENTS 1–6 ===

Amendment 1 — Fingerprint consistency (§5 step 1, §5 step 4.10)

In §5 step 1, after parsing genesis:

For each genesis.members entry, assert member.fingerprint === lowercase_hex(sha256(base64url_decode(member.publicKey))). Failure names the member and stops. Genesis is not trusted until every fingerprint matches its key.

In §5 step 4.10, under membership(join):

Assert body.member.fingerprint === lowercase_hex(sha256(base64url_decode(body.member.publicKey))) before resolving the author. A join carrying a mismatched fingerprint is rejected; it is not a self-certifying join, it is a forgery attempt.

Serves I1 and §4 rule 8. The self-certifying join was only safe because the fingerprint is a function of the key — without this check it was self-certifying the wrong thing.

Amendment 2 — Typed canon rule (§2, §5 step 4.10)

Replace in GenesisRegistry:

```ts
canonRule: { id: string; minCosigns: number };
```

Add to CanonBody:

```ts
newRule?: { id: string; minCosigns: number };   // present only when enacting a rule change
```

In §5 step 4.10, under canon, replace "the cited count meets the rule in force":

The verifier maintains currentRule, initialized from genesis.canonRule. Every cited cosigns id must refer to an earlier cosign of that proposal. The count of distinct supporting cosigns must be >= currentRule.minCosigns. If body.newRule is present, it takes effect after this event verifies; subsequent canon events are checked against it. currentRule changes only by a verified canon event carrying a typed newRule — never by an opaque id the verifier cannot evaluate.

Doctrine still moves by signed event; the verifier can now count. An id string was never a rule, it was a promise the verifier couldn't keep.

Amendment 3 — Resolve role, not just key (§5 step 4.8)

Replace §5 step 4.8:

Resolve the author's publicKey and role — from genesis.members, or from an earlier membership(join) event's body.member. Reject unknown authors. If a kind-specific check needs a role and none resolves, that is a verification failure, not a default.

Serves I8. The seam/seal checks were reading a role the verifier was never instructed to load.

Amendment 4 — The nits, as specified

· §5 step 4.2: add format assertions — id matches UUID v7 (version nibble 7), roomId matches <slug>-<8 hex> and equals genesis.roomId, threadId matches [a-z0-9-]{1,64} or is null.
· §5 step 4.10, under proposal: if supersedes is present, it must reference an earlier proposal.
· §6: rewrite the deps line to read: "Zero imports outside node:crypto and node:fs. tsx and tsc are build tooling, not dependencies; the delivery note names the exact command that runs it in an empty directory."
· §5 step 5: "latest seal" wording per the checkpoint consequence above.

Amendment 5 — Usage is self-reported (§8)

Add to §8:

Member token usage. turn.usage is signed by the member that reports it. The ledger records it and budgets are enforced against it, but the verifier cannot meter independently and does not try. A false usage figure is a signed lie — it is on the record and challengeable under §5, but it is not detectable by hash. Any future "verified usage" claim requires an independent meter, which is outside this contract.

Serves I9, and closes the loop on the middleware thread: a compression gateway lowers the price per turn, the Room caps the turns, and the meter is the member's word on the record — not the room's measurement.

Amendment 6 — Canon-rule ownership in the parallel build (§10)

In §10 rule 5, replace the reference implementation line:

The canon branch implements the canon event kind and the currentRule replay. The rule's values live in genesis.canonRule and in signed newRule payloads. No rule logic is hardcoded outside the verifier's comparison.

---

=== 3. CLOSING NOTE — type alignment and anatomy (not amendments; no new rules) ===

Template rule type. In §2, RoomTemplate.canonRule changes from:

```ts
canonRule: string;
```

to:

```ts
canonRule: { id: string; minCosigns: number };
```

In §10 rule 5, append one sentence:

Spawn copies template.canonRule into genesis.canonRule verbatim — same typed shape, no mapping, no defaults, no coercion. A template whose rule does not satisfy the type is not a template.

Room anatomy. In the rooms/<room-id>/ block, add:

```text
    seams.<seq>.md           # frozen snapshot at each seal, generated
```

Seal write path (§10 rule 5, or wherever the seal write path lives):

Writing a seal event writes seams.<seq>.md from the current seams.md in the same operation as appending the event, before the append. If the snapshot cannot be written, the seal is not written. A seal whose snapshot is missing is a seal the verifier can only warn about.

(<seq> is the seal event's own seq. The verifier checks earlier seals against seams.<seq>.md, per the checkpoint ruling above.)

---

=== 4. MIDDLEWARE CORRECTION (so the plan's stale tool list does not survive into the next prompt) ===

The plan's list of token-compression middleware was partly unverified. Strike Tokan, Tailspin, ShrinkWrap, llm-token-gateway, and TokenLean: they were named without being checked and must not be cited or built against. Paritok stands. ContextForge is a real project, but it federates tools; it does not compress tokens, so it is not a compression gateway. TokenJar is a three-star repo making its own claim and should be treated as unverified. Design consequence unchanged: a compression gateway lowers the price per turn, the Room caps the turns, and the meter is the member's self-reported usage on the record (§8).

---

=== 5. TIMING ===

Contract and verifier come before core hardens; the verifier branch merges before presence. The verifier is written from this contract alone, by someone who has not read the scaffold — otherwise Test #3 passes against code written next to it.
