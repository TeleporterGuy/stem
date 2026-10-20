package server

import (
	"context"
	"crypto/subtle"
	"errors"
	"fmt"
	"log"
	"net/http"
	"strings"
	"time"

	"github.com/join3r/stem/relay/internal/mailer"
	"github.com/join3r/stem/relay/internal/store"
)

var ok = map[string]string{"status": "ok"}

// invite queues an invite. Whatever happens, the answer is the same, so
// the requester never learns whether the address is on Stem.
func (s *Server) invite(w http.ResponseWriter, r *http.Request, body []byte) error {
	from, _, err := s.certified(r, body)
	if err != nil {
		return err
	}
	var in struct{ Address string }
	if err := decode(body, &in); err != nil {
		return err
	}
	to, err := addressArg(in.Address)
	if err != nil {
		return err
	}
	if served, err := s.Serves(to); err != nil {
		return err
	} else if !served {
		return fail(421, "not_authoritative")
	}
	if err := s.queueInvite(from, to); err != nil {
		return err
	}
	writeJSON(w, 202, ok)
	return nil
}

func (s *Server) queueInvite(from, to string) error {
	iv, l := s.cfg.Invite, s.cfg.Limits
	if !iv.Enabled || from == to {
		return nil
	}
	// It is a knock either way.
	fresh, err := s.st.Knock(from, to, s.Now().Add(-time.Duration(l.KnockDays)*day).UnixMilli())
	if err != nil || !fresh {
		return err
	}
	if _, _, err := s.st.AddressAccount(to); err == nil {
		return nil // registered: nothing to invite to
	} else if !errors.Is(err, store.ErrNotFound) {
		return err
	}
	for _, check := range []func() (bool, error){
		func() (bool, error) { return s.st.Suppressed(to) },
		func() (bool, error) { return s.st.InviterBanned(from) },
		func() (bool, error) { return s.isNewLocal(from), nil },
	} {
		if bad, err := check(); err != nil || bad {
			return err
		}
	}
	if okDay, err := s.hit("invite:day:"+from, day, iv.PerSenderDay); err != nil || !okDay {
		return err
	}
	if okMonth, err := s.hit("invite:month:"+from, 30*day, iv.PerSenderMonth); err != nil || !okMonth {
		return err
	}
	count, _, err := s.st.InvitesTo(to, 0)
	if err != nil || count >= iv.MaxPerRecipient {
		return err
	}
	return s.st.QueueInvite(to, from)
}

// isNewLocal: an address this relay verified within NewAddressDays.
func (s *Server) isNewLocal(addr string) bool {
	_, verified, err := s.st.AddressAccount(addr)
	if err != nil {
		return false
	}
	return s.Now().UnixMilli()-verified < int64(s.cfg.Limits.NewAddressDays)*day.Milliseconds()
}

// breakerOpen reports whether invites are paused for bounce or complaint
// rates over the window.
func (s *Server) breakerOpen() (bool, string, error) {
	iv := s.cfg.Invite
	since := s.Now().Add(-time.Duration(iv.BreakerWindowDays) * day).UnixMilli()
	sentN, bounces, complaints, err := s.st.InviteRates(since)
	if err != nil || sentN < iv.BreakerMinSample || sentN == 0 {
		return false, "", err
	}
	br := float64(bounces) * 100 / float64(sentN)
	cr := float64(complaints) * 100 / float64(sentN)
	if br > iv.BounceRatePct || cr > iv.ComplaintRatePct {
		return true, fmt.Sprintf("bounces %.2f%%, complaints %.3f%% of %d invites", br, cr, sentN), nil
	}
	return false, "", nil
}

