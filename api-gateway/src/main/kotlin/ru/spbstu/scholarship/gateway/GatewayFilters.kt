package ru.spbstu.scholarship.gateway

import org.slf4j.LoggerFactory
import org.springframework.beans.factory.annotation.Value
import org.springframework.cloud.gateway.filter.GatewayFilterChain
import org.springframework.cloud.gateway.filter.GlobalFilter
import org.springframework.core.Ordered
import org.springframework.data.redis.core.ReactiveStringRedisTemplate
import org.springframework.http.HttpHeaders
import org.springframework.http.HttpMethod
import org.springframework.http.HttpStatus
import org.springframework.http.MediaType
import org.springframework.stereotype.Component
import org.springframework.web.server.ServerWebExchange
import reactor.core.publisher.Mono
import ru.spbstu.scholarship.platform.token.AccessTokenVerifier
import ru.spbstu.scholarship.platform.token.InvalidTokenException
import java.time.Duration
import java.time.Instant
import java.util.UUID

private const val ATTR_SUBJECT = "gw.subject"
private const val ATTR_CLIENT_IP = "gw.clientIp"

/** Ответ шлюза об ошибке в том же формате, что и у сервисов; без внутренних подробностей. */
fun ServerWebExchange.reject(status: HttpStatus, code: String, message: String, extra: Map<String, String> = emptyMap()): Mono<Void> {
    val res = response
    res.statusCode = status
    res.headers.contentType = MediaType.APPLICATION_JSON
    extra.forEach { (k, v) -> res.headers.set(k, v) }
    val rid = request.headers.getFirst("X-Request-Id") ?: ""
    val body = """{"error":"$code","message":"$message","request_id":"$rid"}""".toByteArray(Charsets.UTF_8)
    return res.writeWith(Mono.just(res.bufferFactory().wrap(body)))
}

/**
 * 1. Гигиена запроса: свой X-Request-Id (значение клиента не принимается), удаление
 *    заголовков, которыми клиент мог бы «представиться» сервису, определение IP клиента,
 *    защитные заголовки ответа.
 */
@Component
class RequestHygieneFilter(@Value("\${gateway.trusted-proxies:}") trusted: String) : GlobalFilter, Ordered {
    private val trustedProxies = trusted.split(',').map { it.trim() }.filter { it.isNotEmpty() }.toSet()
    override fun getOrder() = -300

    override fun filter(exchange: ServerWebExchange, chain: GatewayFilterChain): Mono<Void> {
        val remote = exchange.request.remoteAddress?.address?.hostAddress ?: "unknown"
        // X-Real-IP учитывается только от nginx клиентских контейнеров (фиксированные адреса)
        val clientIp = if (remote in trustedProxies) exchange.request.headers.getFirst("X-Real-IP") ?: remote else remote
        exchange.attributes[ATTR_CLIENT_IP] = clientIp
        val request = exchange.request.mutate().headers { h ->
            listOf("X-Request-Id", "X-User-Id", "X-User-Roles", "X-Authenticated-User", "X-Service-Token").forEach { h.remove(it) }
            h.set("X-Request-Id", UUID.randomUUID().toString())
        }.build()
        val ex = exchange.mutate().request(request).build()
        ex.response.beforeCommit {
            val h = ex.response.headers
            h.set("X-Request-Id", request.headers.getFirst("X-Request-Id"))
            h.set("Strict-Transport-Security", "max-age=31536000")
            h.set("X-Content-Type-Options", "nosniff")
            h.set("X-Frame-Options", "DENY")
            if (!h.containsKey(HttpHeaders.CACHE_CONTROL)) h.set(HttpHeaders.CACHE_CONTROL, "no-store")
            Mono.empty()
        }
        return chain.filter(ex)
    }
}

/**
 * 2. Ограничение размера тела (B-01): 64 КБ для всех операций, 1 МБ — для реестра выплат (OP-05).
 * Тело без Content-Length (chunked) на изменяющих методах не принимается.
 */
@Component
class BodySizeFilter : GlobalFilter, Ordered {
    override fun getOrder() = -250

    override fun filter(exchange: ServerWebExchange, chain: GatewayFilterChain): Mono<Void> {
        val req = exchange.request
        if (req.method !in setOf(HttpMethod.POST, HttpMethod.PUT, HttpMethod.PATCH)) return chain.filter(exchange)
        val limit = if (req.path.value().endsWith("/payout-registry")) 1_048_576L else 65_536L
        val length = req.headers.contentLength
        if (length < 0 && req.headers.getFirst(HttpHeaders.TRANSFER_ENCODING) != null) {
            return exchange.reject(HttpStatus.LENGTH_REQUIRED, "length_required", "Требуется заголовок Content-Length")
        }
        if (length > limit) return exchange.reject(HttpStatus.PAYLOAD_TOO_LARGE, "payload_too_large", "Превышен допустимый размер тела запроса")
        return chain.filter(exchange)
    }
}

/**
 * 3. Первичная проверка токена на шлюзе: подпись, алгоритм, срок. Запрос с негодным токеном
 * не доходит до сервисов. Это НЕ замена проверке в сервисе: сервис проверяет токен заново
 * и дополнительно сверяет сессию в Redis (B-04, «шлюзу не доверяет»).
 * Токен передаётся сервису в исходном виде; заголовков с ролью шлюз не добавляет.
 */
