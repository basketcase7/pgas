package ru.spbstu.scholarship.platform.web

import com.fasterxml.jackson.databind.ObjectMapper
import jakarta.servlet.FilterChain
import jakarta.servlet.http.HttpServletRequest
import jakarta.servlet.http.HttpServletResponse
import org.slf4j.LoggerFactory
import org.slf4j.MDC
import org.springframework.web.context.request.RequestContextHolder
import org.springframework.web.context.request.ServletRequestAttributes
import org.springframework.web.filter.OncePerRequestFilter
import ru.spbstu.scholarship.platform.security.AuthUser
import ru.spbstu.scholarship.platform.session.SessionLookup
import ru.spbstu.scholarship.platform.token.AccessTokenVerifier
import ru.spbstu.scholarship.platform.token.InvalidTokenException
import java.util.UUID

object RequestIds {
    const val HEADER = "X-Request-Id"
    const val ATTR = "platform.requestId"
    fun current(req: HttpServletRequest?): UUID? = req?.getAttribute(ATTR) as UUID?
    fun current(): UUID {
        val req = (RequestContextHolder.getRequestAttributes() as? ServletRequestAttributes)?.request
        return current(req) ?: UUID.randomUUID()
    }
}

/**
 * Идентификатор запроса для журнала аудита (audit_log.request_id) и логов.
 * Значение от шлюза принимается, только если это корректный UUID; иначе генерируется своё.
 * Это не элемент безопасности — подделка request_id не даёт прав.
 */
class RequestIdFilter : OncePerRequestFilter() {
    override fun doFilterInternal(req: HttpServletRequest, res: HttpServletResponse, chain: FilterChain) {
        val id = req.getHeader(RequestIds.HEADER)?.let { runCatching { UUID.fromString(it) }.getOrNull() }
            ?: UUID.randomUUID()
        req.setAttribute(RequestIds.ATTR, id)
        res.setHeader(RequestIds.HEADER, id.toString())
        MDC.put("request_id", id.toString())
        try {
            chain.doFilter(req, res)
        } finally {
            MDC.remove("request_id")
        }
    }
}

/**
 * Аутентификация в самом сервисе (граница TB-02, B-04).
 * Сервис не доверяет шлюзу и заголовкам вида X-User-*: субъект определяется
 * только по подписанному токену, а действительность сессии — по Redis (отзыв при выходе).
 * Просроченный, подделанный, отозванный токен → 401.
 */
class AuthenticationFilter(
    private val verifier: AccessTokenVerifier,
    private val sessions: SessionLookup,
    private val objectMapper: ObjectMapper,
    private val publicPaths: List<String>,
) : OncePerRequestFilter() {
    private val log = LoggerFactory.getLogger(AuthenticationFilter::class.java)

    override fun shouldNotFilter(req: HttpServletRequest): Boolean {
        val path = req.requestURI
        return path.startsWith("/actuator") || path.startsWith("/internal/") ||
            publicPaths.any { path == it || path.startsWith("$it/") }
    }

    override fun doFilterInternal(req: HttpServletRequest, res: HttpServletResponse, chain: FilterChain) {
        val header = req.getHeader("Authorization")
        if (header == null || !header.startsWith("Bearer ", ignoreCase = true)) {
            return reject(req, res, "missing_token")
        }
        val token = try {
            verifier.verify(header.substring(7).trim())
        } catch (e: InvalidTokenException) {
            log.info("Токен отклонён: {}", e.message)
            return reject(req, res, "invalid_token")
        }
        val active = try {
            sessions.isActive(token.sessionId)
        } catch (e: Exception) {
            // хранилище сессий недоступно — отказ (fail closed), а не пропуск
            log.error("Нет связи с хранилищем сессий", e)
            res.status = 503
            res.contentType = "application/json;charset=UTF-8"
            objectMapper.writeValue(res.outputStream, mapOf("error" to "unavailable",
                "message" to "Сервис временно недоступен", "request_id" to RequestIds.current(req)?.toString()))
            return
        }
        if (!active) return reject(req, res, "session_revoked")

        req.setAttribute(AUTH_ATTR, AuthUser(token.subject, token.sessionId, token.roles, token.unitId))
        MDC.put("actor_id", token.subject.toString())
        try {
            chain.doFilter(req, res)
        } finally {
            MDC.remove("actor_id")
        }
    }

    private fun reject(req: HttpServletRequest, res: HttpServletResponse, code: String) {
        res.status = 401
        res.setHeader("WWW-Authenticate", "Bearer")
        res.contentType = "application/json;charset=UTF-8"
        objectMapper.writeValue(res.outputStream, mapOf("error" to code,
            "message" to "Требуется действующий токен доступа", "request_id" to RequestIds.current(req)?.toString()))
    }

    companion object { const val AUTH_ATTR = "platform.authUser" }
}
