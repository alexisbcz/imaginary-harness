#!/usr/bin/env bash
# Installs Richelieu on a fresh Debian 12+ or Ubuntu 22.04+ VPS: Supabase in Docker, the app with HTTPS, the agent,
# and a mail server for your domain, as one systemd service. Safe to run again: it keeps existing secrets and data,
# pulls the code and restarts.
#
#   sudo bash deploy/vps/install.sh --domain example.com --email you@example.com --anthropic-key sk-ant-...
#
# Options (asked for when missing and run from a terminal):
#   --domain example.com        the domain to receive mail for
#   --app-host app.example.com  where the web app is served (default: app.<domain>)
#   --mail-host mail.example.com the mail server's name, its MX target (default: mail.<domain>)
#   --email you@example.com     for Let's Encrypt, and your first Richelieu account
#   --anthropic-key sk-ant-...  for the agent
#   --relay smtp://u:p@host:587 send through a smarthost (when the provider blocks port 25)
#   --repo URL --branch NAME    where to get the code (default: this repository, main)
#   --no-firewall               leave ufw alone

set -euo pipefail

REPO="https://github.com/alexisbcz/richelieu.ai.git"
BRANCH="main"
DOMAIN="" APP_HOST="" MAIL_HOST="" EMAIL="" ANTHROPIC_KEY="" RELAY="" FIREWALL=1
ROOT=/opt/richelieu
APP=$ROOT/app
BUN=$ROOT/.bun/bin/bun

while [ $# -gt 0 ]; do
  case "$1" in
    --domain) DOMAIN="$2"; shift 2 ;;
    --app-host) APP_HOST="$2"; shift 2 ;;
    --mail-host) MAIL_HOST="$2"; shift 2 ;;
    --email) EMAIL="$2"; shift 2 ;;
    --anthropic-key) ANTHROPIC_KEY="$2"; shift 2 ;;
    --relay) RELAY="$2"; shift 2 ;;
    --repo) REPO="$2"; shift 2 ;;
    --branch) BRANCH="$2"; shift 2 ;;
    --no-firewall) FIREWALL=0; shift ;;
    -h|--help) sed -n '2,21p' "$0"; exit 0 ;;
    *) echo "Unknown option $1" >&2; exit 1 ;;
  esac
done

bold() { printf '\033[1m%s\033[0m\n' "$*"; }
step() { printf '\n\033[1;34m==>\033[0m \033[1m%s\033[0m\n' "$*"; }
ask() { # ask VAR "Question" [default]
  local var=$1 question=$2 default=${3:-}
  if [ -z "${!var}" ]; then
    if [ -t 0 ]; then
      read -r -p "$question${default:+ [$default]}: " answer
      printf -v "$var" '%s' "${answer:-$default}"
    else
      printf -v "$var" '%s' "$default"
    fi
  fi
  if [ -z "${!var}" ]; then echo "Missing: $question (pass it as an option)" >&2; exit 1; fi
}
as_app() { sudo -u richelieu -H bash -c "cd $APP && $*"; }

[ "$(id -u)" -eq 0 ] || { echo "Run as root: sudo bash $0" >&2; exit 1; }

ask DOMAIN "Domain to receive mail for (example.com)"
ask APP_HOST "Web app hostname" "app.$DOMAIN"
ask MAIL_HOST "Mail server hostname" "mail.$DOMAIN"
ask EMAIL "Your email (Let's Encrypt notices, and your Richelieu account)"
[ -f "$APP/.env" ] && grep -q '^ANTHROPIC_API_KEY=.' "$APP/.env" || ask ANTHROPIC_KEY "Anthropic API key, for the agent"

PUBLIC_IP=$(ip -4 route get 1.1.1.1 2>/dev/null | awk '{for (i=1;i<=NF;i++) if ($i=="src") print $(i+1)}' | head -1)
PUBLIC_IP6=$(ip -6 route get 2606:4700:4700::1111 2>/dev/null | awk '{for (i=1;i<=NF;i++) if ($i=="src") print $(i+1)}' | head -1 || true)
case "$PUBLIC_IP" in 10.*|192.168.*|172.1[6-9].*|172.2?.*|172.3[01].*)
  echo "This machine's address ($PUBLIC_IP) is private: set MAIL_PUBLIC_IP in $APP/.env to the public one after the install." >&2 ;;
esac

step "Packages"
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq ca-certificates curl git unzip ufw iproute2 >/dev/null
if ! command -v docker >/dev/null; then apt-get install -y -qq docker.io >/dev/null; fi
if ! docker compose version >/dev/null 2>&1; then
  apt-get install -y -qq docker-compose-v2 >/dev/null 2>&1 || apt-get install -y -qq docker-compose-plugin >/dev/null
fi
systemctl enable --now docker >/dev/null

step "User and Bun"
id richelieu >/dev/null 2>&1 || useradd --system --home-dir "$ROOT" --create-home --shell /bin/bash richelieu
usermod -aG docker richelieu
[ -x "$BUN" ] || sudo -u richelieu -H bash -c 'curl -fsSL https://bun.sh/install | bash' >/dev/null

step "Code ($BRANCH)"
if [ -d "$APP/.git" ]; then
  as_app "git fetch -q origin $BRANCH && git checkout -q $BRANCH && git pull -q --ff-only origin $BRANCH"
else
  sudo -u richelieu -H git clone -q --branch "$BRANCH" "$REPO" "$APP"
fi
as_app "$BUN install --frozen-lockfile >/dev/null"

