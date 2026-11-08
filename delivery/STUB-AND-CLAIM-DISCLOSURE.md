# Stub and claim disclosure

## Explicit stubs

- `tests/live-member.test.ts` contains a local HTTP server labeled `STUB`. It implements only the Ollama model-list and generation response shapes needed by the tests. Its response text and usage fields are fixed test values; it does not run, approximate, or validate any language model.
- The optional live test is not a stub. In this environment it was `NOT RUN` because the configured loopback Ollama service was unreachable. No installed model is claimed.

## Unbuilt or parked

- A2A transport, external-service connectors, a presence or other app UI, additional live members, artifact capture, and external alerting.
- Model installation, downloading, pulling, or provisioning; authentication to external model providers; any non-loopback network path.
- A model-specific tokenizer or independent inference-usage meter. The pre-call cap uses the Room's existing prompt estimate; admission checks the integer counts returned by Ollama and the existing ledger remains authoritative.
- Independent-machine validation and a real live-member output through human exit review.

## Claims not made

- The member registry value `ollama:runtime` is an adapter marker, not a claim that a particular model is installed.
- No particular model is said to be installed or available. Runtime model selection comes from the local Ollama model-list response.
- No model-quality, latency, throughput, inference-cost, or measured-savings claim is made.
- The stubbed tests prove control flow and ledger integration only; they do not prove model behavior or deployment-host availability.
- The live run's backend token consumption is not independently measured. Ollama's returned usage values are the values submitted to the existing ledger checks.

## Keys and package contents

The implementation reuses the Room's existing runtime identity creation path when an Ollama member joins. Tests create temporary identities in test homes and clean them up. No deploy identity, private key, credential, or secret is included in the source archive. The archive audit excludes dependency directories, build output, `.git`, and key or secret files.
