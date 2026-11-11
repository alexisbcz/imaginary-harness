# Mail

Richelieu runs its own mail server: SMTP to receive and send, IMAP for mail apps, and an inbox in the web app.
It is written in TypeScript on Bun, with no other mail software. Everything it keeps lives in the same Supabase
Postgres as the rest of the app, and the agent reads and writes mail through Pi Durable.

- [What it does](#what-it-does)
- [Install on a VPS](#install-on-a-vps)
- [Set up from the command line only](#set-up-from-the-command-line-only)
- [Set up from the web only](#set-up-from-the-web-only)
- [DNS records](#dns-records)
- [Mail apps](#mail-apps)
- [The agent and the assistant](#the-agent-and-the-assistant)
- [How it works](#how-it-works)
- [Configuration](#configuration)
- [Limits](#limits)

## What it does

- **Receives mail** for your domains on port 25, with STARTTLS. Each message is checked with SPF, DKIM and DMARC.
  The results go in an `Authentication-Results` header and show in the inbox as "Verified sender". Mail whose
  domain asks for `p=reject` and fails is refused. Mail that fails softer checks goes to Junk.
- **Sends mail** signed with DKIM (RSA 2048). Recipients on this server get it at once. Other recipients go through a
  queue in Postgres, retried with backoff for five days, then bounced back to the sender with a delivery report.
  The Sent copy shows each recipient's status. The queue uses opportunistic TLS, and requires valid TLS when the
  recipient's domain publishes an MTA-STS policy. It can also send through a relay (`MAIL_RELAY`).
- **Serves IMAP** (IMAP4rev1, with IDLE, UIDPLUS, MOVE, SPECIAL-USE, LITERAL+…) on 143 (STARTTLS) and 993 (TLS),
  and **SMTP submission** on 587 (STARTTLS) and 465 (TLS). Apple Mail, Thunderbird, Outlook and phones connect
  with app passwords, never the Richelieu password.
- **An inbox in the web app**: folders, search, a reader that renders HTML in a sandbox (no scripts, remote images
  only on request), replies, forwards, drafts, attachments, flags. Changes arrive live through Supabase Realtime.
- **Settings in the web app**: addresses, your own domains with their DNS records checked live, app passwords, an
  Apple configuration profile, and the server's state.
- **Mail for the agent**: in a project chat, the agent can list, search, read, draft and send your mail. A mail
  assistant reads each new message, summarizes and files it, and can draft a reply into Drafts.
- **TLS certificates** from Let's Encrypt over ACME (HTTP-01), renewed a month before they expire. The same
  certificate covers the mail host, the web app and the domains' `mta-sts.` and `autoconfig.` names.
- **Client autoconfiguration**: Thunderbird autoconfig, Outlook autodiscover, RFC 6186 SRV records, MTA-STS and
  TLS-RPT.

## Install on a VPS

You need a VPS whose provider allows outgoing port 25 (many block it until asked; or use `--relay`), a domain,
and access to its DNS.

```sh
git clone https://github.com/alexisbcz/richelieu.ai.git && cd richelieu.ai
sudo bash deploy/vps/install.sh --domain example.com --email you@example.com --anthropic-key sk-ant-...
```

The script installs Docker and Bun, runs Supabase from `compose.yml` with fresh secrets, creates the forge
organization, sets up mail for `example.com`, creates your account and `you@example.com`'s address, opens the
firewall, and installs a systemd service. That service runs everything in one process: the web app on 443
(Supabase behind it on the same origin), the agent, SMTP and IMAP. At the end it prints the DNS records to
publish. Run it again to update: it keeps secrets and data.

Then:

1. Publish the DNS records (below), and set the server's reverse DNS (PTR) to the mail hostname in your
   provider's panel.
2. The certificate is ordered as soon as the names resolve; until then the servers use a self-signed stand-in.
3. `sudo -u richelieu -H bash -c 'cd /opt/richelieu/app && ~/.bun/bin/bun run mail doctor'` checks DNS, reverse
   DNS, port 25, the certificate and the listeners, and says what to fix.

## Set up from the command line only

`bun run mail` does everything the web app does, and more:

```sh
bun run mail setup                         # asks for the domain, hostname, IP and TLS; writes .env; prints DNS
bun run mail doctor [domain]               # checks everything; exit code 1 when something needs fixing
bun run mail dns example.com --zone        # the records as a zone file, for providers that import one
bun run mail user add ada@example.org --name "Ada" --address ada@example.com
bun run mail account add hello@example.com --user ada@example.org
bun run mail account catch-all hello@example.com on
bun run mail password ada@example.com --name "iPhone"   # an app password, shown once
bun run mail domain add other.org --owner ada@example.org
bun run mail dkim rotate example.com
bun run mail cert issue
bun run mail queue [retry]
bun run mail send --from ada@example.com --to you@gmail.com
bun run mail serve                         # SMTP, IMAP and the queue without the web app
```

`setup` takes flags for scripts: `--domain --hostname --ip --tls acme|files|self-signed --acme-email --relay
--web-host --user --yes`.

## Set up from the web only

Once the server runs, people do the rest in the browser:

1. Sign up, open **Mail**, and take an address on the server's domain, or open **Mail settings** and add a domain
   of your own.
2. Settings lists the domain's records with copy buttons and a zone file. **Check DNS** looks them up and marks
   each one. The domain sends once the required ones (MX, SPF, DKIM, DMARC) check out.
3. Under **Mail apps**, create an app password and download the Apple profile, or copy the IMAP and SMTP settings.
4. Under **Addresses**, choose what the agent does with new mail: nothing, a summary, or a summary and a draft.

## DNS records

For a domain `example.com` served by `mail.example.com` at `203.0.113.7` (`bun run mail dns` prints yours, with
the DKIM key):

| Type  | Name                               | Value                                                                        | Needed      |
| ----- | ---------------------------------- | ---------------------------------------------------------------------------- | ----------- |
| A     | `mail.example.com`                 | `203.0.113.7`                                                                | yes         |
| PTR   | `7.113.0.203.in-addr.arpa`         | `mail.example.com.` (set at your VPS provider)                               | yes         |
| A     | `app.example.com`                  | `203.0.113.7`                                                                | yes         |
| MX    | `example.com`                      | `10 mail.example.com.`                                                       | yes         |
| TXT   | `example.com`                      | `v=spf1 mx ip4:203.0.113.7 -all`                                             | yes         |
| TXT   | `r20261111._domainkey.example.com` | `v=DKIM1; k=rsa; p=MIIBIjANBgkq…`                                            | yes         |
| TXT   | `_dmarc.example.com`               | `v=DMARC1; p=quarantine; adkim=s; aspf=r; rua=mailto:postmaster@example.com` | yes         |
| CNAME | `mta-sts.example.com`              | `mail.example.com.`                                                          | recommended |
| TXT   | `_mta-sts.example.com`             | `v=STSv1; id=20261111`                                                       | recommended |
| TXT   | `_smtp._tls.example.com`           | `v=TLSRPTv1; rua=mailto:postmaster@example.com`                              | recommended |
| CNAME | `autoconfig.example.com`           | `mail.example.com.`                                                          | recommended |
| SRV   | `_imaps._tcp.example.com`          | `0 1 993 mail.example.com.`                                                  | recommended |
| SRV   | `_submissions._tcp.example.com`    | `0 1 465 mail.example.com.`                                                  | recommended |

Start DMARC at `p=quarantine`; move to `p=reject` once reports show only your own mail passing.

## Mail apps

| Setting  | Value                                                       |
| -------- | ----------------------------------------------------------- |
| Username | the full address                                            |
| Password | an app password (Mail settings, or `bun run mail password`) |
| IMAP     | `mail.example.com`, port 993, SSL/TLS                       |
| SMTP     | `mail.example.com`, port 465 SSL/TLS, or 587 STARTTLS       |

Thunderbird and most Android apps find these settings from the address alone (autoconfig and SRV records). On an
iPhone or a Mac, the Apple profile from Mail settings sets the account up in one step. Mail apps file their own
copy of what they send in Sent, as they expect to. Plus addressing works: `ada+news@example.com` lands at `ada@`.

## The agent and the assistant

The mail extension (`src/mail/agent.ts`) gives Pi Durable six tools: `list_mail`, `search_mail`, `read_mail`,
`draft_mail`, `send_mail` and `label_mail`. Each conversation reaches only its user's mail.

- In a project chat, ask "what did Charles send me this week?" or "draft a reply saying Thursday works". The agent
  sends only when asked, and chat mode blocks `send_mail`.
- The **mail assistant** (`src/mail/assistant.ts`) gives each mail thread its own Pi Durable conversation. Every
  new inbox message is submitted with the message id as the request id, so a crash resumes the same submission
  instead of reading the mail twice. It labels the message (`summary`, `category`) and, when the address asks for
  drafts, writes a reply into Drafts. Its conversations get only the mail tools, without `send_mail`: a stranger's
  email can at worst produce a draft, which you review.
- Sending is replay-safe. Its idempotency key is the tool call's (`pi:<conversation>:<call>`), so a call that
  reruns after a crash finds its queued message instead of sending it twice. The web app's sends carry a key
  too, so a double click sends once.

## How it works

```
                  ┌──────────────────────── one Bun process (systemd) ────────────────────────┐
internet ──25──▶  │ SMTP (mx)  ──▶ SPF · DKIM · DMARC ──▶ MailStore ──▶ Postgres (Supabase)    │
clients ─587/465▶ │ SMTP (submission) ─▶ DKIM sign ─▶ local delivery │ mail.outbound queue ─▶ │──25──▶ other servers
clients ─143/993▶ │ IMAP ◀──── MailStore ◀── modseq, UIDs                                      │
browser ──443──▶  │ web app · mail API · /auth /rest /realtime (proxied to Supabase)            │
                  │ Pi Durable agent ── mail tools ── mail assistant                           │
                  └────────────────────────────────────────────────────────────────────────────┘
```

| Where                               | What                                                                           |
| ----------------------------------- | ------------------------------------------------------------------------------ |
| `src/mail/mime`                     | parsing (MIME tree with byte offsets), encodings, addresses, building messages |
| `src/mail/auth`                     | SPF (RFC 7208), DKIM sign and verify (RFC 6376, 8463), DMARC (RFC 7489), DNS   |
| `src/mail/smtp`                     | the server (MX and submission), the delivery client, MTA-STS                   |
| `src/mail/imap`                     | the IMAP server: commands, FETCH (ENVELOPE, BODYSTRUCTURE, sections), SEARCH   |
| `src/mail/store.ts`                 | domains, accounts, folders, messages, app passwords                            |
| `src/mail/service.ts`               | what happens to mail coming in and going out                                   |
| `src/mail/queue.ts`                 | the outbound queue: retries, delivery status, bounces                          |
| `src/mail/tls`                      | ACME client, CSR and self-signed certificates (DER by hand), renewal           |
| `src/mail/dns-records.ts`           | the records a domain needs, and their live check                               |
| `src/mail/agent.ts`, `assistant.ts` | the Pi Durable tools and the assistant                                         |
| `src/mail/cli.ts`                   | `bun run mail`                                                                 |
| `src/server/mail-api.ts`            | the web app's API, MTA-STS, autoconfig, autodiscover, ACME challenges          |
| `supabase/migrations/…_mail.sql`    | the tables, RLS, and the functions that keep UIDs and modseqs right            |

The tables the web app reads (`mail_domains`, `mail_accounts`, `mail_folders`, `mail_messages`,
`mail_app_passwords`) are in `public` under RLS. The browser changes flags and folders only through
`mail_set_flags`, `mail_move` and `mail_create_folder`, which give moved messages new UIDs. DKIM private keys,
raw messages, the queue, certificates and ACME state are in the `mail` schema, out of the API's reach.

Each IMAP session numbers its folder as IMAP requires. It catches up with changes made elsewhere (deliveries, the
web app, other clients) by UID and modification sequence. Expunges are reported only where the protocol allows
them. A session in IDLE hears about new mail at once from the same process, and within ten seconds from another.

## Configuration

Set in `.env`; `bun run mail setup` writes the main ones.

| Variable                                  | Default (production / local)                          | What                                                   |
| ----------------------------------------- | ----------------------------------------------------- | ------------------------------------------------------ |
| `MAIL_ENABLED`                            | off                                                   | run SMTP, IMAP and the queue in the app's process      |
| `MAIL_HOSTNAME`                           | machine name / `localhost`                            | the mail host: MX target, banner, certificate          |
| `MAIL_DOMAIN`                             |                                                       | the server's domain, open to every user                |
| `MAIL_PUBLIC_IP`                          | the hostname's A/AAAA records                         | for SPF and the reverse DNS check                      |
| `MAIL_TLS`                                | `acme` / `self-signed`                                | or `files` (`MAIL_TLS_CERT`, `MAIL_TLS_KEY`), or `off` |
| `ACME_EMAIL`, `ACME_DIRECTORY`            | Let's Encrypt                                         | the staging directory is useful for trying things out  |
| `MAIL_RELAY`                              | direct delivery                                       | `smtp://user:pass@host:587` or `smtps://…:465`         |
| `MAIL_SMTP_PORT` … `MAIL_IMAPS_PORT`      | 25, 587, 465, 143, 993 / 2525, 2587, 2465, 2143, 2993 | listeners                                              |
| `MAIL_HTTP_PORT`                          | 0                                                     | plain HTTP for ACME when the web server is not on 80   |
| `MAIL_MAX_SIZE`                           | 25 MB                                                 | the largest message accepted                           |
| `MAIL_ENFORCE_DMARC`                      | true                                                  | refuse mail failing `p=reject` (else file it in Junk)  |
| `WEB_HTTPS`, `HTTPS_PORT`, `HTTP_PORT`    | off, 443, 80                                          | serve the web app over HTTPS with the same certificate |
| `SUPABASE_PROXY`, `SUPABASE_INTERNAL_URL` | off, `http://127.0.0.1:54321`                         | serve Supabase on the app's origin                     |

Locally, `MAIL_ENABLED=true bun dev` runs the servers on high ports with a self-signed certificate. Mail to the
local domains can be sent to port 2525, and any IMAP client can sign in on 2143.

## Limits

- One process holds the mail servers. The queue can be shared (it claims rows with `FOR UPDATE SKIP LOCKED`), but
  IDLE notifications between processes rely on a ten-second poll.
- The organizational domain for DMARC alignment comes from a short list of multi-label suffixes, not the full
  Public Suffix List. It errs towards strict alignment.
- No spam scoring beyond SPF, DKIM and DMARC. No DANE, no ARC sealing, no Sieve filters, no quotas.
- DMARC and TLS-RPT reports arrive at `postmaster@` as ordinary mail; nothing parses them yet.
- On Vercel there is no port 25: the web app and the agent work there, the mail server needs a machine.
