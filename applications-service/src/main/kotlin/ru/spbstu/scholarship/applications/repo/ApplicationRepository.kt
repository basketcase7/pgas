package ru.spbstu.scholarship.applications.repo

import org.springframework.jdbc.core.namedparam.MapSqlParameterSource
import org.springframework.jdbc.core.namedparam.NamedParameterJdbcTemplate
import org.springframework.stereotype.Repository
import ru.spbstu.scholarship.applications.domain.ListSort
import java.math.BigDecimal
import java.sql.ResultSet
import java.time.OffsetDateTime
import java.util.UUID

data class ApplicationRow(
    val id: UUID, val applicantId: UUID, val campaignId: UUID, val type: String, val status: String,
    val statement: String, val grounds: List<String>, val submittedAt: OffsetDateTime?, val version: Int,
    val resultsPublished: Boolean,
)

data class OwnApplication(
    val id: UUID, val campaignId: UUID, val status: String, val version: Int, val campaignOpen: Boolean,
)

data class CampaignRow(val id: UUID, val type: String, val open: Boolean, val unitId: UUID)

data class ListRow(
    val id: UUID, val status: String, val type: String, val createdAt: OffsetDateTime,
    val applicantName: String, val totalScore: BigDecimal,
)

data class ListFilter(
    val own: Boolean, val unit: Boolean, val subject: UUID,
    val campaignId: UUID?, val status: String?, val type: String?,
    val sort: ListSort, val limit: Int,
    val cursorTs: OffsetDateTime?, val cursorScore: BigDecimal?, val cursorId: UUID?,
)

/**
 * SQL-доступ к заявкам. Все значения передаются параметрами (:name) — склейки
 * пользовательского ввода в текст запроса нет. Права на объект — в WHERE самого запроса.
 */
@Repository
class ApplicationRepository(private val jdbc: NamedParameterJdbcTemplate) {

    /**
     * OP-01: выборка с проверкой принадлежности ОДНИМ запросом (диаграмма последовательности 1):
     *   :own  — заявитель видит только applicant_id = sub;
     *   :unit — сотрудник/комиссия/поддержка видят заявки кампаний своего подразделения.
     * Чужая заявка и несуществующая дают одинаковый результат — ноль строк.
     */
    fun findVisible(id: UUID, subject: UUID, own: Boolean, unit: Boolean): ApplicationRow? = jdbc.query(
        """
        SELECT a.id, a.applicant_id, a.campaign_id, a.type::text AS type, a.status::text AS status,
               a.statement, a.declared_grounds::text[] AS grounds, a.submitted_at, a.version,
               EXISTS (SELECT 1 FROM protocols p WHERE p.campaign_id = a.campaign_id) AS results_published
        FROM applications a
        JOIN campaigns c ON c.id = a.campaign_id
        WHERE a.id = :id
          AND (   (:own  AND a.applicant_id = :sub)
               OR (:unit AND c.unit_id = (SELECT u.unit_id FROM users u WHERE u.id = :sub)) )
        """.trimIndent(),
        MapSqlParameterSource().addValue("id", id).addValue("sub", subject).addValue("own", own).addValue("unit", unit),
    ) { rs, _ ->
        ApplicationRow(
            rs.uuid("id"), rs.uuid("applicant_id"), rs.uuid("campaign_id"), rs.getString("type"),
            rs.getString("status"), rs.getString("statement"),
            (rs.getArray("grounds").array as Array<*>).map { it.toString() },
            rs.getObject("submitted_at", OffsetDateTime::class.java), rs.getInt("version"),
            rs.getBoolean("results_published"),
        )
    }.firstOrNull()

    fun scoresOf(applicationId: UUID): List<Map<String, Any>> = jdbc.query(
        """
        SELECT s.criterion_id, c.code, c.title, s.value, c.max_score
        FROM application_scores s JOIN criteria c ON c.id = s.criterion_id
        WHERE s.application_id = :id ORDER BY c.code
        """.trimIndent(), MapSqlParameterSource("id", applicationId),
    ) { rs, _ ->
        mapOf("criterion_id" to rs.uuid("criterion_id"), "code" to rs.getString("code"), "title" to rs.getString("title"),
            "value" to rs.getBigDecimal("value"), "max_score" to rs.getBigDecimal("max_score"))
    }

