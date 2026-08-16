# MCP servers pinned to a device

An implementation plan, not user documentation — it is deliberately not linked from
[the Stem guide](README.md).

## The problem

Every MCP server Stem knows about runs wherever `stem-server` runs. `mcp.json` is the
only registry (`src/server/pi/mcp.ts`), and the bridge extension inside the pi process
connects each entry: `stdio` by spawning a child, `http` by opening a connection —
both **from the machine hosting pi** (`stem-mcp-extension.mjs`, `connectOneServer`).

That was invisible while Stem ran on your desk. With the server on a VPS it breaks two
whole classes of tool:

- **stdio servers that only mean anything on your own computer** — your files, your
  applications, your browser, a CLI installed there.
- **HTTP MCP endpoints on your home network** — Home Assistant, a NAS, a router, a dev
  server. The VPS cannot route to `192.168.x.x` and never will.

The UI makes it worse by being wrong about it: the **Remote | Local** toggle
(`McpTab.tsx:343`) does not mean *where*, it means *how* — `Remote` is a URL and `Local`
is a command. On a VPS deployment "Local" means "a process in a container in Germany".

## The shape of the answer

One mechanism, not two. A client that can host an MCP client covers both cases: for
stdio it spawns the process on your machine, and for HTTP it opens the URL **from its own
network**, so `http://homeassistant.local:8123/mcp` works without the VPS knowing that
network exists.

**Where a server runs is a new axis, perpendicular to the existing transport axis.** All
four combinations are meaningful, and no UI that merges them stays honest.

## Decisions

| # | Decision |
|---|---|
| ① | One client-side MCP host covers stdio-on-your-machine and HTTP-on-your-LAN. Location is perpendicular to transport. |
| ② | A server is pinned to a **named device** — `location: { deviceId }` in `mcp.json`, referencing `devices.json`. Not "wherever I'm typing", not "any device that's up": what "my computer" means must be readable from the config, not inferred from where you happened to be sitting. |
| ③ | The **tool catalog is remembered across disconnection**. Availability = that device has an open event stream, evaluated per turn, with no handshake. An unavailable server stays in the catalog, marked, so the assistant can say *"I can do this once your Mac is awake"* instead of silently lacking the capability. |
| ④ | The **spec lives centrally** in `mcp.json`, but **every new or changed spec is approved on the target machine** before it can run. Changing `args`/`env` is a new approval. A compromised server must never be able to start new code on your computer. |
| ⑤ | **No per-call confirmation**, and scheduled runs are allowed. Unlike `run_command`, whose surface is an unbounded command string, an MCP server's tool set is bounded at approval time. A failure caused by a sleeping device must name the server *and* the device. |
| ⑥ | **Eager start when the client launches** — parity with how a local Stem has always behaved (`main.ts:252` prewarms pi, which connects everything). But the approval card is **not** eager: an unapproved spec quietly waits in the Manage panel instead of ambushing you at startup. |
| ⑦ | **Only desktops are offered as hosts.** Not because a phone cannot spawn a process, but because iOS suspends the app and our whole availability signal is "has an open stream" — a phone would flicker between available and unavailable with the screen lock. |
| ⑧ | Delivery rides an **addressed control frame on the existing SSE stream**, written only to that device's streams and never entering the replay ring; the result comes back as an ordinary `POST /rpc`. The channel that carries the call is the same channel that decides availability, so "looks reachable but has nowhere to send work" cannot happen. |
| ⑨ | UI: two truthfully-named controls (*Runs on* + *Command \| URL*), the **place** in each row instead of a globe/plug icon, and the location control **hidden entirely** when Stem is running on this computer — there is one machine, and offering a choice would imply a distinction that does not exist. |
| ⑩ | On the move to a server, existing entries **stay server-located and are flagged**; the fix is a one-click *Move to <device>*. Same on unpairing: an orphaned entry is marked, never silently deleted or silently repointed. |

Derived, and not separately decided:

- Credentials travel with the spec. `env` stays in `mcp.json`, encrypted with the server
  key, and goes down with the spec at connect time. For a device-located HTTP server with
  OAuth nothing changes either: the browser leg already runs on the client
  (`desktop/oauth-courier.ts`) and the token lands in the server's `mcp-oauth.json`.
