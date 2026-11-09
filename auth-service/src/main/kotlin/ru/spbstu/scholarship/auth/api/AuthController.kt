package ru.spbstu.scholarship.auth.api

import jakarta.servlet.http.HttpServletRequest
import org.springframework.beans.factory.annotation.Value
import org.springframework.http.HttpHeaders
import org.springframework.http.HttpStatus
import org.springframework.http.ResponseCookie
import org.springframework.http.ResponseEntity
import org.springframework.web.bind.annotation.GetMapping
import org.springframework.web.bind.annotation.PathVariable
import org.springframework.web.bind.annotation.PostMapping
import org.springframework.web.bind.annotation.RequestBody
import org.springframework.web.bind.annotation.RequestHeader
import org.springframework.web.bind.annotation.RequestMapping
import org.springframework.web.bind.annotation.RestController
import ru.spbstu.scholarship.platform.security.AuthUser
import ru.spbstu.scholarship.platform.util.Hashing
import ru.spbstu.scholarship.platform.web.Errors
import java.time.Duration
import java.util.UUID

// Тела запросов — закрытые списки полей: лишнее поле → 400 (FAIL_ON_UNKNOWN_PROPERTIES).
data class LoginRequest(val login: String?, val password: String?)
data class ReauthRequest(val password: String?)
data class RegisterRequest(val externalId: String?, val email: String?, val password: String?)
data class ResetRequest(val email: String?)
data class ResetConfirmRequest(val token: String?, val newPassword: String?)

data class TokenResponse(val accessToken: String, val tokenType: String = "Bearer", val expiresIn: Long, val user: UserView)