    data class AttachmentRow(val id: UUID, val docType: String, val fileName: String, val sizeBytes: Long, val objectKey: String, val uploadedAt: OffsetDateTime)

    fun attachmentsOf(applicationId: UUID): List<AttachmentRow> = jdbc.query(
        """
        SELECT id, doc_type::text AS doc_type, file_name, size_bytes, object_key, uploaded_at
        FROM attachments WHERE application_id = :id ORDER BY uploaded_at
        """.trimIndent(), MapSqlParameterSource("id", applicationId),
    ) { rs, _ ->
        AttachmentRow(rs.uuid("id"), rs.getString("doc_type"), rs.getString("file_name"), rs.getLong("size_bytes"),
            rs.getString("object_key"), rs.getObject("uploaded_at", OffsetDateTime::class.java))
    }

    fun externalIdOf(userId: UUID): String? = jdbc.query(
        "SELECT external_id FROM users WHERE id = :id", MapSqlParameterSource("id", userId),
    ) { rs, _ -> rs.getString(1) }.firstOrNull()

    /** Окно приёма вычисляется по часам СЕРВЕРА БД (now()), а не по времени клиента. */
    fun campaign(id: UUID): CampaignRow? = jdbc.query(
        """
        SELECT id, type::text AS type, unit_id, (now() BETWEEN accepts_from AND accepts_until) AS open
        FROM campaigns WHERE id = :id
        """.trimIndent(), MapSqlParameterSource("id", id),
    ) { rs, _ -> CampaignRow(rs.uuid("id"), rs.getString("type"), rs.getBoolean("open"), rs.uuid("unit_id")) }.firstOrNull()

    /**
     * OP-02: владелец (applicant_id) — из токена, статус — DEFAULT 'draft' схемы,
     * id и created_at назначает база. Клиент не может повлиять ни на одно из этих полей.
     */
    fun insert(applicantId: UUID, campaignId: UUID, type: String, statement: String, grounds: List<String>, contentHash: String): Triple<UUID, String, OffsetDateTime> =
        jdbc.queryForObject(
            """
            INSERT INTO applications (applicant_id, campaign_id, type, statement, declared_grounds, content_hash)
            VALUES (:applicant, :campaign, CAST(:type AS application_type), :statement,
                    CAST(:grounds AS support_ground[]), :hash)
            RETURNING id, status::text AS status, created_at
            """.trimIndent(),
            MapSqlParameterSource().addValue("applicant", applicantId).addValue("campaign", campaignId)
                .addValue("type", type).addValue("statement", statement)
                // значения уже проверены по белому списку Ground; передаются параметром как литерал массива
                .addValue("grounds", grounds.joinToString(",", "{", "}"))
                .addValue("hash", contentHash),
        ) { rs, _ -> Triple(rs.uuid("id"), rs.getString("status"), rs.getObject("created_at", OffsetDateTime::class.java)) }!!

    /** Своя заявка с блокировкой строки — для подачи, отзыва и выдачи ссылки на вложение. */
    fun lockOwn(id: UUID, applicantId: UUID): OwnApplication? = jdbc.query(
        """
        SELECT a.id, a.campaign_id, a.status::text AS status, a.version,
               (now() BETWEEN c.accepts_from AND c.accepts_until) AS campaign_open
        FROM applications a JOIN campaigns c ON c.id = a.campaign_id
        WHERE a.id = :id AND a.applicant_id = :sub
        FOR UPDATE OF a
        """.trimIndent(), MapSqlParameterSource().addValue("id", id).addValue("sub", applicantId),
    ) { rs, _ -> OwnApplication(rs.uuid("id"), rs.uuid("campaign_id"), rs.getString("status"), rs.getInt("version"), rs.getBoolean("campaign_open")) }
        .firstOrNull()