@Component
class JwtFilter(private val verifier: AccessTokenVerifier) : GlobalFilter, Ordered {
    private val log = LoggerFactory.getLogger(JwtFilter::class.java)
    private val publicPaths = setOf(
        "/api/v1/auth/login", "/api/v1/auth/refresh", "/api/v1/auth/register",
        "/api/v1/auth/password-reset", "/api/v1/auth/password-reset/confirm",
    )
    override fun getOrder() = -200

    override fun filter(exchange: ServerWebExchange, chain: GatewayFilterChain): Mono<Void> {
        val path = exchange.request.path.value()
        if (!path.startsWith("/api/") || path in publicPaths) return chain.filter(exchange)
        val header = exchange.request.headers.getFirst(HttpHeaders.AUTHORIZATION)
        if (header == null || !header.startsWith("Bearer ", ignoreCase = true)) {
            return exchange.reject(HttpStatus.UNAUTHORIZED, "missing_token", "Требуется действующий токен доступа", mapOf("WWW-Authenticate" to "Bearer"))
        }
        return try {
            val token = verifier.verify(header.substring(7).trim())
            exchange.attributes[ATTR_SUBJECT] = token.subject.toString()
            chain.filter(exchange)
        } catch (e: InvalidTokenException) {
            log.info("Шлюз отклонил токен: {}", e.message)
            exchange.reject(HttpStatus.UNAUTHORIZED, "invalid_token", "Требуется действующий токен доступа", mapOf("WWW-Authenticate" to "Bearer"))
        }
    }
}

/**
 * 4. Ограничение частоты (B-01, «Ограничения частоты» в контрактах). Счётчики — в Redis
 * (ключи rl:*, фиксированное окно, INCR + EXPIRE). Ключ — субъект токена, для
 * анонимных операций — IP клиента.
 */
@Component
class RateLimitFilter(private val redis: ReactiveStringRedisTemplate) : GlobalFilter, Ordered {
    private val log = LoggerFactory.getLogger(RateLimitFilter::class.java)
    override fun getOrder() = -100

    data class Rule(val name: String, val method: HttpMethod?, val path: Regex, val limit: Long, val window: Duration, val byIp: Boolean)

    private val uuid = "[0-9a-fA-F-]{36}"
    private val rules = listOf(
        Rule("login", HttpMethod.POST, Regex("^/api/v1/auth/login$"), 20, Duration.ofMinutes(1), true),
        Rule("register", HttpMethod.POST, Regex("^/api/v1/auth/register$"), 5, Duration.ofHours(1), true),
        Rule("pwreset", HttpMethod.POST, Regex("^/api/v1/auth/password-reset(/confirm)?$"), 10, Duration.ofHours(1), true),
        Rule("refresh", HttpMethod.POST, Regex("^/api/v1/auth/refresh$"), 30, Duration.ofMinutes(1), true),
        Rule("app-read", HttpMethod.GET, Regex("^/api/v1/applications/$uuid$"), 60, Duration.ofMinutes(1), false),      // OP-01
        Rule("app-create", HttpMethod.POST, Regex("^/api/v1/applications$"), 5, Duration.ofHours(1), false),            // OP-02
        Rule("app-review", HttpMethod.PATCH, Regex("^/api/v1/applications/$uuid/review$"), 120, Duration.ofMinutes(1), false), // OP-03
        Rule("app-list", HttpMethod.GET, Regex("^/api/v1/applications$"), 60, Duration.ofMinutes(1), false),            // OP-04
        Rule("payout", HttpMethod.POST, Regex("^/api/v1/campaigns/$uuid/payout-registry$"), 5, Duration.ofHours(1), false), // OP-05
        Rule("completeness", HttpMethod.POST, Regex("^/api/v1/applications/$uuid/completeness-check$"), 10, Duration.ofHours(1), false), // OP-06
        Rule("default", null, Regex("^/api/.*"), 300, Duration.ofMinutes(1), false),
    )

    override fun filter(exchange: ServerWebExchange, chain: GatewayFilterChain): Mono<Void> {
        val req = exchange.request
        val path = req.path.value()
        val rule = rules.firstOrNull { (it.method == null || it.method == req.method) && it.path.matches(path) }
            ?: return chain.filter(exchange)
        val who = if (rule.byIp) "ip:" + exchange.attributes[ATTR_CLIENT_IP]
        else (exchange.attributes[ATTR_SUBJECT] as String?)?.let { "sub:$it" } ?: ("ip:" + exchange.attributes[ATTR_CLIENT_IP])
        val now = Instant.now().epochSecond
        val windowSec = rule.window.seconds
        val bucket = now / windowSec
        val key = "rl:${rule.name}:$who:$bucket"
        return redis.opsForValue().increment(key)
            .flatMap { n -> (if (n == 1L) redis.expire(key, rule.window.plusSeconds(5)) else Mono.just(true)).thenReturn(n) }
            .flatMap { n ->
                if (n > rule.limit) {
                    val retry = (bucket + 1) * windowSec - now
                    log.warn("Превышен лимит {} для {}", rule.name, who)
                    exchange.reject(HttpStatus.TOO_MANY_REQUESTS, "rate_limited", "Превышена частота запросов",
                        mapOf(HttpHeaders.RETRY_AFTER to retry.toString()))
                } else chain.filter(exchange)
            }
            // недоступность Redis не блокирует работу системы: лимит — защита от перегрузки,
            // а не контроль доступа (аутентификация и авторизация от Redis-счётчиков не зависят)
            .onErrorResume({ it !is org.springframework.web.server.ResponseStatusException && it is org.springframework.dao.DataAccessException }) {
                log.error("Redis недоступен, ограничение частоты пропущено", it)
                chain.filter(exchange)
            }
    }
}
