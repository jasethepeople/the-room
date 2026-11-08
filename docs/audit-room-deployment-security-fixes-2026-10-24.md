# Audit: Room deployment-security fixes (Zo round one) — VERIFIED 2026-10-24

Bundle relayed by Jason: `integration-gateway-a2a-deployment-security_0_37za.zip`
(660,194 bytes, 1,265 files). Extracted to scratch
`~/workspace/room-fix-verify/integration-gateway-a2a/`; the verified Room
tree was left untouched and used only as the diff baseline.

## Verdict: ACCEPTANCE MET for round one

Every item in the fix brief (`room-fix-brief-for-zo-2026-10-24.md`) is
implemented, tested, and independently re-run. This closes the code half
of the deployment review. It does NOT authorize exposure: the proxy still
has to be actually deployed and reviewed, and Jason's explicit
authorization to expose is still required (project AGENTS.md).

## Independent re-run results (my hands, not Zo's)

- `npm ci`: 57 packages, clean (same count as the Room verification).
- `npm run build` (`tsc --noEmit`): clean.
- `npm test`: **51/51 passed, 7 files, zero failures, two consecutive
  full runs.** Breakdown: security 14, room 7, room-a2a 5, e2e 5, router 7,
  a2a 8, loader 5.
- The standalone Archive CLI independence check ran and passed
  ("verifies the Room history and signed archive anchor with
  agent-archive's standalone CLI", `AGENT_ARCHIVE_ROOT` pointed at the
  independently verified v0.2 archive checkout). Not skipped.
- The e2e real-network test used its fixture fallback
  ("[e2e] get-repository via fixture API") — no live network dependency.

## Brief-item checklist (each with a passing test and a code read)

- **D1 proxy shape:** `docs/room.Caddyfile` delivered (TLS + Basic Auth,
  reverse proxy to `127.0.0.1:3000`, no plaintext password, hash via
  `caddy hash-password`). `ROOM_PUBLIC_BASE_URL` is validated (absolute
  http(s), no credentials/query/fragment, `/a2a` suffix enforced) and is
  the only card-URL source; the request `Host` header is never used.
  Non-loopback `HOST` is refused at startup unless
  `ROOM_ALLOW_NON_LOOPBACK=true`, with a loud warning even then; the
  check lives in the main entry block only, so tests are unaffected.
- **D2 token gate:** `POST /api/v1/execute`, non-room `POST /a2a`
  `message/send`, and `POST /api/v1/manifest/refresh` require
  `Authorization: Bearer <OPERATOR_TOKEN>`, compared timing-safe.
  Fail-closed: unset, missing, or wrong token → 403. Room messages
  (carrying room data) are exempt and remain signature-gated — verified
  by test, not just by reading: the gate checks `roomDataFromMessage`
  before the token.
- **D2 tools flag:** `ROOM_ALLOW_TOOLS` defaults to `false`. The check
  sits in `runRoomTask` BEFORE `appendToolRequest`, so a refused tool
  request never enters the transcript (verified by line order, and by
  the test asserting the transcript is unchanged).
- **D3 reads deferred (as briefed):** `docs/ROOM.md` and `docs/A2A.md`
  state explicitly that reads are authenticated-users-only via the
  proxy, with no per-room ACL. No ACL system was invented.
- **F1 quotas:** max rooms 100, max events per room 10,000, max artifact
  bytes per room 100 MiB (each artifact still capped at 4 MiB), all
  env-overridable. Room creation checks the room cap before writing any
  files; creation is serialized on a global key so concurrent creates
  cannot both pass the count check. Violations → 409 with a named code.
- **F2 pagination:** `GET /api/rooms/<id>/events?limit=&offset=` returns
  `{total, limit, offset, events}`; limit 1–1000, default 100, validated
  at both the HTTP and store layers. Every page read still re-verifies
  the complete signed history (stated in the docs, tested).
