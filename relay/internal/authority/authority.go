// Package authority decides which relay may certify an address: the relay
// named in the domain's `_stem.<domain>` TXT record, or the global relay.
package authority

import (
	"context"
	"crypto/ed25519"
	"errors"
	"net"
	"strings"
	"sync"
	"time"

	"github.com/join3r/stem/relay/internal/proto"
)

// Record is a parsed `_stem` TXT record.
type Record struct {
	Relay string
	Keys  map[string]ed25519.PublicKey
}

// ParseRecord parses `v=stem1; relay=https://...; k=kid:<b64>; ...`.
func ParseRecord(txt string) (*Record, error) {
	r := &Record{Keys: map[string]ed25519.PublicKey{}}
	seenV := false
	for _, part := range strings.Split(txt, ";") {
		k, v, ok := strings.Cut(strings.TrimSpace(part), "=")
		if !ok {
			continue
		}
		switch strings.TrimSpace(k) {
		case "v":
			if strings.TrimSpace(v) != "stem1" {
				return nil, errors.New("unknown record version")
			}
			seenV = true
		case "relay":
			r.Relay = strings.TrimRight(strings.TrimSpace(v), "/")
		case "k":
			kid, pub, ok := strings.Cut(strings.TrimSpace(v), ":")
			if !ok {
				continue
			}
			key, err := proto.ParseEd25519(pub)
			if err != nil {
				continue
			}
			r.Keys[kid] = key
		}
	}
	if !seenV || r.Relay == "" || !strings.HasPrefix(r.Relay, "https://") && !strings.HasPrefix(r.Relay, "http://") || len(r.Keys) == 0 {
		return nil, errors.New("incomplete _stem record")
	}
	return r, nil
}

// TXTLookup is net.Resolver.LookupTXT's shape, swappable in tests.
type TXTLookup func(ctx context.Context, name string) ([]string, error)

// Resolver maps addresses to their authority, caching DNS answers.
type Resolver struct {
	Lookup     TXTLookup
	GlobalURL  string
	GlobalKeys map[string]ed25519.PublicKey
	// Static overrides domain → record, for private setups and tests.
	Static map[string]*Record
	TTL    time.Duration

	mu    sync.Mutex
	cache map[string]cached
}

const maxCache = 10000

type cached struct {
	rec *Record // nil = no record (global)
	at  time.Time
}

func NewResolver(globalURL string, globalKeys map[string]ed25519.PublicKey) *Resolver {
	return &Resolver{
		Lookup:     net.DefaultResolver.LookupTXT,
		GlobalURL:  strings.TrimRight(globalURL, "/"),
		GlobalKeys: globalKeys,
		TTL:        10 * time.Minute,
	}
}

// DomainRecord returns the domain's record, or nil when the domain has none.
func (r *Resolver) DomainRecord(domain string) (*Record, error) {
	if rec, ok := r.Static[domain]; ok {
		return rec, nil
	}
	r.mu.Lock()
	if c, ok := r.cache[domain]; ok && time.Since(c.at) < r.TTL {
		r.mu.Unlock()
		return c.rec, nil
	}
	r.mu.Unlock()

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	txts, err := r.Lookup(ctx, "_stem."+domain)
	var rec *Record
	if err != nil {
		var dnsErr *net.DNSError
		if !errors.As(err, &dnsErr) || !dnsErr.IsNotFound {
			return nil, err // transient: don't cache, don't guess
		}
	}
	for _, t := range txts {
		if p, perr := ParseRecord(t); perr == nil {
			rec = p
			break
		}
	}
	r.mu.Lock()
	// Unauthenticated mail names arbitrary sender domains; keep the cache
	// from growing without bound.
	if r.cache == nil || len(r.cache) >= maxCache {
		r.cache = map[string]cached{}
	}
	r.cache[domain] = cached{rec: rec, at: time.Now()}
	r.mu.Unlock()
	return rec, nil
}

// Authority returns the relay URL and keys allowed to certify the address.
func (r *Resolver) Authority(address string) (string, map[string]ed25519.PublicKey, error) {
	rec, err := r.DomainRecord(proto.Domain(address))
	if err != nil {
		return "", nil, err
	}
	if rec != nil {
		return rec.Relay, rec.Keys, nil
	}
	if r.GlobalURL == "" {
		return "", nil, errors.New("no global relay configured")
	}
	return r.GlobalURL, r.GlobalKeys, nil
}

// IssuerKeys adapts Authority to proto.IssuerKeys.
func (r *Resolver) IssuerKeys() proto.IssuerKeys { return r.Authority }
