// Package mailer sends the relay's only two kinds of email: verification
// codes and invites. Each kind has its own sender and stream.
package mailer

import (
	"crypto/rand"
	"encoding/hex"
	"fmt"
	"log"
	"net/smtp"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/join3r/stem/relay/internal/config"
)

type Kind int

const (
	Verify Kind = iota
	Invite
)

type Message struct {
	Kind    Kind
	To      string
	Subject string
	Body    string
	// Tag lets bounce/complaint webhooks find the message again.
	Tag string
}

type Mailer interface {
	Send(m Message) error
}

func New(c config.Mail) Mailer {
	if c.Driver == "smtp" {
		return &SMTP{c: c}
	}
	return &Log{}
}

// Log prints mail and keeps it, for development and tests.
type Log struct {
	mu   sync.Mutex
	Sent []Message
}

func (l *Log) Send(m Message) error {
	l.mu.Lock()
	l.Sent = append(l.Sent, m)
	l.mu.Unlock()
	log.Printf("mail to %s: %s\n%s", m.To, m.Subject, m.Body)
	return nil
}

func (l *Log) Messages() []Message {
	l.mu.Lock()
	defer l.mu.Unlock()
	return append([]Message(nil), l.Sent...)
}

type SMTP struct{ c config.Mail }

func (s *SMTP) Send(m Message) error {
	from, stream := s.c.VerifyFrom, s.c.VerifyStreamHeader
	if m.Kind == Invite {
		from, stream = s.c.InviteFrom, s.c.InviteStreamHeader
	}
	if strings.ContainsAny(m.To, "\r\n") || strings.ContainsAny(m.Subject, "\r\n") {
		return fmt.Errorf("header injection")
	}
	var b strings.Builder
	fmt.Fprintf(&b, "From: %s\r\nTo: %s\r\nSubject: %s\r\nDate: %s\r\n", from, m.To, m.Subject, time.Now().Format(time.RFC1123Z))
	// Gmail scores mail without a Message-ID as spam-like.
	fmt.Fprintf(&b, "Message-ID: %s\r\n", messageID(envelopeFrom(from)))
	fmt.Fprintf(&b, "MIME-Version: 1.0\r\nContent-Type: text/plain; charset=utf-8\r\nX-Stem-Tag: %s\r\n", m.Tag)
	if stream != "" {
		b.WriteString(stream + "\r\n")
	}
	b.WriteString("\r\n" + strings.ReplaceAll(m.Body, "\n", "\r\n"))
	addr := s.c.SMTPHost + ":" + strconv.Itoa(s.c.SMTPPort)
	var auth smtp.Auth
	if s.c.SMTPUser != "" {
		auth = smtp.PlainAuth("", s.c.SMTPUser, s.c.SMTPPass, s.c.SMTPHost)
	}
	return smtp.SendMail(addr, auth, envelopeFrom(from), []string{m.To}, []byte(b.String()))
}

// envelopeFrom extracts the bare address from `Name <a@b>`.
func envelopeFrom(from string) string {
	if i := strings.LastIndexByte(from, '<'); i >= 0 {
		return strings.TrimSuffix(from[i+1:], ">")
	}
	return from
}

func messageID(from string) string {
	host := "localhost"
	if i := strings.LastIndexByte(from, '@'); i >= 0 {
		host = from[i+1:]
	}
	var r [12]byte
	rand.Read(r[:])
	return "<" + hex.EncodeToString(r[:]) + "@" + host + ">"
}
