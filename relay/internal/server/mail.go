package server

import (
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"sync"
	"time"

	"github.com/join3r/stem/relay/internal/proto"
	"github.com/join3r/stem/relay/internal/store"
)

// ---- delivery ----

var sent = map[string]string{"status": "sent"}

func (s *Server) postMail(w http.ResponseWriter, r *http.Request, body []byte) error {
	var env proto.Envelope
	if err := decode(body, &env); err != nil {
		return err
	}
	env.From, env.To = proto.NormalizeAddress(env.From), proto.NormalizeAddress(env.To)
	sealed, err := proto.VerifyEnvelope(&env, s.Now(), s.issuerKeys)
	if err != nil {
		return fail(400, "bad_envelope")
	}
	if int64(len(sealed)) > s.cfg.Limits.MaxMailBytes {
		return fail(413, "too_large")
	}
	if ok, err := s.Serves(env.To); err != nil {
		return err
	} else if !ok {
		return fail(421, "not_authoritative")
	}
	if seen, err := s.st.Seen(env.ID); err != nil {
		return err
	} else if seen {
		return fail(409, "duplicate")
	}
	signerFp := env.Cert.KeyFp
	drop := func() error {
		if err := s.st.MarkSeen(env.ID, signerFp, env.From, env.To, "dropped"); err != nil {
			return err
		}
		writeJSON(w, 202, sent)
		return nil
	}

	l := s.cfg.Limits
	if sus, err := s.st.Suspended(env.From); err != nil {
		return err
	} else if sus {
		return drop()
	}
	if ok, err := s.hit("send:hour:"+env.From, time.Hour, s.scaled(env.From, l.MailsPerSenderHour)); err != nil {
		return err
	} else if !ok {
		return fail(429, "rate_limited")
	}
	if ok, err := s.hit("issuer:hour:"+env.Cert.Issuer, time.Hour, l.MailsPerIssuerHour); err != nil {
		return err
	} else if !ok {
		return fail(429, "rate_limited")
	}

	acc, _, err := s.st.AddressAccount(env.To)
	if errors.Is(err, store.ErrNotFound) || err == nil && acc.Revoked {
		return drop()
	} else if err != nil {
		return err
	}
	if blocked, err := s.st.Blocks(acc.Fp, env.From); err != nil {
		return err
	} else if blocked {
		return drop()
	}
	allowed, err := s.st.Allows(acc.Fp, env.From)
	if err != nil {
		return err
	}
	if !allowed {
		knockSince := s.Now().Add(-time.Duration(l.KnockDays) * day).UnixMilli()
		fresh, err := s.st.Knock(env.From, env.To, knockSince)
		if err != nil {
			return err
		}
		if !fresh {
			return drop()
		}
		if ok, err := s.hit("first:day:"+env.From, day, s.scaled(env.From, l.FirstContactsPerDay)); err != nil {
			return err
		} else if !ok {
			return drop()
		}
	}

	bytes, mails, err := s.st.QueueUsage(env.To)
	if err != nil {
		return err
	}
	size := int64(len(body))
	full := bytes+size > l.QueueBytes || mails+1 > l.QueueMails
	if !full && l.QueueSenderShare > 0 && l.QueueSenderShare < 100 {
		fb, fm, err := s.st.QueueUsageFrom(env.To, env.From)
		if err != nil {
			return err
		}
		full = fb+size > l.QueueBytes*int64(l.QueueSenderShare)/100 || fm+1 > l.QueueMails*l.QueueSenderShare/100
	}
	if full {
		if allowed {
			return fail(507, "queue_full")
		}
		return drop()
	}

	expires := s.Now().Add(time.Duration(l.HoldDays) * day).UnixMilli()
	if err := s.st.Hold(store.Held{ID: env.ID, To: env.To, From: env.From, Size: size, Envelope: body}, expires); err != nil {
		return err
	}
	if err := s.st.MarkSeen(env.ID, signerFp, env.From, env.To, "pending"); err != nil {
		return err
	}
	s.hub.publish(acc.Fp, store.Held{ID: env.ID, To: env.To, From: env.From, Size: size, Envelope: body})
	writeJSON(w, 202, sent)
	return nil
}

// scaled divides a limit for addresses this relay verified recently.
// Senders on other relays are judged by their own relay.
func (s *Server) scaled(from string, limit int) int {
	l := s.cfg.Limits
	if limit <= 0 || l.NewAddressDivisor <= 1 {
		return limit
	}
	_, verified, err := s.st.AddressAccount(from)
	if err != nil {
		return limit
	}
	if s.Now().UnixMilli()-verified < int64(l.NewAddressDays)*day.Milliseconds() {
		return max(1, limit/l.NewAddressDivisor)
	}
	return limit
}