@RestController
@RequestMapping("/api/v1/auth")
class AuthController(
    private val auth: AuthService,
    @Value("\${security.refresh-cookie-secure}") private val secureCookie: Boolean,
) {
    /** OP-07. POST /auth/login → 200 + токен доступа в теле, токен обновления в cookie HttpOnly. */
    @PostMapping("/login")
    fun login(@RequestBody body: LoginRequest): ResponseEntity<TokenResponse> {
        val login = body.login?.trim().orEmpty()
        val password = body.password.orEmpty()
        if (login.isEmpty() || login.length > 254 || password.isEmpty() || password.length > 128) {
            throw Errors.badRequest("Укажите логин и пароль")
        }
        return tokenResponse(auth.login(login, password))
    }

    /**
     * OP-08. POST /auth/refresh — токен обновления берётся только из cookie.
     * Дополнительно требуется заголовок X-Requested-With: обычная HTML-форма другого сайта
     * не может его выставить (защита от CSRF поверх SameSite=Strict).
     */
    @PostMapping("/refresh")
    fun refresh(req: HttpServletRequest, @RequestHeader("X-Requested-With", required = false) xrw: String?): ResponseEntity<TokenResponse> {
        if (xrw.isNullOrBlank()) throw Errors.badRequest("Требуется заголовок X-Requested-With")
        val token = req.cookies?.firstOrNull { it.name == COOKIE }?.value
            ?: throw Errors.unauthorized("invalid_refresh")
        return tokenResponse(auth.refresh(token))
    }

    /** OP-15 (D-13). POST /auth/logout — сессия удаляется из Redis, токен доступа сразу перестаёт приниматься. */
    @PostMapping("/logout")
    fun logout(user: AuthUser): ResponseEntity<Void> {
        auth.logout(user)
        return ResponseEntity.noContent().header(HttpHeaders.SET_COOKIE, cookie("", Duration.ZERO).toString()).build()
    }

    /** OP-16 (D-14). POST /auth/reauth — повторный ввод пароля перед OP-05 (действует 5 минут). */
    @PostMapping("/reauth")
    fun reauth(user: AuthUser, @RequestBody body: ReauthRequest): ResponseEntity<Void> {
        val pwd = body.password.orEmpty()
        if (pwd.isEmpty() || pwd.length > 128) throw Errors.badRequest("Укажите пароль")
        auth.reauth(user, pwd)
        return ResponseEntity.noContent().build()
    }

    /** OP-14 (D-13). POST /auth/register — активация учётной записи обучающегося из каталога. */
    @PostMapping("/register")
    fun register(@RequestBody body: RegisterRequest): ResponseEntity<Map<String, Any>> {
        val ext = body.externalId?.trim().orEmpty()
        val email = body.email?.trim().orEmpty()
        val pwd = body.password.orEmpty()
        if (!ext.matches(Regex("^[A-Za-z0-9._-]{3,64}$"))) throw Errors.badRequest("Некорректный логин")
        if (email.length > 254 || !email.matches(Regex("^[^@\\s]+@[^@\\s]+$"))) throw Errors.badRequest("Некорректный e-mail")
        val id = auth.register(ext, email, pwd)
        return ResponseEntity.status(HttpStatus.CREATED).body(mapOf("id" to id))
    }

    /** OP-09, шаг 1. POST /auth/password-reset — ответ одинаков для любого адреса. */
    @PostMapping("/password-reset")
    fun resetRequest(@RequestBody body: ResetRequest): ResponseEntity<Map<String, String>> {
        val email = body.email?.trim().orEmpty()
        if (email.isEmpty() || email.length > 254) throw Errors.badRequest("Укажите e-mail")
        auth.requestPasswordReset(email)
        return ResponseEntity.accepted().body(mapOf("status" to "accepted",
            "message" to "Если адрес зарегистрирован, на него отправлено письмо со ссылкой для смены пароля"))
    }

    /** OP-09, шаг 2 (D-13). POST /auth/password-reset/confirm — одноразовый код + новый пароль. */
    @PostMapping("/password-reset/confirm")
    fun resetConfirm(@RequestBody body: ResetConfirmRequest): ResponseEntity<Void> {
        val token = body.token?.trim().orEmpty()
        val pwd = body.newPassword.orEmpty()
        if (token.isEmpty() || token.length > 100) throw Errors.badRequest("Код восстановления недействителен или истёк", "invalid_reset_token")
        auth.confirmPasswordReset(token, pwd)
        return ResponseEntity.noContent().build()
    }

    private fun tokenResponse(t: IssuedTokens): ResponseEntity<TokenResponse> =
        ResponseEntity.ok()
            .header(HttpHeaders.SET_COOKIE, cookie(t.refreshToken, t.refreshMaxAge).toString())
            .header(HttpHeaders.CACHE_CONTROL, "no-store")
            .body(TokenResponse(accessToken = t.accessToken, expiresIn = t.expiresIn, user = t.user))

    /** Cookie токена обновления: недоступна JavaScript (HttpOnly), только HTTPS/localhost, только свой сайт. */
    private fun cookie(value: String, maxAge: Duration) = ResponseCookie.from(COOKIE, value)
        .httpOnly(true).secure(secureCookie).sameSite("Strict").path("/api/v1/auth").maxAge(maxAge).build()

    companion object { const val COOKIE = "refresh_token" }
}

/**
 * Внутренний эндпоинт для notifier (не маршрутизируется шлюзом, порт сервиса не опубликован).
 * Вызывающий подтверждает себя сервисным токеном; сравнение — за постоянное время.
 */
@RestController
@RequestMapping("/internal")
class InternalController(
    private val auth: AuthService,
    @Value("\${security.notifier-service-token}") private val serviceToken: String,
) {
    @GetMapping("/users/{id}/contact")
    fun contact(@PathVariable id: UUID, @RequestHeader("X-Service-Token", required = false) token: String?): Map<String, String> {
        if (token == null || serviceToken.isBlank() || !Hashing.constantTimeEquals(token, serviceToken)) {
            throw Errors.forbidden("Вызывающий сервис не опознан")
        }
        return auth.contactOf(id) ?: throw Errors.notFound()
    }
}
