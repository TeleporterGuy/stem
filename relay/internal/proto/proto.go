// Package proto holds the byte-exact parts of the relay protocol
// (PROTOCOL.md): signing strings, certificates, envelopes, sealing,
// request signatures and proof-of-work. Everything here must match
// testdata/vectors.json and Stem's TypeScript client.
package proto

import (
	"crypto/aes"
	"crypto/cipher"
	"crypto/ecdh"
	"crypto/ed25519"
	"crypto/hkdf"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"errors"
	"fmt"
	"math/bits"
	"strconv"
	"strings"
	"time"

)

// MaxSkew is how far a signed timestamp may be from the verifier's clock.
const MaxSkew = 5 * time.Minute

// CertTTL is how long a sender certificate is valid.
const CertTTL = 24 * time.Hour

var b64 = base64.StdEncoding

func B64(b []byte) string            { return b64.EncodeToString(b) }
func UnB64(s string) ([]byte, error) { return b64.DecodeString(s) }

func Hex(b []byte) string { return hex.EncodeToString(b) }

func SHA256Hex(b []byte) string {
	h := sha256.Sum256(b)
	return hex.EncodeToString(h[:])
}

// NormalizeAddress lowercases and trims; it does not validate.
func NormalizeAddress(a string) string { return strings.ToLower(strings.TrimSpace(a)) }

// ValidAddress is a deliberately loose check: one @, non-empty local part,
// a dotted domain, no whitespace or control characters.
func ValidAddress(a string) bool {
	if len(a) > 254 || a != NormalizeAddress(a) {
		return false
	}
	at := strings.LastIndexByte(a, '@')
	if at <= 0 || at == len(a)-1 || strings.Count(a, "@") != 1 {
		return false
	}
	for _, r := range a {
		if r <= ' ' || r == 0x7f {
			return false
		}
	}
	return strings.Contains(a[at+1:], ".")
}

// Domain is the part after the last @.
func Domain(a string) string { return a[strings.LastIndexByte(a, '@')+1:] }

// Fingerprint of an Ed25519 public key.
func Fingerprint(pub ed25519.PublicKey) string { return SHA256Hex(pub) }

func ParseEd25519(s string) (ed25519.PublicKey, error) {
	b, err := UnB64(s)
	if err != nil || len(b) != ed25519.PublicKeySize {
		return nil, errors.New("bad ed25519 public key")
	}
	return ed25519.PublicKey(b), nil
}

// ---- certificates ----

type Cert struct {
	V       int    `json:"v"`
	Address string `json:"address"`
	KeyFp   string `json:"keyFp"`
	Issuer  string `json:"issuer"`
	Kid     string `json:"kid"`
	Iat     int64  `json:"iat"`
	Exp     int64  `json:"exp"`
	Sig     string `json:"sig"`
}

func (c *Cert) SigningString() string {
	return "stem-cert-v1\n" + c.Address + "\n" + c.KeyFp + "\n" + c.Issuer + "\n" +
		strconv.FormatInt(c.Iat, 10) + "\n" + strconv.FormatInt(c.Exp, 10) + "\n" + c.Kid
}

// CertString is what an envelope signature commits to.
func (c *Cert) CertString() string { return c.SigningString() + "\n" + c.Sig }

func SignCert(c *Cert, priv ed25519.PrivateKey) {
	c.Sig = B64(ed25519.Sign(priv, []byte(c.SigningString())))
}

// IssuerKeys resolves the relay keys allowed to certify an address
// (its domain's DNS record, or the global relay's keys).
type IssuerKeys func(address string) (issuer string, keys map[string]ed25519.PublicKey, err error)

var (
	ErrCertIssuer  = errors.New("certificate issuer is not the authority for this address")
	ErrCertSig     = errors.New("certificate signature invalid")
	ErrCertExpired = errors.New("certificate expired or not yet valid")
)

