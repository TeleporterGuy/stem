package server

import (
	"bufio"
	"bytes"
	"context"
	"crypto/ecdh"
	"crypto/ed25519"
	"crypto/rand"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/join3r/stem/relay/internal/authority"
	"github.com/join3r/stem/relay/internal/config"
	"github.com/join3r/stem/relay/internal/mailer"
	"github.com/join3r/stem/relay/internal/proto"
	"github.com/join3r/stem/relay/internal/store"
)

// ---- harness: a global relay and a private relay for acme.test ----

type relay struct {
	srv  *Server
	http *httptest.Server
	mail *mailer.Log
	st   *store.Store
}

type world struct {
	t      *testing.T
	global *relay
	acme   *relay
	static map[string]*authority.Record
}

func newWorld(t *testing.T) *world {
	w := &world{t: t, static: map[string]*authority.Record{}}
	w.global = w.newRelay(true, nil)
	w.acme = w.newRelay(false, []string{"acme.test"})
	// acme.test's DNS record points at the acme relay.
	w.static["acme.test"] = &authority.Record{Relay: w.acme.http.URL, Keys: w.acme.srv.PublicKeys()}
	return w
}

func (w *world) newRelay(global bool, domains []string) *relay {
	t := w.t
	st, err := store.Open(filepath.Join(t.TempDir(), "relay.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { st.Close() })
	cfg := config.Defaults()
	cfg.Global, cfg.Domains = global, domains
	cfg.Limits.PowBits = 4
	cfg.Invite.Enabled = true
	m := &mailer.Log{}
	hs := httptest.NewUnstartedServer(nil)
	hs.Start()
	t.Cleanup(hs.Close)
	cfg.URL = hs.URL
	if !global {
		cfg.GlobalURL = w.global.http.URL
	}
	res := authority.NewResolver(cfg.GlobalURL, nil)
	res.Static = w.static
	res.Lookup = func(ctx context.Context, name string) ([]string, error) {
		return nil, nil // no records except Static
	}
	if !global {
		res.GlobalKeys = w.global.srv.PublicKeys()
	}
	s, err := New(&cfg, st, m, res)
	if err != nil {
		t.Fatal(err)
	}
	hs.Config.Handler = s.Handler()
	return &relay{srv: s, http: hs, mail: m, st: st}
}

// ---- harness: a Stem client ----

type stem struct {
	t       *testing.T
	home    *relay
	w       *world
	addr    string
	priv    ed25519.PrivateKey
	pub     ed25519.PublicKey
	enc     *ecdh.PrivateKey
	cert    *proto.Cert
	keyBlob string
}

func (w *world) newStem(home *relay, addr string) *stem {
	pub, priv, _ := ed25519.GenerateKey(rand.Reader)
	enc, _ := ecdh.X25519().GenerateKey(rand.Reader)
	encB64 := proto.B64(enc.PublicKey().Bytes())
	blob, _ := json.Marshal(map[string]any{"v": 1, "sig": proto.B64(pub), "enc": encB64,
		"encSig": proto.B64(ed25519.Sign(priv, []byte("stem-key-v1\n"+encB64)))})
	return &stem{t: w.t, home: home, w: w, addr: addr, priv: priv, pub: pub, enc: enc, keyBlob: string(blob)}
}

func (c *stem) do(base, method, path string, body any, withCert bool) (int, []byte) {
	c.t.Helper()
	var raw []byte
	if body != nil {
		raw, _ = json.Marshal(body)
	}
	req, _ := http.NewRequest(method, base+path, bytes.NewReader(raw))
	ts := time.Now().UnixMilli()
	req.Header.Set("Stem-Key", proto.B64(c.pub))
	req.Header.Set("Stem-Time", strconv.FormatInt(ts, 10))
	req.Header.Set("Stem-Sig", proto.B64(ed25519.Sign(c.priv, []byte(proto.RequestSigningString(method, path, ts, raw)))))
	if withCert {
		cj, _ := json.Marshal(c.cert)
		req.Header.Set("Stem-Cert", proto.B64(cj))
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		c.t.Fatal(err)
	}
	defer resp.Body.Close()
	out, _ := io.ReadAll(resp.Body)
	return resp.StatusCode, out
}

var codeRe = regexp.MustCompile(`code (?:to connect \S+ to Stem )?is (\d{6})`)

func lastCode(t *testing.T, m *mailer.Log, to string) string {
	t.Helper()
	msgs := m.Messages()
	for i := len(msgs) - 1; i >= 0; i-- {
		if msgs[i].To == to {
			if mm := codeRe.FindStringSubmatch(msgs[i].Body); mm != nil {
				return mm[1]
			}
		}
	}
	t.Fatalf("no code mailed to %s", to)
	return ""
}

func (c *stem) register() {
	c.t.Helper()
	nonce := proto.SolvePow(c.addr, proto.B64(c.pub), c.home.srv.cfg.Limits.PowBits)
	st, body := c.do(c.home.http.URL, "POST", "/v1/register", map[string]any{"address": c.addr, "keyBlob": c.keyBlob, "pow": map[string]string{"nonce": nonce}}, false)
	if st != 202 || !strings.Contains(string(body), "code_sent") {
		c.t.Fatalf("register: %d %s", st, body)
	}
	code := lastCode(c.t, c.home.mail, c.addr)
	st, body = c.do(c.home.http.URL, "POST", "/v1/verify", map[string]string{"address": c.addr, "code": code}, false)
	if st != 200 {
		c.t.Fatalf("verify: %d %s", st, body)
	}
	var out struct{ Cert *proto.Cert }
	_ = json.Unmarshal(body, &out)
	c.cert = out.Cert
}

func (w *world) relayFor(addr string) *relay {
	if proto.Domain(addr) == "acme.test" {
		return w.acme
	}
	return w.global
}

func (c *stem) lookup(addr string) (int, string, string) {
	st, body := c.do(c.w.relayFor(addr).http.URL, "GET", "/v1/keys?address="+addr, nil, true)
	var out struct{ AuthKey, KeyBlob string }
	_ = json.Unmarshal(body, &out)
	return st, out.AuthKey, out.KeyBlob
}

func (c *stem) envelope(to string, encPub []byte, text string) *proto.Envelope {
	c.t.Helper()
	rk, err := ecdh.X25519().NewPublicKey(encPub)
	if err != nil {
		c.t.Fatal(err)
	}
	e := &proto.Envelope{V: 1, ID: proto.NewID(), Ts: time.Now().UnixMilli(), From: c.addr, To: to, Cert: c.cert}
	sealed, err := proto.Seal(rk, []byte(text), e.ID, e.From, e.To, nil)
	if err != nil {
		c.t.Fatal(err)
	}
	e.Sealed = proto.B64(sealed)
	if err := proto.SignEnvelope(e, c.priv); err != nil {
		c.t.Fatal(err)
	}
	return e
}

func (c *stem) send(to string, recipient *stem, text string) (*proto.Envelope, int, string) {
	e := c.envelope(to, recipient.enc.PublicKey().Bytes(), text)
	code, body := c.postEnv(e)
	return e, code, body
}

func (c *stem) postEnv(e *proto.Envelope) (int, string) {
	raw, _ := json.Marshal(e)
	resp, err := http.Post(c.w.relayFor(e.To).http.URL+"/v1/mail", "application/json", bytes.NewReader(raw))
	if err != nil {
		c.t.Fatal(err)
	}
	defer resp.Body.Close()
	b, _ := io.ReadAll(resp.Body)
	return resp.StatusCode, string(b)
}

// held returns envelopes waiting on the stream (reads until ": ready").
func (c *stem) held() []proto.Envelope {
	c.t.Helper()
	path := "/v1/stream"
	ts := time.Now().UnixMilli()
	req, _ := http.NewRequest("GET", c.home.http.URL+path, nil)
	req.Header.Set("Stem-Key", proto.B64(c.pub))
	req.Header.Set("Stem-Time", strconv.FormatInt(ts, 10))
	req.Header.Set("Stem-Sig", proto.B64(ed25519.Sign(c.priv, []byte(proto.RequestSigningString("GET", path, ts, nil)))))
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	resp, err := http.DefaultClient.Do(req.WithContext(ctx))
	if err != nil {
		c.t.Fatal(err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != 200 {
		b, _ := io.ReadAll(resp.Body)
		c.t.Fatalf("stream: %d %s", resp.StatusCode, b)
	}
	var out []proto.Envelope
	sc := bufio.NewScanner(resp.Body)
	sc.Buffer(make([]byte, 1<<20), 64<<20)
	for sc.Scan() {
		line := sc.Text()
		if line == ": ready" {
			break
		}
		if d, ok := strings.CutPrefix(line, "data: "); ok {
			var e proto.Envelope
			if err := json.Unmarshal([]byte(d), &e); err != nil {
				c.t.Fatal(err)
			}
			out = append(out, e)
		}
	}
	return out
}

func (c *stem) ack(ids ...string) {
	if st, b := c.do(c.home.http.URL, "POST", "/v1/ack", map[string]any{"ids": ids}, false); st != 200 {
		c.t.Fatalf("ack: %d %s", st, b)
	}
}

func (c *stem) list(op, addr string) {
	if st, b := c.do(c.home.http.URL, "POST", "/v1/"+op, map[string]string{"address": addr}, false); st != 200 {
		c.t.Fatalf("%s: %d %s", op, st, b)
	}
}

func (c *stem) status(to, id string) string {
	_, b := c.do(c.w.relayFor(to).http.URL, "GET", "/v1/mail/status?id="+id, nil, true)
	var out struct{ Status string }
	_ = json.Unmarshal(b, &out)
	return out.Status
}

// ---- tests ----

func TestCrossRelayDelivery(t *testing.T) {
	w := newWorld(t)
	vlado := w.newStem(w.global, "vlado@gmail.test")
	martin := w.newStem(w.acme, "martin@acme.test")
	vlado.register()
	martin.register()

	st, authKey, blob := vlado.lookup("martin@acme.test")
	if st != 200 || authKey != proto.B64(martin.pub) || blob != martin.keyBlob {
		t.Fatalf("lookup: %d %q", st, authKey)
	}

	env, code, _ := vlado.send("martin@acme.test", martin, "hello martin")
	if code != 202 {
		t.Fatalf("send: %d", code)
	}
	if s := vlado.status("martin@acme.test", env.ID); s != "sent" {
		t.Fatalf("stranger status = %q, want sent", s)
	}
	got := martin.held()
	if len(got) != 1 {
		t.Fatalf("held = %d", len(got))
	}
	sealed, _ := proto.UnB64(got[0].Sealed)
	plain, err := proto.Open(martin.enc, sealed, got[0].ID, got[0].From, got[0].To)
	if err != nil || string(plain) != "hello martin" {
		t.Fatalf("open: %v %q", err, plain)
	}
	martin.ack(got[0].ID)
	if len(martin.held()) != 0 {
		t.Fatal("acked mail still held")
	}
	// Once martin accepts vlado, vlado sees real status.
	martin.list("allow", "vlado@gmail.test")
	if s := vlado.status("martin@acme.test", env.ID); s != "delivered" {
		t.Fatalf("contact status = %q, want delivered", s)
	}
	// Replay is refused.
	if c, _ := vlado.postEnv(env); c != 409 {
		t.Fatalf("replay: %d", c)
	}
}

func TestForgedSenderRejected(t *testing.T) {
	w := newWorld(t)
	martin := w.newStem(w.acme, "martin@acme.test")
	martin.register()
	mallory := w.newStem(w.global, "mallory@gmail.test")
	mallory.register()

	// The global relay is not the authority for acme.test, so a cert it
	// signs for an acme address must not verify anywhere.
	forged := w.global.srv.issueCert("ceo@acme.test", proto.Fingerprint(mallory.pub))
	mallory.cert = forged
	mallory.addr = "ceo@acme.test"
	_, code, _ := mallory.send("martin@acme.test", martin, "wire the money")
	if code != 400 {
		t.Fatalf("forged cert accepted: %d", code)
	}
	if len(martin.held()) != 0 {
		t.Fatal("forged mail held")
	}

	// A valid cert but an envelope signed by a different key.
	mallory2 := w.newStem(w.global, "mallory2@gmail.test")
	mallory2.register()
	e := mallory2.envelope("martin@acme.test", martin.enc.PublicKey().Bytes(), "x")
	other, otherPriv, _ := ed25519.GenerateKey(rand.Reader)
	_ = other
	_ = proto.SignEnvelope(e, otherPriv)
	if c, _ := mallory2.postEnv(e); c != 400 {
		t.Fatalf("mismatched signer accepted: %d", c)
	}
}

func TestOneKnockAndBlock(t *testing.T) {
	w := newWorld(t)
	a := w.newStem(w.global, "a@gmail.test")
	b := w.newStem(w.global, "b@gmail.test")
	a.register()
	b.register()

	for i := range 3 {
		if _, c, _ := a.send(b.addr, b, "knock "+strconv.Itoa(i)); c != 202 {
			t.Fatalf("send %d: %d", i, c)
		}
	}
	if n := len(b.held()); n != 1 {
		t.Fatalf("stranger got %d mails held, want 1 (one knock)", n)
	}
	b.list("allow", a.addr)
	a.send(b.addr, b, "after accept")
	if n := len(b.held()); n != 2 {
		t.Fatalf("after accept held = %d, want 2", n)
	}
	b.list("block", a.addr)
	a.send(b.addr, b, "after block")
	if n := len(b.held()); n != 2 {
		t.Fatalf("after block held = %d, want 2", n)
	}
}

func TestUnlistedLooksUnregistered(t *testing.T) {
	w := newWorld(t)
	a := w.newStem(w.global, "a@gmail.test")
	b := w.newStem(w.global, "b@gmail.test")
	a.register()
	b.register()

	if st, _ := b.do(w.global.http.URL, "PUT", "/v1/account", map[string]bool{"unlisted": true}, false); st != 200 {
		t.Fatal(st)
	}
	st1, _, _ := a.lookup(b.addr)
	st2, _, _ := a.lookup("nobody@gmail.test")
	if st1 != 404 || st2 != 404 {
		t.Fatalf("unlisted %d, unregistered %d; want both 404", st1, st2)
	}
	b.list("allow", a.addr)
	if st, _, _ := a.lookup(b.addr); st != 200 {
		t.Fatalf("allowed lookup: %d", st)
	}
}

func TestUnregisteredRecipientDropped(t *testing.T) {
	w := newWorld(t)
	a := w.newStem(w.global, "a@gmail.test")
	a.register()
	ghost := w.newStem(w.global, "ghost@gmail.test")
	if _, c, body := a.send(ghost.addr, ghost, "hi"); c != 202 || !strings.Contains(body, "sent") {
		t.Fatalf("send to unregistered: %d %s", c, body)
	}
	if n, _, _ := w.global.st.QueueUsage(ghost.addr); n != 0 {
		t.Fatal("mail to unregistered was stored")
	}
}

func TestReRegisterWarnsOwner(t *testing.T) {
	w := newWorld(t)
	a := w.newStem(w.global, "a@gmail.test")
	a.register()
	laptop2 := w.newStem(w.global, "a@gmail.test")
	laptop2.register() // same flow, same answers
	msgs := w.global.mail.Messages()
	if !strings.Contains(msgs[len(msgs)-1].Subject, "new device") {
		t.Fatalf("second registration subject = %q", msgs[len(msgs)-1].Subject)
	}
	// The old key no longer gets certificates for the address.
	if st, _ := a.do(w.global.http.URL, "POST", "/v1/cert", map[string]string{"address": a.addr}, false); st != 403 {
		t.Fatalf("old key cert: %d", st)
	}
	var ks struct{ Current bool }
	resp, _ := http.Get(w.global.http.URL + "/v1/keystatus?address=" + a.addr + "&fp=" + proto.Fingerprint(a.pub))
	_ = json.NewDecoder(resp.Body).Decode(&ks)
	resp.Body.Close()
	if ks.Current {
		t.Fatal("old key still current")
	}
}

func TestInvites(t *testing.T) {
	w := newWorld(t)
	g := w.global
	g.srv.cfg.Invite.GlobalPerDay = 2
	senders := []*stem{w.newStem(g, "s1@gmail.test"), w.newStem(g, "s2@gmail.test"), w.newStem(g, "s3@gmail.test")}
	for _, s := range senders {
		s.register()
		// Not new: backdate verification so new-address limits don't apply.
		_, _ = g.st.DB().Exec(`UPDATE addresses SET verified = 0 WHERE address = ?`, s.addr)
	}
	invite := func(s *stem, to string) {
		if st, b := s.do(g.http.URL, "POST", "/v1/invite", map[string]string{"address": to}, true); st != 202 {
			t.Fatalf("invite: %d %s", st, b)
		}
	}
	invite(senders[0], "friend@gmail.test")
	invite(senders[1], "friend@gmail.test")
	invite(senders[0], "other@gmail.test")
	invite(senders[2], "third@gmail.test")
	invite(senders[0], "s2@gmail.test") // registered: no invite
	before := len(g.mail.Messages())
	if err := g.srv.DispatchInvites(); err != nil {
		t.Fatal(err)
	}
	sentNow := g.mail.Messages()[before:]
	if len(sentNow) != 2 {
		t.Fatalf("global budget: sent %d, want 2", len(sentNow))
	}
	if sentNow[0].To != "friend@gmail.test" || !strings.Contains(sentNow[0].Subject, "and 1 other") {
		t.Fatalf("batched invite: %+v", sentNow[0])
	}
	for _, m := range sentNow {
		if m.To == "s2@gmail.test" {
			t.Fatal("invited a registered address")
		}
	}
	// Next run: budget spent for today.
	if err := g.srv.DispatchInvites(); err != nil {
		t.Fatal(err)
	}
	if len(g.mail.Messages()) != before+2 {
		t.Fatal("sent past the global budget")
	}
}

func TestBreakerPausesInvites(t *testing.T) {
	w := newWorld(t)
	g := w.global
	g.srv.cfg.Invite.BreakerMinSample = 2
	for i := range 4 {
		tag := "i-t" + strconv.Itoa(i)
		_ = g.st.LogInvite("x"+strconv.Itoa(i)+"@gmail.test", tag, []string{"s@gmail.test"})
		if i == 0 {
			_ = g.st.LogMailEvent(tag, "complaint")
		}
	}
	open, _, err := g.srv.breakerOpen()
	if err != nil || !open {
		t.Fatalf("breaker open = %v, %v", open, err)
	}
}

func TestWellKnownAndInfo(t *testing.T) {
	w := newWorld(t)
	resp, err := http.Get(w.acme.http.URL + "/.well-known/stem-relay")
	if err != nil {
		t.Fatal(err)
	}
	var wk struct {
		URL  string
		Keys []struct{ Kid, Pub string }
	}
	_ = json.NewDecoder(resp.Body).Decode(&wk)
	resp.Body.Close()
	if wk.URL != w.acme.http.URL || len(wk.Keys) != 1 {
		t.Fatalf("well-known: %+v", wk)
	}
}

func TestEmailLinksNeedAPost(t *testing.T) {
	w := newWorld(t)
	g := w.global
	owner := w.newStem(g, "o@gmail.test")
	owner.register()
	thief := w.newStem(g, "o@gmail.test")
	nonce := proto.SolvePow(thief.addr, proto.B64(thief.pub), g.srv.cfg.Limits.PowBits)
	thief.do(g.http.URL, "POST", "/v1/register", map[string]any{"address": thief.addr, "keyBlob": thief.keyBlob, "pow": map[string]string{"nonce": nonce}}, false)
	msgs := g.mail.Messages()
	link := regexp.MustCompile(`https?://\S+/v1/verify-link\?t=\S+`).FindString(msgs[len(msgs)-1].Body)
	unsub := regexp.MustCompile(`https?://\S+/v1/unsubscribe\?t=\S+`).FindString(msgs[len(msgs)-1].Body)
	// A mail scanner opening both links changes nothing.
	for _, l := range []string{link, unsub} {
		resp, err := http.Get(l)
		if err != nil || resp.StatusCode != 200 {
			t.Fatalf("GET %s: %v %v", l, err, resp)
		}
		resp.Body.Close()
	}
	if acc, _, _ := g.st.AddressAccount(owner.addr); acc.Fp != proto.Fingerprint(owner.pub) {
		t.Fatal("GET on the verify link moved the address")
	}
	if sup, _ := g.st.Suppressed(owner.addr); sup {
		t.Fatal("GET on the unsubscribe link suppressed the address")
	}
	// Pressing the button does.
	tok := link[strings.Index(link, "t=")+2:]
	resp, _ := http.PostForm(g.http.URL+"/v1/verify-link", map[string][]string{"t": {tok}})
	resp.Body.Close()
	if acc, _, _ := g.st.AddressAccount(owner.addr); acc.Fp != proto.Fingerprint(thief.pub) {
		t.Fatal("POST on the verify link did not complete")
	}
}

func TestVerifyAttemptsAreCapped(t *testing.T) {
	w := newWorld(t)
	g := w.global
	c := w.newStem(g, "c@gmail.test")
	nonce := proto.SolvePow(c.addr, proto.B64(c.pub), g.srv.cfg.Limits.PowBits)
	c.do(g.http.URL, "POST", "/v1/register", map[string]any{"address": c.addr, "keyBlob": c.keyBlob, "pow": map[string]string{"nonce": nonce}}, false)
	code := lastCode(t, g.mail, c.addr)
	done := make(chan int, 20)
	for i := range 20 {
		go func() {
			st, _ := c.do(g.http.URL, "POST", "/v1/verify", map[string]string{"address": c.addr, "code": strconv.Itoa(100000 + i)}, false)
			done <- st
		}()
	}
	for range 20 {
		<-done
	}
	if st, _ := c.do(g.http.URL, "POST", "/v1/verify", map[string]string{"address": c.addr, "code": code}, false); st != 400 {
		t.Fatalf("right code after 20 wrong guesses: %d, want 400", st)
	}
}

func TestStreamFollowsTheKeyNotTheAddress(t *testing.T) {
	w := newWorld(t)
	g := w.global
	old := w.newStem(g, "k@gmail.test")
	old.register()
	sub := g.srv.hub.subscribe(proto.Fingerprint(old.pub))
	defer g.srv.hub.unsubscribe(sub)
	fresh := w.newStem(g, "k@gmail.test")
	fresh.register()
	sender := w.newStem(g, "s@gmail.test")
	sender.register()
	sender.send(fresh.addr, fresh, "for the new key")
	select {
	case <-sub:
		t.Fatal("the old key's stream received mail for a moved address")
	case <-time.After(100 * time.Millisecond):
	}
	if n := len(fresh.held()); n != 1 {
		t.Fatalf("new key held %d", n)
	}
}
