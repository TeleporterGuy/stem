// Command stem-relay runs a Stem relay. See relay/README.md.
package main

import (
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"crypto/tls"
	"errors"
	"flag"
	"fmt"
	"log"
	"net/http"
	"os"
	"os/signal"
	"path/filepath"
	"sort"
	"strings"
	"syscall"
	"time"

	"golang.org/x/crypto/acme/autocert"

	"github.com/join3r/stem/relay/internal/apns"
	"github.com/join3r/stem/relay/internal/authority"
	"github.com/join3r/stem/relay/internal/config"
	"github.com/join3r/stem/relay/internal/mailer"
	"github.com/join3r/stem/relay/internal/proto"
	"github.com/join3r/stem/relay/internal/server"
	"github.com/join3r/stem/relay/internal/store"
)

const usage = `stem-relay — a Stem relay

  stem-relay init [-config relay.toml]        write a starter config
  stem-relay serve [-config relay.toml]       run the relay
  stem-relay dns [-config relay.toml]         print the _stem DNS record (private relays)
  stem-relay keys list|add|activate|remove [kid]   manage signing keys
  stem-relay suspend <address>                stop an address sending, looking up and sharing
  stem-relay unsuspend <address>              lift a suspension
  stem-relay share-reports                    list open reports on share links
  stem-relay share-takedown <id> <reason>     remove a share link and close its reports
  stem-relay version
`

func main() {
	log.SetFlags(log.LstdFlags)
	if len(os.Args) < 2 {
		fmt.Print(usage)
		os.Exit(2)
	}
	cmd, args := os.Args[1], os.Args[2:]
	fs := flag.NewFlagSet(cmd, flag.ExitOnError)
	cfgPath := fs.String("config", "relay.toml", "config file")
	_ = fs.Parse(args)
	var err error
	switch cmd {
	case "init":
		err = initConfig(*cfgPath)
	case "serve":
		err = serve(*cfgPath)
	case "dns":
		err = withServer(*cfgPath, printDNS)
	case "keys":
		err = keys(*cfgPath, fs.Args())
	case "unsuspend":
		err = withStore(*cfgPath, func(_ *config.Config, st *store.Store) error {
			if fs.NArg() != 1 {
				return errors.New("usage: stem-relay unsuspend <address>")
			}
			return st.Unsuspend(proto.NormalizeAddress(fs.Arg(0)))
		})
	case "suspend":
		err = withStore(*cfgPath, func(_ *config.Config, st *store.Store) error {
			if fs.NArg() != 1 {
				return errors.New("usage: stem-relay suspend <address>")
			}
			return st.Suspend(proto.NormalizeAddress(fs.Arg(0)))
		})
	case "share-reports":
		err = withStore(*cfgPath, shareReports)
	case "share-takedown":
		err = withStore(*cfgPath, func(_ *config.Config, st *store.Store) error {
			if fs.NArg() != 2 {
				return errors.New("usage: stem-relay share-takedown <id> <reason>")
			}
			id := fs.Arg(0)
			sh, err := st.GetShare(id)
			if err != nil {
				return fmt.Errorf("share %s: %w", id, err)
			}
			if _, err := st.RemoveShare(id, "takedown: "+fs.Arg(1)); err != nil {
				return err
			}
			if err := st.HandleShareReports(id); err != nil {
				return err
			}
			fmt.Printf("removed %s (shared by %s); suspend them with: stem-relay suspend %s\n", id, sh.Owner, sh.Owner)
			return nil
		})
	case "version":
		fmt.Println(server.Version)
	default:
		fmt.Print(usage)
		os.Exit(2)
	}
	if err != nil {
		log.Fatal(err)
	}
}

func initConfig(path string) error {
	c := config.Defaults()
	c.URL = "https://relay.example.com"
	c.Domains = []string{"example.com"}
	c.GlobalURL = "https://relay.stem.example"
	c.GlobalKeys = []string{"k1:<global relay key>"}
	c.Mail.VerifyFrom = "Stem <codes@relay.example.com>"
	c.Mail.InviteFrom = "Stem <invites@invites.relay.example.com>"
	if err := c.Write(path); err != nil {
		return err
	}
	fmt.Printf("Wrote %s. Edit url, domains (or global = true), mail settings, then:\n  stem-relay serve -config %s\n", path, path)
	return nil
}

func withStore(path string, fn func(*config.Config, *store.Store) error) error {
	cfg, err := config.Load(path)
	if err != nil {
		return err
	}
	if err := os.MkdirAll(cfg.DataDir, 0o700); err != nil {
		return err
	}
	st, err := store.Open(filepath.Join(cfg.DataDir, "relay.db"))
	if err != nil {
		return err
	}
	defer st.Close()
	return fn(cfg, st)
}

func newServer(cfg *config.Config, st *store.Store) (*server.Server, error) {
	gk := map[string]ed25519.PublicKey{}
	if !cfg.Global {
		var err error
		if gk, err = config.ParseKeys(cfg.GlobalKeys); err != nil {
			return nil, err
		}
	}
	res := authority.NewResolver(cfg.GlobalURL, gk)
	return server.New(cfg, st, mailer.New(cfg.Mail), res)
}

func withServer(path string, fn func(*config.Config, *server.Server) error) error {
	return withStore(path, func(cfg *config.Config, st *store.Store) error {
		s, err := newServer(cfg, st)
		if err != nil {
			return err
		}
		return fn(cfg, s)
	})
}

