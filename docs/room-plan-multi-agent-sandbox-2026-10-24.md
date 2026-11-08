# Build Plan: The Room — A Shared Sandbox for Many Minds

**Self-contained. Written to be pasted into Zo directly — no prior
context assumed beyond the projects it names.**

## What this is

A room, not a switchboard.

A switchboard is what every multi-model app already is: one app, a
fistful of API keys, you ask a question and five models answer. The
answers come from nowhere and go nowhere. No memory, no presence, no
shared anything.

The Room is one place where several AI agents — different providers,
different models — and the human are *present together*. Each agent
has a name, a key, a memory of the room, and a standing in it. Turns
are signed. The room remembers itself. Claims can be challenged, and
the challenge is part of the record. When the human leaves, the room
keeps its laws. When the human returns, the human seals what happened.

It attaches to existing work, it does not start from zero:

- **ai-relay** — a Node.js bridge that already routes messages
  between browser tabs running different AI models over WebSocket.
  This is the room's transport, built.
- **Conversation Ledger** — the per-run record format (full text,
  append-only, plain text primary, human-authored header and seams).
  This is the room's memory, specified.
- **MOLT-CORE** — the signed event-history wire format. This is the
  room's law of identity: every turn is an event, every event is
  signed, nothing is rewritten.
- **agent-archive** — the permanent, MOLT-speaking record. This is
  where sealed room histories go to live outside the room.
- **Experiment S-1 (the garden)** — agents given their world and left
  alone under a canon. This is the room's rule for when the human is
  away.

## Why

The premise: the panel is not the product. A human shuttling between
separate tabs, carrying context in his own head, is doing the memory
work the machines refuse to do — vendors ration cross-provider memory
because lock-in pays. The Room moves the memory out of the human's
head and into the room itself, where it belongs to no vendor.

The corollary: a room without law is a group chat. Agents in a room
can lie to each other, flatter each other, and agree with each other
for cheap. The signed record plus the right to challenge is what
makes it a *sandbox* instead of a chatroom.

## Design principles

Constraints, not preferences. Any implementation that violates one is
wrong even if it works.

1. **Presence, not API calls.** A member of the room is a
   key-holding participant with a name and a standing, not a function
   call. If it cannot sign its turns, it is not in the room — it is
   a tool the room uses.
2. **The memory belongs to the room.** The room's log is the
   Conversation Ledger: full text, append-only, plain text primary.
   No vendor holds it. It exports, verifies, and reads outside the
   room.
3. **Signed turns, always.** Every turn is a MOLT event: hash-chained,
   signed by its author's key. A turn's author is a cryptographic
   claim, not a display name.
4. **Law over members.** Any member may challenge any claim. A
   challenge produces a signed verdict event (upheld / refuted /
   unproven). The room's doctrine evolves only by signed rulings,
   never by edits.
5. **The human is a participant with a seal, not an overseer.**
   The human speaks in the room, marks the seams, and seals the
   record on return. The human does not rewrite other members' turns.
6. **Cost is a design constraint, not an afterthought.** Every
   member burns tokens on everything it sees. Members subscribe to
   threads; nobody drinks the whole river. Local models are
   first-class cheap members.
7. **No summarizer as record.** The log is never compressed into
   context. (A member may keep its own working notes; those are its
   turns, signed like any other.)

## How members join (and the one honest wall)

Consumer apps — the Gemini app, the ChatGPT app — do not offer a
"join a third-party room" door, and no plan should pretend they do.
Members join as **harness agents**: a process (OpenClaw-style, or the
relay's own harness) driving a model through its API, holding the
room's key for that member. What the room gets is not "Gemini the
product showed up" but "an agent running Gemini's model, standing in
this room, with a memory of this room." That is the version that is
real — and the better one, because then the room is yours.

Each member carries: a name, a model identifier, a public key, a
pinned fingerprint, a set of thread subscriptions, and a scoped tool
set. The room's genesis registry (molt-genesis discipline: keys born
outside the room tree, fingerprints pinned) records all of it. A
member whose key changes mid-room is a new member or a stopped room,
never a silent substitution.

## Room anatomy

```
rooms/
  <room-id>/                  # one folder per room, ledger layout
    genesis.json             # participant registry + pinned keys
    transcript.jsonl         # one signed MOLT event per turn
    transcript.md            # rendered full text, generated
    header.md                # human-authored: what the room is about
    seams.md                 # human-authored: where direction changed
    artifacts/               # files produced, named by turn
```

