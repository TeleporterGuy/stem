// Package apns sends alert pushes to Apple with a provider token (.p8). It is
// the relay's half of Stem's push gateway: Stems without Awantech's APNs key
// hand a device token and a wake-up to the relay, which signs and sends it.
package apns

import (
	"bytes"
	"context"
	"crypto/ecdsa"
	"crypto/rand"
	"crypto/sha256"
	"crypto/x509"
	"encoding/base64"
	"encoding/json"
	"encoding/pem"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"sync"
	"time"
)

type Result int

const (
	Sent Result = iota
	// Gone: Apple says the token is dead (app deleted, device restored).
	Gone
	Failed
)

var Hosts = map[string]string{
	"production": "https://api.push.apple.com",
	"sandbox":    "https://api.sandbox.push.apple.com",
}

// Apple refuses a provider token older than an hour and rate-limits minting.
const tokenTTL = 50 * time.Minute

type Client struct {
	KeyID, TeamID, Topic string
	key                  *ecdsa.PrivateKey
	HTTP                 *http.Client
	// Hosts by environment; tests point both at an httptest server.
	Hosts map[string]string

	mu       sync.Mutex
	token    string
	mintedAt time.Time
}

func New(keyPath, keyID, teamID, topic string) (*Client, error) {
	raw, err := os.ReadFile(keyPath)
	if err != nil {
		return nil, err
	}
	key, err := ParseKey(raw)
	if err != nil {
		return nil, err
	}
	return &Client{KeyID: keyID, TeamID: teamID, Topic: topic, key: key, Hosts: Hosts,
		HTTP: &http.Client{Timeout: 10 * time.Second}}, nil
}

// ParseKey reads an Apple .p8 (PKCS#8 PEM, P-256).
func ParseKey(raw []byte) (*ecdsa.PrivateKey, error) {
	block, _ := pem.Decode(raw)
	if block == nil {
		return nil, errors.New("apns key: no PEM block")
	}
	k, err := x509.ParsePKCS8PrivateKey(block.Bytes)
	if err != nil {
		return nil, fmt.Errorf("apns key: %w", err)
	}
	ec, ok := k.(*ecdsa.PrivateKey)
	if !ok {
		return nil, errors.New("apns key: not an EC key")
	}
	return ec, nil
}

// WithKey builds a client around an already parsed key (tests).
func WithKey(key *ecdsa.PrivateKey, keyID, teamID, topic string, hc *http.Client, hosts map[string]string) *Client {
	return &Client{KeyID: keyID, TeamID: teamID, Topic: topic, key: key, HTTP: hc, Hosts: hosts}
}

func b64url(b []byte) string { return base64.RawURLEncoding.EncodeToString(b) }

// providerToken is {alg:ES256,kid} over {iss,iat}, signed as raw r||s.
func (c *Client) providerToken() (string, error) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.token != "" && time.Since(c.mintedAt) < tokenTTL {
		return c.token, nil
	}
	h, _ := json.Marshal(map[string]string{"alg": "ES256", "kid": c.KeyID})
	cl, _ := json.Marshal(map[string]any{"iss": c.TeamID, "iat": time.Now().Unix()})
	in := b64url(h) + "." + b64url(cl)
	sum := sha256.Sum256([]byte(in))
	r, s, err := ecdsa.Sign(rand.Reader, c.key, sum[:])
	if err != nil {
		return "", err
	}
	sig := make([]byte, 64)
	r.FillBytes(sig[:32])
	s.FillBytes(sig[32:])
	c.token, c.mintedAt = in+"."+b64url(sig), time.Now()
	return c.token, nil
}

func (c *Client) forgetToken() {
	c.mu.Lock()
	c.token = ""
	c.mu.Unlock()
}

// Send posts one alert push. env is "production" or "sandbox".
func (c *Client) Send(ctx context.Context, env, deviceToken string, payload []byte) (Result, string) {
	host, ok := c.Hosts[env]
	if !ok {
		return Failed, "bad env"
	}
	tok, err := c.providerToken()
	if err != nil {
		return Failed, err.Error()
	}
	req, err := http.NewRequestWithContext(ctx, "POST", host+"/3/device/"+deviceToken, bytes.NewReader(payload))
	if err != nil {
		return Failed, err.Error()
	}
	req.Header.Set("authorization", "bearer "+tok)
	req.Header.Set("apns-topic", c.Topic)
	req.Header.Set("apns-push-type", "alert")
	req.Header.Set("apns-priority", "10")
	req.Header.Set("content-type", "application/json")
	res, err := c.HTTP.Do(req)
	if err != nil {
		return Failed, err.Error()
	}
	defer res.Body.Close()
	body, _ := io.ReadAll(io.LimitReader(res.Body, 1024))
	switch {
	case res.StatusCode == 200:
		return Sent, ""
	case res.StatusCode == 410:
		return Gone, string(body)
	case res.StatusCode == 400 && bytes.Contains(body, []byte("BadDeviceToken")):
		return Gone, string(body)
	case res.StatusCode == 403:
		c.forgetToken()
	}
	return Failed, fmt.Sprintf("%d %s", res.StatusCode, body)
}