    fun markSubmitted(id: UUID): OffsetDateTime = jdbc.queryForObject(
        """
        UPDATE applications SET status = 'submitted', submitted_at = now(), version = version + 1
        WHERE id = :id AND status = 'draft' RETURNING submitted_at
        """.trimIndent(), MapSqlParameterSource("id", id), OffsetDateTime::class.java,
    )!!

    fun submittedAt(id: UUID): OffsetDateTime? = jdbc.queryForObject(
        "SELECT submitted_at FROM applications WHERE id = :id", MapSqlParameterSource("id", id), OffsetDateTime::class.java,
    )

    fun markWithdrawn(id: UUID) = jdbc.update(
        "UPDATE applications SET status = 'withdrawn', version = version + 1 WHERE id = :id AND status = 'submitted'",
        MapSqlParameterSource("id", id),
    )

    fun deleteDraft(id: UUID): List<String> {
        val keys = jdbc.queryForList("SELECT object_key FROM attachments WHERE application_id = :id",
            MapSqlParameterSource("id", id), String::class.java)
        jdbc.update("DELETE FROM applications WHERE id = :id AND status = 'draft'", MapSqlParameterSource("id", id))
        return keys
    }

    fun countAttachments(applicationId: UUID): Int = jdbc.queryForObject(
        "SELECT count(*) FROM attachments WHERE application_id = :id", MapSqlParameterSource("id", applicationId), Int::class.java,
    )!!

    fun insertAttachment(applicationId: UUID, docType: String, objectKey: String, fileName: String, size: Long, sha256: String): UUID =
        jdbc.queryForObject(
            """
            INSERT INTO attachments (application_id, doc_type, object_key, file_name, size_bytes, sha256)
            VALUES (:app, CAST(:doc AS document_type), :key, :name, :size, :sha)
            RETURNING id
            """.trimIndent(),
            MapSqlParameterSource().addValue("app", applicationId).addValue("doc", docType).addValue("key", objectKey)
                .addValue("name", fileName).addValue("size", size).addValue("sha", sha256),
            UUID::class.java,
        )!!

    /**
     * OP-04. Область выборки задаётся сервером по роли (:own / :unit) и всегда присутствует в WHERE;
     * фильтры campaign_id/status/type могут её только сузить. Сортировка выбирается из
     * белого списка готовых фрагментов (ListSort) — значение параметра sort в SQL не попадает.
     * Пагинация — keyset-курсор (значение сортировки + id), без OFFSET.
     */
    fun list(f: ListFilter): List<ListRow> {
        val (keyset, order) = when (f.sort) {
            ListSort.CREATED_DESC -> "(CAST(:cts AS timestamptz) IS NULL OR (t.created_at, t.id) < (CAST(:cts AS timestamptz), CAST(:cid AS uuid)))" to "t.created_at DESC, t.id DESC"
            ListSort.CREATED_ASC -> "(CAST(:cts AS timestamptz) IS NULL OR (t.created_at, t.id) > (CAST(:cts AS timestamptz), CAST(:cid AS uuid)))" to "t.created_at ASC, t.id ASC"
            ListSort.SCORE_DESC -> "(CAST(:csc AS numeric) IS NULL OR (t.total_score, t.id) < (CAST(:csc AS numeric), CAST(:cid AS uuid)))" to "t.total_score DESC, t.id DESC"
            ListSort.SCORE_ASC -> "(CAST(:csc AS numeric) IS NULL OR (t.total_score, t.id) > (CAST(:csc AS numeric), CAST(:cid AS uuid)))" to "t.total_score ASC, t.id ASC"
        }
        val sql = """
            SELECT t.* FROM (
                SELECT a.id, a.status::text AS status, a.type::text AS type, a.created_at,
                       u.full_name AS applicant_name,
                       COALESCE((SELECT SUM(s.value) FROM application_scores s WHERE s.application_id = a.id), 0) AS total_score
                FROM applications a
                JOIN campaigns c ON c.id = a.campaign_id
                JOIN users u ON u.id = a.applicant_id
                WHERE (   (:own  AND a.applicant_id = :sub)
                       OR (:unit AND c.unit_id = (SELECT me.unit_id FROM users me WHERE me.id = :sub)) )
                  AND (CAST(:campaign AS uuid) IS NULL OR a.campaign_id = CAST(:campaign AS uuid))
                  AND (CAST(:status AS text) IS NULL OR a.status = CAST(:status AS application_status))
                  AND (CAST(:type AS text) IS NULL OR a.type = CAST(:type AS application_type))
            ) t
            WHERE $keyset
            ORDER BY $order
            LIMIT :limit
        """.trimIndent()
        val p = MapSqlParameterSource()
            .addValue("own", f.own).addValue("unit", f.unit).addValue("sub", f.subject)
            .addValue("campaign", f.campaignId?.toString()).addValue("status", f.status).addValue("type", f.type)
            .addValue("cts", f.cursorTs?.toString()).addValue("csc", f.cursorScore?.toPlainString())
            .addValue("cid", f.cursorId?.toString()).addValue("limit", f.limit + 1)
        return jdbc.query(sql, p) { rs, _ ->
            ListRow(rs.uuid("id"), rs.getString("status"), rs.getString("type"),
                rs.getObject("created_at", OffsetDateTime::class.java), rs.getString("applicant_name"), rs.getBigDecimal("total_score"))
        }
    }

