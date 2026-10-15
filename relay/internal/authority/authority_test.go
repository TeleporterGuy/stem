package authority

import (
	"context"
	"crypto/ed25519"
	"net"
	"testing"

	"github.com/join3r/stem/relay/internal/proto"
)

func TestParseRecord(t *testing.T) {
	pub, _, _ := ed25519.GenerateKey(nil)
	r, err := ParseRecord("v=stem1; relay=https://relay.acme.com/; k=k1:" + proto.B64(pub) + "; k=bad:zz")
	if err != nil || r.Relay != "https://relay.acme.com" || len(r.Keys) != 1 {
		t.Fatalf("%+v %v", r, err)
	}
	for _, bad := range []string{"v=stem2; relay=https://x; k=k1:" + proto.B64(pub), "v=stem1; k=k1:" + proto.B64(pub), "v=stem1; relay=https://x"} {
		if _, err := ParseRecord(bad); err == nil {
			t.Errorf("accepted %q", bad)
		}
	}
}

func TestAuthority(t *testing.T) {
	gpub, _, _ := ed25519.GenerateKey(nil)
	apub, _, _ := ed25519.GenerateKey(nil)
	res := NewResolver("https://global.test", map[string]ed25519.PublicKey{"k1": gpub})
	calls := 0
	res.Lookup = func(_ context.Context, name string) ([]string, error) {
		calls++
		switch name {
		case "_stem.acme.test":
			return []string{"unrelated", "v=stem1; relay=https://relay.acme.test; k=a1:" + proto.B64(apub)}, nil
		case "_stem.flaky.test":
			return nil, &net.DNSError{Err: "timeout", IsTimeout: true}
		}
		return nil, &net.DNSError{Err: "no such host", IsNotFound: true}
	}
	if u, ks, err := res.Authority("m@acme.test"); err != nil || u != "https://relay.acme.test" || ks["a1"] == nil {
		t.Fatalf("acme: %s %v", u, err)
	}
	if u, ks, err := res.Authority("v@gmail.test"); err != nil || u != "https://global.test" || ks["k1"] == nil {
		t.Fatalf("gmail: %s %v", u, err)
	}
	res.Authority("m@acme.test")
	if calls != 2 {
		t.Fatalf("cache: %d lookups", calls)
	}
	if _, _, err := res.Authority("x@flaky.test"); err == nil {
		t.Fatal("a DNS timeout must not fall back to the global relay")
	}
}
