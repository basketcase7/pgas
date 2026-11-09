package ru.spbstu.scholarship.platform.idempotency

import org.springframework.jdbc.core.namedparam.MapSqlParameterSource
import org.springframework.jdbc.core.namedparam.NamedParameterJdbcTemplate
import ru.spbstu.scholarship.platform.web.Errors
import java.util.UUID

data class StoredResponse(val requestHash: String, val code: Int, val body: String)

/**
 * Ключи идемпотентности (таблица idempotency_keys, п. 3.3 ЛР2).
 * Ключ действует в пределах пары (субъект, эндпоинт): чужой ключ не даёт прочитать
 * сохранённый ответ другого пользователя.
 */
class IdempotencyStore(private val jdbc: NamedParameterJdbcTemplate) {

    /**
     * Сериализует обработку запросов с одним ключом: транзакционная advisory-блокировка
     * держится до COMMIT, второй параллельный запрос ждёт и затем видит сохранённый ответ.
     */
    fun lock(key: UUID, userId: UUID, endpoint: String) {
        jdbc.queryForList(
            "SELECT pg_advisory_xact_lock(hashtextextended(:k, 0))",
            MapSqlParameterSource("k", "$endpoint|$userId|$key"),
        )
    }

    fun find(key: UUID, userId: UUID, endpoint: String): StoredResponse? =
        jdbc.query(
            """
            SELECT request_hash, response_code, response_body::text AS body
            FROM idempotency_keys
            WHERE key = :key AND user_id = :uid AND endpoint = :ep AND expires_at > now()
            """.trimIndent(),
            MapSqlParameterSource().addValue("key", key).addValue("uid", userId).addValue("ep", endpoint),
        ) { rs, _ -> StoredResponse(rs.getString("request_hash"), rs.getInt("response_code"), rs.getString("body")) }
            .firstOrNull()

    /** Повтор с тем же ключом, но другим телом — ошибка клиента, а не повод создать второй объект. */
    fun findReplay(key: UUID, userId: UUID, endpoint: String, requestHash: String): StoredResponse? {
        val stored = find(key, userId, endpoint) ?: return null
        if (stored.requestHash != requestHash) {
            throw Errors.unprocessable("Idempotency-Key уже использован с другим содержимым запроса", "idempotency_key_reused")
        }
        return stored
    }

    fun save(key: UUID, userId: UUID, endpoint: String, requestHash: String, code: Int, bodyJson: String) {
        // устаревшая запись с тем же ключом (expires_at прошёл) удаляется, затем сохраняется новая
        val p = MapSqlParameterSource().addValue("key", key).addValue("uid", userId).addValue("ep", endpoint)
            .addValue("hash", requestHash).addValue("code", code).addValue("body", bodyJson)
        jdbc.update("DELETE FROM idempotency_keys WHERE key = :key AND user_id = :uid AND endpoint = :ep AND expires_at <= now()", p)
        jdbc.update(
            """
            INSERT INTO idempotency_keys (key, user_id, endpoint, request_hash, response_code, response_body)
            VALUES (:key, :uid, :ep, :hash, :code, CAST(:body AS jsonb))
            """.trimIndent(), p,
        )
    }

    companion object {
        /** Разбор заголовка Idempotency-Key: обязателен и должен быть UUID. */
        fun parseKey(raw: String?, missing: () -> Nothing): UUID {
            if (raw.isNullOrBlank()) missing()
            return runCatching { UUID.fromString(raw.trim()) }.getOrNull()
                ?: throw Errors.badRequest("Idempotency-Key должен быть UUID")
        }
    }
}
