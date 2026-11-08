# Validation report

Validation was performed on the same host as implementation, from a clean extraction of the source-only release archive. It was not an independent-machine run.

- `npm ci`: PASS. Full output: `NPM-CI-OUTPUT.log`.
- `npm run typecheck`: PASS. Full output: `TYPECHECK-OUTPUT.log`.
- `npm test`: PASS, 42 tests total, 41 passed, 0 failed, 1 skipped. Full unedited output: `TEST-OUTPUT.log`.
- The optional live Ollama test reported `NOT RUN` because Ollama was not reachable at the configured loopback host. No live model output or installed model is claimed.
- `npm run room -- help`: PASS. Full output: `CLI-HELP-OUTPUT.log`.
- The certified baseline test run completed with 34 passed and 0 failed. Full unedited output: `BASELINE-TEST-OUTPUT.log`.

Frozen archive and file hashes are recorded in `FROZEN-HASH-REPORT.md`. Stub behavior and unbuilt or unproven scope are listed in `STUB-AND-CLAIM-DISCLOSURE.md`. Earlier interrupted validation and its correction are permanently recorded in the root `FAILURES.md`.
