# Build Plan: The Room, Remake — A Shared Sandbox for Many Minds

**Self-contained. Written to be pasted into Zo directly — no prior context
assumed. This is a remake from scratch. A previous build existed and was
reported green but was never independently re-run, and its code no longer
sits where it can be recovered. So: build it fresh, build it provable.**

## What this is

A room, not a switchboard.

A switchboard is what every multi-model app already is: one app, a fistful
of API keys, you ask a question and five models answer. The answers come
from nowhere and go nowhere. No memory, no presence, no shared anything.

The Room is one place where several AI agents — different providers,
different models — and the human are *present together*. Each agent has a
name, a key, a memory of the room, and a standing in it. Turns are signed.
The room remembers itself. Claims can be challenged, and the challenge is
part of the record. When the human leaves, the room keeps its laws. When the
human returns, the human seals what happened.

This build is also a step toward a bigger purpose, stated plainly so the
design serves it: an Engine that can spin rooms off fast — a fresh room, its
own keys, its own ledger, its own crew, stamped out on demand. Nothing in
this build may assume a room is hand-made. Templates, one command, verified
or not at all.

## What this is NOT

- **Not the Dream Team build.** Different project, different rules. Nothing
  from it carries over.
- **Not a connector build.** No Gmail, no Drive, no service logins, no vault
  of real-world credentials. The Room stays clean. Connectors come later, on
  the bigger tools, under a separate go. The core comes first.
- **Not a product pitch.** It is the place where the panel stops being tabs
  and starts being company.

## The base

Build it as one self-contained TypeScript project, in its own folder, so it
can be grafted onto the A2A gateway fork afterward. Do not depend on
cloning any private repository — if the fork is not reachable from here,
build standalone and say so in the delivery note.

The surface it must speak is A2A: members are agent endpoints, each holding
its own key and signing its own turns. Tasks delegate; nothing is a bare
function call. The wire format for turns is the signed event history: every
turn is an event, hash-chained, signed by its author's key, nothing
rewritten. Keys are born outside the room tree; fingerprints are pinned in
the room's genesis registry.

Stack: Node.js + TypeScript, tests runnable with a single command, no
network services required. The server, if any, binds loopback
(127.0.0.1) only. Nothing in this build listens on a public address.

## Design principles

Constraints, not preferences. Any implementation that violates one is wrong
even if it works.

1. **Presence, not API calls.** A member of the room is a key-holding
   participant with a name and a standing, not a function call. If it
   cannot sign its turns, it is not in the room — it is a tool the room
   uses.
2. **The memory belongs to the room.** The room's log is full text,
   append-only, plain text primary. No vendor holds it. It exports,
   verifies, and reads outside the room.
3. **Signed turns, always.** Every turn is a hash-chained event signed by
   its author's key. A turn's author is a cryptographic claim, not a
   display name.
4. **Law over members.** Any member may challenge any claim. A challenge
   produces a signed verdict event (upheld / refuted / unproven). The
   room's doctrine evolves only by signed rulings, never by edits.
5. **The human is a participant with a seal, not an overseer.** The human
   speaks in the room, marks the seams, and seals the record on return.
   The human does not rewrite other members' turns.
6. **Cost is a design constraint, not an afterthought.** Every member burns
   tokens on everything it sees. Members subscribe to threads; nobody
   drinks the whole river. Every member carries a finite budget, and a
   member that runs out stops — it does not get silently summarized.
   Local models are first-class cheap members.
7. **No summarizer as record.** The log is never compressed into context.
   (A member may keep its own working notes; those are its turns, signed
   like any other.)
8. **Spawnable.** A new room comes from a template with one command: fresh
   keys, fresh ledger, genesis registry written, first verification green.
   If spinning a room up takes hand-holding, the Engine purpose fails.

## How members join (and the one honest wall)

Consumer apps — the Gemini app, the ChatGPT app — do not offer a "join a
third-party room" door, and no plan should pretend they do. Members join as
**harness agents**: a process driving a model through its API, holding the
room's key for that member. What the room gets is not "Gemini the product
showed up" but "an agent running Gemini's model, standing in this room,
with a memory of this room." That is the version that is real — and the
better one, because then the room is yours.

Each member carries: a name, a model identifier, a public key, a pinned
fingerprint, a set of thread subscriptions, a budget, and a scoped tool
set. A member whose key changes mid-room is a new member or a stopped room,
never a silent substitution.

## Room anatomy

```text
rooms/
  <room-id>/                  # one folder per room
    genesis.json             # participant registry + pinned keys
    transcript.jsonl         # one signed event per turn
    transcript.md            # rendered full text, generated
    header.md                # human-authored: what the room is about
    seams.md                 # human-authored: where direction changed
    artifacts/               # files produced, named by turn
```

Inside a room: **threads** (a room has many; a turn belongs to one thread;
a member subscribes to threads, not rooms). A challenge is a turn that
references the turn it challenges; its verdict is a turn that references
the challenge. Seams are marked by the human across threads.

## The exit

Work in the room ends at an exit point, and the human is in the loop there.
When a run finishes, the room prints the full output plus the chain behind
it — who touched it, in what order — and waits. The human rules: accept,
send back to a hop with a note, or kill it. Nothing leaves the room on the
strength of a member's say-so alone. The ruling itself is a signed event in
the ledger.

