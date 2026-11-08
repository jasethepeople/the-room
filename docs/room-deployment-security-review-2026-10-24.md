# The Room — Deployment Security Review (2026-10-24)

Reviewer: Muse (this assistant). Tree reviewed: `~/workspace/room-verify/integration-gateway-a2a/`
(the independently verified Room bundle; suite 35/35, tsc clean, 2026-10-24 ~05:00).
Method: read the server, A2A agent, router, logger, store, identity, archive, and
`docs/ROOM.md` in full. No code changed, nothing exposed, nothing pushed.

## Verdict: DO NOT EXPOSE as-is

The Room is safe to run loopback-only on a single-user machine, which is its
current posture and its own documented posture. It is **not** safe to bind to a
network as it stands. Exposure requires the prerequisites in §5, a re-review of
the access-control layer itself, and Jason's explicit authorization — the
project's own `AGENTS.md` says: "Keep the server loopback-bound by default. Do
not expose it or push anything to GitHub without Jason's explicit
authorization." `docs/ROOM.md` says the same in its own words: "The HTTP routes
do not implement user login or per-room read authorization; keep the server
local unless you add and review an access-control layer."

This review authorizes nothing. It is the analysis that must precede any
exposure decision.

## 1. Critical blockers for any network exposure

### 1.1 Two unauthenticated remote-execution endpoints

There is no authentication anywhere in the server: no tokens, sessions, API
keys, or middleware (`src/server.ts`, whole file). Two routes execute gateway
components for anyone who can reach the port:

- `POST /api/v1/execute` → `router.execute()` (`server.ts`, execute route).
- `POST /a2a` → `message/send` with no `room_id` data part →
  `executeRequestFromMessage` → `runExecuteTask` → `router.execute()`
  (`src/a2a/agent.ts`, `handleMessageSend`).

Components run **in-process, unsandboxed**: `component.run(ctx, req.event, {})`
(`src/router.ts`, `execute`). There is no sandbox, no separate uid, no
capability drop. Execution happens as the server process user, with the
server's filesystem and environment.

### 1.2 The Room tool path is not a trust boundary for execution

Room tool invocation looks gated — member signature + `allowed_tools` +
thread subscription + SHA-256-bound input (`src/room/store.ts`,
`validateEventSemantics`, `room.tool.request`) — and within a room it is.
But room creation is permissionless and every identity in it is
self-asserted: anyone who can reach the server generates keypairs, creates a
room with themself as the "human," grants themself any `allowed_tools`, and
invokes them (`src/room/store.ts`, `create` + `validateGenesis`; genesis
requires a human signer, but "human" is a role label in a self-signed event).
So the Room path gives the same unauthenticated execution as §1.1, with a
signed audit trail attached. The allowlist binds a member *inside* a room; it
does not decide who may execute *on the host*.

### 1.3 Host vendor credentials are handed to components

`envAuthForApp` derives `APP_<APPNAME>_*` environment variables into the
`auth` object passed to every component (`src/router.ts`, `buildContext`),
and request-supplied `auth` merges over it. If the deployment host carries
vendor credentials in env (GitHub, Slack, Stripe, etc.), exposed execution
means abuse of those credentials, not just code execution. This is the
highest-blast-radius consequence of §1.1/§1.2.

### 1.4 All room content is readable unauthenticated

Every read route is open: `GET /api/rooms` (list), `GET /api/rooms/:id`
(summary), `/verify`, `/events` (full event history), `/anchor-context`,
ledger files (`transcript.jsonl`, `transcript.md`, `header.md`, `seams.md`,
`genesis.json`), and artifacts by event id + filename (`server.ts`, room
routes). There is no per-room read authorization — `ROOM.md` states this
plainly. On a network, every room's full transcript and every artifact is
public to anyone who can reach the port. (Tool *inputs* are hash-only in the
transcript by design — but see §2.3 for the side-channel that undoes this.)

### 1.5 No TLS, and Host-header-reflected URLs

The server is plain `node:http` — no TLS option exists. `HOST`/`PORT` env
vars control the listener (default `127.0.0.1:3000`, `server.ts` main block);
setting `HOST=0.0.0.0` exposes plaintext HTTP. Agent-card URLs are built from
the request `Host` header (`http://${req.headers.host}/a2a`), so a hostile
`Host` header poisons advertised card URLs, and the scheme is always `http`
even behind a TLS proxy (downgrade + misdirection).

## 2. High-severity issues

### 2.1 No quotas, rate limits, pagination, or task eviction → resource exhaustion

- Unlimited rooms, events per room, and artifacts per room (4 MiB each, no
  count cap) → trivial disk exhaustion by an unauthenticated creator.
- Every read/append re-reads and fully re-verifies the room's entire history
  and re-renders both Markdown views (`store.ts`, `read`); `list()` does this
  for every room; `GET /events` returns the full history with no pagination
  → CPU/memory amplification: one large room makes every request O(history).
- The A2A task map is never evicted (`agent.ts`, `tasks` Map); every
  `message/send` stores a task forever, including execution results whose size
  is uncapped → slow memory growth from unauthenticated requests.

### 2.2 Error responses leak internals

Failed executions return `error: { message, stack }` to the caller
(`router.ts`, `execute`). Stack traces disclose file paths and code
structure — free reconnaissance on an exposed server. Unhandled 500s also
return `err.message`, which can carry filesystem paths.

### 2.3 The execution log is a plaintext side-channel for tool inputs

`logger.logExecution` records the full request event and result
(`router.ts`, `execute`) to `logs/executions.jsonl`. Redaction is by key
name only, against six defaults (`access_token`, `token`, `secret`,
`password`, `api_key`, `authorization`, `src/logger.ts`). Any secret carried
under a different key name — a prompt containing a code, a passphrase field,
a component result echoing data — is logged in full, with default file
permissions (no mode set on `appendFile`/`mkdir`). This bypasses the
transcript's deliberate hash-only storage of tool inputs for everything not
named exactly like a credential. The persisted component store
(`.data/store.json`, `router.ts` `Store`) is likewise written with default
permissions and no quota.