func printDNS(cfg *config.Config, s *server.Server) error {
	if cfg.Global {
		fmt.Println("The global relay needs no DNS record. Stems ship with its URL and these keys:")
	}
	pubs := s.PublicKeys()
	kids := make([]string, 0, len(pubs))
	for k := range pubs {
		kids = append(kids, k)
	}
	sort.Strings(kids)
	parts := []string{"v=stem1", "relay=" + cfg.URL}
	for _, k := range kids {
		parts = append(parts, "k="+k+":"+proto.B64(pubs[k]))
	}
	if cfg.Closed {
		parts = append(parts, "access=closed")
	}
	rec := strings.Join(parts, "; ")
	for _, d := range cfg.Domains {
		fmt.Printf("_stem.%s. TXT \"%s\"\n", d, rec)
	}
	if cfg.Global {
		fmt.Println(rec)
	}
	return nil
}

func keys(path string, args []string) error {
	return withStore(path, func(cfg *config.Config, st *store.Store) error {
		if len(args) == 0 {
			args = []string{"list"}
		}
		switch args[0] {
		case "list":
			ks, err := st.RelayKeys()
			if err != nil {
				return err
			}
			for _, k := range ks {
				mark := ""
				if k.Active {
					mark = " (active)"
				}
				fmt.Printf("%s %s%s\n", k.Kid, proto.B64(ed25519.PrivateKey(k.Priv).Public().(ed25519.PublicKey)), mark)
			}
			return nil
		case "add":
			if len(args) != 2 {
				return errors.New("usage: keys add <kid>")
			}
			_, priv, err := ed25519.GenerateKey(rand.Reader)
			if err != nil {
				return err
			}
			if err := st.AddRelayKey(args[1], priv, false); err != nil {
				return err
			}
			fmt.Println("Added (inactive). Publish it (stem-relay dns), wait for DNS to spread, then: keys activate", args[1])
			return nil
		case "activate":
			if len(args) != 2 {
				return errors.New("usage: keys activate <kid>")
			}
			return st.ActivateRelayKey(args[1])
		case "remove":
			if len(args) != 2 {
				return errors.New("usage: keys remove <kid>")
			}
			fmt.Println("Removed. Certificates it signed stop verifying; wait at least 24 h after activating its successor.")
			return st.RemoveRelayKey(args[1])
		}
		return errors.New("usage: keys list|add|activate|remove [kid]")
	})
}

func serve(path string) error {
	return withServer(path, func(cfg *config.Config, s *server.Server) error {
		ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
		defer stop()
		if p := cfg.Push; p.Enabled {
			c, err := apns.New(p.KeyPath, p.KeyID, p.TeamID, p.BundleID)
			if err != nil {
				return err
			}
			s.Pusher = c
			log.Printf("push gateway on for %s", p.BundleID)
		}
		go s.Run(ctx)

		// ReadTimeout bounds slow uploads; no WriteTimeout because /v1/stream
		// is long-lived.
		srv := &http.Server{Handler: s.Handler(), ReadHeaderTimeout: 10 * time.Second,
			ReadTimeout: 2 * time.Minute, IdleTimeout: 2 * time.Minute, MaxHeaderBytes: 64 << 10}
		errc := make(chan error, 1)
		if cfg.TLS {
			m := &autocert.Manager{
				Prompt:     autocert.AcceptTOS,
				HostPolicy: autocert.HostWhitelist(cfg.TLSHost),
				Cache:      autocert.DirCache(filepath.Join(cfg.DataDir, "certs")),
			}
			srv.Addr = ":443"
			srv.TLSConfig = &tls.Config{GetCertificate: m.GetCertificate, MinVersion: tls.VersionTLS12}
			go func() { errc <- http.ListenAndServe(":80", m.HTTPHandler(nil)) }()
			go func() { errc <- srv.ListenAndServeTLS("", "") }()
			log.Printf("stem-relay %s serving %s on :443", server.Version, cfg.URL)
		} else {
			srv.Addr = cfg.Listen
			go func() { errc <- srv.ListenAndServe() }()
			log.Printf("stem-relay %s serving %s on %s", server.Version, cfg.URL, cfg.Listen)
		}
		select {
		case err := <-errc:
			return err
		case <-ctx.Done():
			sctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
			defer cancel()
			return srv.Shutdown(sctx)
		}
	})
}

func shareReports(cfg *config.Config, st *store.Store) error {
	reps, err := st.OpenShareReports()
	if err != nil {
		return err
	}
	if len(reps) == 0 {
		fmt.Println("no open reports")
		return nil
	}
	for _, r := range reps {
		owner := "(gone)"
		if sh, err := st.GetShare(r.Share); err == nil {
			owner = sh.Owner
		}
		link := cfg.Share.ViewerURL + "/s/" + r.Share
		if r.Key != "" {
			link += "#" + r.Key
		}
		fmt.Printf("#%d  %s  %s  by %s\n    %s\n", r.ID, time.UnixMilli(r.At).UTC().Format(time.RFC3339), r.Reason, owner, link)
		if r.Detail != "" {
			fmt.Printf("    %s\n", strings.ReplaceAll(r.Detail, "\n", "\n    "))
		}
		if r.Contact != "" {
			fmt.Printf("    contact: %s\n", r.Contact)
		}
	}
	return nil
}
