#!/bin/sh
# Точка входа контейнера liquibase: применяет changelog и завершается.
# Пароли ролей сервисов передаются параметрами changelog из окружения —
# в репозитории их нет (см. roles.sql).
set -eu

: "${POSTGRES_PASSWORD:?не задан POSTGRES_PASSWORD}"
: "${SVC_AUTH_DB_PASSWORD:?не задан SVC_AUTH_DB_PASSWORD}"
: "${SVC_APPLICATIONS_DB_PASSWORD:?не задан SVC_APPLICATIONS_DB_PASSWORD}"
: "${SVC_REVIEW_DB_PASSWORD:?не задан SVC_REVIEW_DB_PASSWORD}"

exec liquibase \
  --url="jdbc:postgresql://postgres:5432/scholarship" \
  --username=postgres \
  --password="$POSTGRES_PASSWORD" \
  --search-path=/liquibase/changelog \
  --changelog-file=changelog.xml \
  --log-level=info \
  update \
  --contexts="${MIGRATION_CONTEXTS:-demo}" \
  -Dsvc_auth_password="$SVC_AUTH_DB_PASSWORD" \
  -Dsvc_applications_password="$SVC_APPLICATIONS_DB_PASSWORD" \
  -Dsvc_review_password="$SVC_REVIEW_DB_PASSWORD"
