package ru.spbstu.scholarship.auth.api

import org.slf4j.LoggerFactory
import org.springframework.dao.DuplicateKeyException
import org.springframework.data.redis.core.StringRedisTemplate
import org.springframework.http.HttpStatus
import org.springframework.stereotype.Service
import ru.spbstu.scholarship.auth.crypto.PasswordHasher
import ru.spbstu.scholarship.auth.session.SessionStore
import ru.spbstu.scholarship.auth.token.TokenIssuer
import ru.spbstu.scholarship.auth.user.UserRepository
import ru.spbstu.scholarship.platform.audit.AuditLog
import ru.spbstu.scholarship.platform.audit.AuditResult
import ru.spbstu.scholarship.platform.catalog.CatalogUnavailableException
import ru.spbstu.scholarship.platform.catalog.LdapCatalog
import ru.spbstu.scholarship.platform.events.EventPublisher
import ru.spbstu.scholarship.platform.events.PasswordResetEvent
import ru.spbstu.scholarship.platform.events.Topics
import ru.spbstu.scholarship.platform.security.AuthUser
import ru.spbstu.scholarship.platform.util.Hashing
import ru.spbstu.scholarship.platform.web.ApiException
import ru.spbstu.scholarship.platform.web.Errors
import java.time.Duration
import java.time.Instant
import java.util.UUID

data class IssuedTokens(val accessToken: String, val refreshToken: String, val expiresIn: Long, val refreshMaxAge: Duration, val user: UserView)
data class UserView(val id: UUID, val fullName: String, val roles: List<String>, val unitId: UUID)

