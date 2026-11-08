# Runbook: finish the Room deployment

Goal: take the verified Room (deployment-security fixes, 51/51) from a
bundle on Zo's machine to a live deployment behind TLS + auth — and stop
at the authorization checkpoint before calling it finished.

Source of truth for the code: Zo's `Projects/integration-gateway-a2a`
tree — the same tree the verified bundle came from. Do NOT deploy from
any other copy, and do NOT push anything to GitHub as part of this
runbook (a push needs Jason's separate word).

## Step 0 — Pick the host (Jason's call)

Any Linux host with Node ≥ 20 that stays on and keeps a stable address
works. Candidates: his Kali laptop (only while it is on and home), or a
host he already runs. A laptop that sleeps or moves networks makes a
flaky deployment — if the Room must stay up, the host must stay up.
Record the choice before continuing; every step below assumes it.
Host picked 2026-10-25: his Dell PowerEdge T340 Linux server
(distro and network details TBD — see the server appendix). The Pi
appendix below is superseded for this deployment.
If the host is a Raspberry Pi, see the appendix — it covers the
Pi-specific installs, storage, and network steps.

## Step 1 — Verify the tree on the host (stop if this fails)

On the host, in the project tree:

```
npm ci
npm run build
npm test
```

All three must pass clean. `npm test` needs the Agent Archive checkout
for the independence test (`AGENT_ARCHIVE_ROOT` if it is not the sibling
default). If anything fails, STOP — do not deploy a tree that does not
pass on the deployment host. Report the failure to Jason instead.

## Step 2 — DNS first

Point a DNS name at the host and wait for it to resolve. Example only —
Jason picks the real name; a subdomain of a domain he already controls
(such as `room.should.love`) is the obvious shape. Nothing below works
until the name resolves to the host, because Caddy obtains its TLS
certificate for that name.

## Step 3 — Secrets (never in the repo, never in the Caddyfile)

Generate these on the host. They live in the service environment only.

```
# Operator token for direct execution + manifest refresh:
openssl rand -hex 32

# Proxy password hash (type a password when prompted; the hash, not the
# password, goes into Caddy's environment):
caddy hash-password
```

Keep the plaintext operator token somewhere the operator can use it for
probes (Step 7) and then store it like a password. If it ever leaks,
generate a new one and restart the gateway (Step 6).

## Step 4 — Gateway environment

Write these to a service env file the gateway's systemd unit reads
(e.g. `/etc/room-gateway.env`, mode 0600, root-owned). Do not commit
this file.

```
HOST=127.0.0.1
PORT=3000
ROOM_PUBLIC_BASE_URL=https://<your-domain>
OPERATOR_TOKEN=<output of Step 3>
ROOM_ALLOW_TOOLS=false
```

Notes on the choices baked in here:

- `HOST` stays loopback. NEVER set `ROOM_ALLOW_NON_LOOPBACK=true` in
  this deployment — the proxy is the only public listener.
- `ROOM_ALLOW_TOOLS=false` is the safe default: signed Room tool
  requests are rejected before they reach the ledger. Setting it to
  `true` is Jason's call, and it means trusting every room that can
  reach the server (see the authorization checkpoint).
- Leave `ROOM_ARCHIVE_URL` at its loopback default unless the Agent
  Archive service is also running on this host. Live seal anchors need
  it; rooms work without it, and anchor attempts fail gracefully.
- Quota/rate-limit defaults (100 rooms, 10,000 events, 100 MiB
  artifacts, 1,000 tasks, 120 POSTs/minute) stand unless Jason says
  otherwise.

## Step 5 — Caddy (TLS + auth in front)

Install Caddy on the host. Use the project's `docs/room.Caddyfile` —
it terminates TLS, requires HTTP Basic Auth, and proxies to
`127.0.0.1:3000`. Run Caddy with these in its environment (the
`{$...}` placeholders in the Caddyfile expand from the environment):

```
ROOM_DOMAIN=<your-domain>
ROOM_PROXY_USER=<a username>
ROOM_PROXY_PASSWORD_HASH=<output of Step 3>
```

Then validate before going live:

```
caddy fmt --overwrite docs/room.Caddyfile
caddy validate --config docs/room.Caddyfile --adapter caddyfile
```

If validation fails, STOP and fix it — do not start Caddy with an
unvalidated config.

## Step 6 — Start the gateway (systemd example)

Example unit (`/etc/systemd/system/room-gateway.service`; adjust paths
to the real tree):

```
[Unit]
Description=Room gateway (integration-gateway-a2a)
After=network.target

[Service]
Type=simple
WorkingDirectory=<path-to>/integration-gateway-a2a
EnvironmentFile=/etc/room-gateway.env
ExecStart=/usr/bin/npm start
Restart=on-failure
RestartSec=5

[Install]
WantedBy=multi-user.target
```

Then:

```
systemctl daemon-reload
systemctl enable --now room-gateway
systemctl start caddy   # or: systemctl reload caddy
journalctl -u room-gateway -n 50
```

The log must show the gateway listening on `http://127.0.0.1:3000`.
Anything else (an error, a non-loopback bind) means STOP.

## Step 7 — Verification probes (all must pass, report all results)

Run these and report every result to Jason — passes AND failures.
Probe from a second machine where a probe says "from outside".

1. **TLS + auth:** `https://<your-domain>/.well-known/agent-card.json`
   without credentials → 401. With the proxy username/password → 200,
   and the card's A2A URL starts with `https://<your-domain>` (never
   `http://`, never a reflected Host value).
