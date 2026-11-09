#!/bin/sh
# Одноразовая инициализация Kafka: топики, топики недоставленных сообщений (DLT) и ACL.
# Выполняется под административной учётной записью; сервисы получают ровно те права,
# которые нужны по реестру границ (B-08 — публикация, B-09 — чтение своей группы).
set -eu
umask 077
CFG=/tmp/admin.properties
cat > "$CFG" <<EOF
security.protocol=SASL_PLAINTEXT
sasl.mechanism=PLAIN
sasl.jaas.config=org.apache.kafka.common.security.plain.PlainLoginModule required username="admin" password="${KAFKA_ADMIN_PASSWORD}";
EOF

BS=kafka:9092
BIN=/opt/kafka/bin

topic() { # имя партиции retention.ms
  $BIN/kafka-topics.sh --bootstrap-server $BS --command-config $CFG --create --if-not-exists \
    --topic "$1" --partitions "$2" --replication-factor 1 --config retention.ms="$3"
}

acl() {
  $BIN/kafka-acls.sh --bootstrap-server $BS --command-config $CFG --add --force "$@" >/dev/null
}

# события заявок: ключ сообщения = application_id, порядок событий одной заявки сохраняется
topic applications.events      3 604800000    # 7 суток — можно переиграть события
topic applications.events.DLT  1 2592000000   # 30 суток на разбор
# коды восстановления доступа: срок хранения = сроку действия кода (15 минут)
topic auth.password-reset      1 900000
topic auth.password-reset.DLT  1 900000

# производители
acl --allow-principal User:applications --operation Write --operation Describe --topic applications.events
acl --allow-principal User:review       --operation Write --operation Describe --topic applications.events
acl --allow-principal User:auth         --operation Write --operation Describe --topic auth.password-reset
# потребитель notifier: чтение своих топиков и своей группы, запись только в DLT
acl --allow-principal User:notifier --operation Read --operation Describe --topic applications.events
acl --allow-principal User:notifier --operation Read --operation Describe --topic auth.password-reset
acl --allow-principal User:notifier --operation Read --group notifier
acl --allow-principal User:notifier --operation Write --operation Describe --topic applications.events.DLT
acl --allow-principal User:notifier --operation Write --operation Describe --topic auth.password-reset.DLT

echo "--- топики"
$BIN/kafka-topics.sh --bootstrap-server $BS --command-config $CFG --list
echo "--- ACL"
$BIN/kafka-acls.sh --bootstrap-server $BS --command-config $CFG --list | grep -E "ResourcePattern|principal" | sed 's/^\s*//'
echo "kafka-init: готово"
