package server

import (
	"context"
	"encoding/json"
	"strings"
	"sync"
	"testing"

	"github.com/join3r/stem/relay/internal/apns"
)

type fakePusher struct {
	mu   sync.Mutex
	sent []string // token|payload
	next apns.Result
}

func (f *fakePusher) Send(_ context.Context, env, token string, payload []byte) (apns.Result, string) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.sent = append(f.sent, env+"|"+token+"|"+string(payload))
	return f.next, ""
}

var tokA = strings.Repeat("ab", 32)

func TestPushGateway(t *testing.T) {
	w := newWorld(t)
	g := w.global
	a := w.newStem(g, "a@gmail.test")
	b := w.newStem(g, "b@gmail.test")

	if code, _ := a.do(g.http.URL, "POST", "/v1/push", map[string]any{"token": tokA, "wake": map[string]any{"kind": "mail"}}, false); code != 404 {
		t.Fatalf("disabled gateway answered %d", code)
	}
	fp := &fakePusher{}
	g.srv.Pusher = fp

	code, out := a.do(g.http.URL, "POST", "/v1/push", map[string]any{"token": tokA,
		"wake": map[string]any{"kind": "approval", "approvalKind": "exec", "threadId": "t-1", "approvalId": "42", "label": "rm -rf secrets"}}, false)
	if code != 200 || !strings.Contains(string(out), `"sent"`) {
		t.Fatalf("push: %d %s", code, out)
	}
	parts := strings.SplitN(fp.sent[0], "|", 3)
	if parts[0] != "production" || parts[1] != tokA {
		t.Fatalf("sent %v", parts[:2])
	}
	var p struct {
		Aps struct {
			Alert struct{ Title, Body string }
		}
		Stem map[string]any
	}
	_ = json.Unmarshal([]byte(parts[2]), &p)
	if p.Aps.Alert.Body != "A command is waiting for your decision." || p.Stem["approvalId"] != "42" || strings.Contains(parts[2], "secrets") {
		t.Fatalf("payload %s", parts[2])
	}

	// The token is a's now: b may not push to it.
	if code, out := b.do(g.http.URL, "POST", "/v1/push", map[string]any{"token": tokA, "wake": map[string]any{"kind": "mail"}}, false); code != 409 {
		t.Fatalf("other key: %d %s", code, out)
	}
	// Unknown kinds and odd ids are refused, never phrased.
	for _, wake := range []map[string]any{{"kind": "custom"}, {"kind": "mail", "conversationId": "<b>hi</b>"}} {
		if code, _ := a.do(g.http.URL, "POST", "/v1/push", map[string]any{"token": tokA, "wake": wake}, false); code != 400 {
			t.Fatalf("wake %v answered %d", wake, code)
		}
	}
	if code, _ := a.do(g.http.URL, "POST", "/v1/push", map[string]any{"token": "nothex", "wake": map[string]any{"kind": "mail"}}, false); code != 400 {
		t.Fatal("bad token accepted")
	}

	// Apple says gone: the binding is dropped, so b can claim the token.
	fp.next = apns.Gone
	if _, out := a.do(g.http.URL, "POST", "/v1/push", map[string]any{"token": tokA, "wake": map[string]any{"kind": "mail"}}, false); !strings.Contains(string(out), `"gone"`) {
		t.Fatalf("gone: %s", out)
	}
	fp.next = apns.Sent
	if code, _ := b.do(g.http.URL, "POST", "/v1/push", map[string]any{"token": tokA, "env": "sandbox", "wake": map[string]any{"kind": "turn", "failed": true}}, false); code != 200 {
		t.Fatalf("b after gone: %d", code)
	}

	// Per-IP ceiling: fresh keys from one address don't get around it.
	g.srv.cfg.Push.PerIPHour = 4 // four pushes from this IP so far
	c := w.newStem(g, "c@gmail.test")
	if code, _ := c.do(g.http.URL, "POST", "/v1/push", map[string]any{"token": strings.Repeat("ef", 32), "wake": map[string]any{"kind": "mail"}}, false); code != 429 {
		t.Fatalf("per-IP limit: %d", code)
	}
	g.srv.cfg.Push.PerIPHour = 600

	// Per-token ceiling.
	g.srv.cfg.Push.PerTokenHour = 1
	tokB := strings.Repeat("cd", 32)
	a.do(g.http.URL, "POST", "/v1/push", map[string]any{"token": tokB, "wake": map[string]any{"kind": "mail"}}, false)
	if code, _ := a.do(g.http.URL, "POST", "/v1/push", map[string]any{"token": tokB, "wake": map[string]any{"kind": "mail"}}, false); code != 429 {
		t.Fatalf("rate limit: %d", code)
	}
}