2. **Loopback proof:** from another machine on the network,
   `curl http://<host-ip>:3000/health` → connection refused. Port 3000
   must not answer off-host.
3. **Token gate:** `POST https://<your-domain>/api/v1/execute` without
   `Authorization: Bearer <OPERATOR_TOKEN>` → 403. With it → executes.
   Same for non-room `POST /a2a` `message/send`.
4. **Tools flag:** a signed Room tool request with
   `ROOM_ALLOW_TOOLS=false` → rejected, and the room transcript is
   unchanged. (If Jason set it `true`, a tool request executes instead
   — report which behavior was observed.)
5. **Manifest:** `GET https://<your-domain>/api/v1/manifest` → serves
   the manifest (or 404 if none exists yet) without rebuilding.
   `POST /api/v1/manifest/refresh` without the token → 403.
6. **A real room round-trip:** create a room, append a member-signed
   turn, read it back, and (if the archive service is up) anchor it.
   The transcript must verify under the Room's own verify route.
7. **Logs:** `logs/access.jsonl` and `logs/executions.jsonl` exist,
   are mode 0600, and the access log shows the probe requests with
   method, path, and status only.

## Step 8 — AUTHORIZATION CHECKPOINT (do not skip)

The deployment is NOT finished when the probes pass. It is finished
when Jason, having seen the probe results, explicitly authorizes
leaving the proxy up. Report to him:

- the host and domain chosen,
- every probe result from Step 7,
- whether `ROOM_ALLOW_TOOLS` is false or true,
- the residual limits he already knows: no per-room read ACLs (proxy
  users are the only readers), no trusted-human key list, signatures
  prove key possession — not identity, independence, or truth.

If he does not authorize, STOP Caddy (`systemctl stop caddy`) and leave
the gateway loopback-only. A running public proxy without his word is
not a finished deployment — it is an exposure.

## After it is live

- Rotate `OPERATOR_TOKEN` by generating a new value, updating the env
  file, and restarting the gateway.
- Update by re-running Step 1 on a newly verified bundle, then
  restarting the service. Never deploy an unverified tree.
- Logs are private local data: `logs/access.jsonl`,
  `logs/executions.jsonl`, `rooms/`, `.data/store.json` — keep the host
  itself secured; the proxy is not a substitute for host hygiene.
- Still open (separate work, not this deployment): per-room ACLs,
  trusted-human key lists, seed encryption, the identity layer, the
  Vitest upgrade, the full-registry swap.

## Appendix: Raspberry Pi host notes

Use this when the Step 0 host is a Raspberry Pi. The main runbook still
applies in full; this appendix covers only what is Pi-specific.

