package server

import (
	"context"
	"encoding/json"
	"log"
	"net/http"
	"regexp"
	"time"

	"github.com/join3r/stem/relay/internal/apns"
	"github.com/join3r/stem/relay/internal/proto"
)

// ---- push gateway ----
//
// A Stem without the app's APNs key sends {token, env, wake} signed with its
// own key; the relay writes the alert itself from fixed wording, so no Stem
// can put its own words on someone's lock screen, and sends it with the
// Awantech .p8. A token belongs to the first key that pushes to it.

// Pusher is what the gateway sends through: *apns.Client, or a test's.
type Pusher interface {
	Send(ctx context.Context, env, deviceToken string, payload []byte) (apns.Result, string)
}

type Wake struct {
	Kind           string `json:"kind"`
	ApprovalKind   string `json:"approvalKind,omitempty"`
	ConversationID string `json:"conversationId,omitempty"`
	ThreadID       string `json:"threadId,omitempty"`
	ApprovalID     string `json:"approvalId,omitempty"`
	TaskID         string `json:"taskId,omitempty"`
	Failed         bool   `json:"failed,omitempty"`
}

var (
	deviceTokenRe = regexp.MustCompile(`^[0-9a-f]{64,200}$`)
	pushIDRe      = regexp.MustCompile(`^[A-Za-z0-9_.:-]{1,128}$`)
)

func idOK(id string) bool { return id == "" || pushIDRe.MatchString(id) }

// Phrasing mirrors src/server/push/index.ts without the label: the relay
// never shows text a Stem chose.
func phrasing(w Wake) (title, body string, ok bool) {
	switch w.Kind {
	case "approval":
		switch w.ApprovalKind {
		case "exec":
			return "Approval needed", "A command is waiting for your decision.", true
		case "mcp":
			return "Approval needed", "An MCP change is waiting for your decision.", true
		case "instructions":
			return "Approval needed", "A change to your instructions is waiting.", true
		case "harness":
			return "Approval needed", "A coding agent is waiting for your decision.", true
		case "skill", "":
			return "Approval needed", "A skill is waiting for your review.", true
		}
	case "turn":
		if w.Failed {
			return "A turn stopped", "A turn you started did not finish.", true
		}
		return "Stem finished", "A turn you started has finished.", true
	case "task":
		return "Task update", "A scheduled task has something for you.", true
	case "mail":
		return "New mail", "You have new mail in Stem.", true
	}
	return "", "", false
}

func pushPayload(w Wake) ([]byte, bool) {
	title, body, ok := phrasing(w)
	if !ok || !idOK(w.ConversationID) || !idOK(w.ThreadID) || !idOK(w.ApprovalID) || !idOK(w.TaskID) {
		return nil, false
	}
	aps := map[string]any{"alert": map[string]string{"title": title, "body": body}, "sound": "default"}
	if w.ConversationID != "" {
		aps["thread-id"] = "mail:" + w.ConversationID
	} else if w.ThreadID != "" {
		aps["thread-id"] = w.ThreadID
	}
	stem := map[string]any{"kind": w.Kind}
	for k, v := range map[string]string{"conversationId": w.ConversationID, "approvalKind": w.ApprovalKind,
		"threadId": w.ThreadID, "approvalId": w.ApprovalID, "taskId": w.TaskID} {
		if v != "" {
			stem[k] = v
		}
	}
	if w.Kind == "turn" {
		stem["failed"] = w.Failed
	}
	b, _ := json.Marshal(map[string]any{"aps": aps, "stem": stem})
	return b, true
}

func (s *Server) push(w http.ResponseWriter, r *http.Request, body []byte) error {
	if s.Pusher == nil {
		return fail(404, "push_disabled")
	}
	pub, err := s.signed(r, body)
	if err != nil {
		return err
	}
	var in struct {
		Token string `json:"token"`
		Env   string `json:"env"`
		Wake  Wake   `json:"wake"`
	}
	if err := decode(body, &in); err != nil {
		return err
	}
	if in.Env == "" {
		in.Env = "production"
	}
	if !deviceTokenRe.MatchString(in.Token) || (in.Env != "production" && in.Env != "sandbox") {
		return fail(400, "bad_token")
	}
	payload, ok := pushPayload(in.Wake)
	if !ok {
		return fail(400, "bad_wake")
	}
	p := s.cfg.Push
	fp := proto.Fingerprint(pub)
	// Keys are free, so the per-key ceiling alone stops nobody: the client IP
	// is counted first. The token's ceiling comes after ownership, so a key
	// that does not own a token can't spend its allowance, and the global one
	// last, so refused requests never eat everyone else's.
	limit := func(k string, n int) error {
		if ok, err := s.hit(k, time.Hour, n); err != nil {
			return err
		} else if !ok {
			return fail(429, "rate_limited")
		}
		return nil
	}
	if err := limit("push:ip:"+ipBucket(s.clientIP(r)), p.PerIPHour); err != nil {
		return err
	}
	if err := limit("push:key:"+fp, p.PerKeyHour); err != nil {
		return err
	}
	if owns, err := s.st.ClaimPushToken(in.Token, fp, time.Duration(p.RebindDays)*day); err != nil {
		return err
	} else if !owns {
		return fail(409, "token_bound")
	}
	if err := limit("push:tok:"+in.Token, p.PerTokenHour); err != nil {
		return err
	}
	if err := limit("push:global", p.GlobalHour); err != nil {
		return err
	}
	res, detail := s.Pusher.Send(r.Context(), in.Env, in.Token, payload)
	switch res {
	case apns.Sent:
		writeJSON(w, 200, map[string]string{"result": "sent"})
	case apns.Gone:
		if err := s.st.DropPushToken(in.Token); err != nil {
			return err
		}
		writeJSON(w, 200, map[string]string{"result": "gone"})
	default:
		log.Printf("push: apns refused: %s", detail)
		return fail(502, "apns_failed")
	}
	return nil
}
