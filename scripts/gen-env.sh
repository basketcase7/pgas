#!/bin/sh
# Генерирует .env со случайными секретами, пару ключей подписи токенов и TLS-сертификат шлюза.
# Запуск из корня проекта:  sh scripts/gen-env.sh        (Git Bash / Linux / macOS, нужен openssl)
# либо без openssl на хосте:
#   docker run --rm -v "${PWD}:/w" -w /w alpine:3.20 sh -c "apk add -q openssl && sh scripts/gen-env.sh"
set -eu
# Git Bash (MSYS) иначе превращает "/CN=..." в путь Windows
export MSYS_NO_PATHCONV=1

cd "$(dirname "$0")/.."

if [ -f .env ] && [ "${1:-}" != "--force" ]; then
  echo ".env уже существует. Для перегенерации: sh scripts/gen-env.sh --force"
  echo "ВНИМАНИЕ: после перегенерации базу нужно сбросить (docker compose down -v)."
  exit 1
fi

rnd() { openssl rand -hex "${1:-24}"; }
b64() { openssl base64 -A; }

mkdir -p secrets
tmp=secrets/.tmp; mkdir -p "$tmp"

# --- ключи подписи токенов RS256 ---
openssl genpkey -algorithm RSA -pkeyopt rsa_keygen_bits:2048 -out "$tmp/jwt.key" 2>/dev/null
openssl pkey -in "$tmp/jwt.key" -pubout -out "$tmp/jwt.pub" 2>/dev/null
JWT_PRIVATE_KEY_B64=$(b64 < "$tmp/jwt.key")
JWT_PUBLIC_KEY_B64=$(b64 < "$tmp/jwt.pub")

# --- TLS-сертификат api-gateway (самоподписанный, SAN: api-gateway, localhost) ---
openssl req -x509 -newkey rsa:2048 -nodes -days 365 \
  -keyout secrets/gateway.key -out secrets/gateway.crt \
  -subj "/CN=api-gateway" \
  -addext "subjectAltName=DNS:api-gateway,DNS:localhost,IP:127.0.0.1" 2>/dev/null
chmod 644 secrets/gateway.key secrets/gateway.crt

DEMO=${DEMO_USERS_PASSWORD:-Demo-$(openssl rand -hex 6)}

cat > .env <<EOF
POSTGRES_PASSWORD=$(rnd)
SVC_AUTH_DB_PASSWORD=$(rnd)
SVC_APPLICATIONS_DB_PASSWORD=$(rnd)
SVC_REVIEW_DB_PASSWORD=$(rnd)
REDIS_GATEWAY_PASSWORD=$(rnd)
REDIS_AUTH_PASSWORD=$(rnd)
REDIS_APPLICATIONS_PASSWORD=$(rnd)
REDIS_REVIEW_PASSWORD=$(rnd)
REDIS_NOTIFIER_PASSWORD=$(rnd)
KAFKA_ADMIN_PASSWORD=$(rnd)
KAFKA_APPLICATIONS_PASSWORD=$(rnd)
KAFKA_REVIEW_PASSWORD=$(rnd)
KAFKA_AUTH_PASSWORD=$(rnd)
KAFKA_NOTIFIER_PASSWORD=$(rnd)
JWT_PRIVATE_KEY_B64=$JWT_PRIVATE_KEY_B64
JWT_PUBLIC_KEY_B64=$JWT_PUBLIC_KEY_B64
PASSWORD_PEPPER_B64=$(openssl rand -base64 32)
DEMO_USERS_PASSWORD=$DEMO
LDAP_ADMIN_PASSWORD=$(rnd)
LDAP_READONLY_PASSWORD=$(rnd)
S3_ADMIN_ACCESS_KEY=admin$(rnd 6)
S3_ADMIN_SECRET_KEY=$(rnd)
S3_APPLICATIONS_ACCESS_KEY=apps$(rnd 6)
S3_APPLICATIONS_SECRET_KEY=$(rnd)
SMTP_USER=notifier
SMTP_PASSWORD=$(rnd)
NOTIFIER_SERVICE_TOKEN=$(rnd 32)
EOF

rm -rf "$tmp"
echo "Готово: .env и secrets/ созданы."
echo "Пароль тестовых пользователей: $DEMO"
