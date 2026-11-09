#!/bin/sh
# Демонстрация задания 2.2: учётные записи сервисов не имеют прав сверх необходимых.
# Запуск из корня проекта при работающей системе: sh scripts/db-rights-check.sh
set -u
cd "$(dirname "$0")/.."
val() { grep "^$1=" .env | cut -d= -f2-; }

run() { # пользователь пароль SQL
  printf '\n[%s] %s\n' "$1" "$3"
  docker compose exec -T -e PGPASSWORD="$2" postgres \
    psql -h localhost -U "$1" -d scholarship -v ON_ERROR_STOP=1 -c "$3" 2>&1 | sed 's/^/    /'
}

APPS=$(val SVC_APPLICATIONS_DB_PASSWORD)
REV=$(val SVC_REVIEW_DB_PASSWORD)

run svc_applications "$APPS" "DROP TABLE users;"
run svc_applications "$APPS" "CREATE TABLE hack (id int);"
run svc_applications "$APPS" "SELECT count(*) FROM payout_entries;"
run svc_applications "$APPS" "DELETE FROM audit_log;"
run svc_review "$REV" "UPDATE audit_log SET result = 'success';"
run svc_review "$REV" "DELETE FROM applications;"
run svc_applications "$APPS" "SELECT count(*) AS my_visible_applications FROM applications;"