- **F3 eviction/caps:** task map capped at 1,000 with true LRU eviction
  (evicted tasks' controllers are aborted); oversize task artifacts are
  replaced with an `omitted-for-size` note, never truncated mid-JSON.
- **F4 rate limit:** fixed-window 120 POSTs/minute/IP, 429 with
  `Retry-After`. `X-Forwarded-For` is trusted only when the TCP peer is
  loopback; otherwise the socket IP is used. Bucket map is capped
  (10,000) with stale-bucket cleanup.
- **F5 log/store hygiene:** dirs 0700, files 0600 — enforced in code
  (mkdir/open/chmod) for the access log, execution log, component
  store (now atomic tmp + rename), room dirs, artifact dirs, artifact
  files, and the manifest writer. Disk-confirmed after the run:
  `logs/` is 0700, `access.jsonl` and `executions.jsonl` are 0600.
  Redaction keys extended with `private_key`, `private_key_hex`,
  `seed`, `passphrase`, with normalized matching (case/punctuation
  variants match). Access log records timestamp, method, path, status
  only — no bodies, headers, or query strings.
- **F6 error hygiene:** no `stack` in any response; 500s return a generic
  message; stacks go to the server console only. A2A error artifacts
  carry a generic message, not the thrown error. Component error
  messages are returned message-only (no paths — the loader's error
  wording was changed to name the target, not the file path).
- **F7 manifest off GET:** `GET /api/v1/manifest` serves disk contents
  (404 with a pointer to refresh if absent) and never rebuilds.
  `POST /api/v1/manifest/refresh` is token-gated; `npm run
  refresh:manifest` is the local equivalent. The manifest script
  validates per-app manifest structure and writes atomically
  (0700/0600).

## Baseline integrity (what Zo did NOT break)

- `src/room/archive.ts`, `identity.ts`, `client.ts`: byte-identical.
  MOLT signing, canonicalization, and identity format untouched.
- `src/loader.ts`: only error-message wording changed (no file paths in
  errors). The 64-in-flight bound is untouched.
- `package-lock.json`: unchanged. No Vitest upgrade, no new production
  dependencies (the only `package.json` change is the new
  `refresh:manifest` script).
- Room semantics preserved: one-byte tamper rejected, re-signed tail
  rejected at the seal, doctrine co-signature rule, seal + archive
  anchor, task cancellation — all still passing.
- Test harness updated the right way: a default test operator token and
  bearer header in `tests/helpers.ts`, and `allowRoomTools: true` passed
  explicitly where Room tool tests need it. No test was weakened to
  accommodate a gate.

## Correctly NOT built (per the brief's out-of-scope list)

Seed encryption, per-room read ACLs, per-room trusted-human key lists,
an identity layer, the Vitest upgrade, the full-registry swap. None of
these appear in the bundle. The docs name the deferred items instead of
pretending they exist.

## Nits (non-blocking, noted for a later round)

- `docs/A2A.md` lost the `GET /api/rooms/<id>/genesis.json` table row
  during the events-row edit. The route itself still works (it is in
  the server's ledger-file list); only the doc row is missing.
- `server.ts` keeps a vestigial `response.ok ? 200 : 200` ternary on the
  execute route (pre-existing, harmless).
- Display artifact, not a bundle defect: my tool outputs rendered the
  test bearer value as `<redacted>` in two places. A count-only check
  proves the file on disk contains the real test value twice and zero
  literal `<redacted>` placeholders — and the cancel test passing with
  that header confirms the token matches. Nothing to fix in the bundle.

## What remains before any exposure

1. The proxy itself must be deployed per `docs/room.Caddyfile` and
   reviewed (TLS, auth, upstream kept private).
2. Deployment-time secrets (`OPERATOR_TOKEN`, proxy password hash) must
   be set by the operator — correctly, none of them are in the bundle.
3. Jason's explicit authorization to expose, per the project AGENTS.md.
4. The deferred items (per-room ACLs, trusted-human keys, identity
   layer, seed encryption) remain open design questions for multi-party
   hosting; they are not needed for the single-household deployment
   this round assumes.

Nothing was pushed to GitHub. Nothing was exposed. The verified tree is
the scratch copy above; Zo's project remains the source of truth.
