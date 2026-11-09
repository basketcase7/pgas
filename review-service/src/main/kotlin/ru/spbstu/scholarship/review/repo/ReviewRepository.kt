package ru.spbstu.scholarship.review.repo

import org.springframework.jdbc.core.namedparam.MapSqlParameterSource
import org.springframework.jdbc.core.namedparam.NamedParameterJdbcTemplate
import org.springframework.stereotype.Repository
import java.math.BigDecimal
import java.sql.ResultSet
import java.time.LocalDate
import java.util.UUID

data class ReviewTarget(
    val id: UUID, val applicantId: UUID, val campaignId: UUID, val type: String, val status: String,
    val version: Int, val campaignClosed: Boolean,
)

data class CampaignForPayout(val id: UUID, val quota: Int, val minAmount: BigDecimal, val maxAmount: BigDecimal, val inUnit: Boolean)

data class EntryCheck(val applicationId: UUID, val campaignId: UUID, val status: String, val applicantId: UUID)

/** SQL review-service. Только параметризованные запросы. */
@Repository
class ReviewRepository(private val jdbc: NamedParameterJdbcTemplate) {

    /**
     * OP-03: заявка ищется сразу с условием «кампания закреплена за подразделением сотрудника»
     * (campaigns.unit_id = users.unit_id). Строка блокируется до конца транзакции.
     */
    fun lockForReview(id: UUID, reviewer: UUID): ReviewTarget? = jdbc.query(
        """
        SELECT a.id, a.applicant_id, a.campaign_id, a.type::text AS type, a.status::text AS status, a.version,
               EXISTS (SELECT 1 FROM protocols p WHERE p.campaign_id = a.campaign_id) AS campaign_closed
        FROM applications a
        JOIN campaigns c ON c.id = a.campaign_id
        WHERE a.id = :id AND c.unit_id = (SELECT u.unit_id FROM users u WHERE u.id = :sub)
        FOR UPDATE OF a
        """.trimIndent(), MapSqlParameterSource().addValue("id", id).addValue("sub", reviewer),
    ) { rs, _ ->
        ReviewTarget(rs.uuid("id"), rs.uuid("applicant_id"), rs.uuid("campaign_id"), rs.getString("type"),
            rs.getString("status"), rs.getInt("version"), rs.getBoolean("campaign_closed"))
    }.firstOrNull()

    /** Критерии кампании: id → максимальный балл. */
    fun criteriaOf(campaignId: UUID): Map<UUID, BigDecimal> = jdbc.query(
        "SELECT id, max_score FROM criteria WHERE campaign_id = :c", MapSqlParameterSource("c", campaignId),
    ) { rs, _ -> rs.uuid("id") to rs.getBigDecimal("max_score") }.toMap()

    fun scoresOf(applicationId: UUID): Map<UUID, BigDecimal> = jdbc.query(
        "SELECT criterion_id, value FROM application_scores WHERE application_id = :a", MapSqlParameterSource("a", applicationId),
    ) { rs, _ -> rs.uuid("criterion_id") to rs.getBigDecimal("value") }.toMap()

    fun upsertScore(applicationId: UUID, criterionId: UUID, value: BigDecimal, scoredBy: UUID) = jdbc.update(
        """
        INSERT INTO application_scores (application_id, criterion_id, value, scored_by)
        VALUES (:a, :c, :v, :by)
        ON CONFLICT (application_id, criterion_id)
        DO UPDATE SET value = EXCLUDED.value, scored_by = EXCLUDED.scored_by, scored_at = now()
        """.trimIndent(),
        MapSqlParameterSource().addValue("a", applicationId).addValue("c", criterionId).addValue("v", value).addValue("by", scoredBy),
    )

    /**
     * Оптимистическая блокировка: обновление проходит, только если версия не изменилась
     * с момента чтения (If-Match). reviewed_by — из токена, не из тела запроса.
     */
    fun updateStatus(id: UUID, expectedVersion: Int, status: String, reviewer: UUID, reason: String?): Int? = jdbc.query(
        """
        UPDATE applications
        SET status = CAST(:st AS application_status), reviewed_by = :by, reviewed_at = now(),
            reject_reason = :reason, version = version + 1
        WHERE id = :id AND version = :v
        RETURNING version
        """.trimIndent(),
        MapSqlParameterSource().addValue("st", status).addValue("by", reviewer).addValue("reason", reason)
            .addValue("id", id).addValue("v", expectedVersion),
    ) { rs, _ -> rs.getInt(1) }.firstOrNull()

