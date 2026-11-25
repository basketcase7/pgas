#!/bin/sh
# DAST: OWASP ZAP против локально запущенной системы (только своя система, сеть docker compose).
#   1) API без аутентификации: импорт OpenAPI → пассивное + активное сканирование;
#   2) API с токеном обычного пользователя (stud001), хук обновляет токен;
#   3) веб-кабинет заявителя: spider + пассивное + активное (zap-full-scan).
# Запуск из корня репозитория:  sh tools/dast/zap-run.sh docs/lab5/before
set -eu
OUT="${1:?каталог для отчётов}"
mkdir -p "$OUT/zap"
W=$(pwd -W 2>/dev/null || pwd)
PASS=$(grep '^DEMO_USERS_PASSWORD=' .env | cut -d= -f2-)
sed "s#https://localhost:8443/api/v1#https://api-gateway:8443/api/v1#" docs/openapi.yaml > "$OUT/zap/openapi.scan.yaml"
ZAP="docker run --rm --network scholarship_frontend -v $W/$OUT/zap:/zap/wrk:rw -v $W/secrets/gateway.crt:/zap/ca/gateway.crt:ro -v $W/tools/dast:/zap/hooks:ro"
# темп ниже лимитов шлюза (300 запросов/мин на субъекта), иначе сканер видит в основном 429
OPTS="-config scanner.threadPerHost=1 -config scanner.delayInMs=250 -config connection.timeoutInSecs=30"

$ZAP ghcr.io/zaproxy/zaproxy:stable zap-api-scan.py -t /zap/wrk/openapi.scan.yaml -f openapi \
  -r api-unauth.html -J api-unauth.json -x api-unauth.xml -T 40 -z "$OPTS" > "$OUT/zap/api-unauth.txt" 2>&1 &
P1=$!
$ZAP -e ZAP_USER=stud001 -e ZAP_PASSWORD="$PASS" -e ZAP_CA_FILE=/zap/ca/gateway.crt ghcr.io/zaproxy/zaproxy:stable \
  zap-api-scan.py -t /zap/wrk/openapi.scan.yaml -f openapi --hook=/zap/hooks/zap_auth_hook.py \
  -r api-auth.html -J api-auth.json -x api-auth.xml -T 40 -z "$OPTS" > "$OUT/zap/api-auth.txt" 2>&1 &
P2=$!
[ "${SKIP_WEB:-}" = 1 ] || $ZAP ghcr.io/zaproxy/zaproxy:stable zap-full-scan.py -t http://applicant-web:8080 -m 2 -T 20 \
  -r web-full.html -J web-full.json -x web-full.xml -z "-config scanner.threadPerHost=2" > "$OUT/zap/web-full.txt" 2>&1 &
P3=$!
wait $P1 || true; wait $P2 || true; wait $P3 || true
echo "ZAP: готово ($OUT/zap)"
