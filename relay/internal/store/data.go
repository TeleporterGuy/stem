package store

import (
	"database/sql"
	"encoding/json"
	"errors"
	"strings"
)

// ---- accounts and addresses ----

type Account struct {
	Fp       string
	AuthKey  string
	KeyBlob  string
	Unlisted bool
	Revoked  bool
}

func (s *Store) Account(fp string) (*Account, error) {
	a := &Account{Fp: fp}
	var u, r int
	err := s.db.QueryRow(`SELECT auth_key, key_blob, unlisted, revoked FROM accounts WHERE fp = ?`, fp).
		Scan(&a.AuthKey, &a.KeyBlob, &u, &r)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, ErrNotFound
	}
	a.Unlisted, a.Revoked = u == 1, r == 1
	return a, err
}

// AddressAccount returns the account currently holding the address.
func (s *Store) AddressAccount(address string) (*Account, int64, error) {
	var fp string
	var verified int64
	err := s.db.QueryRow(`SELECT fp, verified FROM addresses WHERE address = ?`, address).Scan(&fp, &verified)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, 0, ErrNotFound
	}
	if err != nil {
		return nil, 0, err
	}
	a, err := s.Account(fp)
	return a, verified, err
}

func (s *Store) AccountAddresses(fp string) ([]string, error) {
	rows, err := s.db.Query(`SELECT address FROM addresses WHERE fp = ? ORDER BY address`, fp)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []string
	for rows.Next() {
		var a string
		if err := rows.Scan(&a); err != nil {
			return nil, err
		}
		out = append(out, a)
	}
	return out, rows.Err()
}

func (s *Store) SetUnlisted(fp string, v bool) error {
	_, err := s.db.Exec(`UPDATE accounts SET unlisted = ? WHERE fp = ?`, b2i(v), fp)
	return err
}

// Revoke stops certifying the key and releases its addresses.
func (s *Store) Revoke(fp string) error {
	tx, err := s.db.Begin()
	if err != nil {
		return err
	}
	if _, err := tx.Exec(`UPDATE accounts SET revoked = 1 WHERE fp = ?`, fp); err != nil {
		tx.Rollback()
		return err
	}
	if _, err := tx.Exec(`DELETE FROM addresses WHERE fp = ?`, fp); err != nil {
		tx.Rollback()
		return err
	}
	return tx.Commit()
}

// ---- pending verifications ----

type Pending struct {
	Address, Fp, AuthKey, KeyBlob, CodeHash, Token string
	Created                                        int64
	Attempts                                       int
}

func (s *Store) PutPending(p Pending) error {
	_, err := s.db.Exec(`INSERT INTO pending (address, fp, auth_key, key_blob, code_hash, token, created, attempts)
		VALUES (?, ?, ?, ?, ?, ?, ?, 0)
		ON CONFLICT (address, fp) DO UPDATE SET auth_key = excluded.auth_key, key_blob = excluded.key_blob,
		  code_hash = excluded.code_hash, token = excluded.token, created = excluded.created, attempts = 0`,
		p.Address, p.Fp, p.AuthKey, p.KeyBlob, p.CodeHash, p.Token, now())
	return err
}

func (s *Store) scanPending(row *sql.Row) (*Pending, error) {
	p := &Pending{}
	err := row.Scan(&p.Address, &p.Fp, &p.AuthKey, &p.KeyBlob, &p.CodeHash, &p.Token, &p.Created, &p.Attempts)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, ErrNotFound
	}
	return p, err
}

const pendingCols = `address, fp, auth_key, key_blob, code_hash, token, created, attempts`

func (s *Store) GetPending(address, fp string) (*Pending, error) {
	return s.scanPending(s.db.QueryRow(`SELECT `+pendingCols+` FROM pending WHERE address = ? AND fp = ?`, address, fp))
}

func (s *Store) GetPendingByToken(token string) (*Pending, error) {
	return s.scanPending(s.db.QueryRow(`SELECT `+pendingCols+` FROM pending WHERE token = ?`, token))
}

// TakePendingAttempt spends one verification attempt; false when none are
// left. Atomic, so concurrent guesses can't overspend.
func (s *Store) TakePendingAttempt(address, fp string, max int) (bool, error) {
	res, err := s.db.Exec(`UPDATE pending SET attempts = attempts + 1 WHERE address = ? AND fp = ? AND attempts < ?`, address, fp, max)
	if err != nil {
		return false, err
	}
	n, err := res.RowsAffected()
	return n == 1, err
}