- Reserved servers (`stem-recall`, the admin server) are always server-located.
- The model's interface does not change. `invoke_tool` / `describe_tool` are unchanged;
  a pinned server is just another routed server to it.
- **A payoff worth naming**: the catalog is server-side, so *from your phone* the
  assistant can see and use tools that run on your Mac, as long as the Mac is on. That
  falls out of ② and ③ for free.

## How a call travels

```
pi (on the server)
  bridge: connectOneServer sees location.deviceId
    → McpDeviceClient: ctx.ui.input(DEVICE_MCP_BRIDGE_TITLE, payload)
                       [same shape as the existing stem-exec-bridge round-trip]
  → PiRuntime.onPiEvent intercepts the sentinel
  → DeviceMcpRouter: does that device have an open stream?
       no  → immediate honest error, no waiting
       yes → addressed control frame (event: mcp-request), NOT in the replay ring
  → desktop/proxy.ts control() → the client's MCP host
       spec not approved on this machine → refuse, surface as pending in the panel
       approved → McpStdioClient / McpHttpClient, here, on this network
  → result back via POST /rpc (mcpHost:result)
  → the held elicitation is answered; the tool returns
```

At client launch the same pieces run in the other direction: the client asks the server
which servers are pinned to it, starts the approved ones, and announces their tool
catalog upward, which refreshes the cached copy.

## Protocol and data-model additions

Nothing here is exotic; each piece has a precedent in the codebase, named next to it.

**`PiMcpServer` (`src/server/pi/mcp-config.ts`)**

```ts
/** Where this server runs. Absent = the machine running stem-server (today). */
location?: { deviceId: string };
```

Mirrored on `McpServerInput` and `McpServerSummary` (`src/shared/types.ts`); the summary
carries the device **label** too, so the panel can render a place without a second call.

**Device kind (`src/server/transport/auth.ts`)** — ⑦ needs to know which paired devices
are desktops. `DeviceRecord` gains an optional `kind: 'desktop' | 'mobile'`, supplied at
pairing by the client and defaulting to `'desktop'` for records written before this
change. The parser already tolerates unknown fields; no `devices.json` version bump.

**Sentinel (`src/server/pi/protocol.ts` + its hand-written twin in the extension)**

```ts
export const DEVICE_MCP_BRIDGE_TITLE = 'stem-device-mcp-bridge';
```

Payload rides in `placeholder`, exactly like `EXEC_BRIDGE_TITLE`:

- `{ op: 'tools', server }` → `{ ok: true, tools: [...] }` — live from the device when it
  is up, from the cache when it is not.
- `{ op: 'call', server, tool, args }` → `{ ok: true, content }` or `{ ok: false, error }`.

`tests/unit/pi-protocol.test.ts` parses the extension source and fails if only one side
changes. Update both together.

**Transport (`src/server/transport/server.ts`)**

- `pushTo(deviceId, name, data): number` — writes a **control frame**
  (`event: mcp-request`, no `id:` line) to that device's streams only, returning how many
  it reached. Control frames already exist for `resync`/`snapshot` and are structurally
  impossible to confuse with a push, which is exactly why they are the right vehicle: a
  data frame carries no `event:` line, so an addressed frame can never be mistaken for a
  broadcast one.
- `connectedDevices(): Set<string>` — the availability signal for ③. The `clients` set is
  already tagged with `deviceId`.
- **The replay ring is not touched.** Its documented invariant (`server.ts:473`) is that
  every frame in it was one every authenticated device was entitled to; an addressed frame
  is not. Do not implement this as a filter inside `push()`. Precedent: the APNs path from
  Phase 4 is per-device and deliberately stays out of the ring too.

**Server channels (`src/server/ipc/mcp.ts`, specs in `ipc/guard.ts`)**

- `mcpHost:hello` → the servers pinned to the calling device: `{ name, spec, fingerprint }[]`.
- `mcpHost:announce` — the client reports its tool catalog and per-server status, plus the
  specs it is holding as unapproved.
- `mcpHost:result` — one call's result, keyed by `requestId`.

`requestId` must be unguessable and single-use. Every server channel is also bound to
`ipcMain` on the desktop (`bindServerChannels`), so a renderer *can* call `mcpHost:result`;
single-use unguessable ids keep that from being able to affect anything but a request that
device was legitimately handed.