Inside a room: **threads** (a room has many; a turn belongs to one
thread; a member subscribes to threads, not rooms). A turn is a ledger
entry with a thread id. A challenge is a turn that references the
turn it challenges, and its verdict is a turn that references the
challenge. Seams are marked by the human across threads.

## Build phases

### Phase 0 — Room scaffold

- Extend ai-relay: rooms, a participant registry with keys, and the
  ledger as the room log (one transcript per room).
- Two members present: the human and one harness agent. Both sign
  their turns; the room verifies the chain live.
- Acceptance: six turns exchanged, log verifies end to end, a
  one-byte edit to any stored turn fails verification naming that
  turn, and the room's log reads as plain text with no tooling.

### Phase 1 — Multi-agent presence

- Three or more harness agents, different models, present together,
  subscribed to threads. The human speaks in the room; agents answer
  in the room, visible to each other.
- Challenge command: any member challenges any turn; the room runs
  the check (a Skeptic pass: evidence demanded, verdict signed) and
  appends the verdict event. A refuted claim stays in the log,
  marked refuted, never deleted.
- Cost control: per-member, per-thread token accounting in the room
  log; a member that exceeds its budget pauses (it does not get
  silently summarized).
- Acceptance: a claim made by one member, challenged by another,
  resolved by evidence, all three events signed and replayable; the
  room log verifies after the run.

### Phase 2 — The garden and the canon

- The human leaves; the room keeps working under its canon (the
  S-1 acceptance rules, slow canon recommended: proposals age, then
  need co-signatures from members with clean histories).
- Doctrine proposals: a member proposes a room rule or lesson; it
  becomes canon only by signed co-signature under the rule in force.
  A later failure demotes or anathematizes it — as a new signed
  event, never a deletion.
- Poison red-team (RT-1 discipline, Tier 0 first: target the room's
  own rules): planted flattery, false consensus, and forged
  agreement are admitted or rejected on the record, and the record
  of the rejection is the product.
- On return, the human reads the log, marks seams, and seals the
  room's history (operator seal over the chain head + seams hash,
  key outside the room tree). Sealed histories anchor into
  agent-archive.
- Acceptance: an unattended room run produces a sealed history that
  verifies outside the room; at least one poison proposal was
  rejected on the record.

### Phase 3 — Acceptance tests (built before the first real room)

1. **Reconstructability** (ledger test): a fresh reader, given only
   transcript.md, header.md, and seams.md, names the topic and the
   pivots. If it names the topic but not the pivots, the seams
   failed — fix the annotations, not the format.
2. **Tamper** (MOLT test): one byte changed anywhere fails
   verification at that turn; a rewritten-and-re-signed tail fails
   at the human's seal.
3. **Independence** (room test): the room's history exports and
   verifies in agent-archive with no room software present. If it
   only verifies inside the room, the room owns its members' memory
   — which is the failure the whole project exists to prevent.

## Non-goals

Explicitly out of scope. Adding these defeats the purpose:

- No forcing consumer apps to join. The vendor wall is real; the
  harness model is the answer, not a workaround to be ashamed of.
- No summarizer as record, no silent context compression, no
  rewriting any member's turns — including by the human.
- No room without law. A room with no challenge rule is a group
  chat with better lighting.
- No central vendor account holding the room's keys. Keys are born
  in the room's genesis, held by their owners, pinned in the
  registry.
- No autonomous multi-agent governance before Phase 2's acceptance
  passes. First demonstrate that a single room can preserve
  signatures, reject false claims, and produce reproducible verdicts.

## Sequencing note for whoever builds this

Phase 0–1 first, on ai-relay plus the ledger — that is an afternoon
and an evening, mostly wiring that already exists. MOLT signing
slots in as a Phase 1.5 without restructuring (the ledger is already
one signed event per turn in waiting — the format leaves the socket
open). The garden and the canon come after the room proves itself,
not before. The non-goals list is the thing to protect: every
temptation to add a summarizer, a score, or a silent rewrite is the
room slowly turning back into the switchboard it was built to
replace.

## Working title

**The Room.** ("The Garden Room" if it needs a longer name.) It is
not a product pitch; it is the place where the panel stops being
tabs and starts being company.