func VerifyCert(c *Cert, now time.Time, keys IssuerKeys) error {
	if c == nil || c.V != 1 || !ValidAddress(c.Address) {
		return errors.New("malformed certificate")
	}
	issuer, ks, err := keys(c.Address)
	if err != nil {
		return err
	}
	if issuer != c.Issuer {
		return ErrCertIssuer
	}
	pub, ok := ks[c.Kid]
	if !ok {
		return ErrCertIssuer
	}
	sig, err := UnB64(c.Sig)
	if err != nil || !ed25519.Verify(pub, []byte(c.SigningString()), sig) {
		return ErrCertSig
	}
	ms := now.UnixMilli()
	if c.Iat > ms+MaxSkew.Milliseconds() || ms >= c.Exp {
		return ErrCertExpired
	}
	return nil
}

// ---- envelopes ----

type Envelope struct {
	V      int    `json:"v"`
	ID     string `json:"id"`
	Ts     int64  `json:"ts"`
	From   string `json:"from"`
	To     string `json:"to"`
	Cert   *Cert  `json:"cert"`
	Signer string `json:"signer"`
	Sealed string `json:"sealed"`
	Sig    string `json:"sig"`
}

func EnvelopeSigningString(e *Envelope, sealed []byte) string {
	return "stem-env-v1\n" + e.ID + "\n" + strconv.FormatInt(e.Ts, 10) + "\n" + e.From + "\n" + e.To + "\n" +
		SHA256Hex(sealed) + "\n" + SHA256Hex([]byte(e.Cert.CertString()))
}

func SignEnvelope(e *Envelope, priv ed25519.PrivateKey) error {
	sealed, err := UnB64(e.Sealed)
	if err != nil {
		return err
	}
	e.Signer = B64(priv.Public().(ed25519.PublicKey))
	e.Sig = B64(ed25519.Sign(priv, []byte(EnvelopeSigningString(e, sealed))))
	return nil
}

func validID(id string) bool {
	if len(id) != 32 {
		return false
	}
	_, err := hex.DecodeString(id)
	return err == nil && strings.ToLower(id) == id
}

// VerifyEnvelope checks structure, certificate, binding and signature. It
// returns the decoded sealed bytes. Replay (seen ids) is the caller's job.
func VerifyEnvelope(e *Envelope, now time.Time, keys IssuerKeys) ([]byte, error) {
	if e.V != 1 || !validID(e.ID) || !ValidAddress(e.From) || !ValidAddress(e.To) || e.Cert == nil {
		return nil, errors.New("malformed envelope")
	}
	if d := now.UnixMilli() - e.Ts; d > MaxSkew.Milliseconds() || d < -MaxSkew.Milliseconds() {
		return nil, errors.New("envelope timestamp out of range")
	}
	if e.Cert.Address != e.From {
		return nil, errors.New("certificate is for a different address")
	}
	if err := VerifyCert(e.Cert, now, keys); err != nil {
		return nil, err
	}
	signer, err := ParseEd25519(e.Signer)
	if err != nil {
		return nil, err
	}
	if Fingerprint(signer) != e.Cert.KeyFp {
		return nil, errors.New("signer does not match certificate")
	}
	sealed, err := UnB64(e.Sealed)
	if err != nil || len(sealed) < 32+sealOverhead {
		return nil, errors.New("bad sealed payload")
	}
	sig, err := UnB64(e.Sig)
	if err != nil || !ed25519.Verify(signer, []byte(EnvelopeSigningString(e, sealed)), sig) {
		return nil, errors.New("envelope signature invalid")
	}
	return sealed, nil
}

// ---- sealing ----

func sealAAD(id, from, to string) []byte {
	return []byte("stem-seal-v1\n" + id + "\n" + from + "\n" + to)
}

// AES-256-GCM rather than ChaCha20-Poly1305: Electron's BoringSSL (the
// desktop app's embedded server) has no ChaCha20 cipher in node:crypto.
const sealOverhead = 16

func sealKey(shared, ephPub, recipPub []byte) ([]byte, error) {
	salt := append(append([]byte{}, ephPub...), recipPub...)
	return hkdf.Key(sha256.New, shared, salt, "stem-seal-v1", 32)
}

func sealAEAD(key []byte) (cipher.AEAD, error) {
	block, err := aes.NewCipher(key)
	if err != nil {
		return nil, err
	}
	return cipher.NewGCM(block)
}

