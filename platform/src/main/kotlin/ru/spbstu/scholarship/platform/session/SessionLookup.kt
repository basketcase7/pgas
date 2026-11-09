package ru.spbstu.scholarship.platform.session

import org.springframework.data.redis.core.StringRedisTemplate
import java.time.Instant

/**
 * Чтение сессий из Redis (B-06). Сессию создаёт и удаляет только auth-service;
 * остальные сервисы имеют к префиксу session:* доступ только на чтение (ACL %R~).
 */
interface SessionLookup {
    fun isActive(sessionId: String): Boolean
    /** Время последнего повторного ввода пароля (для OP-05), если было. */
    fun reauthAt(sessionId: String): Instant?
}

class RedisSessionLookup(private val redis: StringRedisTemplate) : SessionLookup {
    override fun isActive(sessionId: String): Boolean = redis.hasKey(key(sessionId))

    override fun reauthAt(sessionId: String): Instant? =
        redis.opsForHash<String, String>().get(key(sessionId), "reauth_at")
            ?.toLongOrNull()?.let { Instant.ofEpochSecond(it) }

    companion object {
        fun key(sid: String) = "session:$sid"
    }
}