// CompleteVerification binds the address to the pending key, creating or
// refreshing the account, and drops every pending row for the address.
func (s *Store) CompleteVerification(p *Pending) error {
	tx, err := s.db.Begin()
	if err != nil {
		return err
	}
	defer tx.Rollback()
	if _, err := tx.Exec(`INSERT INTO accounts (fp, auth_key, key_blob, created) VALUES (?, ?, ?, ?)
		ON CONFLICT (fp) DO UPDATE SET key_blob = excluded.key_blob, revoked = 0`, p.Fp, p.AuthKey, p.KeyBlob, now()); err != nil {
		return err
	}
	if _, err := tx.Exec(`INSERT INTO addresses (address, fp, verified) VALUES (?, ?, ?)
		ON CONFLICT (address) DO UPDATE SET fp = excluded.fp, verified = excluded.verified`, p.Address, p.Fp, now()); err != nil {
		return err
	}
	if _, err := tx.Exec(`DELETE FROM pending WHERE address = ?`, p.Address); err != nil {
		return err
	}
	if _, err := tx.Exec(`DELETE FROM suppressed WHERE address = ?`, p.Address); err != nil {
		return err
	}
	return tx.Commit()
}

// ---- suppression ----

func (s *Store) Suppressed(address string) (bool, error) {
	var x int
	err := s.db.QueryRow(`SELECT 1 FROM suppressed WHERE address = ?`, address).Scan(&x)
	if errors.Is(err, sql.ErrNoRows) {
		return false, nil
	}
	return err == nil, err
}

func (s *Store) Suppress(address string) error {
	_, err := s.db.Exec(`INSERT OR IGNORE INTO suppressed (address, at) VALUES (?, ?)`, address, now())
	return err
}

func (s *Store) PutUnsubToken(token, address string) error {
	_, err := s.db.Exec(`INSERT INTO unsub_tokens (token, address, at) VALUES (?, ?, ?)`, token, address, now())
	return err
}

func (s *Store) UnsubToken(token string) (string, error) {
	var a string
	err := s.db.QueryRow(`SELECT address FROM unsub_tokens WHERE token = ?`, token).Scan(&a)
	if errors.Is(err, sql.ErrNoRows) {
		return "", ErrNotFound
	}
	return a, err
}

// ---- allow / block / suspend ----

func (s *Store) Allow(fp, address string) error {
	_, err := s.db.Exec(`INSERT OR IGNORE INTO allow (fp, address) VALUES (?, ?)`, fp, address)
	return err
}

func (s *Store) Unallow(fp, address string) error {
	_, err := s.db.Exec(`DELETE FROM allow WHERE fp = ? AND address = ?`, fp, address)
	return err
}

func (s *Store) Allows(fp, address string) (bool, error) {
	var x int
	err := s.db.QueryRow(`SELECT 1 FROM allow WHERE fp = ? AND address = ?`, fp, address).Scan(&x)
	if errors.Is(err, sql.ErrNoRows) {
		return false, nil
	}
	return err == nil, err
}

func (s *Store) Block(fp, address string) error {
	_, err := s.db.Exec(`INSERT OR IGNORE INTO block (fp, address, at) VALUES (?, ?, ?)`, fp, address, now())
	return err
}

func (s *Store) Unblock(fp, address string) error {
	_, err := s.db.Exec(`DELETE FROM block WHERE fp = ? AND address = ?`, fp, address)
	return err
}

func (s *Store) Blocks(fp, address string) (bool, error) {
	var x int
	err := s.db.QueryRow(`SELECT 1 FROM block WHERE fp = ? AND address = ?`, fp, address).Scan(&x)
	if errors.Is(err, sql.ErrNoRows) {
		return false, nil
	}
	return err == nil, err
}

// DistinctBlockers counts accounts that blocked address since `since`.
func (s *Store) DistinctBlockers(address string, since int64) (int, error) {
	var n int
	err := s.db.QueryRow(`SELECT COUNT(DISTINCT fp) FROM block WHERE address = ? AND at >= ?`, address, since).Scan(&n)
	return n, err
}

func (s *Store) Suspend(address string) error {
	_, err := s.db.Exec(`INSERT OR IGNORE INTO suspended (address, at) VALUES (?, ?)`, address, now())
	return err
}

func (s *Store) Unsuspend(address string) error {
	_, err := s.db.Exec(`DELETE FROM suspended WHERE address = ?`, address)
	return err
}

func (s *Store) Suspended(address string) (bool, error) {
	var x int
	err := s.db.QueryRow(`SELECT 1 FROM suspended WHERE address = ?`, address).Scan(&x)
	if errors.Is(err, sql.ErrNoRows) {
		return false, nil
	}
	return err == nil, err
}

// ---- held mail ----

type Held struct {
	ID, To, From string
	Size         int64
	Envelope     []byte
}

func (s *Store) QueueUsage(to string) (bytes int64, mails int, err error) {
	err = s.db.QueryRow(`SELECT COALESCE(SUM(size), 0), COUNT(*) FROM mail WHERE to_addr = ?`, to).Scan(&bytes, &mails)
	return
}

