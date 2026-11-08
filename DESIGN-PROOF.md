# Live-member design proof

## Frozen input and protected surfaces

The implementation starts from the requested Drive archive. Its archive hash and the contract/verifier hashes are recorded in `delivery/FROZEN-HASH-REPORT.md`. The contract and root verifier remain byte-identical to that source. No contract body, event shape, canonicalization rule, key-generation algorithm, or seal behavior is changed.

## Admission invariants

- **Assignment identity:** `task` remains the existing signed human turn. `run-member` accepts only an existing turn addressed by the live member's exact name and fingerprint, in a subscribed thread, authored by a present human. No assignment event shape is added.
- **Verified input:** before probing or generating, the runner verifies the root chain and compares the verified event count and head with the room snapshots used for the assignment. A failed or changing chain stops before any Ollama request.
- **Local-only transport:** the adapter accepts only a loopback HTTP origin, rejects credentials and paths, and disables redirects. Its only requests are the model-list probe and one non-streaming generation request. It has no retry path and uses Node's built-in `fetch` only.
- **Runtime model selection:** the adapter reads model names from the local `/api/tags` response. A configured name must be present in that response; otherwise, the first reported name is selected. The source contains no claim that any particular model is installed.
- **Draft separation:** generation returns an in-memory draft and integer usage counts. The Ollama adapter has no ledger writer, signer, or policy bypass. The runner calls only the existing `postTurn` path to attempt admission.
- **Budget gate:** before contacting Ollama, the runner checks pause state and remaining member allowance and caps requested generation using the existing prompt estimate. It then validates the API-reported counts as safe integers and rejects a turn whose total exceeds the remaining allowance or the existing per-turn limit. `postTurn` repeats the locked budget and policy preflight against current state, so a concurrent budget change cannot create an over-budget event. There is no retry after rejection.
- **Strip and signing order:** `postTurn` checks policy on the original draft, calls the existing `stripPaste` pipeline (wrapper rules before filler rules), signs the stripped text through the existing event signer, validates the candidate locally and with the unchanged root verifier, and verifies the written transcript. No live-specific admission route exists.
- **Unavailable service:** an unreachable local service, non-success response, empty runtime model list, or unavailable configured model returns `NOT AVAILABLE` before `postTurn`; therefore no model turn is appended. Invalid protocol data stops without admission.
- **Human exit:** a successful model turn is only an admitted internal turn. Existing signed human review remains required before release.
- **Single-member scope:** joining a second `ollama:runtime` member in the same room is rejected. Fixtures remain unchanged and cannot be run through the Ollama harness path.

## Limits of the proof

The ledger can prove only the token counts returned by the local Ollama API. The pre-call cap uses the Room's existing prompt estimate; it is not a model-specific tokenizer or an independent measurement of inference work. Returned usage is checked before signing, and the ledger cannot contain a reported over-budget turn, but this build does not claim an independent backend usage meter. Model availability and a real generation run are unproven when the optional local test reports `NOT RUN`.

## Validation basis

The source archive was extracted and validated on the same host. `delivery/TEST-OUTPUT.log` contains the complete unedited test-run output; its optional live Ollama test is reported separately as `NOT RUN` when no local service is reachable. No independent-machine validation is claimed.
