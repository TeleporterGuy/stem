# Stem policy file (for administrators)

A machine-wide file that limits what Stem may do on a company computer. The
user can't change it from inside Stem. Today it covers mail with other Stems.

| System  | Path                                              |
| ------- | ------------------------------------------------- |
| macOS   | `/Library/Application Support/Stem/policy.json`   |
| Linux   | `/etc/stem/policy.json`                           |
| Windows | `%ProgramData%\Stem\policy.json`                  |

Make it writable by administrators only (root-owned, mode 0644). MDM tools
can deploy it as a plain file. A headless Stem server (Docker) takes the same
JSON in the `STEM_POLICY` environment variable; a file on the machine wins
over it. Stem reads the policy at start, so restart it after a change.

## No mail with other Stems

```json
{ "interStem": { "enabled": false } }
```

Settings shows "Turned off by your organization". Stem contacts no relay at
all, and phone push notifications don't go through the global relay either
(a server with its own APNs key still pushes directly).

## Only inside the company

```json
{
  "interStem": {
    "domains": ["acme.com"],
    "relay": "https://stem-relay.acme.com",
    "relayKeys": ["k1:<base64 public key>"]
  }
}
```

- People can add only addresses in `domains`, and write only to addresses in
  `domains`. Anything else fails at once with a message naming the policy.
- Every address in those domains is taken to live on `relay`, checked with
  `relayKeys` (`stem-relay dns` prints them as the `k=` values). DNS is not
  consulted, so a forged `_stem` record can't redirect anyone.
- The global relay is never contacted. Push notifications go through
  `relay` (when it has `[push]` enabled) or not at all.
- Mail arriving from outside the domains is dropped without being shown.
- An address verified before the policy arrived (on the global relay, or
  outside the domains) stops being used; adding it again moves it to the
  company relay.

To include a partner, list its domain too and leave out `relay` and
`relayKeys`: each domain's `_stem` DNS record then names its relay. A listed
domain without a record is unreachable; it never falls back to the global
relay.

## When the file is wrong

A file that exists but can't be read or parsed turns mail with other Stems
off (the reason is in Stem's log). A broken lockdown never fails open.

## Pair it with the relay

The policy controls company machines. The company relay controls who gets
in: set `closed = true` there and publish its `access=closed` DNS record
(`relay/README.md`, "Keep it inside the company"). With both, outsiders
can't reach your people and your people can't reach outsiders, even from a
Stem without the policy file.