step "Secrets"
touch "$APP/.env" && chown richelieu:richelieu "$APP/.env" && chmod 600 "$APP/.env"
set_env() { # set_env KEY VALUE: replaces the line, or appends it
  local key=$1 value=$2
  if grep -q "^$key=" "$APP/.env"; then
    sed -i "s|^$key=.*|$key=$(printf '%s' "$value" | sed 's/[&|]/\\&/g')|" "$APP/.env"
  else
    printf '%s=%s\n' "$key" "$value" >> "$APP/.env"
  fi
}
if ! grep -q '^SUPABASE_JWT_SECRET=' "$APP/.env"; then
  as_app "$BUN deploy/vps/secrets.ts" >> "$APP/.env"
  echo "Generated the database password and Supabase keys"
fi
PG_PASSWORD=$(grep '^POSTGRES_PASSWORD=' "$APP/.env" | cut -d= -f2-)
SERVICE_KEY=$(grep '^SUPABASE_SERVICE_ROLE_KEY=' "$APP/.env" | cut -d= -f2-)
set_env DATABASE_URL "postgres://postgres:$PG_PASSWORD@127.0.0.1:54322/postgres"
set_env PUBLIC_URL "https://$APP_HOST"
set_env SITE_URL "https://$APP_HOST"
set_env API_EXTERNAL_URL "https://$APP_HOST/auth/v1"
set_env ADDITIONAL_REDIRECT_URLS "https://$APP_HOST/**"
set_env SUPABASE_PUBLIC_URL "https://$APP_HOST"
set_env BUN_PUBLIC_SUPABASE_URL "https://$APP_HOST"
set_env SUPABASE_INTERNAL_URL "http://127.0.0.1:54321"
set_env SUPABASE_PROXY true
set_env SUPABASE_SERVICE_ROLE_KEY "$SERVICE_KEY"
[ -n "$ANTHROPIC_KEY" ] && set_env ANTHROPIC_API_KEY "$ANTHROPIC_KEY"

step "Supabase"
as_app "docker compose up -d --wait --quiet-pull" || as_app "docker compose up -d"
for _ in $(seq 1 60); do
  as_app "docker compose exec -T db pg_isready -U postgres -q" && break
  sleep 2
done

step "Git forge"
grep -q '^FORGE_PRIVATE_KEY=' "$APP/.env" || as_app "$BUN run forge:org richelieu --write-env"

step "Mail"
MAIL_ARGS="--yes --domain $DOMAIN --hostname $MAIL_HOST --ip ${PUBLIC_IP}${PUBLIC_IP6:+,$PUBLIC_IP6} --tls acme --acme-email $EMAIL --web-host $APP_HOST --https yes"
[ -n "$RELAY" ] && MAIL_ARGS="$MAIL_ARGS --relay $RELAY"
as_app "$BUN run mail setup $MAIL_ARGS" | sed -n '/✓/p'

SAFE_EMAIL=$(printf '%s' "$EMAIL" | tr -cd 'A-Za-z0-9@._+-')
EXISTS=$(as_app "docker compose exec -T db psql -U postgres -tAc \"select 1 from auth.users where lower(email) = lower('$SAFE_EMAIL')\"" || true)
if [ "$(printf '%s' "$EXISTS" | tr -d '[:space:]')" != "1" ]; then
  PASSWORD=$(head -c 18 /dev/urandom | base64 | tr -d '+/=' | cut -c1-20)
  LOCAL=$(printf '%s' "${SAFE_EMAIL%@*}" | tr 'A-Z' 'a-z' | tr -cd 'a-z0-9._-')
  as_app "$BUN run mail user add $SAFE_EMAIL --password $PASSWORD --address ${LOCAL:-me}@$DOMAIN" >/dev/null
  CREATED_PASSWORD=$PASSWORD
  CREATED_ADDRESS="${LOCAL:-me}@$DOMAIN"
fi

if [ "$FIREWALL" -eq 1 ]; then
  step "Firewall"
  ufw allow OpenSSH >/dev/null
  for port in 25 80 443 465 587 993; do ufw allow "$port/tcp" >/dev/null; done
  ufw --force enable >/dev/null
  echo "Open: 22, 25, 80, 443, 465, 587, 993"
fi

step "Service"
install -m 644 "$APP/deploy/vps/richelieu.service" /etc/systemd/system/richelieu.service
systemctl daemon-reload
systemctl enable richelieu >/dev/null
systemctl restart richelieu
sleep 3
systemctl is-active --quiet richelieu && echo "richelieu is running (journalctl -u richelieu -f)" || { journalctl -u richelieu -n 30 --no-pager; exit 1; }

step "DNS records to publish"
as_app "$BUN run mail dns $DOMAIN"
printf '\n  A     %s\n        %s\n' "$APP_HOST" "$PUBLIC_IP"
[ -n "$PUBLIC_IP6" ] && printf '  AAAA  %s\n        %s\n' "$APP_HOST" "$PUBLIC_IP6"

echo
bold "Almost there:"
echo "  1. Publish the records above at your DNS provider, and set the reverse DNS of $PUBLIC_IP to $MAIL_HOST"
echo "     in your VPS provider's panel."
echo "  2. Once DNS is live, the certificate is issued on its own (or: sudo -u richelieu -H bash -c 'cd $APP && $BUN run mail cert issue')."
echo "  3. Check everything: sudo -u richelieu -H bash -c 'cd $APP && $BUN run mail doctor'"
echo "  4. Open https://$APP_HOST"
if [ -n "${CREATED_PASSWORD:-}" ]; then
  echo
  bold "Your account: $EMAIL, password $CREATED_PASSWORD (change it after signing in). Your address: $CREATED_ADDRESS"
fi
