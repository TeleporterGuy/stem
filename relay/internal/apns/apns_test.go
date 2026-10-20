package apns

import (
	"context"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"math/big"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestSendSignsAndClassifies(t *testing.T) {
	key, _ := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	var gotAuth, gotTopic, gotPath string
	status := 200
	hs := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotAuth, gotTopic, gotPath = r.Header.Get("authorization"), r.Header.Get("apns-topic"), r.URL.Path
		w.WriteHeader(status)
	}))
	defer hs.Close()
	c := WithKey(key, "KID", "TEAM", "sk.awantech.stem", hs.Client(), map[string]string{"production": hs.URL})

	if r, _ := c.Send(context.Background(), "production", "abcd", []byte(`{}`)); r != Sent {
		t.Fatalf("result %v", r)
	}
	if gotTopic != "sk.awantech.stem" || gotPath != "/3/device/abcd" {
		t.Fatalf("topic %q path %q", gotTopic, gotPath)
	}
	jwt := strings.TrimPrefix(gotAuth, "bearer ")
	parts := strings.Split(jwt, ".")
	sig, _ := base64.RawURLEncoding.DecodeString(parts[2])
	sum := sha256.Sum256([]byte(parts[0] + "." + parts[1]))
	if len(sig) != 64 || !ecdsa.Verify(&key.PublicKey, sum[:], new(big.Int).SetBytes(sig[:32]), new(big.Int).SetBytes(sig[32:])) {
		t.Fatal("provider token signature does not verify as raw r||s")
	}
	status = 410
	if r, _ := c.Send(context.Background(), "production", "abcd", []byte(`{}`)); r != Gone {
		t.Fatalf("410 gave %v", r)
	}
	if r, _ := c.Send(context.Background(), "sandbox", "abcd", []byte(`{}`)); r != Failed {
		t.Fatal("unknown env should fail")
	}
}
