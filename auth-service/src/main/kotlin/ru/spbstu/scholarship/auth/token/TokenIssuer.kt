package ru.spbstu.scholarship.auth.token

import com.nimbusds.jose.JWSAlgorithm
import com.nimbusds.jose.JWSHeader
import com.nimbusds.jose.crypto.RSASSASigner
import com.nimbusds.jwt.JWTClaimsSet
import com.nimbusds.jwt.SignedJWT
import org.springframework.beans.factory.annotation.Value
import org.springframework.stereotype.Component
import ru.spbstu.scholarship.platform.token.AccessTokenVerifier
import ru.spbstu.scholarship.platform.token.Pem
import java.security.SecureRandom
import java.time.Duration
import java.time.Instant
import java.util.Base64
import java.util.Date
import java.util.UUID

/**
 * Выпуск токенов (политика токенов, см. отчёт, раздел 2.4):
 *  - токен доступа — JWT RS256, срок 10 минут, хранится у клиента только в памяти;
 *    полезная нагрузка: iss, aud, sub, sid, jti, roles, unit_id, iat, nbf, exp — без ФИО и e-mail;
 *  - токен обновления — случайные 256 бит (не JWT), в браузере — cookie HttpOnly; Secure;
 *    SameSite=Strict; Path=/api/v1/auth; на сервере хранится только его SHA-256 (Redis).
 * Закрытый ключ есть только у auth-service, остальные сервисы проверяют подпись открытым.
 */
@Component
class TokenIssuer(
    @Value("\${security.jwt.private-key-b64}") privateKeyB64: String,
    @Value("\${security.jwt.access-ttl}") val accessTtl: Duration,
) {
    private val signer = RSASSASigner(Pem.privateKeyFromEnvValue(privateKeyB64))
    private val random = SecureRandom()

    fun issueAccess(userId: UUID, sessionId: String, roles: Collection<String>, unitId: UUID?): String {
        val now = Instant.now()
        val claims = JWTClaimsSet.Builder()
            .issuer(AccessTokenVerifier.ISSUER)
            .audience(AccessTokenVerifier.AUDIENCE)
            .subject(userId.toString())
            .jwtID(UUID.randomUUID().toString())
            .issueTime(Date.from(now))
            .notBeforeTime(Date.from(now))
            .expirationTime(Date.from(now.plus(accessTtl)))
            .claim("sid", sessionId)
            .claim("roles", roles.sorted())
            .claim("unit_id", unitId?.toString())
            .build()
        val header = JWSHeader.Builder(JWSAlgorithm.RS256).type(AccessTokenVerifier.TOKEN_TYPE).keyID("auth-1").build()
        return SignedJWT(header, claims).apply { sign(signer) }.serialize()
    }

    /** Случайное значение для токена обновления / кода восстановления / идентификатора сессии. */
    fun randomToken(bytes: Int = 32): String {
        val b = ByteArray(bytes).also { random.nextBytes(it) }
        return Base64.getUrlEncoder().withoutPadding().encodeToString(b)
    }
}