    /** Кампании для формы подачи (OP-17, D-11): заявителю — открытые, сотрудникам — своего подразделения. */
    fun campaigns(subject: UUID, unitScope: Boolean): List<Map<String, Any?>> {
        val rows = jdbc.query(
            """
            SELECT c.id, c.title, c.type::text AS type, un.name AS unit_name, c.accepts_from, c.accepts_until,
                   (now() BETWEEN c.accepts_from AND c.accepts_until) AS is_open, c.quota, c.min_amount, c.max_amount,
                   EXISTS (SELECT 1 FROM protocols p WHERE p.campaign_id = c.id) AS has_protocol
            FROM campaigns c JOIN units un ON un.id = c.unit_id
            WHERE (:unit AND c.unit_id = (SELECT me.unit_id FROM users me WHERE me.id = :sub))
               OR (NOT :unit AND now() BETWEEN c.accepts_from AND c.accepts_until)
            ORDER BY c.accepts_until DESC
            """.trimIndent(), MapSqlParameterSource().addValue("sub", subject).addValue("unit", unitScope),
        ) { rs, _ ->
            linkedMapOf<String, Any?>(
                "id" to rs.uuid("id"), "title" to rs.getString("title"), "type" to rs.getString("type"),
                "unit_name" to rs.getString("unit_name"),
                "accepts_from" to rs.getObject("accepts_from", OffsetDateTime::class.java),
                "accepts_until" to rs.getObject("accepts_until", OffsetDateTime::class.java),
                "is_open" to rs.getBoolean("is_open"), "quota" to rs.getInt("quota"),
                "min_amount" to rs.getBigDecimal("min_amount"), "max_amount" to rs.getBigDecimal("max_amount"),
                "has_protocol" to rs.getBoolean("has_protocol"),
            )
        }
        if (rows.isEmpty()) return rows
        val criteria = jdbc.query(
            "SELECT id, campaign_id, code, title, max_score FROM criteria WHERE campaign_id IN (:ids) ORDER BY code",
            MapSqlParameterSource("ids", rows.map { it["id"] }),
        ) { rs, _ ->
            rs.uuid("campaign_id") to mapOf("id" to rs.uuid("id"), "code" to rs.getString("code"),
                "title" to rs.getString("title"), "max_score" to rs.getBigDecimal("max_score"))
        }.groupBy({ it.first }, { it.second })
        rows.forEach { it["criteria"] = criteria[it["id"]] ?: emptyList<Any>() }
        return rows
    }
}

fun ResultSet.uuid(col: String): UUID = getObject(col, UUID::class.java)
