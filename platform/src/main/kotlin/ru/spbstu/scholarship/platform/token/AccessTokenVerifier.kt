package ru.spbstu.scholarship.platform.token

import com.nimbusds.jose.JOSEObjectType
import com.nimbusds.jose.JWSAlgorithm
import com.nimbusds.jose.crypto.RSASSAVerifier
import com.nimbusds.jwt.SignedJWT
import java.security.interfaces.RSAPublicKey
import java.time.Clock
import java.time.Instant
import java.util.UUID

/** Полезная нагрузка токена доступа после проверки. Никаких ПДн — только идентификаторы. */
data class AccessToken(
    val subject: UUID,      // sub — идентификатор пользователя
    val sessionId: String,  // sid — сессия в Redis, по ней работает отзыв
    val tokenId: String,    // jti
    val roles: Set<String>, // roles — коды ролей из user_roles
    val unitId: UUID?,      // unit_id — подразделение (подсказка; права на объект проверяются по БД)
    val expiresAt: Instant,
)

class InvalidTokenException(reason: String) : RuntimeException(reason)

/**
 * Проверка токена доступа. Используется шлюзом И каждым сервисом самостоятельно
 * (B-04: сервис проверяет токен сам и не доверяет шлюзу).
 *
 * Порядок проверок:
 *  1. алгоритм строго RS256 — токены с alg=none или HS256 (подмена алгоритма) отклоняются;
 *  2. тип токена в заголовке — at+jwt (refresh-токен или чужой JWT не пройдёт);
 *  3. подпись открытым ключом auth-service; закрытого ключа у проверяющих нет,
 *     поэтому выпустить токен может только auth-service;
 *  4. iss, aud, exp, nbf/iat с допуском расхождения часов 30 с;
 *  5. обязательные утверждения sub, sid, jti, roles.
 */
class AccessTokenVerifier(
    publicKey: RSAPublicKey,
    private val issuer: String = ISSUER,
    private val audience: String = AUDIENCE,
    private val clock: Clock = Clock.systemUTC(),
) {
    private val verifier = RSASSAVerifier(publicKey)

    fun verify(raw: String): AccessToken {
        val jwt = try {
            SignedJWT.parse(raw)
        } catch (e: Exception) {
            throw InvalidTokenException("malformed")
        }
        val header = jwt.header
        if (header.algorithm != JWSAlgorithm.RS256) throw InvalidTokenException("alg")
        if (header.type != TOKEN_TYPE) throw InvalidTokenException("typ")
        if (!jwt.verify(verifier)) throw InvalidTokenException("signature")

        val claims = jwt.jwtClaimsSet
        val now = clock.instant()
        if (claims.issuer != issuer) throw InvalidTokenException("iss")
        if (audience !in (claims.audience ?: emptyList())) throw InvalidTokenException("aud")
        val exp = claims.expirationTime?.toInstant() ?: throw InvalidTokenException("exp")
        if (now.isAfter(exp.plusSeconds(SKEW_SECONDS))) throw InvalidTokenException("expired")
        claims.notBeforeTime?.toInstant()?.let { if (now.plusSeconds(SKEW_SECONDS).isBefore(it)) throw InvalidTokenException("nbf") }
        claims.issueTime?.toInstant()?.let { if (now.plusSeconds(SKEW_SECONDS).isBefore(it)) throw InvalidTokenException("iat") }

        val sub = claims.subject?.let { runCatching { UUID.fromString(it) }.getOrNull() }
            ?: throw InvalidTokenException("sub")
        val sid = claims.getStringClaim("sid") ?: throw InvalidTokenException("sid")
        val jti = claims.jwtid ?: throw InvalidTokenException("jti")
        val roles = claims.getStringListClaim("roles")?.toSet() ?: throw InvalidTokenException("roles")
        val unit = claims.getStringClaim("unit_id")?.let { runCatching { UUID.fromString(it) }.getOrNull() }
        return AccessToken(sub, sid, jti, roles, unit, exp)
    }

    companion object {
        const val ISSUER = "scholarship-auth"
        const val AUDIENCE = "scholarship-api"
        const val SKEW_SECONDS = 30L
        val TOKEN_TYPE = JOSEObjectType("at+jwt")
    }
}
