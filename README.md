# The Room — contract-shaped local core

## Repository status

This repo holds the Room as delivered by the builder, assembled from the October 30 live-member delivery (the latest and most complete tree). The frozen contract `ROOM-CONTRACT.md` is byte-identical to the frozen hash. Deploy-time keys are not set and no room is live from this repo.

Verified here on this machine: typecheck clean, 41 tests pass, 0 fail, 1 skipped (the optional live-Ollama test, skipped with no local model present). The same tree ran two live turns on the laptop with a clean verify. In the builder's rounds the wrapper strip passed 26/26 and each migration passed 18/18.

Not verified: the filler-strip round stopped mid-build and its bundle was never separately archived, so the filler-strip path is not claimed verified here, even though its code and tests are the same files this tree carries. The phase 0-1 scaffold had an A2A request projection, but its module no longer compiles against the current types and is not included; there is no A2A transport in this build. The open work is running the Room on the integration-gateway.

A standalone Node.js/TypeScript room ledger. It writes signed, hash-chained events using the frozen room contract and validates staged writes with local replay/policy checks and the frozen root `verify.ts`. It has no database, network listener, provider login, external connector, or A2A transport. An explicitly added harness member can use one local Ollama generation path.

## Run

Requires Node.js 22.18 or newer.

```sh
npm ci
npm run typecheck
npm test
npm run room -- spawn evidence-room "A room for careful evidence" --home /tmp/room-home
npm run room -- verify evidence-room-12345678 --home /tmp/room-home
```

Use the actual `roomId` printed by `spawn`; the example suffix is illustrative. The default home is `~/.the-room` or `ROOM_HOME`. `spawn` loads `template/default/template.json`, creates fresh Ed25519 identities, writes a typed genesis registry and signed system event, then runs the root verifier before returning. The default is one human plus one `fixture:*` harness member. `--members N` adds fixture identities only; it does not start models.

Private keys are stored outside each room under `<home>/keys/`, with owner-only permissions. A room lives under `<home>/rooms/<room-id>/`; public-key fingerprints are the lowercase SHA-256 of the decoded SPKI public-key bytes. Runtime keys and rooms are not part of the source bundle.

## Contract behavior

`transcript.jsonl` is the authority. Each line is a complete contract event envelope with a UUIDv7 ID, consecutive sequence, previous-event hash, canonical payload hash, and Ed25519 signature. The root verifier is the source of truth: if it rejects a staged candidate, the core rejects it too. Failed admission rolls back the transcript and staged files, writes digest/reason-only quarantine metadata, and emits a local `ALERT JASON` message.

The amendment paste supplies the typed canonical rule `{ id, minCosigns }`; it remains a separate document and does not edit the base contract. The core emits only contract event kinds: system, membership, turn, challenge, verdict, proposal, cosign, canon, budget, seam, and seal. A challenge gets at most one verdict; a superseding proposal must cite an earlier proposal; canon replay uses the typed current rule. Member roles are resolved through their registered public keys.

`transcript.md` renders complete envelopes without replacing or summarizing the log. `seams.md` is the human-readable seam view. A seam operation appends its signed seam event and a signed seal checkpoint. A seal snapshots the exact current `seams.md` bytes to `seams.<seq>.md` before the seal event is appended; if the snapshot cannot be written, the event is not written. The root verifier checks the latest seal against the current seam file and historical seals against their snapshots.

The `task` command records an assignment as an ordinary signed human turn. Fixture output is another signed turn. The optional local Ollama member consumes an assignment by its existing event ID and submits its draft only through ordinary turn admission. Exit requests, human decisions, and releases are also represented by signed turns so no non-contract event kinds are introduced; a release requires the human's signed acceptance at the reviewed chain head and is returned only after post-write verification.

## One local Ollama member

Add the room's single live harness member with `member-add-ollama <room-id> <name...> --budget N`. The existing `task` command assigns work; use its signed event ID with `run-member <room-id> <member-or-fingerprint> <assignment-event-id>`. The member must be assigned to the same existing thread, and the assignment must be a signed turn addressed to that member and authored by a present human.

The host defaults to `http://127.0.0.1:11434`. Override it with `--ollama-host URL` or `ROOM_OLLAMA_HOST`; both must resolve to a loopback HTTP origin. Select a model with `--model NAME` or `ROOM_OLLAMA_MODEL`. Without a selection, the member uses the first model name returned by the live Ollama `/api/tags` probe. No model name is built into the project or assumed to be installed. The adapter uses built-in `fetch` only for the local `/api/tags` and `/api/generate` endpoints and rejects redirects.

The member registry uses `ollama:runtime` as an adapter marker, not as the name of an installed model. The actual local model name is resolved only by the runtime probe.

