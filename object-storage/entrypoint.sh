#!/bin/sh
# Запуск SeaweedFS с S3 API. Конфигурация учётных записей собирается из окружения:
#   admin                — создание бакета при инициализации;
#   applications-service — Read/Write/List ТОЛЬКО на бакет вложений (B-07);
# анонимного доступа нет: любой запрос без подписи или presigned-ссылки отклоняется.
set -eu
umask 077
B="${S3_BUCKET}"
cat > /tmp/s3.json <<EOF
{
  "identities": [
    {
      "name": "admin",
      "credentials": [{ "accessKey": "${S3_ADMIN_ACCESS_KEY}", "secretKey": "${S3_ADMIN_SECRET_KEY}" }],
      "actions": ["Admin", "Read", "List", "Tagging", "Write"]
    },
    {
      "name": "applications-service",
      "credentials": [{ "accessKey": "${S3_APPLICATIONS_ACCESS_KEY}", "secretKey": "${S3_APPLICATIONS_SECRET_KEY}" }],
      "actions": ["Read:${B}", "Write:${B}", "List:${B}"]
    }
  ]
}
EOF

rm -f /tmp/bucket-ready
weed server -dir=/data -ip=localhost -ip.bind=0.0.0.0 \
  -master.volumeSizeLimitMB=64 -volume.max=20 \
  -s3 -s3.port=8333 -s3.config=/tmp/s3.json &
PID=$!

# ждём мастер и filer, затем создаём бакет
i=0
until echo "s3.bucket.list" | weed shell -master=localhost:9333 >/tmp/shell.log 2>&1 && ! grep -qi error /tmp/shell.log; do
  i=$((i+1)); [ $i -gt 60 ] && { echo "seaweedfs не поднялся"; cat /tmp/shell.log; exit 1; }
  sleep 2
done
if ! echo "s3.bucket.list" | weed shell -master=localhost:9333 2>/dev/null | grep -q "$B"; then
  echo "s3.bucket.create -name $B" | weed shell -master=localhost:9333
fi
touch /tmp/bucket-ready
echo "object-storage: бакет $B готов"
wait $PID