// DispatchInvites sends queued invites within the global budget. Called
// periodically.
func (s *Server) DispatchInvites() error {
	iv := s.cfg.Invite
	if !iv.Enabled {
		return nil
	}
	if err := s.st.DropQueuedInvitesBefore(s.Now().Add(-time.Duration(iv.PerRecipientDays) * day).UnixMilli()); err != nil {
		return err
	}
	open, why, err := s.breakerOpen()
	if err != nil {
		return err
	}
	if open {
		if prev, _ := s.st.Meta("breaker"); prev != "open" {
			log.Printf("ALERT: invites paused by circuit breaker: %s", why)
			_ = s.st.SetMeta("breaker", "open")
		}
		return nil
	}
	_ = s.st.SetMeta("breaker", "closed")
	used, err := s.st.Count("invite:global", day)
	if err != nil {
		return err
	}
	budget := iv.GlobalPerDay - used
	if budget <= 0 {
		return nil
	}
	queue, err := s.st.InviteQueue(500)
	if err != nil {
		return err
	}
	gap := time.Duration(iv.PerRecipientDays) * day
	for _, q := range queue {
		if budget <= 0 {
			break
		}
		// The address may have joined, unsubscribed or been invited meanwhile.
		if _, _, err := s.st.AddressAccount(q.To); err == nil {
			_ = s.st.DropQueuedInvite(q.To)
			continue
		}
		if sup, _ := s.st.Suppressed(q.To); sup {
			_ = s.st.DropQueuedInvite(q.To)
			continue
		}
		count, last, err := s.st.InvitesTo(q.To, 0)
		if err != nil {
			return err
		}
		if count >= iv.MaxPerRecipient {
			_ = s.st.DropQueuedInvite(q.To)
			continue
		}
		if last > 0 && s.Now().UnixMilli()-last < gap.Milliseconds() {
			continue // batched into the next window
		}
		if err := s.sendInvite(q); err != nil {
			log.Printf("invite to %s failed: %v", q.To, err)
			continue
		}
		_, _ = s.hit("invite:global", day, 0)
		budget--
	}
	return nil
}

func (s *Server) sendInvite(q store.QueuedInvite) error {
	tag := "i-" + randomToken()[:16]
	unsub := randomToken()
	if err := s.st.PutUnsubToken(unsub, q.To); err != nil {
		return err
	}
	who := q.Senders[0]
	subject := who + " wants to reach you on Stem"
	if n := len(q.Senders) - 1; n == 1 {
		subject = who + " and 1 other want to reach you on Stem"
	} else if n > 1 {
		subject = fmt.Sprintf("%s and %d others want to reach you on Stem", who, n)
	}
	var b strings.Builder
	fmt.Fprintf(&b, "%s tried to send you a message through Stem.\n\n", strings.Join(q.Senders, ", "))
	b.WriteString("Stem is a personal assistant app. Messages between Stems are end-to-end encrypted, so this email can't contain the message itself.\n\n")
	if s.cfg.Invite.DownloadURL != "" {
		fmt.Fprintf(&b, "Get Stem: %s\n\n", s.cfg.Invite.DownloadURL)
	}
	fmt.Fprintf(&b, "Never email me again: %s/v1/unsubscribe?t=%s\n", s.cfg.URL, unsub)
	if err := s.mail.Send(mailer.Message{Kind: mailer.Invite, To: q.To, Subject: subject, Body: b.String(), Tag: tag}); err != nil {
		return err
	}
	return s.st.LogInvite(q.To, tag, q.Senders)
}

// mailEvent takes bounce and complaint notifications from the mail
// provider (normalized by whatever forwards them).
func (s *Server) mailEvent(w http.ResponseWriter, r *http.Request, body []byte) error {
	secret := s.cfg.Invite.WebhookSecret
	if secret == "" || subtle.ConstantTimeCompare([]byte(r.Header.Get("X-Stem-Webhook-Secret")), []byte(secret)) != 1 {
		return fail(401, "bad_secret")
	}
	var in struct{ Tag, Kind string }
	if err := decode(body, &in); err != nil {
		return err
	}
	if in.Kind != "bounce" && in.Kind != "complaint" {
		return fail(400, "bad_kind")
	}
	if err := s.st.LogMailEvent(in.Tag, in.Kind); err != nil {
		return err
	}
	to, senders, err := s.st.InviteTagAddress(in.Tag)
	if err == nil {
		if err := s.st.Suppress(to); err != nil {
			return err
		}
		if in.Kind == "complaint" {
			for _, f := range senders {
				if err := s.st.BanInviter(f); err != nil {
					return err
				}
			}
		}
	} else if !errors.Is(err, store.ErrNotFound) {
		return err
	}
	writeJSON(w, 200, map[string]any{})
	return nil
}

// Run does periodic work until ctx ends: sweeping and invite dispatch.
func (s *Server) Run(ctx context.Context) {
	t := time.NewTicker(time.Minute)
	defer t.Stop()
	sweep := time.Now()
	for {
		if time.Since(sweep) >= 10*time.Minute {
			if err := s.st.Sweep(s.cfg.Limits.HoldDays); err != nil {
				log.Printf("sweep: %v", err)
			}
			sweep = time.Now()
		}
		if err := s.DispatchInvites(); err != nil {
			log.Printf("invites: %v", err)
		}
		select {
		case <-ctx.Done():
			return
		case <-t.C:
		}
	}
}
