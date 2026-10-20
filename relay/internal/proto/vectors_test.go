package proto

import (
	"bytes"
	"crypto/ecdh"
	"crypto/ed25519"
	"encoding/json"
	"flag"
	"os"
	"path/filepath"
	"testing"
	"time"
)

var update = flag.Bool("update", false, "rewrite testdata/vectors.json")

func seed(b byte) []byte { return bytes.Repeat([]byte{b}, 32) }

// buildVectors derives every signed or sealed structure from fixed keys.
// Ed25519 and this sealing are deterministic, so the output is stable.
func buildVectors(t *testing.T) map[string]any {
	relayPriv := ed25519.NewKeyFromSeed(seed(1))
	stemPriv := ed25519.NewKeyFromSeed(seed(2))
	stemPub := stemPriv.Public().(ed25519.PublicKey)
	recipEnc, err := ecdh.X25519().NewPrivateKey(seed(3))
	if err != nil {
		t.Fatal(err)
	}
	eph, _ := ecdh.X25519().NewPrivateKey(seed(4))

	encB64 := B64(recipEnc.PublicKey().Bytes())
	encSig := B64(ed25519.Sign(stemPriv, []byte("stem-key-v1\n"+encB64)))

	reqBody := []byte(`{"address":"martin@acme.test"}`)
	reqStr := RequestSigningString("POST", "/v1/cert", 1760000000000, reqBody)

	cert := &Cert{V: 1, Address: "vlado@gmail.test", KeyFp: Fingerprint(stemPub), Issuer: "https://relay.test",
		Kid: "k1", Iat: 1760000000000, Exp: 1760000000000 + CertTTL.Milliseconds()}
	SignCert(cert, relayPriv)

	env := &Envelope{V: 1, ID: "0123456789abcdef0123456789abcdef", Ts: 1760000000000,
		From: "vlado@gmail.test", To: "martin@acme.test", Cert: cert}
	plaintext := []byte(`{"v":1,"subject":"Hi","body":"Hello Martin"}`)
	sealed, err := Seal(recipEnc.PublicKey(), plaintext, env.ID, env.From, env.To, eph)
	if err != nil {
		t.Fatal(err)
	}
	env.Sealed = B64(sealed)
	if err := SignEnvelope(env, stemPriv); err != nil {
		t.Fatal(err)
	}

	return map[string]any{
		"keys": map[string]string{
			"relaySeed": Hex(seed(1)), "relayPub": B64(relayPriv.Public().(ed25519.PublicKey)),
			"stemSeed": Hex(seed(2)), "stemPub": B64(stemPub), "stemFp": Fingerprint(stemPub),
			"recipientEncPriv": Hex(seed(3)), "recipientEncPub": encB64,
			"ephemeralPriv": Hex(seed(4)), "ephemeralPub": B64(eph.PublicKey().Bytes()),
		},
		"keyBlob": map[string]string{"enc": encB64, "encSig": encSig},
		"request": map[string]any{
			"method": "POST", "path": "/v1/cert", "time": 1760000000000, "body": string(reqBody),
			"signingString": reqStr, "sig": B64(ed25519.Sign(stemPriv, []byte(reqStr))),
		},
		"cert":     map[string]any{"cert": cert, "signingString": cert.SigningString()},
		"envelope": map[string]any{"plaintext": string(plaintext), "envelope": env, "signingString": EnvelopeSigningString(env, sealed)},
		"pow":      map[string]any{"address": "vlado@gmail.test", "key": B64(stemPub), "bits": 8, "nonce": SolvePow("vlado@gmail.test", B64(stemPub), 8)},
	}
}

func TestVectors(t *testing.T) {
	got, err := json.MarshalIndent(buildVectors(t), "", "  ")
	if err != nil {
		t.Fatal(err)
	}
	got = append(got, '\n')
	path := filepath.Join("..", "..", "testdata", "vectors.json")
	if *update {
		if err := os.WriteFile(path, got, 0o644); err != nil {
			t.Fatal(err)
		}
	}
	want, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("%v (run go test ./internal/proto -update)", err)
	}
	if !bytes.Equal(got, want) {
		t.Fatal("vectors changed; if intentional, rerun with -update and update the TypeScript client")
	}
}

func TestRoundTrips(t *testing.T) {
	v := buildVectors(t)
	env := v["envelope"].(map[string]any)["envelope"].(*Envelope)
	relayPub := ed25519.NewKeyFromSeed(seed(1)).Public().(ed25519.PublicKey)
	keys := func(string) (string, map[string]ed25519.PublicKey, error) {
		return "https://relay.test", map[string]ed25519.PublicKey{"k1": relayPub}, nil
	}
	at := time.UnixMilli(env.Ts)
	sealed, err := VerifyEnvelope(env, at, keys)
	if err != nil {
		t.Fatal(err)
	}
	priv, _ := ecdh.X25519().NewPrivateKey(seed(3))
	plain, err := Open(priv, sealed, env.ID, env.From, env.To)
	if err != nil || string(plain) != `{"v":1,"subject":"Hi","body":"Hello Martin"}` {
		t.Fatalf("open: %v %s", err, plain)
	}
	// Tampering with the outer addressing breaks the AAD.
	if _, err := Open(priv, sealed, env.ID, env.From, "eve@acme.test"); err == nil {
		t.Fatal("open succeeded with a different recipient")
	}
	// Expired certificate.
	if _, err := VerifyEnvelope(env, at.Add(25*time.Hour), keys); err == nil {
		t.Fatal("accepted with expired cert / stale timestamp")
	}
	// Wrong issuer.
	other := func(string) (string, map[string]ed25519.PublicKey, error) {
		return "https://other.test", map[string]ed25519.PublicKey{"k1": relayPub}, nil
	}
	if _, err := VerifyEnvelope(env, at, other); err == nil {
		t.Fatal("accepted a cert from a non-authoritative issuer")
	}
	if !PowOK("vlado@gmail.test", v["pow"].(map[string]any)["key"].(string), v["pow"].(map[string]any)["nonce"].(string), 8) {
		t.Fatal("pow")
	}
}

func TestValidAddress(t *testing.T) {
	for a, want := range map[string]bool{
		"a@b.co": true, "A@b.co": false, "a@b": false, "@b.co": false, "a@@b.co": false, "a b@c.co": false, "a@b.co\n": false,
	} {
		if ValidAddress(a) != want {
			t.Errorf("ValidAddress(%q) = %v", a, !want)
		}
	}
}