The generated text is an in-memory draft, never a direct ledger write. The runner verifies the room before contacting Ollama, limits requested generation using remaining budget, validates the returned integer usage, and submits the draft to the existing `postTurn` admission path. That path checks policy and budget on original text, applies wrapper stripping before filler stripping, signs, and uses the existing local and root-verifier checks. The command reports the admitted turn as pending human exit review. If Ollama is unavailable, it reports `NOT AVAILABLE` and does not append an event. It does not retry. The server's returned token counts are checked before admission; the project's pre-call prompt estimate is not an independent model tokenizer or backend usage meter.

## Turn stripping and receipts

Turn admission checks policy and size on the original text, applies the existing wrapper strip, then the additive filler strip, and signs the resulting text. A rejected or oversized turn does not receive a receipt. The sidecar retains the original/stripped SHA-256 hashes, byte and line counts, rule IDs, token estimates, and hash-chain fields; `ruleSet` is `wrapper`, `filler`, or `both`.

Filler rules are deterministic and removal-only:

- **F1:** remove a leading `please` (optionally followed by a comma) and trailing `thanks`, `thank you`, `thank you so much`, or `thanks so much` (optionally followed by `!` or `.`).
- **F2:** at sentence starts, remove `could you please`, `can you please`, `would you please`, `will you please`, `would you mind`, `could you`, `can you`, `would you`, `will you`, `kindly`, or bare `please`.
- **F3:** remove `if you don't mind`, `when you get a chance`, `whenever you get a chance`, `if you have a moment`, `I was wondering if you could`, `I would appreciate it if you could`, `it would be great if you could`, `I'd like you to`, and `I would like you to` in prose.
- **F4:** remove `basically`, `essentially`, and `as a matter of fact`; `in order to` becomes `to` by deleting `in order`.
- **F5:** filler matching leaves fenced and inline code, URLs, file paths and filenames, JSON, camelCase/PascalCase identifiers, and text inside single or double quotes untouched.
- **F6:** after removal, collapse repeated spaces, trim outer whitespace, remove spaces before punctuation, drop orphan terminal commas, doubled punctuation, and sentences emptied by stripping. No capitalization or other case conversion is performed.
- **F7:** matching is case-insensitive and whole-word/phrase only.

The existing receipt's token and cost fields are deterministic estimates retained by the strip implementation. They are not Ollama token counts, provider charges, or measured savings. Integer micro-dollar fields remain part of the existing receipt format; displayed decimal-dollar text is not hashed.

## Commands

Run `npm run room -- help` for the full CLI. It supports spawn, verify, status, members, fixture and single Ollama member join/leave, task assignment and local-member execution, turn, challenge/verdict, proposal/cosign/canon, budget pause/resume, seam/seal, exit review/release, and importing already-signed events. Threads are declared in genesis; this build does not add or dispatch live threads.

## Verifiers and tests

`verify.ts` is the contract-first standalone verifier. It imports only Node built-ins and remains independent of `src/`. The unchanged contract test includes the empty-copy test: the verifier runs with only `genesis.json` and `transcript.jsonl` beside it. A separate end-to-end test spawns a room through the migrated CLI and runs the unchanged root verifier against it. `tools/verify-transcript.mjs` is preserved as a dependency-free checker for the earlier scaffold format only; it is not valid for migrated rooms.

The original contract-verifier tests remain unchanged. Live-member coverage uses a local HTTP server labeled `STUB` for assignment flow, budget rejection, outage handling, strip admission, and input-chain verification. A separate optional live-Ollama test is skipped with `NOT RUN` when the configured local instance or model is unavailable. Run all checks with `npm run typecheck` and `npm test`.

## Deliberate scope and stubs

Fixture members never call models. The local Ollama HTTP server in `tests/live-member.test.ts` is an explicitly labeled STUB: it returns fixed protocol-shaped data and does not run or imitate a model. The optional live test is the only test that may contact an installed local model; it reports `NOT RUN` when the configured loopback service or selected model is unavailable. There is no A2A transport, external connector, UI, provider tokenizer, independent usage meter, artifact capture, or external alerting. The pre-call input estimate cannot prove backend token use; returned usage is checked before ledger admission, and the existing locked ledger enforcement remains authoritative. The legacy portable verifier remains for legacy files only. Validation in this delivery is a same-host run, not an independent-machine verification.

## Contract documents

`ROOM-CONTRACT.md` is kept byte-for-byte unchanged. `ROOM-CONTRACT-PASTE-2026-10-28.md` is its companion amendment; implementation follows the typed `canonRule` amendment without silently merging the paste into the base file.