func (s *Server) mailStatus(w http.ResponseWriter, r *http.Request, body []byte) error {
	_, fp, err := s.certified(r, body)
	if err != nil {
		return err
	}
	signerFp, from, to, status, err := s.st.SeenRow(r.URL.Query().Get("id"))
	if errors.Is(err, store.ErrNotFound) || err == nil && signerFp != fp {
		writeJSON(w, 200, sent)
		return nil
	} else if err != nil {
		return err
	}
	acc, _, err := s.st.AddressAccount(to)
	if err != nil || status == "dropped" {
		writeJSON(w, 200, sent)
		return nil
	}
	if ok, err := s.st.Allows(acc.Fp, from); err != nil {
		return err
	} else if !ok {
		writeJSON(w, 200, sent)
		return nil
	}
	writeJSON(w, 200, map[string]string{"status": status})
	return nil
}

func (s *Server) ack(w http.ResponseWriter, r *http.Request, body []byte) error {
	_, addrs, err := s.own(r, body)
	if err != nil {
		return err
	}
	var in struct {
		IDs []string `json:"ids"`
	}
	if err := decode(body, &in); err != nil {
		return err
	}
	if len(in.IDs) > 1000 {
		return fail(400, "too_many")
	}
	n, err := s.st.Ack(in.IDs, addrs)
	if err != nil {
		return err
	}
	writeJSON(w, 200, map[string]int{"acked": n})
	return nil
}

// ---- stream ----

func (s *Server) stream(w http.ResponseWriter, r *http.Request) {
	acc, addrs, err := s.own(r, nil)
	if err != nil {
		var ae *apiError
		if errors.As(err, &ae) {
			writeJSON(w, ae.status, map[string]string{"error": ae.code})
		} else {
			writeJSON(w, 500, map[string]string{"error": "internal"})
		}
		return
	}
	if !s.streams.take(acc.Fp, streamsPerKey) {
		writeJSON(w, 429, map[string]string{"error": "too_many_streams"})
		return
	}
	defer s.streams.give(acc.Fp)
	flusher, ok := w.(http.Flusher)
	if !ok {
		writeJSON(w, 500, map[string]string{"error": "no_streaming"})
		return
	}
	ch := s.hub.subscribe(acc.Fp)
	defer s.hub.unsubscribe(ch)

	w.Header().Set("Content-Type", "text/event-stream")
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("X-Accel-Buffering", "no")
	w.WriteHeader(200)

	sentIDs := map[string]bool{}
	send := func(h store.Held) bool {
		if sentIDs[h.ID] {
			return true
		}
		sentIDs[h.ID] = true
		_, err := fmt.Fprintf(w, "event: mail\nid: %s\ndata: %s\n\n", h.ID, compact(h.Envelope))
		flusher.Flush()
		return err == nil
	}
	held, err := s.st.HeldFor(addrs)
	if err != nil {
		return
	}
	for _, h := range held {
		if !send(h) {
			return
		}
	}
	fmt.Fprint(w, ": ready\n\n")
	flusher.Flush()

	ping := time.NewTicker(25 * time.Second)
	defer ping.Stop()
	for {
		select {
		case <-r.Context().Done():
			return
		case h := <-ch:
			if !send(h) {
				return
			}
		case <-ping.C:
			if _, err := fmt.Fprint(w, ": ping\n\n"); err != nil {
				return
			}
			flusher.Flush()
		}
	}
}

// compact keeps an SSE data line on one line.
func compact(b []byte) []byte {
	var v json.RawMessage = b
	out, err := json.Marshal(v)
	if err != nil {
		return b
	}
	return out
}

// hub fans new mail out to open streams by account fingerprint, not by
// address: when an address moves to a new key, the old key's open stream
// must stop receiving it at once.
type hub struct {
	mu   sync.Mutex
	subs map[chan store.Held]string
}

func newHub() *hub { return &hub{subs: map[chan store.Held]string{}} }

func (h *hub) subscribe(fp string) chan store.Held {
	ch := make(chan store.Held, 64)
	h.mu.Lock()
	h.subs[ch] = fp
	h.mu.Unlock()
	return ch
}

func (h *hub) unsubscribe(ch chan store.Held) {
	h.mu.Lock()
	delete(h.subs, ch)
	h.mu.Unlock()
}

func (h *hub) publish(fp string, m store.Held) {
	h.mu.Lock()
	defer h.mu.Unlock()
	for ch, sub := range h.subs {
		if sub == fp {
			select {
			case ch <- m:
			default: // slow reader: it gets it on reconnect
			}
		}
	}
}