// Seal encrypts plaintext to an X25519 public key. ephPriv may be nil
// (random); tests pass a fixed one to produce vectors.
func Seal(recipient *ecdh.PublicKey, plaintext []byte, id, from, to string, ephPriv *ecdh.PrivateKey) ([]byte, error) {
	var err error
	if ephPriv == nil {
		if ephPriv, err = ecdh.X25519().GenerateKey(rand.Reader); err != nil {
			return nil, err
		}
	}
	shared, err := ephPriv.ECDH(recipient)
	if err != nil {
		return nil, err
	}
	ephPub := ephPriv.PublicKey().Bytes()
	key, err := sealKey(shared, ephPub, recipient.Bytes())
	if err != nil {
		return nil, err
	}
	aead, err := sealAEAD(key)
	if err != nil {
		return nil, err
	}
	nonce := make([]byte, aead.NonceSize())
	return aead.Seal(append([]byte{}, ephPub...), nonce, plaintext, sealAAD(id, from, to)), nil
}

// Open is Seal's inverse. The relay never calls it; it exists for tests
// and vectors.
func Open(priv *ecdh.PrivateKey, sealed []byte, id, from, to string) ([]byte, error) {
	if len(sealed) < 32+sealOverhead {
		return nil, errors.New("sealed payload too short")
	}
	eph, err := ecdh.X25519().NewPublicKey(sealed[:32])
	if err != nil {
		return nil, err
	}
	shared, err := priv.ECDH(eph)
	if err != nil {
		return nil, err
	}
	key, err := sealKey(shared, sealed[:32], priv.PublicKey().Bytes())
	if err != nil {
		return nil, err
	}
	aead, err := sealAEAD(key)
	if err != nil {
		return nil, err
	}
	return aead.Open(nil, make([]byte, aead.NonceSize()), sealed[32:], sealAAD(id, from, to))
}

// ---- request signatures ----

func RequestSigningString(method, pathQuery string, ts int64, body []byte) string {
	return "stem-req-v1\n" + method + "\n" + pathQuery + "\n" + strconv.FormatInt(ts, 10) + "\n" + SHA256Hex(body)
}

// VerifyRequest checks Stem-Key/Stem-Time/Stem-Sig header values.
func VerifyRequest(keyB64, tsStr, sigB64, method, pathQuery string, body []byte, now time.Time) (ed25519.PublicKey, error) {
	pub, err := ParseEd25519(keyB64)
	if err != nil {
		return nil, err
	}
	ts, err := strconv.ParseInt(tsStr, 10, 64)
	if err != nil {
		return nil, errors.New("bad Stem-Time")
	}
	if d := now.UnixMilli() - ts; d > MaxSkew.Milliseconds() || d < -MaxSkew.Milliseconds() {
		return nil, errors.New("Stem-Time out of range")
	}
	sig, err := UnB64(sigB64)
	if err != nil || !ed25519.Verify(pub, []byte(RequestSigningString(method, pathQuery, ts, body)), sig) {
		return nil, errors.New("bad request signature")
	}
	return pub, nil
}

// ---- proof of work ----

func PowHash(address, keyB64, nonce string) [32]byte {
	return sha256.Sum256([]byte("stem-pow-v1\n" + address + "\n" + keyB64 + "\n" + nonce))
}

func leadingZeroBits(h [32]byte) int {
	n := 0
	for _, b := range h {
		if b == 0 {
			n += 8
			continue
		}
		return n + bits.LeadingZeros8(b)
	}
	return n
}

func PowOK(address, keyB64, nonce string, bitsNeeded int) bool {
	return bitsNeeded <= 0 || (len(nonce) <= 64 && leadingZeroBits(PowHash(address, keyB64, nonce)) >= bitsNeeded)
}

// SolvePow brute-forces a nonce (clients and tests).
func SolvePow(address, keyB64 string, bitsNeeded int) string {
	for i := 0; ; i++ {
		n := strconv.Itoa(i)
		if PowOK(address, keyB64, n, bitsNeeded) {
			return n
		}
	}
}

// NewID returns 32 lowercase hex characters.
func NewID() string {
	b := make([]byte, 16)
	if _, err := rand.Read(b); err != nil {
		panic(fmt.Sprintf("rand: %v", err))
	}
	return Hex(b)
}