    fun totalScore(applicationId: UUID): BigDecimal? = jdbc.queryForObject(
        "SELECT SUM(value) FROM application_scores WHERE application_id = :a", MapSqlParameterSource("a", applicationId), BigDecimal::class.java,
    )

    /** Кампания и признак «закреплена за подразделением вызывающего». */
    fun campaignForPayout(id: UUID, caller: UUID): CampaignForPayout? = jdbc.query(
        """
        SELECT c.id, c.quota, c.min_amount, c.max_amount,
               c.unit_id = (SELECT u.unit_id FROM users u WHERE u.id = :sub) AS in_unit
        FROM campaigns c WHERE c.id = :id
        -- без FOR UPDATE: у svc_review нет UPDATE на campaigns; гонку двух реестров
        -- закрывает ограничение uq_protocol_per_campaign
        """.trimIndent(), MapSqlParameterSource().addValue("id", id).addValue("sub", caller),
    ) { rs, _ ->
        CampaignForPayout(rs.uuid("id"), rs.getInt("quota"), rs.getBigDecimal("min_amount"), rs.getBigDecimal("max_amount"), rs.getBoolean("in_unit"))
    }.firstOrNull()

    fun protocolExists(campaignId: UUID): Boolean = jdbc.queryForObject(
        "SELECT EXISTS (SELECT 1 FROM protocols WHERE campaign_id = :c)", MapSqlParameterSource("c", campaignId), Boolean::class.java,
    ) == true

    /** Заявки из entries[] с блокировкой: статус не изменится между проверкой и записью реестра. */
    fun lockEntries(ids: Collection<UUID>): List<EntryCheck> = jdbc.query(
        """
        SELECT id, campaign_id, status::text AS status, applicant_id
        FROM applications WHERE id IN (:ids) FOR UPDATE
        """.trimIndent(), MapSqlParameterSource("ids", ids),
    ) { rs, _ -> EntryCheck(rs.uuid("id"), rs.uuid("campaign_id"), rs.getString("status"), rs.uuid("applicant_id")) }

    fun insertProtocol(campaignId: UUID, number: String, date: LocalDate, createdBy: UUID, checksum: String): UUID = jdbc.queryForObject(
        """
        INSERT INTO protocols (campaign_id, number, signed_date, created_by, checksum)
        VALUES (:c, :n, :d, :by, :sum) RETURNING id
        """.trimIndent(),
        MapSqlParameterSource().addValue("c", campaignId).addValue("n", number).addValue("d", date)
            .addValue("by", createdBy).addValue("sum", checksum),
        UUID::class.java,
    )!!

    fun insertPayout(protocolId: UUID, applicationId: UUID, recipientId: UUID, amount: BigDecimal) = jdbc.update(
        """
        INSERT INTO payout_entries (protocol_id, application_id, recipient_id, amount)
        VALUES (:p, :a, :r, :amt)
        """.trimIndent(),
        MapSqlParameterSource().addValue("p", protocolId).addValue("a", applicationId).addValue("r", recipientId).addValue("amt", amount),
    )

    /** OP-12: ранжирование по сумме баллов в пределах кампании своего подразделения. */
    fun campaignInUnit(id: UUID, caller: UUID): Pair<Int, String>? = jdbc.query(
        """
        SELECT c.quota, c.title FROM campaigns c
        WHERE c.id = :id AND c.unit_id = (SELECT u.unit_id FROM users u WHERE u.id = :sub)
        """.trimIndent(), MapSqlParameterSource().addValue("id", id).addValue("sub", caller),
    ) { rs, _ -> rs.getInt("quota") to rs.getString("title") }.firstOrNull()

    fun ranking(campaignId: UUID): List<Map<String, Any?>> = jdbc.query(
        """
        SELECT a.id, u.full_name, a.status::text AS status, COALESCE(SUM(s.value), 0) AS total_score
        FROM applications a
        JOIN users u ON u.id = a.applicant_id
        LEFT JOIN application_scores s ON s.application_id = a.id
        WHERE a.campaign_id = :c AND a.status IN ('submitted', 'under_review', 'approved')
        GROUP BY a.id, u.full_name, a.status, a.submitted_at
        ORDER BY total_score DESC, a.submitted_at ASC, a.id
        """.trimIndent(), MapSqlParameterSource("c", campaignId),
    ) { rs, _ ->
        linkedMapOf("application_id" to rs.uuid("id"), "applicant_name" to rs.getString("full_name"),
            "status" to rs.getString("status"), "total_score" to rs.getBigDecimal("total_score"))
    }
}

fun ResultSet.uuid(col: String): UUID = getObject(col, UUID::class.java)