**Client-owned channels (`src/desktop/ipc-bridge.ts`, `handleLocal`)** — the approval store
is a fact about *this machine*, so these never go on the wire:

- `mcpHost:localState` → `{ approved, pending, status }` for this machine.
- `mcpHost:approve` / `mcpHost:reject` — the user's decision on a spec.
- `mcpHost:test` — connect now (diagnostics, and the natural place to meet the ⑥ card).

**Approval store (client)** — a small JSON file beside `client-store.ts`'s document,
mapping server name → approved spec fingerprint. The fingerprint is a hash over the
normalized spec **including `env` and header values**, so widening the surface by editing
an already-approved entry cannot slip through.

**Catalog (③)** — keep the two sources separate rather than teaching one to parse the
other:

- `mcp-catalog.json` (bridge) keeps holding **server-located** servers only.
- `mcp-device-catalog.json` (main) holds device-located tool lists, rewritten on every
  client announcement.
- `buildMcpCatalogContext()` (`mcp-config.ts:84`) renders the second block itself and
  concatenates, stamping each device server with its live availability at injection time.
  That is what makes ③'s "evaluated per turn, no handshake" true.

## Work order

Five steps. Each one lands on its own and leaves `main` working.

**1 — Data model and UI, no routing.** `location` through
`mcp-config.ts` → `mcp.ts` → `shared/types.ts` → `McpTab.tsx`. Device kind at pairing, and
a device picker that lists desktops only. Rename the transport toggle to **Command | URL**
— that misnomer has to go regardless of everything else. Location control hidden unless
this client is talking to a remote server (`hooks/useRemoteServer.ts`). The bridge **skips**
located servers for now, the way it skips disabled ones.
*Done when:* a location can be set and survives a restart, existing servers behave exactly
as before, and the full suite is green.

**2 — Transport and router skeleton.** `pushTo` + `connectedDevices`; the `mcp-request`
control frame handled in `desktop/proxy.ts`'s `control()`; the three server channels; a
`DeviceMcpRouter` in the server owning correlation ids, timeouts (120s for a call, 30s for
a tool listing) and the availability check.
*Done when:* a stub host echoes a round-trip end to end in a unit test, and a test asserts
`bufferedFrames()` does not move when `pushTo` is called.

**3 — Client host and approvals.** `src/desktop/mcp-host/` — `McpStdioClient` and
`McpHttpClient` carried over from the extension, the approval store, the fingerprint, eager
start at launch, the catalog announcement. Panel gains the pending state, the approve
action and *Test connection*.
*Done when:* on one machine (use the isolated second instance via `STEM_PROFILE` + CDP) a
stdio server pinned to a device starts after approval, and refuses to start before it.

**4 — Bridge branch and catalog.** `DEVICE_MCP_BRIDGE_TITLE` on both sides plus the drift
test; `McpDeviceClient` in the extension registered into the router's `clients` map so
`invoke_tool`/`describe_tool` need no changes; device servers excluded from the bridge's
catalog text; `mcp-device-catalog.json` and the merge in `buildMcpCatalogContext()`.
Errors name the server and the device.
*Done when:* the assistant can call a tool on the pinned device; with the client closed the
tool is still listed, marked unavailable, and the call fails saying which machine is asleep.

**5 — Migration, orphans, documentation.** `import` flags entries that look device-shaped
(`workspace/state-transfer.ts`); the panel offers *Move to <device>*; revoking a device
marks its servers orphaned rather than deleting them; `docs/running-on-a-server.md` gains
the follow-up to steps 4 and 6.

Run `npm run typecheck`, `npm run lint` and `npm run test` at every step; add unit tests
next to the existing ones (`tests/unit/`) for the router, the fingerprint, the catalog
merge and the ring invariant.

## Residual risk, accepted knowingly

A compromised server **cannot** start new code on your machine — that is what ④ buys.
It **can** invoke any tool you have already approved, without a further question, because
⑤ removes per-call confirmation. The whole protection therefore sits in what you approve,
not in when it is called.

One concrete requirement follows: **the approval card must say so when the server being
approved does not itself have a bounded surface.** Approving something like a shell MCP
server is a one-time click that authorizes unbounded execution, and that has to be legible
on the card rather than buried here.