func (s *Store) QueueUsageFrom(to, from string) (bytes int64, mails int, err error) {
	err = s.db.QueryRow(`SELECT COALESCE(SUM(size), 0), COUNT(*) FROM mail WHERE to_addr = ? AND from_addr = ?`, to, from).Scan(&bytes, &mails)
	return
}

// Seen reports whether an envelope id was already accepted (replay).
func (s *Store) Seen(id string) (bool, error) {
	var x int
	err := s.db.QueryRow(`SELECT 1 FROM seen WHERE id = ?`, id).Scan(&x)
	if errors.Is(err, sql.ErrNoRows) {
		return false, nil
	}
	return err == nil, err
}

// MarkSeen records an envelope id. status is 'pending' for held mail and
// 'dropped' for mail the relay accepted but threw away.
func (s *Store) MarkSeen(id, signerFp, from, to, status string) error {
	_, err := s.db.Exec(`INSERT INTO seen (id, signer_fp, from_addr, to_addr, at, status) VALUES (?, ?, ?, ?, ?, ?)`,
		id, signerFp, from, to, now(), status)
	return err
}

func (s *Store) SeenRow(id string) (signerFp, from, to, status string, err error) {
	err = s.db.QueryRow(`SELECT signer_fp, from_addr, to_addr, status FROM seen WHERE id = ?`, id).Scan(&signerFp, &from, &to, &status)
	if errors.Is(err, sql.ErrNoRows) {
		err = ErrNotFound
	}
	return
}

func (s *Store) Hold(h Held, expires int64) error {
	_, err := s.db.Exec(`INSERT INTO mail (id, to_addr, from_addr, size, envelope, received, expires) VALUES (?, ?, ?, ?, ?, ?, ?)`,
		h.ID, h.To, h.From, h.Size, h.Envelope, now(), expires)
	return err
}

