package store

import (
	"database/sql"
	"errors"
)

// Share is one public share link's row. Blob is nil once removed.
type Share struct {
	ID         string
	Owner      string
	Fp         string
	Size       int64
	Blob       []byte
	Created    int64
	Expires    int64 // 0 = never
	Removed    int64 // 0 = live
	RemovedWhy string
	// The link preview the sharer chose to publish in the clear (may be empty).
	CardTitle string
	CardDesc  string
}

func (s *Store) PutShare(sh *Share) error {
	_, err := s.db.Exec(`INSERT INTO shares (id, owner, fp, size, blob, created, expires, card_title, card_desc)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		sh.ID, sh.Owner, sh.Fp, sh.Size, sh.Blob, sh.Created, sh.Expires, sh.CardTitle, sh.CardDesc)
	return err
}

// GetShare returns the row with its blob. An expired share not yet swept
// reads as not found.
func (s *Store) GetShare(id string) (*Share, error) {
	var sh Share
	err := s.db.QueryRow(`SELECT id, owner, fp, size, blob, created, expires, removed, removed_why, card_title, card_desc
		FROM shares WHERE id = ?`, id).
		Scan(&sh.ID, &sh.Owner, &sh.Fp, &sh.Size, &sh.Blob, &sh.Created, &sh.Expires, &sh.Removed, &sh.RemovedWhy,
			&sh.CardTitle, &sh.CardDesc)
	if errors.Is(err, sql.ErrNoRows) || err == nil && sh.Expires > 0 && sh.Expires <= now() {
		return nil, ErrNotFound
	}
	if err != nil {
		return nil, err
	}
	return &sh, nil
}

// RemoveShare drops the blob and keeps a tombstone. It reports whether a
// live share was removed.
func (s *Store) RemoveShare(id, why string) (bool, error) {
	res, err := s.db.Exec(`UPDATE shares SET blob = NULL, card_title = '', card_desc = '', removed = ?, removed_why = ?
		WHERE id = ? AND removed = 0`, now(), why, id)
	if err != nil {
		return false, err
	}
	n, err := res.RowsAffected()
	return n == 1, err
}

// OwnerShares lists an address's live shares, newest first, without blobs.
func (s *Store) OwnerShares(owner string) ([]Share, error) {
	rows, err := s.db.Query(`SELECT id, size, created, expires FROM shares
		WHERE owner = ? AND removed = 0 AND (expires = 0 OR expires > ?) ORDER BY created DESC`, owner, now())
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []Share
	for rows.Next() {
		sh := Share{Owner: owner}
		if err := rows.Scan(&sh.ID, &sh.Size, &sh.Created, &sh.Expires); err != nil {
			return nil, err
		}
		out = append(out, sh)
	}
	return out, rows.Err()
}

// OwnerShareUsage is how many live shares an address holds and their bytes.
func (s *Store) OwnerShareUsage(owner string) (count int, bytes int64, err error) {
	err = s.db.QueryRow(`SELECT COUNT(*), COALESCE(SUM(size), 0) FROM shares WHERE owner = ? AND removed = 0 AND (expires = 0 OR expires > ?)`,
		owner, now()).Scan(&count, &bytes)
	return count, bytes, err
}

type ShareReport struct {
	ID      int64
	Share   string
	Reason  string
	Detail  string
	Contact string
	Key     string
	IP      string
	At      int64
}

func (s *Store) AddShareReport(r *ShareReport) error {
	_, err := s.db.Exec(`INSERT INTO share_reports (share, reason, detail, contact, key, ip, at) VALUES (?, ?, ?, ?, ?, ?, ?)`,
		r.Share, r.Reason, r.Detail, r.Contact, r.Key, r.IP, now())
	return err
}

// OpenShareReports lists reports not yet marked handled, oldest first.
func (s *Store) OpenShareReports() ([]ShareReport, error) {
	rows, err := s.db.Query(`SELECT id, share, reason, detail, contact, key, ip, at FROM share_reports WHERE handled = 0 ORDER BY at`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []ShareReport
	for rows.Next() {
		var r ShareReport
		if err := rows.Scan(&r.ID, &r.Share, &r.Reason, &r.Detail, &r.Contact, &r.Key, &r.IP, &r.At); err != nil {
			return nil, err
		}
		out = append(out, r)
	}
	return out, rows.Err()
}

// HandleShareReports marks every report on a share handled.
func (s *Store) HandleShareReports(share string) error {
	_, err := s.db.Exec(`UPDATE share_reports SET handled = 1 WHERE share = ?`, share)
	return err
}
