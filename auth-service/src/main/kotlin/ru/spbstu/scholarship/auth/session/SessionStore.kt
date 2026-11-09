package ru.spbstu.scholarship.auth.session

import org.springframework.beans.factory.annotation.Value
import org.springframework.data.redis.core.StringRedisTemplate
import org.springframework.stereotype.Component
import ru.spbstu.scholarship.platform.util.Hashing
import java.time.Duration
import java.time.Instant
import java.util.UUID

/**
 * Сессии и токены обновления в Redis (B-06). Ключи:
 *   session:{sid}            hash {user_id, created_at, reauth_at, refresh_hash}, TTL 8 ч (абсолютный)
 *   user-sessions:{user_id}  set идентификаторов сессий — для отзыва всех сессий при смене пароля
 *   refresh:{sha256}         → sid; TTL = остаток жизни сессии
 *   refresh-used:{sha256}    → sid; использованный (ротированный) токен — для обнаружения повторного использования
 * Сам токен обновления в Redis не хранится — только его SHA-256.
 */
@Component
class SessionStore(
    private val redis: StringRedisTemplate,
    @Value("\${security.session-ttl}") private val sessionTtl: Duration,
) {
    data class Session(val sid: String, val userId: UUID)

    fun create(sid: String, userId: UUID, refreshToken: String) {
        val key = sessionKey(sid)
        val hash = Hashing.sha256Hex(refreshToken)
        redis.opsForHash<String, String>().putAll(key, mapOf(
            "user_id" to userId.toString(),
            "created_at" to Instant.now().epochSecond.toString(),
            "refresh_hash" to hash,
        ))
        redis.expire(key, sessionTtl)
        redis.opsForSet().add(userSessionsKey(userId), sid)
        redis.expire(userSessionsKey(userId), sessionTtl)
        redis.opsForValue().set("refresh:$hash", sid, sessionTtl)
    }

    sealed interface RotateResult {
        data class Ok(val session: Session) : RotateResult
        data object Invalid : RotateResult
        data class Reused(val sid: String) : RotateResult
    }

    /**
     * Ротация токена обновления: старый токен удаляется атомарно (GETDEL) и больше не действует.
     * Если предъявлен уже использованный токен — вероятна кража; вся сессия отзывается.
     */
    fun rotate(oldToken: String, newToken: String): RotateResult {
        val oldHash = Hashing.sha256Hex(oldToken)
        val sid = redis.opsForValue().getAndDelete("refresh:$oldHash")
        if (sid == null) {
            val reusedSid = redis.opsForValue().get("refresh-used:$oldHash")
            return if (reusedSid != null) RotateResult.Reused(reusedSid) else RotateResult.Invalid
        }
        val key = sessionKey(sid)
        val userId = redis.opsForHash<String, String>().get(key, "user_id") ?: return RotateResult.Invalid
        val ttl = redis.getExpire(key).takeIf { it > 0 }?.let { Duration.ofSeconds(it) } ?: return RotateResult.Invalid
        val newHash = Hashing.sha256Hex(newToken)
        redis.opsForValue().set("refresh-used:$oldHash", sid, ttl)
        redis.opsForValue().set("refresh:$newHash", sid, ttl)
        redis.opsForHash<String, String>().put(key, "refresh_hash", newHash)
        return RotateResult.Ok(Session(sid, UUID.fromString(userId)))
    }

    fun remainingTtl(sid: String): Duration =
        redis.getExpire(sessionKey(sid)).takeIf { it > 0 }?.let { Duration.ofSeconds(it) } ?: Duration.ZERO

    fun markReauthenticated(sid: String) {
        redis.opsForHash<String, String>().put(sessionKey(sid), "reauth_at", Instant.now().epochSecond.toString())
    }

    /** Отзыв сессии: после удаления ключа любой токен доступа с этим sid отклоняется сервисами (401). */
    fun revoke(sid: String) {
        val key = sessionKey(sid)
        val h = redis.opsForHash<String, String>()
        h.get(key, "refresh_hash")?.let { redis.delete("refresh:$it") }
        h.get(key, "user_id")?.let { redis.opsForSet().remove(userSessionsKey(UUID.fromString(it)), sid) }
        redis.delete(key)
    }

    fun revokeAll(userId: UUID): Int {
        val sids = redis.opsForSet().members(userSessionsKey(userId)) ?: emptySet()
        sids.forEach { revoke(it) }
        redis.delete(userSessionsKey(userId))
        return sids.size
    }

    private fun sessionKey(sid: String) = "session:$sid"
    private fun userSessionsKey(userId: UUID) = "user-sessions:$userId"
}
