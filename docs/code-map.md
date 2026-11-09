# Карта кода

Где в коде реализовано каждое проектное решение ЛР № 2.

## Операции API

| Операция | Метод и путь | Сервис | Обработчик → логика |
|---|---|---|---|
| OP-01 | `GET /api/v1/applications/{id}` | applications-service | `ApplicationsController.get` → `ApplicationService.get` → `ApplicationRepository.findVisible` (права на объект в WHERE) |
| OP-02 | `POST /api/v1/applications` | applications-service | `ApplicationsController.create` → `ApplicationService.create` → `ApplicationRepository.insert` |
| OP-03 | `PATCH /api/v1/applications/{id}/review` | review-service | `ReviewController.review` → `ReviewService.review` → `ReviewRepository.lockForReview / updateStatus` |
| OP-04 | `GET /api/v1/applications` | applications-service | `ApplicationsController.list` → `ApplicationService.list` → `ApplicationRepository.list` |
| OP-05 | `POST /api/v1/campaigns/{id}/payout-registry` | review-service | `ReviewController.registry` → `ReviewService.createRegistry` |
| OP-06 / OP-11 | `POST/GET /api/v1/applications/{id}/completeness-check` | applications-service | `ApplicationsController.completeness` → 501 |
| OP-07 | `POST /api/v1/auth/login` | auth-service | `AuthController.login` → `AuthService.login` |
| OP-08 | `POST /api/v1/auth/refresh` | auth-service | `AuthController.refresh` → `AuthService.refresh` → `SessionStore.rotate` |
| OP-09 | `POST /api/v1/auth/password-reset`, `.../confirm` | auth-service | `AuthService.requestPasswordReset / confirmPasswordReset` |
| OP-10 | `POST /api/v1/applications/{id}/attachments` | applications-service | `ApplicationService.requestUpload` → `ObjectStorage.presignUpload` |
| OP-12 | `GET /api/v1/campaigns/{id}/ranking` | review-service | `ReviewService.ranking` |
| OP-13 | `DELETE /api/v1/applications/{id}` | applications-service | `ApplicationService.withdraw` |
| OP-14 | `POST /api/v1/auth/register` | auth-service | `AuthService.register` |
| OP-15 | `POST /api/v1/auth/logout` | auth-service | `AuthService.logout` → `SessionStore.revoke` |
| OP-16 | `POST /api/v1/auth/reauth` | auth-service | `AuthService.reauth` → `SessionStore.markReauthenticated` |
| OP-17 | `GET /api/v1/campaigns` | applications-service | `ApplicationRepository.campaigns` |
| OP-18 | `POST /api/v1/applications/{id}/submit` | applications-service | `ApplicationService.submit` |

## Сквозные механизмы

| Решение | Файл |
|---|---|
| Проверка токена (алгоритм, подпись, срок, iss/aud) | `platform/.../token/AccessTokenVerifier.kt` |
| Аутентификация в каждом сервисе + проверка сессии в Redis (отзыв) | `platform/.../web/Filters.kt` (`AuthenticationFilter`) |
| Сопоставление ролей и прав на операцию | `platform/.../security/Permissions.kt` |
| Субъект запроса берётся только из токена | `platform/.../web/PlatformWebConfig.kt` (`AuthUserArgumentResolver`) |
| Обработка ошибок: 500 без подробностей | `platform/.../web/ApiErrorHandler.kt` |
| Журнал аудита (success в транзакции, denied — отдельно) | `platform/.../audit/AuditLog.kt` |
| Ключи идемпотентности | `platform/.../idempotency/IdempotencyStore.kt` |
| Публикация событий после фиксации транзакции | `platform/.../events/Events.kt` |
| Каталог LDAP, параметризованный фильтр | `platform/.../catalog/LdapCatalog.kt` |
| Argon2id + перец | `auth-service/.../crypto/PasswordHasher.kt` |
| Выпуск JWT RS256 | `auth-service/.../token/TokenIssuer.kt` |
| Сессии, ротация refresh, отзыв | `auth-service/.../session/SessionStore.kt` |
| Шлюз: TLS, маршруты | `api-gateway/.../GatewayApplication.kt`, `application.yml` |
| Шлюз: размер тела, проверка токена, лимиты частоты | `api-gateway/.../GatewayFilters.kt` |
| Потребитель Kafka, идемпотентность, DLT | `notifier/.../NotificationListener.kt`, `NotifierApplication.kt` |
| Хранение токена в клиенте (память) | `applicant-web/public/api.js` |
| Схема, роли, тестовые данные | `db/schema.sql`, `db/roles.sql`, `db/seed.sql`, `db/changelog.xml` |
| Топики и ACL Kafka | `kafka/init-topics.sh` |
| ACL Redis | `redis/start.sh` |
