package ru.spbstu.scholarship.platform.audit

import com.fasterxml.jackson.databind.ObjectMapper
import org.springframework.jdbc.core.namedparam.MapSqlParameterSource
import org.springframework.jdbc.core.namedparam.NamedParameterJdbcTemplate
import org.springframework.transaction.PlatformTransactionManager
import org.springframework.transaction.TransactionDefinition
import org.springframework.transaction.support.TransactionTemplate
import ru.spbstu.scholarship.platform.web.RequestIds
import java.util.UUID

enum class AuditResult(val db: String) { SUCCESS("success"), DENIED("denied"), ERROR("error") }

/**
 * Запись в audit_log. У ролей сервисов есть только INSERT — изменить или удалить
 * запись прикладной код не может.
 *  - success пишется в ТЕКУЩЕЙ транзакции: изменение данных и запись о нём фиксируются
 *    или откатываются вместе (OP-03, OP-05 — «иначе возможно изменение без записи в журнале»);
 *  - denied/error пишется в ОТДЕЛЬНОЙ транзакции (REQUIRES_NEW): отказ сопровождается
 *    исключением и откатом основной транзакции, но след попытки должен остаться.
 * В details не пишутся текст заявки, пароли и токены.
 */
class AuditLog(
    private val jdbc: NamedParameterJdbcTemplate,
    private val om: ObjectMapper,
    txManager: PlatformTransactionManager,
) {
    private val independentTx = TransactionTemplate(txManager).apply {
        propagationBehavior = TransactionDefinition.PROPAGATION_REQUIRES_NEW
    }

    fun write(
        action: String,
        objectType: String,
        objectId: UUID?,
        actorId: UUID?,
        result: AuditResult = AuditResult.SUCCESS,
        details: Map<String, Any?> = emptyMap(),
        requestId: UUID = RequestIds.current(),
    ) {
        val insert = {
            jdbc.update(
                """
                INSERT INTO audit_log (actor_id, action, object_type, object_id, request_id, result, details)
                VALUES (:actor, :action, :otype, :oid, :rid, :result, CAST(:details AS jsonb))
                """.trimIndent(),
                MapSqlParameterSource()
                    .addValue("actor", actorId)
                    .addValue("action", action)
                    .addValue("otype", objectType)
                    .addValue("oid", objectId)
                    .addValue("rid", requestId)
                    .addValue("result", result.db)
                    .addValue("details", if (details.isEmpty()) null else om.writeValueAsString(details)),
            )
        }
        if (result == AuditResult.SUCCESS) insert() else independentTx.executeWithoutResult { insert() }
    }
}