### 2.4 Side effect on GET: manifest regeneration

`GET /api/v1/manifest` spawns `scripts/registry-manifest.mjs` via
`child_process` when the manifest is stale (`server.ts`, `getManifest` /
`regenerateManifest`). The script path is fixed (not injectable), but an
unauthenticated GET triggers a build step with CPU and disk writes. GET
routes must not have side effects on an exposed server.

### 2.5 Sybil: "human," distinct signers, and doctrine canon are self-asserted

Genesis requires ≥1 human + ≥1 agent and a doctrine rule with
`min_signatures ≥ 2` and distinct signers (`store.ts`, `validateGenesis`),
but all identities are self-generated keypairs. One operator holding N keys
satisfies every "distinct human/agent" requirement alone. Doctrine canon and
"human-only" seam/seal therefore attest to *key possession*, never to
real-world independence, humanness, or the truth of a claim. `ROOM.md` says
this ("Signatures prove possession of a pinned key, not a participant's
real-world identity, independence, or the truth of a claim") — it is a
governance limit, not a code bug, but it must shape what a deployed Room's
doctrine is ever allowed to mean.

## 3. What is genuinely good — keep all of it

- **Write path inside a room is real authentication.** Appends require valid
  MOLT signatures against genesis-pinned keys, verified on every read and
  append; sealed histories are immutable; appends are serialized per room
  with atomic writes and rollback (`store.ts`, `read`/`appendUnlocked`).
- **No path traversal found.** Room ids are strict slugs, artifact filenames
  are strict ASCII with no `..`, artifact fetch requires the matching signed
  event, ledger-file reads are restricted to five literals at the route
  layer (`store.ts`, `server.ts`).
- **The server never holds member private keys.** It verifies only; seeds
  stay with members, and identity files enforce mode 0600 on load
  (`src/room/identity.ts`). The unencrypted-seed risk is member-side (see
  §5.5), not a server key store.
- **Tool/artifact binding is sound.** Inputs are SHA-256-bound, artifacts are
  hash- and length-bound with a 4 MiB cap, allowlist entries are format-
  validated, thread subscription is enforced (`store.ts`).
- **Archive anchoring is well-guarded.** The archive URL is server
  configuration only (never request-controlled, so no SSRF); remote archive
  URLs require HTTPS plus `ROOM_ARCHIVE_ALLOW_REMOTE=true`; anchor proofs
  are strictly validated against the sealed transcript and policy
  (`src/room/archive.ts`, `store.ts` `validateArchiveProof`); 15 s fetch
  timeout.
- **Body size limits exist at every endpoint** (5 MB default, 512 KB room
  create, 1 MB anchor, 8 MB `/a2a`, `server.ts` `readBody`).

## 4. Loopback posture today: safe with one caveat

On a single-user machine, loopback-only (`127.0.0.1`) is an acceptable
posture: the attacker must already be local. Caveat: on a shared or
multi-user host, *any* local user or process can reach the port and gets
everything in §1 for free. Loopback is a boundary against the network, not
against local users.

## 5. Prerequisites for any deployment (in order)

1. **Access-control layer, then a re-review of it.** Authenticated identity
   for all routes, per-room read authorization, and execution endpoints
   restricted to authorized operators. This is the layer `ROOM.md` itself
   demands. A reverse proxy with auth in front of a still-loopback-bound
   server is the smallest sound shape; in-server auth is the alternative.
   Either way the layer itself gets reviewed before exposure.
2. **TLS termination** at the proxy, and Host-header handling fixed (no
   reflected card URLs; https-aware base URL).
3. **Execution gating.** Separate the execution endpoints from the room API
   in the auth policy. Decide explicitly whether room tool execution stays
   for rooms whose creator is trusted, or is disabled for self-asserted
   rooms; never let self-asserted genesis alone authorize host execution.
   Audit what `APP_<APP>_*` credentials exist on the deployment host first —
   they are the blast radius.
4. **Quotas and limits.** Per-room and global caps (rooms, events, artifact
   bytes), rate limits, pagination on `/events`, task eviction and bounded
   result sizes, and a cap on full-history re-verification work per request.
5. **Seed hygiene for member harnesses.** Encrypted identity files (or OS
   keychain) for any member harness; never run member harnesses on the
   server host with plaintext seeds unless the host is single-user, since
   host compromise then equals impersonation of every member on that host.
6. **Log hygiene.** `logs/executions.jsonl` and `.data/store.json` to 0600,
   extended redaction or disabled result logging for sensitive tools, and
   access logging for room reads/creates (currently absent).
7. **Error hygiene.** Generic 500s; no stack traces or filesystem paths in
   responses; no side effects on GET (manifest regeneration behind an
   authorized admin action).
8. **Identity layer — only if doctrine/human actions must mean more.** If a
   deployed Room's canon or "human" actions will ever be treated as
   independent-human attestation, members need real identity verification;
   otherwise document that they do not, and never let doctrine canon stand
   in for it.
9. **Jason's explicit authorization to expose**, after §1–§8 and the
   access-layer re-review. Until then, loopback stays the default.

## 6. Suggested deployment shape (if he wants it)

Reverse proxy (TLS + auth) in front; the Room server stays loopback-bound
behind it; execution endpoints restricted to operators; room reads restricted
per room; quotas, log perms, and error hygiene from §5 applied; member
harnesses on separate machines with encrypted seeds; archive kept loopback
or behind the same proxy with HTTPS + the remote flag.