### Which Pi

- Recommended: Pi 4 or 5, 4 GB RAM or more, running 64-bit Raspberry Pi
  OS Lite (no desktop needed for a server). Check with `uname -m` — it
  should print `aarch64`.
- Works but slower: Pi 3, Zero 2 W. Startup and the test run take
  longer; household load is still fine.
- Not recommended: original Pi Zero / Pi 1 (armv6) — current
  NodeSource builds don't cover armv6. Don't fight it.

### OS and runtime installs

Flash 64-bit Raspberry Pi OS Lite to the boot drive (see Storage), then:

Node — system-wide, so the systemd service can use it (nvm is
per-shell and awkward for services):

```
sudo apt update && sudo apt upgrade -y
curl -fsSL https://deb.nodesource.com/setup_lts.x | sudo -E bash -
sudo apt install -y nodejs
node -v   # must be >= 20
```

(If the OS repo's own nodejs is already ≥ 20 that works too;
NodeSource is the reliable route to a current LTS.)

Caddy — official repo. The apt package enables the caddy service and
puts a starter Caddyfile at `/etc/caddy/Caddyfile`:

```
sudo apt install -y debian-keyring debian-archive-keyring apt-transport-https curl
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | sudo gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' | sudo tee /etc/apt/sources.list.d/caddy-stable.list
sudo chmod o+r /usr/share/keyrings/caddy-stable-archive-keyring.gpg /etc/apt/sources.list.d/caddy-stable.list
sudo apt update
sudo apt install -y caddy
caddy version
```

Replace `/etc/caddy/Caddyfile` with the project's
`docs/room.Caddyfile` content. Because the apt install runs Caddy as a
service (user `caddy`), the `{$...}` placeholders must be in the
caddy service's environment, NOT in the Caddyfile:

```
sudo systemctl edit caddy
```

with:

```
[Service]
Environment="ROOM_DOMAIN=<your-domain>"
Environment="ROOM_PROXY_USER=<a username>"
Environment="ROOM_PROXY_PASSWORD_HASH=<output of Step 3>"
```

Then validate (Step 5) and `sudo systemctl reload caddy`.

The gateway systemd unit from Step 6 works unchanged — just make sure
its WorkingDirectory points at the real tree path on the Pi, and that
node/npm are on the service's PATH (the system-wide NodeSource install
covers this).

### Storage: USB SSD, and backups

- Run the OS from a USB SSD, not an SD card. The Room's ledger is
  append-only and writes constantly (`rooms/`, `logs/`,
  `.data/store.json`); SD cards wear out under that and corrupt on
  power loss. Pi 4/5 boot from USB — flash Pi OS to the SSD with Pi
  Imager.
- Use the official power supply. Undervoltage is the classic cause of
  "weird Pi crashes" and storage corruption.
- Back up the Room's memory: `rooms/`, `.data/store.json`, and the
  non-secret parts of the env file. The ledger is append-only, so a
  plain rsync copy to another machine or a second USB drive is a
  complete backup. Losing `rooms/` means losing the history — there is
  no vendor copy to restore from.
- A small UPS is good practice for a 24/7 Pi, but the store's atomic
  writes (tmp file + rename + fsync) already protect individual files
  from a mid-write power cut; without one, the risk is losing the last
  write, not corrupting the whole ledger.

### Network: the fiddly part on a home connection

- Give the Pi a stable LAN address: a DHCP reservation on the router
  (preferred) or a static IP on the Pi.
- Forward TCP 80 and 443 on the router to the Pi's LAN address. Caddy
  needs 80/443 reachable from the internet to obtain and renew its
  certificate automatically (HTTP-01 / TLS-ALPN challenge).
