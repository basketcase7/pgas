#!/bin/sh
# Redis: сессии, ключи обновления, коды восстановления, счётчики лимитов (B-06).
# ACL-файл собирается при старте из переменных окружения — паролей в репозитории нет.
#   default выключен: подключиться без учётной записи нельзя;
#   каждый клиент видит только свой префикс ключей; %R~ — только чтение;
#   -@dangerous запрещает FLUSHALL, KEYS, CONFIG, DEBUG и т. п.
set -eu
umask 077
ACL=/tmp/users.acl
{
  echo "user default off"
  echo "user gateway on >${REDIS_GATEWAY_PASSWORD} ~rl:* +@all -@dangerous"
  echo "user auth on >${REDIS_AUTH_PASSWORD} ~session:* ~refresh:* ~refresh-used:* ~pwreset:* ~pwreset-user:* ~user-sessions:* +@all -@dangerous"
  echo "user applications on >${REDIS_APPLICATIONS_PASSWORD} %R~session:* ~enum404:* +@all -@dangerous"
  echo "user review on >${REDIS_REVIEW_PASSWORD} %R~session:* +@all -@dangerous"
  echo "user notifier on >${REDIS_NOTIFIER_PASSWORD} ~notifier:* +@all -@dangerous"
} > "$ACL"
chown redis:redis "$ACL" 2>/dev/null || true
# Персистентность выключена намеренно: перезапуск Redis = завершение всех сессий.
exec setpriv --reuid=redis --regid=redis --clear-groups redis-server --aclfile "$ACL" --save "" --appendonly no
