# Сервис заявок на материальную поддержку и ПГАС — ЛР № 3

Реализация системы, спроектированной в ЛР № 2 (курс «Основы разработки безопасных цифровых систем»).
Kotlin 2.1 + Spring Boot 3.5, PostgreSQL 16 (SQL без ORM, Spring JDBC), миграции Liquibase,
Apache Kafka, Redis, S3-хранилище (SeaweedFS), OpenLDAP (заглушка каталога), Mailpit (заглушка почты).

Отличия от проекта — [docs/discrepancies.md](docs/discrepancies.md), карта кода — [docs/code-map.md](docs/code-map.md).

## Требования к компьютеру

* Docker Desktop (Engine 24+) с Docker Compose v2; 8 ГБ ОЗУ (системе нужно около 4 ГБ), 6 ГБ на диске.
* Свободные порты на 127.0.0.1: 8080, 8081, 8443, 8025, 8090.
* Для генерации секретов — `openssl` (есть в Git Bash) либо сам Docker.
* Для автоматической коллекции запросов — Node.js 18+ (необязательно).

Сборка Kotlin-сервисов идёт внутри Docker (образ `gradle:8.14.3-jdk21`); локально JDK и Gradle не нужны.

## Запуск

```bash
sh scripts/gen-env.sh
```

Скрипт создаёт `.env` (случайные пароли, ключи подписи RS256, перец) и `secrets/` (TLS-сертификат шлюза)
и печатает пароль тестовых пользователей (он же — `DEMO_USERS_PASSWORD` в `.env`). Без openssl на хосте:

```bash
docker run --rm -v "${PWD}:/w" -w /w alpine:3.20 sh -c "apk add -q openssl && sh scripts/gen-env.sh"
```

Затем одна команда поднимает всю систему (первая сборка — 5–10 минут):

```bash
docker compose up -d --build
```

Готовность: `docker compose ps` — пять Java-сервисов в состоянии `healthy`, `liquibase` и `kafka-init` — `Exited (0)`.
База создаётся и заполняется автоматически (контейнер `liquibase`), ручных действий в БД нет.

Остановка — `docker compose down`. **Сброс в исходное состояние** (БД, хранилище, топики, сессии) — `docker compose down -v`, затем снова `docker compose up -d`.

## Адреса

| Что | Адрес |
|---|---|
| Кабинет заявителя (applicant-web) | http://localhost:8080 |
| Панель сотрудника (staff-panel) | http://127.0.0.1:8081 — именно 127.0.0.1: cookie не различают порты, другой хост разделяет сессии двух приложений |
| API (api-gateway, HTTPS, самоподписанный сертификат `secrets/gateway.crt`) | https://localhost:8443/api/v1 |
| Почта (Mailpit): письма уведомлений и восстановления доступа | http://localhost:8025 |
| Kafka UI: топики, сообщения, группы потребителей | http://localhost:8090 |

PostgreSQL, Redis, Kafka, LDAP, хранилище и сами сервисы наружу не публикуются.

## Тестовые учётные записи

Пароль у всех — значение `DEMO_USERS_PASSWORD` из `.env`.

| Логин | Роль | Подразделение | Назначение в демонстрации |
|---|---|---|---|
| stud001 | заявитель (R-02) | ICST | свои заявки e01 (подана), e04 (одобрена) |
| stud002 | заявитель (R-02) | ICST | свои заявки e02, e03 (черновик), e05 — stud001 их не видит |
| stud003 | заявитель (R-02) | IEE | заявка e06 в другом подразделении |
| stud004 | заявитель, **отчислен** по каталогу | ICST | подача заявки → 403 |
| emp001 | сотрудник (R-03) | ICST | проверка заявок ICST |
| emp002 | сотрудник (R-03) | IEE | не видит заявок ICST |
| chair001 | председатель комиссии (R-04) | ICST | реестр выплат по кампании «ПГАС, осенний семестр» |
| chair002 | председатель комиссии (R-04) | IEE | чужая комиссия → 403 |
| sup001 | служба поддержки (R-07) | ICST | только просмотр статуса, без вложений |
| stud010 | есть только в каталоге LDAP | ICST | регистрация (OP-14) |

## Проверка

```bash
NODE_EXTRA_CA_CERTS=secrets/gateway.crt node requests/run-all.mjs
```

Скрипт проходит по всем эндпоинтам (≈150 проверок), включая три проверочных запроса из задания 7.2,
и печатает фактический код ответа рядом с ожидаемым. Рассчитан на исходные данные: перед повторным прогоном — `docker compose down -v && docker compose up -d`.
Для ручных запросов — `requests/api.http` (HTTP-клиент IntelliJ IDEA / VS Code REST Client).

### Что показать на защите

* **Сообщение в брокере и его обработка.** Подать заявку в кабинете → Kafka UI → Topics → `applications.events` → Messages; письмо в Mailpit.
* **Падение обработчика:** `docker compose stop notifier`, подать/отозвать заявку — в Kafka UI растёт отставание группы `notifier`; `docker compose start notifier` — накопленные события обрабатываются, письма приходят. Повторная доставка не даёт второго письма (`notifier:done:{event_id}` в Redis).
* **Права учётной записи приложения:** `sh scripts/db-rights-check.sh` — под `svc_applications` и `svc_review` выполняются `DROP TABLE`, `CREATE TABLE`, `UPDATE audit_log`, чтение чужих таблиц; все завершаются ошибкой прав. Вручную: `docker compose exec postgres psql -h localhost -U svc_applications -d scholarship` (пароль `SVC_APPLICATIONS_DB_PASSWORD` из `.env`).
* **Журнал аудита:** `docker compose exec postgres psql -U postgres -d scholarship -c "SELECT occurred_at, actor_id, action, result FROM audit_log ORDER BY id DESC LIMIT 20"`.

## Структура репозитория

```
docker-compose.yml   .env.example   scripts/gen-env.sh
db/                  schema.sql (ЛР2), roles.sql, seed.sql, changes/, changelog.xml — контейнер liquibase
api-gateway/         шлюз: TLS, маршрутизация, проверка подписи, лимиты (Spring Cloud Gateway)
auth-service/        вход, токены, сессии, регистрация, восстановление доступа
applications-service/заявки, вложения, кампании
review-service/      проверка, рейтинг, реестр выплат
notifier/            потребитель Kafka → почта
platform/            общая библиотека сервисов (не контейнер)
applicant-web/       кабинет заявителя (SPA + nginx)
staff-panel/         панель сотрудника (SPA + nginx)
kafka/ redis/ ldap/ object-storage/   конфигурация инфраструктурных контейнеров
requests/            коллекция запросов
docs/                отчёт, журнал расхождений, карта кода
```