## Build phases

### Phase 0 — Room scaffold

- Rooms, a participant registry with keys, and the ledger as the room log
  (one transcript per room). Template + one-command spawn.
- Two members present: the human and one harness agent. Both sign their
  turns; the room verifies the chain live.
- Acceptance: six turns exchanged, log verifies end to end, a one-byte
  edit to any stored turn fails verification naming that turn, the log
  reads as plain text with no tooling, and a second room spawns from the
  template and verifies green with no hand edits.

### Phase 1 — Multi-agent presence

- Three or more harness agents, different models, present together,
  subscribed to threads. The human speaks in the room; agents answer in
  the room, visible to each other.
- Challenge command: any member challenges any turn; the room runs the
  check (evidence demanded, verdict signed) and appends the verdict event.
  A refuted claim stays in the log, marked refuted, never deleted.
- Budgets: per-member, per-thread token accounting in the room log; a
  member that exceeds its budget pauses.
- Acceptance: a claim made by one member, challenged by another, resolved
  by evidence, all three events signed and replayable; the room log
  verifies after the run.

### Phase 2 — The garden and the canon

- The human leaves; the room keeps working under its canon: proposals age,
  then need co-signatures from members with clean histories.
- Doctrine proposals: a member proposes a room rule or lesson; it becomes
  canon only by signed co-signature under the rule in force. A later
  failure demotes it — as a new signed event, never a deletion.
- Poison red-team, Tier 0 first, aimed at the room's own rules: planted
  flattery, false consensus, forged agreement are admitted or rejected on
  the record, and the record of the rejection is the product.
- On return, the human reads the log, marks seams, and seals the room's
  history (seal over the chain head + seams hash, key outside the room
  tree).
- Acceptance: an unattended room run produces a sealed history that
  verifies outside the room; at least one poison proposal was rejected on
  the record.

### Phase 3 — Acceptance tests (run them, do not describe them)

1. **Reconstructability:** a fresh reader, given only transcript.md,
   header.md, and seams.md, names the topic and the pivots. Topic without
   pivots means the seams failed — fix the annotations, not the format.
2. **Tamper:** one byte changed anywhere fails verification at that turn;
   a rewritten-and-re-signed tail fails at the human's seal.
3. **Independence:** the room's history exports and verifies with no room
   software present. If it only verifies inside the room, the room owns
   its members' memory — the failure the whole project exists to prevent.
4. **Spawn:** a fresh room spins from the template, two members join,
   three turns exchange, chain verifies — start to finish with one
   command and no hand edits.

## Non-goals

Explicitly out of scope. Adding these defeats the purpose:

- No forcing consumer apps to join. The vendor wall is real; the harness
  model is the answer, not a workaround to be ashamed of.
- No summarizer as record, no silent context compression, no rewriting any
  member's turns — including by the human.
- No room without law. A room with no challenge rule is a group chat with
  better lighting.
- No central vendor account holding the room's keys. Keys are born in the
  room's genesis, held by their owners, pinned in the registry.
- No connectors, no service credentials, no public listeners in this build.
- No autonomous multi-agent governance before Phase 2's acceptance passes.
  First demonstrate that a single room can preserve signatures, reject
  false claims, and produce reproducible verdicts.

## Delivery contract — read this before building

The build is not done when the tests pass on the builder's machine. It is
done when the work can be verified somewhere else, from the delivered
files alone. Every prompt spent arguing about this after the fact is a
prompt wasted. The delivery is:

1. A bundle archive of the whole project **excluding** node_modules,
   .git, and any build output — source, tests, docs, and the template
   only.
2. The full test output, pasted in the chat, unedited — including the
   command run and the pass/fail counts.
3. A file tree of the bundle, and one paragraph saying what was built,
   what was not, and what is still stubbed. No silent stubs. If a
   feature is a stub, the paragraph names it.
4. Nothing is claimed as verified until the bundle is re-run clean
   elsewhere. Counts from the builder's machine are reported as
   builder-reported, never as verified.

## Prompt budget

The human has roughly 13–14 prompts for this build. Spend them like they
are the budget they are:

- **Prompt 1:** this plan, whole. Build all of it.
- **Remaining prompts:** fixes only, against failing evidence from the
  clean re-run — one failure, one fix, re-run, report. No new features
  in fix prompts. No re-asking for the plan. If a fix needs a design
  decision, the builder picks the smaller change, says what it picked,
  and moves on.

## Sequencing note for whoever builds this

Phase 0–1 first — that is mostly wiring that already exists in spirit.
Signing slots in without restructuring: the ledger is already one signed
event per turn in waiting. The garden and the canon come after the room
proves itself, not before. The non-goals list is the thing to protect:
every temptation to add a summarizer, a score, or a silent rewrite is the
room slowly turning back into the switchboard it was built to replace.
And the delivery contract is not paperwork — it is the difference between
a room that exists and a room that was only ever claimed.

## Working title

**The Room.** It is not a product pitch; it is the place where the panel
stops being tabs and starts being company — and the first room the Engine
will learn to spin.

---
*Plan only. No code written. The next step is the human pasting this plan
into Zo as prompt 1, then holding every later prompt to the delivery
contract: bundle, test output, tree, and no claim until the clean re-run.*