@Service
class AuthService(
    private val users: UserRepository,
    private val hasher: PasswordHasher,
    private val tokens: TokenIssuer,
    private val sessions: SessionStore,
    private val catalog: LdapCatalog,
    private val audit: AuditLog,
    private val events: EventPublisher,
    private val redis: StringRedisTemplate,
) {
    private val log = LoggerFactory.getLogger(AuthService::class.java)

    /** Одинаковый ответ на неверный логин, неверный пароль и заблокированную запись (задание 3.1). */
    private fun invalidCredentials() =
        ApiException(HttpStatus.UNAUTHORIZED, "invalid_credentials", "Неверный логин или пароль")

    // ------------------------------------------------------------------ OP-07 вход
    fun login(login: String, password: String): IssuedTokens {
        val user = users.findByLogin(login)
        // проверка выполняется всегда, даже если пользователя нет (выравнивание времени ответа)
        val passwordOk = hasher.matches(password, user?.passwordHash)
        if (user == null || !passwordOk || !user.isActive) {
            audit.write("auth.login", "user", null, null, AuditResult.DENIED,
                mapOf("reason" to "invalid_credentials", "login_sha256" to Hashing.sha256Hex(login.lowercase())))
            throw invalidCredentials()
        }
        // B-13: учётная запись должна существовать в корпоративном каталоге
        val entry = try { catalog.find(user.externalId) } catch (e: CatalogUnavailableException) {
            log.error("Каталог недоступен при входе", e)
            throw ApiException(HttpStatus.SERVICE_UNAVAILABLE, "catalog_unavailable", "Сервис временно недоступен")
        }
        if (entry == null) {
            audit.write("auth.login", "user", user.id, null, AuditResult.DENIED, mapOf("reason" to "catalog_missing"))
            throw invalidCredentials()
        }
        audit.write("auth.login", "user", user.id, user.id)
        return openSession(user.id)
    }

    private fun openSession(userId: UUID): IssuedTokens {
        val user = users.findById(userId) ?: throw invalidCredentials()
        val roles = users.rolesOf(userId)
        val sid = tokens.randomToken(16)
        val refresh = tokens.randomToken()
        sessions.create(sid, userId, refresh)
        return issued(user.id, user.fullName, user.unitId, roles, sid, refresh)
    }

    private fun issued(id: UUID, name: String, unit: UUID, roles: List<String>, sid: String, refresh: String) =
        IssuedTokens(
            accessToken = tokens.issueAccess(id, sid, roles, unit),
            refreshToken = refresh,
            expiresIn = tokens.accessTtl.seconds,
            refreshMaxAge = sessions.remainingTtl(sid),
            user = UserView(id, name, roles, unit),
        )

    // ------------------------------------------------------------------ OP-08 обновление с ротацией
    fun refresh(refreshToken: String): IssuedTokens {
        val newRefresh = tokens.randomToken()
        return when (val r = sessions.rotate(refreshToken, newRefresh)) {
            is SessionStore.RotateResult.Ok -> {
                val user = users.findById(r.session.userId)
                if (user == null || !user.isActive) { sessions.revoke(r.session.sid); throw Errors.unauthorized("invalid_refresh") }
                // роли перечитываются из БД: отозванная роль перестаёт действовать при следующем обновлении
                issued(user.id, user.fullName, user.unitId, users.rolesOf(user.id), r.session.sid, newRefresh)
            }
            is SessionStore.RotateResult.Reused -> {
                // повторное предъявление ротированного токена — признак кражи: отзываем всю сессию
                sessions.revoke(r.sid)
                audit.write("auth.refresh_reuse", "session", null, null, AuditResult.DENIED, mapOf("sid_sha256" to Hashing.sha256Hex(r.sid)))
                throw Errors.unauthorized("invalid_refresh")
            }
            SessionStore.RotateResult.Invalid -> throw Errors.unauthorized("invalid_refresh")
        }
    }

    // ------------------------------------------------------------------ OP-15 выход
    fun logout(user: AuthUser) {
        sessions.revoke(user.sessionId)
        audit.write("auth.logout", "user", user.id, user.id)
    }

    // ------------------------------------------------------------------ OP-16 повторное подтверждение личности
    fun reauth(user: AuthUser, password: String) {
        val record = users.findById(user.id)
        if (record == null || !hasher.matches(password, record.passwordHash)) {
            audit.write("auth.reauth", "user", user.id, user.id, AuditResult.DENIED)
            throw ApiException(HttpStatus.FORBIDDEN, "invalid_credentials", "Неверный пароль")
        }
        sessions.markReauthenticated(user.sessionId)
        audit.write("auth.reauth", "user", user.id, user.id)
    }

    // ------------------------------------------------------------------ OP-14 регистрация (D-13)
    fun register(externalId: String, email: String, password: String): UUID {
        PasswordPolicy.check(password, externalId, email)
        val entry = try { catalog.find(externalId) } catch (e: CatalogUnavailableException) {
            throw ApiException(HttpStatus.SERVICE_UNAVAILABLE, "catalog_unavailable", "Сервис временно недоступен")
        }
        // Каталог — источник истины: регистрироваться может только действующий обучающийся,
        // e-mail должен совпадать с каталожным; ФИО и подразделение берутся из каталога, а не от клиента.
        val failed = ApiException(HttpStatus.UNPROCESSABLE_ENTITY, "registration_failed",
            "Регистрация невозможна: данные не совпадают с каталогом обучающихся")
        if (entry == null || !entry.isActiveStudent || !entry.email.equals(email, ignoreCase = true)) {
            audit.write("auth.register", "user", null, null, AuditResult.DENIED, mapOf("reason" to "catalog_mismatch"))
            throw failed
        }
        val unitId = entry.unitCode?.let { users.unitIdByCode(it) } ?: throw failed
        if (users.existsByExternalIdOrEmail(externalId, email)) {
            throw Errors.conflict("Учётная запись уже зарегистрирована", "already_registered")
        }
        val id = try {
            users.insertApplicant(externalId, entry.email!!, entry.fullName, unitId, hasher.hash(password))
        } catch (e: DuplicateKeyException) {
            throw Errors.conflict("Учётная запись уже зарегистрирована", "already_registered")
        }
        audit.write("auth.register", "user", id, id)
        return id
    }

    // ------------------------------------------------------------------ OP-09 восстановление: запрос
    /**
     * Ответ всегда одинаковый (202), есть ли такой адрес или нет — перечислить
     * пользователей через эту форму нельзя. Код: 256 бит, одноразовый, срок 15 минут;
     * в Redis хранится только его SHA-256.
     */
    fun requestPasswordReset(email: String) {
        val user = users.findByEmail(email)
        if (user == null || !user.isActive) {
            audit.write("auth.password_reset_requested", "user", null, null, AuditResult.DENIED,
                mapOf("reason" to "unknown_email"))
            return
        }
        val token = tokens.randomToken()
        val hash = Hashing.sha256Hex(token)
        val ops = redis.opsForValue()
        // предыдущий неиспользованный код пользователя аннулируется
        ops.getAndDelete("pwreset-user:${user.id}")?.let { redis.delete("pwreset:$it") }
        ops.set("pwreset:$hash", user.id.toString(), RESET_TTL)
        ops.set("pwreset-user:${user.id}", hash, RESET_TTL)
        audit.write("auth.password_reset_requested", "user", user.id, null)
        // письмо отправляет notifier через брокер (B-14); здесь — только публикация события
        events.publishAfterCommit(Topics.PASSWORD_RESET, user.id.toString(),
            PasswordResetEvent(userId = user.id, resetToken = token, expiresAt = Instant.now().plus(RESET_TTL)))
    }

    // ------------------------------------------------------------------ OP-09 восстановление: смена пароля
    fun confirmPasswordReset(token: String, newPassword: String) {
        // GETDEL атомарен: код срабатывает ровно один раз, даже при параллельных запросах
        val userId = redis.opsForValue().getAndDelete("pwreset:${Hashing.sha256Hex(token)}")
            ?.let { UUID.fromString(it) }
            ?: throw Errors.badRequest("Код восстановления недействителен или истёк", "invalid_reset_token")
        redis.delete("pwreset-user:$userId")
        val user = users.findById(userId) ?: throw Errors.badRequest("Код восстановления недействителен или истёк", "invalid_reset_token")
        PasswordPolicy.check(newPassword, user.externalId, user.email)
        users.updatePassword(userId, hasher.hash(newPassword))
        val revoked = sessions.revokeAll(userId) // все прежние сессии завершаются
        audit.write("auth.password_reset_completed", "user", userId, userId, details = mapOf("sessions_revoked" to revoked))
    }

    // ------------------------------------------------------------------ контакт для notifier
    fun contactOf(id: UUID) = users.findById(id)?.let { mapOf("email" to it.email, "full_name" to it.fullName) }

    companion object { val RESET_TTL: Duration = Duration.ofMinutes(15) }
}

object PasswordPolicy {
    fun check(password: String, login: String, email: String) {
        if (password.length < 10 || password.length > 128) throw Errors.badRequest("Пароль должен содержать от 10 до 128 символов", "weak_password")
        if (password.contains(login, ignoreCase = true) || password.equals(email, ignoreCase = true))
            throw Errors.badRequest("Пароль не должен содержать логин", "weak_password")
        if (password.toSet().size < 5) throw Errors.badRequest("Пароль слишком простой", "weak_password")
    }
}
