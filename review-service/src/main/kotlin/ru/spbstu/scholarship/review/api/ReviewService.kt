package ru.spbstu.scholarship.review.api

import com.fasterxml.jackson.databind.ObjectMapper
import org.springframework.dao.DuplicateKeyException
import org.springframework.stereotype.Service
import org.springframework.transaction.annotation.Transactional
import ru.spbstu.scholarship.platform.audit.AuditLog
import ru.spbstu.scholarship.platform.audit.AuditResult
import ru.spbstu.scholarship.platform.events.ApplicationEvent
import ru.spbstu.scholarship.platform.events.EventPublisher
import ru.spbstu.scholarship.platform.events.Topics
import ru.spbstu.scholarship.platform.idempotency.IdempotencyStore
import ru.spbstu.scholarship.platform.security.AuthUser
import ru.spbstu.scholarship.platform.session.SessionLookup
import ru.spbstu.scholarship.platform.util.Hashing
import ru.spbstu.scholarship.platform.web.Errors
import ru.spbstu.scholarship.review.repo.ReviewRepository
import java.math.BigDecimal
import java.math.RoundingMode
import java.time.Duration
import java.time.Instant
import java.time.LocalDate
import java.util.UUID

@Service
class ReviewService(
    private val repo: ReviewRepository,
    private val audit: AuditLog,
    private val idem: IdempotencyStore,
    private val events: EventPublisher,
    private val sessions: SessionLookup,
    private val om: ObjectMapper,
) {
    // ======================================================================= OP-03
    /**
     * Порядок: (роль и If-Match проверены в контроллере) → схема тела → объект в подразделении
     * сотрудника (404) → конфликт интересов (403) → кампания не закрыта протоколом (422) →
     * версия (409) → допустимость перехода (400) → баллы → UPDATE + журнал в ОДНОЙ транзакции.
     */
    @Transactional
    fun review(user: AuthUser, id: UUID, expectedVersion: Int, req: ReviewRequest): ReviewView {
        val newStatus = req.status ?: throw Errors.badRequest("Поле status обязательно")
        if (newStatus !in setOf("under_review", "approved", "rejected")) throw Errors.badRequest("status: under_review, approved или rejected")
        val reason = req.reason?.trim()?.takeIf { it.isNotEmpty() }
        if (newStatus == "rejected" && reason == null) throw Errors.badRequest("При отклонении обязательна причина (reason)")
        if (reason != null && reason.length > 1000) throw Errors.badRequest("reason: не более 1000 символов")
        val scores = (req.scores ?: emptyList()).map {
            val c = it.criterionId?.let { s -> runCatching { UUID.fromString(s) }.getOrNull() }
                ?: throw Errors.badRequest("scores[].criterion_id должен быть UUID")
            val v = it.value ?: throw Errors.badRequest("scores[].value обязателен")
            c to v
        }
        if (scores.map { it.first }.toSet().size != scores.size) throw Errors.badRequest("Критерий указан дважды")

        val app = repo.lockForReview(id, user.id) ?: throw Errors.notFound() // вне подразделения = не существует
        if (app.applicantId == user.id) {
            // предположение P-01 закрыто проверкой: сотрудник не проверяет собственную заявку
            audit.write("application.review", "application", id, user.id, AuditResult.DENIED, mapOf("reason" to "conflict_of_interest"))
            throw Errors.forbidden("Нельзя проверять собственную заявку", "conflict_of_interest")
        }
        if (app.campaignClosed) throw Errors.unprocessable("Кампания закрыта протоколом: статусы больше не меняются", "campaign_closed")
        if (app.version != expectedVersion) throw Errors.conflict("Заявку уже изменил другой сотрудник — перечитайте её", "version_mismatch")
        if (newStatus !in (TRANSITIONS[app.status] ?: emptySet())) {
            throw Errors.badRequest("Недопустимый переход статуса: ${app.status} → $newStatus", "invalid_transition")
        }

        val criteria = repo.criteriaOf(app.campaignId)
        scores.forEach { (c, v) ->
            val max = criteria[c] ?: throw Errors.badRequest("Критерий не относится к кампании заявки")
            if (v < BigDecimal.ZERO || v > max) throw Errors.badRequest("Балл должен быть от 0 до $max")
            if (v.scale() > 2) throw Errors.badRequest("Балл — не более двух знаков после запятой")
        }
        if (newStatus == "approved" && app.type == "pgas" && scores.isEmpty()) {
            throw Errors.badRequest("Для одобрения заявки на ПГАС обязательны баллы (scores)")
        }

        val before = repo.scoresOf(id)
        scores.forEach { (c, v) -> repo.upsertScore(id, c, v, user.id) }
        val newVersion = repo.updateStatus(id, expectedVersion, newStatus, user.id, if (newStatus == "rejected") reason else null)
            ?: throw Errors.conflict("Заявку уже изменил другой сотрудник — перечитайте её", "version_mismatch")
        val total = repo.totalScore(id)

        // журнал — в той же транзакции: изменение без записи невозможно
        audit.write("application.reviewed", "application", id, user.id, details = mapOf(
            "status" to mapOf("old" to app.status, "new" to newStatus),
            "scores" to scores.associate { (c, v) -> c.toString() to mapOf("old" to before[c], "new" to v) },
            "reason" to reason,
            "version" to newVersion,
        ))
        if (newStatus != app.status) {
            events.publishAfterCommit(Topics.APPLICATION_EVENTS, id.toString(), ApplicationEvent(
                type = "application.status_changed", applicationId = id, campaignId = app.campaignId,
                recipientId = app.applicantId, status = newStatus))
        }
        return ReviewView(id, newStatus, total, newVersion, user.id)
    }

    // ======================================================================= OP-05
    /**
     * Три рубежа от повторного начисления (п. 3.3 ЛР2):
     *  1) Idempotency-Key — повтор возвращает сохранённый результат (200);
     *  2) проверка «по кампании ещё нет реестра» — 409;
     *  3) ограничения БД uq_protocol_per_campaign / uq_payout_per_application — работают,
     *     даже если два экземпляра сервиса обработают запрос одновременно.
     */
    @Transactional
    fun createRegistry(user: AuthUser, campaignId: UUID, key: UUID, req: RegistryRequest): Pair<Int, RegistryView> {
        // повторное подтверждение личности не старше 5 минут: деньги не выдаются по оставленной сессии
        val reauthAt = sessions.reauthAt(user.sessionId)
        if (reauthAt == null || reauthAt.isBefore(Instant.now().minus(REAUTH_WINDOW))) {
            audit.write("payout.create", "campaign", campaignId, user.id, AuditResult.DENIED, mapOf("reason" to "reauth_required"))
            throw Errors.forbidden("Подтвердите личность повторным вводом пароля", "reauth_required")
        }

        // схема тела
        val number = req.protocolNumber?.trim().orEmpty()
        if (number.isEmpty() || number.length > 64 || !number.matches(Regex("^[\\p{L}\\p{N} ./№-]+$")))
            throw Errors.badRequest("protocol_number: 1–64 символа (буквы, цифры, пробел, . / - №)")
        val date = req.protocolDate?.let { runCatching { LocalDate.parse(it) }.getOrNull() }
            ?: throw Errors.badRequest("protocol_date: дата в формате ГГГГ-ММ-ДД")
        if (date.isAfter(LocalDate.now())) throw Errors.badRequest("protocol_date не может быть в будущем")
        val raw = req.entries ?: throw Errors.badRequest("entries обязателен")
        if (raw.isEmpty() || raw.size > 1000) throw Errors.badRequest("entries: от 1 до 1000 строк")
        val entries = raw.mapIndexed { i, e ->
            val appId = e.applicationId?.let { runCatching { UUID.fromString(it) }.getOrNull() }
                ?: throw Errors.badRequest("entries[$i].application_id должен быть UUID")
            val amount = e.amount ?: throw Errors.badRequest("entries[$i].amount обязателен")
            if (amount.scale() > 2) throw Errors.badRequest("entries[$i].amount — не более двух знаков после запятой")
            appId to amount.setScale(2, RoundingMode.UNNECESSARY)
        }
        if (entries.map { it.first }.toSet().size != entries.size) throw Errors.unprocessable("Заявка указана в реестре дважды", "duplicate_entry")

        // 1-й рубеж: идемпотентность
        val reqHash = Hashing.sha256Hex(om.writeValueAsString(listOf(campaignId, number, date.toString(),
            entries.map { listOf(it.first.toString(), it.second.toPlainString()) })))
        val endpoint = "POST /campaigns/$campaignId/payout-registry"
        idem.lock(key, user.id, endpoint)
        idem.findReplay(key, user.id, endpoint, reqHash)?.let { return 200 to om.readValue(it.body, RegistryView::class.java) }

        // права на объект: кампания закреплена за комиссией (подразделением) вызывающего
        val campaign = repo.campaignForPayout(campaignId, user.id)
        if (campaign == null || !campaign.inUnit) {
            audit.write("payout.create", "campaign", campaignId, user.id, AuditResult.DENIED, mapOf("reason" to "foreign_campaign"))
            throw Errors.forbidden("Кампания не закреплена за вашей комиссией")
        }
        // 2-й рубеж: реестр по кампании уже есть
        if (repo.protocolExists(campaignId)) throw Errors.conflict("Реестр по этой кампании уже сформирован", "registry_exists")
        if (entries.size > campaign.quota) throw Errors.unprocessable("Число получателей превышает квоту кампании (${campaign.quota})", "quota_exceeded")

        // каждая заявка: из ЭТОЙ кампании, в статусе approved, сумма в границах кампании
        val found = repo.lockEntries(entries.map { it.first }).associateBy { it.applicationId }
        entries.forEachIndexed { i, (appId, amount) ->
            val e = found[appId]
            if (e == null || e.campaignId != campaignId) throw Errors.unprocessable("entries[$i]: заявка не относится к кампании", "foreign_application")
            if (e.status != "approved") throw Errors.unprocessable("entries[$i]: заявка не в статусе approved", "not_approved")
            if (amount < campaign.minAmount || amount > campaign.maxAmount)
                throw Errors.unprocessable("entries[$i]: сумма вне диапазона ${campaign.minAmount}–${campaign.maxAmount}", "amount_out_of_range")
        }

        val checksum = checksum(campaignId, number, date, entries)
        val total = entries.fold(BigDecimal.ZERO) { acc, e -> acc + e.second }
        val protocolId = try {
            val pid = repo.insertProtocol(campaignId, number, date, user.id, checksum)
            // получатель (recipient_id) берётся из заявки в БД, а не из запроса
            entries.forEach { (appId, amount) -> repo.insertPayout(pid, appId, found.getValue(appId).applicantId, amount) }
            pid
        } catch (e: DuplicateKeyException) {
            // 3-й рубеж: ограничение БД сработало (параллельный запрос или тот же номер протокола)
            throw Errors.conflict("Реестр по этой кампании или протокол с таким номером уже существует", "registry_exists")
        }

        val body = RegistryView(protocolId, protocolId, entries.size, total, checksum)
        audit.write("payout.created", "protocol", protocolId, user.id, details = mapOf(
            "campaign_id" to campaignId, "protocol_number" to number, "protocol_date" to date.toString(),
            "entries" to entries.map { mapOf("application_id" to it.first, "amount" to it.second) },
            "total_amount" to total, "checksum" to checksum,
            "reauth_at" to reauthAt.toString(), "idempotency_key" to key,
        ))
        idem.save(key, user.id, endpoint, reqHash, 201, om.writeValueAsString(body))
        return 201 to body
    }

    /** SHA-256 нормализованного реестра: строки отсортированы по application_id, суммы с 2 знаками. */
    fun checksum(campaignId: UUID, number: String, date: LocalDate, entries: List<Pair<UUID, BigDecimal>>): String {
        val sb = StringBuilder("campaign:$campaignId\nprotocol:$number\ndate:$date\n")
        entries.sortedBy { it.first.toString() }.forEach { (a, amt) -> sb.append(a).append(';').append(amt.toPlainString()).append('\n') }
        return Hashing.sha256Hex(sb.toString())
    }

    // ======================================================================= OP-12
    fun ranking(user: AuthUser, campaignId: UUID): Map<String, Any?> {
        val (quota, title) = repo.campaignInUnit(campaignId, user.id) ?: throw Errors.notFound()
        val rows = repo.ranking(campaignId).mapIndexed { i, r ->
            LinkedHashMap(r).apply { put("rank", i + 1); put("within_quota", i < quota) }
        }
        audit.write("campaign.ranking_viewed", "campaign", campaignId, user.id, details = mapOf("rows" to rows.size))
        return mapOf("campaign_id" to campaignId, "title" to title, "quota" to quota, "items" to rows)
    }

    companion object {
        val REAUTH_WINDOW: Duration = Duration.ofMinutes(5)
        /** Допустимые переходы статуса для OP-03. draft и withdrawn не проверяются. */
        val TRANSITIONS = mapOf(
            "submitted" to setOf("under_review", "approved", "rejected"),
            "under_review" to setOf("under_review", "approved", "rejected"),
            "approved" to setOf("under_review"),
            "rejected" to setOf("under_review"),
        )
    }
}

// ----------------------------------------------------------------------- DTO
data class ScoreInput(val criterionId: String?, val value: BigDecimal?)
data class ReviewRequest(val status: String?, val scores: List<ScoreInput>?, val reason: String?)
data class ReviewView(val id: UUID, val status: String, val totalScore: BigDecimal?, val version: Int, val reviewedBy: UUID)

data class EntryInput(val applicationId: String?, val amount: BigDecimal?)
data class RegistryRequest(val protocolNumber: String?, val protocolDate: String?, val entries: List<EntryInput>?)
data class RegistryView(val registryId: UUID, val protocolId: UUID, val entriesCount: Int, val totalAmount: BigDecimal, val checksum: String)
