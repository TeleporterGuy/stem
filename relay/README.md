# Stem relay

Carries end-to-end encrypted mail between Stems. It holds a mail only until
the recipient's Stem collects it (7 days at most), verifies who sent it, and
never sees what's inside. Design: `../docs/inter-stem-mail-design.md`. Wire
protocol: `PROTOCOL.md`.

One static binary (or a small Docker image), one SQLite file, no database
server.

## Run a private relay for your company

1. Build: `go build -o stem-relay ./cmd/stem-relay` (Go 1.26), or
   `docker build -t stem-relay .`
2. `./stem-relay init` writes `relay.toml`. Set:
   - `url`: the public HTTPS address, e.g. `https://relay.acme.com`
   - `domains`: the email domains you serve, e.g. `["acme.com"]`
   - `global_url` / `global_keys`: the global relay's, so your people can
     receive mail from addresses on it
   - `[mail]`: SMTP settings for verification codes (`driver = "smtp"`)
   - either `tls = true` + `tls_host` (built-in Let's Encrypt on :443), or
     `listen = ":8080"` behind your own reverse proxy (`trust_proxy = true`)
3. `./stem-relay dns` prints the TXT record. Add it to your DNS:
   `_stem.acme.com. TXT "v=stem1; relay=https://relay.acme.com; k=k1:..."`
4. `./stem-relay serve`

Invites are off unless `[invites] enabled = true`.

## Run the global relay

Same, with `global = true` and no `domains`: it serves every domain without a
`_stem` record. Turn on invites and give them their own sender subdomain and
provider stream (`invite_from`, `invite_stream_header`), separate from
verification mail. Point the provider's bounce and complaint webhooks at
`POST /v1/hooks/mail-event` (header `X-Stem-Webhook-Secret`, body
`{"tag":"<X-Stem-Tag header of the mail>","kind":"bounce"|"complaint"}`).

## Push gateway (global relay)

Stems that don't hold the iOS app's APNs key wake their phones through the
relay. Put the team's `.p8` beside the relay, readable by uid 65532, and add:

```toml
[push]
enabled = true
key_path = "/secrets/apns.p8"
key_id = "ND4436FVW9"
team_id = "AX23G9CAL9"
bundle_id = "sk.awantech.stem"
```

`/v1/info` then lists `push`. Protocol: `PROTOCOL.md`, "Push gateway".

## Tuning

Every limit is in `[limits]` and `[invites]` in `relay.toml`. Edit and
restart; no new release needed.

## Signing key rotation

1. `stem-relay keys add k2`, then `stem-relay dns` and publish both keys.
2. When DNS has spread: `stem-relay keys activate k2`.
3. After 24 hours (the certificate lifetime): `stem-relay keys remove k1`
   and republish the record.

## Development

`go test ./...`. `testdata/vectors.json` is the byte-exact contract with
Stem's TypeScript client; `go test ./internal/proto -update` regenerates it.