func (s *Store) HeldFor(addresses []string) ([]Held, error) {
	if len(addresses) == 0 {
		return nil, nil
	}
	q := `SELECT id, to_addr, from_addr, size, envelope FROM mail WHERE to_addr IN (?` + strings.Repeat(",?", len(addresses)-1) + `) ORDER BY received`
	args := make([]any, len(addresses))
	for i, a := range addresses {
		args[i] = a
	}
	rows, err := s.db.Query(q, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []Held
	for rows.Next() {
		var h Held
		if err := rows.Scan(&h.ID, &h.To, &h.From, &h.Size, &h.Envelope); err != nil {
			return nil, err
		}
		out = append(out, h)
	}
	return out, rows.Err()
}

// Ack deletes held mail addressed to one of addresses and marks it
// delivered. Ids for other addresses are ignored.
func (s *Store) Ack(ids, addresses []string) (int, error) {
	tx, err := s.db.Begin()
	if err != nil {
		return 0, err
	}
	defer tx.Rollback()
	owned := map[string]bool{}
	for _, a := range addresses {
		owned[a] = true
	}
	n := 0
	for _, id := range ids {
		var to string
		if err := tx.QueryRow(`SELECT to_addr FROM mail WHERE id = ?`, id).Scan(&to); err != nil {
			continue
		}
		if !owned[to] {
			continue
		}
		if _, err := tx.Exec(`DELETE FROM mail WHERE id = ?`, id); err != nil {
			return 0, err
		}
		if _, err := tx.Exec(`UPDATE seen SET status = 'delivered' WHERE id = ?`, id); err != nil {
			return 0, err
		}
		n++
	}
	return n, tx.Commit()
}

// ---- knocks ----

// Knock records an outstanding knock from → to. It returns false when one
// is already outstanding (newer than since).
func (s *Store) Knock(from, to string, since int64) (bool, error) {
	var at int64
	err := s.db.QueryRow(`SELECT at FROM knocks WHERE from_addr = ? AND to_addr = ?`, from, to).Scan(&at)
	if err == nil && at > since {
		return false, nil
	}
	if err != nil && !errors.Is(err, sql.ErrNoRows) {
		return false, err
	}
	_, err = s.db.Exec(`INSERT INTO knocks (from_addr, to_addr, at) VALUES (?, ?, ?)
		ON CONFLICT (from_addr, to_addr) DO UPDATE SET at = excluded.at`, from, to, now())
	return err == nil, err
}

// ClearKnock forgets an outstanding knock (the recipient accepted).
func (s *Store) ClearKnock(from, to string) error {
	_, err := s.db.Exec(`DELETE FROM knocks WHERE from_addr = ? AND to_addr = ?`, from, to)
	return err
}

// ---- invites ----

func (s *Store) InvitesTo(to string, since int64) (count int, last int64, err error) {
	err = s.db.QueryRow(`SELECT COUNT(*), COALESCE(MAX(at), 0) FROM invite_log WHERE to_addr = ?`, to).Scan(&count, &last)
	_ = since
	return
}

func (s *Store) QueueInvite(to, from string) error {
	var raw string
	err := s.db.QueryRow(`SELECT senders FROM invite_queue WHERE to_addr = ?`, to).Scan(&raw)
	var senders []string
	if err == nil {
		_ = json.Unmarshal([]byte(raw), &senders)
	} else if !errors.Is(err, sql.ErrNoRows) {
		return err
	}
	for _, x := range senders {
		if x == from {
			return nil
		}
	}
	senders = append(senders, from)
	b, _ := json.Marshal(senders)
	_, err = s.db.Exec(`INSERT INTO invite_queue (to_addr, senders, queued) VALUES (?, ?, ?)
		ON CONFLICT (to_addr) DO UPDATE SET senders = excluded.senders`, to, string(b), now())
	return err
}

type QueuedInvite struct {
	To      string
	Senders []string
	Queued  int64
}

func (s *Store) InviteQueue(limit int) ([]QueuedInvite, error) {
	rows, err := s.db.Query(`SELECT to_addr, senders, queued FROM invite_queue ORDER BY queued LIMIT ?`, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []QueuedInvite
	for rows.Next() {
		var q QueuedInvite
		var raw string
		if err := rows.Scan(&q.To, &raw, &q.Queued); err != nil {
			return nil, err
		}
		_ = json.Unmarshal([]byte(raw), &q.Senders)
		out = append(out, q)
	}
	return out, rows.Err()
}

func (s *Store) DropQueuedInvite(to string) error {
	_, err := s.db.Exec(`DELETE FROM invite_queue WHERE to_addr = ?`, to)
	return err
}

func (s *Store) DropQueuedInvitesBefore(t int64) error {
	_, err := s.db.Exec(`DELETE FROM invite_queue WHERE queued <= ?`, t)
	return err
}

func (s *Store) LogInvite(to, tag string, senders []string) error {
	tx, err := s.db.Begin()
	if err != nil {
		return err
	}
	defer tx.Rollback()
	if _, err := tx.Exec(`INSERT INTO invite_log (to_addr, at, tag) VALUES (?, ?, ?)`, to, now(), tag); err != nil {
		return err
	}
	for _, f := range senders {
		if _, err := tx.Exec(`INSERT INTO invite_senders (tag, from_addr) VALUES (?, ?)`, tag, f); err != nil {
			return err
		}
	}
	if _, err := tx.Exec(`DELETE FROM invite_queue WHERE to_addr = ?`, to); err != nil {
		return err
	}
	return tx.Commit()
}

func (s *Store) InviteTagAddress(tag string) (to string, senders []string, err error) {
	if err = s.db.QueryRow(`SELECT to_addr FROM invite_log WHERE tag = ?`, tag).Scan(&to); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			err = ErrNotFound
		}
		return
	}
	rows, err := s.db.Query(`SELECT from_addr FROM invite_senders WHERE tag = ?`, tag)
	if err != nil {
		return
	}
	defer rows.Close()
	for rows.Next() {
		var f string
		if err = rows.Scan(&f); err != nil {
			return
		}
		senders = append(senders, f)
	}
	err = rows.Err()
	return
}

func (s *Store) BanInviter(from string) error {
	_, err := s.db.Exec(`INSERT OR IGNORE INTO invite_banned (from_addr, at) VALUES (?, ?)`, from, now())
	return err
}

func (s *Store) InviterBanned(from string) (bool, error) {
	var x int
	err := s.db.QueryRow(`SELECT 1 FROM invite_banned WHERE from_addr = ?`, from).Scan(&x)
	if errors.Is(err, sql.ErrNoRows) {
		return false, nil
	}
	return err == nil, err
}

func (s *Store) LogMailEvent(tag, kind string) error {
	_, err := s.db.Exec(`INSERT INTO mail_events (tag, kind, at) VALUES (?, ?, ?)`, tag, kind, now())
	return err
}

// InviteRates returns invites sent and bounce/complaint counts since t.
func (s *Store) InviteRates(since int64) (sent, bounces, complaints int, err error) {
	if err = s.db.QueryRow(`SELECT COUNT(*) FROM invite_log WHERE at >= ?`, since).Scan(&sent); err != nil {
		return
	}
	err = s.db.QueryRow(`SELECT
		COALESCE(SUM(kind = 'bounce'), 0), COALESCE(SUM(kind = 'complaint'), 0)
		FROM mail_events e WHERE at >= ? AND EXISTS (SELECT 1 FROM invite_log l WHERE l.tag = e.tag)`, since).Scan(&bounces, &complaints)
	return
}
