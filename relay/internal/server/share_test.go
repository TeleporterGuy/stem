package server

import (
	"bytes"
	"crypto/ed25519"
	"encoding/base64"
	"encoding/json"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/join3r/stem/relay/internal/proto"
)

// doRaw is do with an opaque body (share blobs aren't JSON).
func (c *stem) doRaw(base, method, path string, raw []byte, withCert bool) (int, []byte) {
	c.t.Helper()
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

func get(t *testing.T, url string) (int, []byte) {
	t.Helper()
	resp, err := http.Get(url)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	out, _ := io.ReadAll(resp.Body)
	return resp.StatusCode, out
}

func blob(n int) []byte {
	b := make([]byte, n)
	b[0] = 1
	return b
}

func TestShareLinks(t *testing.T) {
	w := newWorld(t)
	g := w.global
	a := w.newStem(g, "a@gmail.test")
	a.register()
	b := w.newStem(w.acme, "b@acme.test")
	b.register()

	if code, _ := a.doRaw(g.http.URL, "POST", "/v1/shares", blob(64), true); code != 404 {
		t.Fatalf("disabled share answered %d", code)
	}
	g.srv.cfg.Share.Enabled = true
	g.srv.cfg.Share.ViewerURL = "https://share.example"

	// A certificate is required, and the blob must look like one.
	if code, _ := a.doRaw(g.http.URL, "POST", "/v1/shares", blob(64), false); code != 401 {
		t.Fatalf("uncertified upload answered %d", code)
	}
	if code, _ := a.doRaw(g.http.URL, "POST", "/v1/shares", []byte(strings.Repeat("x", 64)), true); code != 400 {
		t.Fatalf("bad blob answered %d", code)
	}

	code, out := a.doRaw(g.http.URL, "POST", "/v1/shares", blob(64), true)
	if code != 200 {
		t.Fatalf("upload: %d %s", code, out)
	}
	var made struct {
		ID      string `json:"id"`
		URL     string `json:"url"`
		Expires int64  `json:"expires"`
	}
	_ = json.Unmarshal(out, &made)
	// No ttl: the longest allowed (30 days by default).
	if !shareIDRe.MatchString(made.ID) || made.URL != "https://share.example/s/"+made.ID ||
		made.Expires < time.Now().Add(29*day).UnixMilli() || made.Expires > time.Now().Add(31*day).UnixMilli() {
		t.Fatalf("upload answered %s", out)
	}

	// Anyone can fetch the bytes.
	code, got := get(t, g.http.URL+"/v1/shares/"+made.ID)
	if code != 200 || !bytes.Equal(got, blob(64)) {
		t.Fatalf("fetch: %d (%d bytes)", code, len(got))
	}
	if code, _ := get(t, g.http.URL+"/v1/shares/AAAAAAAAAAAAAAAAAAAAAA"); code != 404 {
		t.Fatalf("unknown id answered %d", code)
	}

	// An address from another relay can share too, and lists only its own.
	code, out = b.doRaw(g.http.URL, "POST", "/v1/shares?ttl=7", blob(40), true)
	if code != 200 {
		t.Fatalf("cross-relay upload: %d %s", code, out)
	}
	var bMade struct {
		ID      string `json:"id"`
		Expires int64  `json:"expires"`
	}
	_ = json.Unmarshal(out, &bMade)
	if bMade.Expires < time.Now().Add(6*day).UnixMilli() {
		t.Fatalf("ttl ignored: %s", out)
	}
	_, out = a.do(g.http.URL, "GET", "/v1/shares", nil, true)
	if !strings.Contains(string(out), made.ID) || strings.Contains(string(out), bMade.ID) {
		t.Fatalf("list: %s", out)
	}

	// Only the owner revokes; then the link says gone.
	if code, _ := b.do(g.http.URL, "DELETE", "/v1/shares/"+made.ID, nil, true); code != 404 {
		t.Fatalf("stranger's revoke answered %d", code)
	}
	if code, _ := a.do(g.http.URL, "DELETE", "/v1/shares/"+made.ID, nil, true); code != 200 {
		t.Fatalf("revoke answered %d", code)
	}
	code, out = get(t, g.http.URL+"/v1/shares/"+made.ID)
	if code != 410 || !strings.Contains(string(out), "revoked") {
		t.Fatalf("revoked fetch: %d %s", code, out)
	}

	// Reports land in the store; a bad reason doesn't.
	post := func(id string, body string) int {
		resp, err := http.Post(g.http.URL+"/v1/shares/"+id+"/report", "application/json", strings.NewReader(body))
		if err != nil {
			t.Fatal(err)
		}
		resp.Body.Close()
		return resp.StatusCode
	}
	if c := post(bMade.ID, `{"reason":"nope"}`); c != 400 {
		t.Fatalf("bad reason answered %d", c)
	}
	if c := post(bMade.ID, `{"reason":"illegal","key":"not a key"}`); c != 400 {
		t.Fatalf("bad key answered %d", c)
	}
	key := strings.Repeat("k", 43)
	if c := post(bMade.ID, `{"reason":"illegal","detail":"bad\u001b[2Jstuff\nline two","contact":"a\u009b@b\nc","key":"`+key+`"}`); c != 202 {
		t.Fatalf("report answered %d", c)
	}
	reps, _ := g.st.OpenShareReports()
	if len(reps) != 1 || reps[0].Share != bMade.ID || reps[0].Key != key {
		t.Fatalf("reports: %+v", reps)
	}
	// Control characters never reach the operator's terminal.
	if reps[0].Detail != "bad[2Jstuff\nline two" || reps[0].Contact != "a@b c" {
		t.Fatalf("report text not cleaned: %q %q", reps[0].Detail, reps[0].Contact)
	}
	if ok, _ := g.st.RemoveShare(bMade.ID, "takedown: test"); !ok {
		t.Fatal("takedown removed nothing")
	}
	_, out = get(t, g.http.URL+"/v1/shares/"+bMade.ID)
	if !strings.Contains(string(out), "taken_down") {
		t.Fatalf("taken-down fetch: %s", out)
	}
}

func TestShareLimits(t *testing.T) {
	w := newWorld(t)
	g := w.global
	g.srv.cfg.Share.Enabled = true
	g.srv.cfg.Share.ViewerURL = "https://share.example"
	a := w.newStem(g, "a@gmail.test")
	a.register()

	g.srv.cfg.Share.QuotaBytes = 100
	if code, _ := a.doRaw(g.http.URL, "POST", "/v1/shares", blob(60), true); code != 200 {
		t.Fatalf("first upload answered %d", code)
	}
	if code, _ := a.doRaw(g.http.URL, "POST", "/v1/shares", blob(60), true); code != 507 {
		t.Fatalf("over quota answered %d", code)
	}
	g.srv.cfg.Share.QuotaBytes = 0
	g.srv.cfg.Share.PerAddressDay = 2
	if code, _ := a.doRaw(g.http.URL, "POST", "/v1/shares", blob(60), true); code != 200 {
		t.Fatalf("second upload answered %d", code)
	}
	if code, _ := a.doRaw(g.http.URL, "POST", "/v1/shares", blob(60), true); code != 429 {
		t.Fatalf("over the daily limit answered %d", code)
	}

	g.srv.cfg.Share.PerAddressDay = 0
	if code, _ := a.doRaw(g.http.URL, "POST", "/v1/shares?ttl=31", blob(60), true); code != 400 {
		t.Fatalf("31-day share answered %d", code)
	}
	if code, _ := a.doRaw(g.http.URL, "POST", "/v1/shares?ttl=30", blob(60), true); code != 200 {
		t.Fatalf("30-day share answered %d", code)
	}

	// At most max_live working links; revoking one frees a slot.
	g.srv.cfg.Share.MaxLive = 3 // the three uploads above
	if code, out := a.doRaw(g.http.URL, "POST", "/v1/shares?ttl=1", blob(60), true); code != 507 || !strings.Contains(string(out), "too_many_links") {
		t.Fatalf("fourth live link answered %d %s", code, out)
	}
	_, out := a.do(g.http.URL, "GET", "/v1/shares", nil, true)
	var list struct{ Shares []struct{ ID string } }
	_ = json.Unmarshal(out, &list)
	if len(list.Shares) != 3 {
		t.Fatalf("list: %s", out)
	}
	a.do(g.http.URL, "DELETE", "/v1/shares/"+list.Shares[0].ID, nil, true)
	if code, _ := a.doRaw(g.http.URL, "POST", "/v1/shares?ttl=1", blob(60), true); code != 200 {
		t.Fatalf("after a revoke answered %d", code)
	}

	// A suspended address can't share.
	_ = g.st.Suspend("a@gmail.test")
	if code, _ := a.doRaw(g.http.URL, "POST", "/v1/shares?ttl=7", blob(60), true); code != 403 {
		t.Fatalf("suspended upload answered %d", code)
	}
}

func TestSharePreviewCard(t *testing.T) {
	w := newWorld(t)
	g := w.global
	dir := t.TempDir()
	page := "<html><head>\n<!--stem-card-->\n<title>Shared from Stem</title>\n<!--/stem-card-->\n</head><body></body></html>"
	if err := os.WriteFile(filepath.Join(dir, "index.html"), []byte(page), 0o600); err != nil {
		t.Fatal(err)
	}
	g.srv.cfg.Share.Enabled = true
	g.srv.cfg.Share.ViewerURL = "http://" + strings.TrimPrefix(g.http.URL, "http://")
	g.srv.cfg.Share.ViewerDir = dir
	if err := os.MkdirAll(filepath.Join(dir, "assets"), 0o700); err != nil {
		t.Fatal(err)
	}
	_ = os.WriteFile(filepath.Join(dir, "assets", "index-abc.js"), []byte("console.log(1)"), 0o600)
	a := w.newStem(g, "a@gmail.test")
	a.register()

	card := base64.RawURLEncoding.EncodeToString([]byte(`{"t":"Terasa <b>\"olej\"</b>\u001b[2J","d":"Dve tenké\nvrstvy"}`))
	code, out := a.doRaw(g.http.URL, "POST", "/v1/shares?card="+card, blob(60), true)
	if code != 200 {
		t.Fatalf("upload: %d %s", code, out)
	}
	var made struct{ ID string }
	_ = json.Unmarshal(out, &made)

	resp, err := http.Get(g.http.URL + "/s/" + made.ID)
	if err != nil {
		t.Fatal(err)
	}
	body, _ := io.ReadAll(resp.Body)
	resp.Body.Close()
	html := string(body)
	if !strings.Contains(resp.Header.Get("X-Robots-Tag"), "noindex") {
		t.Fatalf("no noindex header: %v", resp.Header)
	}
	for _, want := range []string{
		`<title>Terasa &lt;b&gt;&#34;olej&#34;&lt;/b&gt;[2J</title>`,
		`content="Dve tenké vrstvy"`,
		`content="` + g.http.URL + `/s/` + made.ID + `"`,
		`content="` + g.http.URL + `/og.png"`,
	} {
		if !strings.Contains(html, want) {
			t.Fatalf("page lacks %s:\n%s", want, html)
		}
	}
	if strings.Contains(html, "<b>") || strings.Contains(html, "\x1b") {
		t.Fatalf("card not escaped:\n%s", html)
	}

	// No card: the page as built. Revoked: a removed card, the old text gone.
	_, out = a.doRaw(g.http.URL, "POST", "/v1/shares", blob(60), true)
	var plain struct{ ID string }
	_ = json.Unmarshal(out, &plain)
	if _, b := get(t, g.http.URL+"/s/"+plain.ID); string(b) != page {
		t.Fatalf("cardless page changed:\n%s", b)
	}
	a.do(g.http.URL, "DELETE", "/v1/shares/"+made.ID, nil, true)
	if _, b := get(t, g.http.URL+"/s/"+made.ID); strings.Contains(string(b), "Terasa") || !strings.Contains(string(b), "Link removed") {
		t.Fatalf("revoked page:\n%s", b)
	}
	if code, _ := a.doRaw(g.http.URL, "POST", "/v1/shares?card=***", blob(60), true); code != 400 {
		t.Fatalf("bad card answered %d", code)
	}

	// Assets come from the viewer folder, with a long cache; nothing outside it.
	resp, _ = http.Get(g.http.URL + "/assets/index-abc.js")
	b, _ := io.ReadAll(resp.Body)
	resp.Body.Close()
	if resp.StatusCode != 200 || string(b) != "console.log(1)" || !strings.Contains(resp.Header.Get("Cache-Control"), "immutable") {
		t.Fatalf("asset: %d %q %v", resp.StatusCode, b, resp.Header)
	}
	if code, _ := get(t, g.http.URL+"/assets/../index.html"); code == 200 {
		t.Fatal("served outside assets")
	}

	// Another host (the relay's own name) gets no viewer at all.
	g.srv.cfg.Share.ViewerURL = "https://share.example"
	if code, _ := get(t, g.http.URL+"/s/"+plain.ID); code != 404 {
		t.Fatalf("viewer on the relay host answered %d", code)
	}
	if code, _ := get(t, g.http.URL+"/assets/index-abc.js"); code != 404 {
		t.Fatalf("asset on the relay host answered %d", code)
	}
}