- DNS A record → public IP. If the ISP rotates the public IP, use
  dynamic DNS (DuckDNS, Cloudflare, or the registrar's DDNS) and keep
  the record fresh — Caddy keeps serving on a valid cert, but a stale
  record means new visitors can't reach the Pi and renewal eventually
  fails.
- If port forwarding doesn't work at all: check for CGNAT first. Many
  5G and some fiber ISPs share one public IPv4 across customers, so no
  inbound forwarding is possible. Signs: the router's WAN IP is in
  `100.64.0.0/10`, or differs from what a "what is my IP" check shows.
  Fallbacks, in order: IPv6 if the ISP provides it (Caddy serves IPv6
  fine), or a tunnel (Cloudflare Tunnel, Tailscale) — a tunnel changes
  the trust picture, so it needs Jason's call, not a quiet
  substitution.
- If port 80 is blocked but 443 is open: Caddy can use the DNS
  challenge instead (needs a DNS plugin for the provider). Note it as
  an option; don't silently switch challenge types.

### Performance expectations on a Pi

- Startup is the slowest part: the registry scan runs once per server
  start (memoized after). Fixture scale (1,208 entries) is seconds to
  tens of seconds on a Pi 4/5; the full 14k registry, if ever swapped
  in, would be minutes — plan cold starts accordingly.
- Room reads re-verify the full signed history every time (by design).
  At household scale this is fine; a room approaching the 10,000-event
  cap will feel slower on a Pi than on a laptop — that cap exists
  partly for this reason.
- The Step 1 test suite takes longer on a Pi than the ~7 s seen on the
  verification host. Slower is fine; failing is not.

## Appendix: Dell T340 Linux server notes (host picked 2026-10-25)

None of the Pi appendix applies here: x86_64, real disks, no ARM
builds, no SD-card wear. The generic Steps 1–8 stand; this appendix
covers only the server deltas. Distro and network details are still
TBD — fill them in before Step 1.

### Check what already lives on the box first

A server that already runs things is different from a fresh Pi.
Before Step 5, check what owns ports 80 and 443:

- `ss -tlnp | grep -E ':80 |:443 '` — if an existing web server
  or reverse proxy already binds them, do NOT start a second
  Caddy on the same ports. Instead the Room joins as one more
  reverse-proxy entry (a new vhost / location) on the existing
  proxy, with the same TLS + auth shape as Step 5. Record which
  proxy owns the ports before continuing.
- Host firewall: if `ufw` or `firewalld` is active, allow 80/443
  (or the proxy's ports) explicitly; a silent firewall drop looks
  exactly like a failed port forward.

### Distro install routes (pick one)

- Debian/Ubuntu: NodeSource LTS for Node ≥ 20 (system-wide, so
  systemd services see it), and the Cloudsmith Caddy apt repo, as
  in the Pi appendix's install commands — the commands are the
  same on x86_64, only the architecture differs.
- RHEL/Rocky/Alma/Fedora: NodeSource's RPM repo for Node ≥ 20,
  and Caddy's official RPM repo (or the distribution's Caddy
  package where current). Confirm with `node -v` (must be ≥ 20)
  and `caddy version` before Step 1.
- If Node ≥ 20 or Caddy is already installed, skip that install
  and record the versions — do not reinstall over a working setup.

### Storage and backups

Real disks remove the SD-card failure mode but not the backup
requirement: RAID is not a backup. `rsync` the `rooms/` and
`.data/` directories off the box on a schedule (the ledger is the
history — losing it loses the Room). The gateway's atomic
tmp+rename+fsync writes already protect individual files; backups
protect against disk, fire, and fat-finger loss.

### Network

Same shape as the Pi network section: a stable LAN address
(DHCP reservation or static IP), router forwards for 80/443 to
that address, and a DNS A record for the chosen domain — unless
the server is already internet-facing with a domain, in which
case the forwards are already done and only the DNS record for
the Room's name is new. If port forwarding does not work,
check CGNAT first (WAN IP in 100.64.0.0/10, or differing from a
"what is my IP" lookup) before assuming a config error.

### Performance, and a second job for this box

Room load at household scale is a non-issue on a T340 — the Pi
performance notes do not bind here. The same box is also the
leading candidate for Toy-001's Ollama host (the 100-round run
needs a reachable Ollama server, which neither the Pi nor any
current host provides). That is a separate decision: CPU-only
inference for small models is slower than GPU inference, so
measure one model's round-trip time on this box before promising
the 100-round run a schedule.
