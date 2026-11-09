package ru.spbstu.scholarship.applications.api

import com.fasterxml.jackson.databind.ObjectMapper
import org.slf4j.LoggerFactory
import org.springframework.dao.DuplicateKeyException
import org.springframework.data.redis.core.StringRedisTemplate
import org.springframework.http.HttpStatus
import org.springframework.stereotype.Service
import org.springframework.transaction.annotation.Transactional
import ru.spbstu.scholarship.applications.domain.ApplicationStatus
import ru.spbstu.scholarship.applications.domain.ApplicationType
import ru.spbstu.scholarship.applications.domain.ContentHash
import ru.spbstu.scholarship.applications.domain.DocType
import ru.spbstu.scholarship.applications.domain.Ground
import ru.spbstu.scholarship.applications.domain.ListSort
import ru.spbstu.scholarship.applications.repo.ApplicationRepository
import ru.spbstu.scholarship.applications.repo.ListFilter
import ru.spbstu.scholarship.applications.storage.ObjectStorage
import ru.spbstu.scholarship.platform.audit.AuditLog
import ru.spbstu.scholarship.platform.audit.AuditResult
import ru.spbstu.scholarship.platform.catalog.CatalogUnavailableException
import ru.spbstu.scholarship.platform.catalog.LdapCatalog
import ru.spbstu.scholarship.platform.events.ApplicationEvent
import ru.spbstu.scholarship.platform.events.EventPublisher
import ru.spbstu.scholarship.platform.events.Topics
import ru.spbstu.scholarship.platform.idempotency.IdempotencyStore
import ru.spbstu.scholarship.platform.security.AuthUser
import ru.spbstu.scholarship.platform.security.Roles
import ru.spbstu.scholarship.platform.util.Hashing
import ru.spbstu.scholarship.platform.web.ApiException
import ru.spbstu.scholarship.platform.web.Errors
import java.time.Duration
import java.time.OffsetDateTime
import java.util.Base64
import java.util.UUID

/** Результат операции с возможностью вернуть 200 (повтор) или 201 (создано). */
data class Outcome<T>(val status: Int, val body: T)

@Service
class ApplicationService(
    private val repo: ApplicationRepository,
    private val audit: AuditLog,
    private val idem: IdempotencyStore,
    private val events: EventPublisher,
    private val catalog: LdapCatalog,
    private val storage: ObjectStorage,
    private val redis: StringRedisTemplate,
    private val om: ObjectMapper,
) {
    private val log = LoggerFactory.getLogger(ApplicationService::class.java)

    // ======================================================================= OP-01
    /**
     * Порядок шагов — как на диаграмме последовательности 1 (ЛР2):
     * токен уже проверен фильтром → право роли на операцию → выборка с проверкой
     * принадлежности в том же запросе → журнал → ответ.
     */
    fun get(user: AuthUser, id: UUID, includeAttachments: Boolean): Pair<ApplicationView, Int> {
        // право на операцию applications:read проверено в контроллере
        val own = user.isApplicant()
        val unit = user.isUnitScoped()
        val row = repo.findVisible(id, user.id, own, unit)
        if (row == null) {
            // 404 одинаково для «нет такой» и «чужая»: нарушитель не узнаёт, существует ли заявка
            audit.write("application.view", "application", id, user.id, AuditResult.DENIED)
            countNotFound(user)
            throw Errors.notFound()
        }
        val isStaffViewer = row.applicantId != user.id && unit
        if (isStaffViewer) {
            // для R-03, R-04, R-07 фиксируется факт просмотра чужой заявки
            audit.write("application.view", "application", id, user.id)
        }
        val canSeeScores = user.hasRole(Roles.REVIEWER) || user.hasRole(Roles.COMMITTEE_CHAIR) ||
            (row.applicantId == user.id && row.resultsPublished)
        // служба поддержки (R-07) не имеет доступа к вложениям (реестр ролей ЛР1)
        val canSeeAttachments = includeAttachments && (row.applicantId == user.id ||
            user.hasRole(Roles.REVIEWER) || user.hasRole(Roles.COMMITTEE_CHAIR))

        val view = ApplicationView(
            id = row.id, campaignId = row.campaignId, type = row.type, status = row.status,
            applicantId = row.applicantId, statement = row.statement, declaredGrounds = row.grounds,
            submittedAt = row.submittedAt,
            attachments = if (canSeeAttachments) repo.attachmentsOf(id).map {
                AttachmentView(it.id, it.docType, it.fileName, it.sizeBytes, it.uploadedAt, storage.presignDownload(it.objectKey))
            } else null,
            scores = if (canSeeScores) repo.scoresOf(id) else null,
        )
        return view to row.version
    }

    /** Серия 404 по разным id от одного субъекта — признак перебора (OP-01, «ограничения частоты»). */
    private fun countNotFound(user: AuthUser) {
        runCatching {
            val key = "enum404:${user.id}"
            val n = redis.opsForValue().increment(key) ?: 0
            if (n == 1L) redis.expire(key, Duration.ofMinutes(1))
            if (n == ENUMERATION_THRESHOLD) {
                log.warn("Подозрение на перебор идентификаторов заявок: actor={}", user.id)
                audit.write("security.enumeration_suspected", "user", user.id, user.id, AuditResult.DENIED,
                    mapOf("not_found_per_minute" to n))
            }
        }.onFailure { log.warn("Не удалось учесть 404 в Redis", it) }
    }

    // ======================================================================= OP-02
    @Transactional
    fun create(user: AuthUser, key: UUID, req: CreateApplicationRequest): Outcome<CreatedView> {
        // 1. схема тела: закрытый список полей уже обеспечен Jackson; здесь — обязательность и значения
        val campaignId = req.campaignId?.let { runCatching { UUID.fromString(it) }.getOrNull() }
            ?: throw Errors.badRequest("Поле campaign_id обязательно и должно быть UUID")
        val type = ApplicationType.parse(req.type)
        val statement = req.statement?.trim().orEmpty()
        if (statement.isEmpty() || statement.length > 4000) throw Errors.badRequest("Поле statement: от 1 до 4000 символов")
        val groundsRaw = req.declaredGrounds ?: throw Errors.badRequest("Поле declared_grounds обязательно")
        if (groundsRaw.isEmpty() || groundsRaw.size > Ground.entries.size) throw Errors.badRequest("declared_grounds: от 1 до 9 оснований")
        val grounds = groundsRaw.map { Ground.parse(it) }.distinct().sortedBy { it.db }

        // 2. идемпотентность: тот же ключ → тот же результат, второй объект не создаётся
        val reqHash = Hashing.sha256Hex(om.writeValueAsString(listOf(campaignId, type.db, statement, grounds.map { it.db })))
        idem.lock(key, user.id, EP_CREATE)
        idem.findReplay(key, user.id, EP_CREATE, reqHash)?.let {
            return Outcome(200, om.readValue(it.body, CreatedView::class.java))
        }

        // 3. статус обучающегося сверяется с каталогом на момент подачи (B-13, RK-10)
        val externalId = repo.externalIdOf(user.id) ?: throw Errors.unauthorized()
        val entry = try { catalog.find(externalId) } catch (e: CatalogUnavailableException) {
            log.error("Каталог недоступен", e)
            throw ApiException(HttpStatus.SERVICE_UNAVAILABLE, "catalog_unavailable", "Сервис временно недоступен")
        }
        if (entry == null || !entry.isActiveStudent) {
            audit.write("application.create", "application", null, user.id, AuditResult.DENIED,
                mapOf("reason" to "not_active_student", "campaign_id" to campaignId))
            throw Errors.forbidden("По данным каталога вы не являетесь действующим обучающимся", "not_active_student")
        }

        // 4. кампания: существует, вид поддержки совпадает, приём открыт по часам сервера
        val campaign = repo.campaign(campaignId) ?: throw Errors.badRequest("Кампания не найдена", "unknown_campaign")
        if (campaign.type != type.db) throw Errors.badRequest("Вид поддержки не совпадает с видом кампании")
        if (!campaign.open) throw Errors.unprocessable("Приём заявок в кампанию закрыт", "campaign_closed")

        // 5. запись: владелец и статус назначает сервер
        val (id, status, createdAt) = try {
            repo.insert(user.id, campaignId, type.db, statement, grounds.map { it.db }, ContentHash.of(type, grounds, statement))
        } catch (e: DuplicateKeyException) {
            // второй рубеж — ограничение uq_application_per_campaign в БД
            throw Errors.conflict("У вас уже есть заявка в этой кампании", "duplicate_application")
        }
        val body = CreatedView(id, status, createdAt)
        audit.write("application.created", "application", id, user.id,
            details = mapOf("campaign_id" to campaignId, "idempotency_key" to key)) // текст statement не пишется
        idem.save(key, user.id, EP_CREATE, reqHash, 201, om.writeValueAsString(body))
        return Outcome(201, body)
    }

    // ======================================================================= OP-04
    fun list(user: AuthUser, campaignId: String?, status: String?, type: String?, sort: String?, limit: String?, cursor: String?): ListView {
        val f = ListFilter(
            own = user.isApplicant(),
            unit = user.hasRole(Roles.REVIEWER) || user.hasRole(Roles.COMMITTEE_CHAIR),
            subject = user.id,
            campaignId = campaignId?.let { runCatching { UUID.fromString(it) }.getOrNull() ?: throw Errors.badRequest("campaign_id должен быть UUID") },
            status = status?.let { ApplicationStatus.parse(it).db },
            type = type?.let { ApplicationType.parse(it).db },
            sort = ListSort.parse(sort),
            limit = limit?.let { it.toIntOrNull()?.takeIf { n -> n in 1..100 } ?: throw Errors.badRequest("limit: от 1 до 100") } ?: 20,
            cursorTs = null, cursorScore = null, cursorId = null,
        ).let { applyCursor(it, cursor) }

        val rows = repo.list(f)
        val page = rows.take(f.limit)
        val staff = f.unit
        val next = if (rows.size > f.limit) encodeCursor(f.sort, page.last()) else null
        if (staff) {
            // безопасный метод, отдающий ПДн сразу по многим субъектам (RK-03), — фиксируется
            audit.write("applications.listed", "application", null, user.id, details = mapOf(
                "filters" to mapOf("campaign_id" to f.campaignId, "status" to f.status, "type" to f.type, "sort" to f.sort.param),
                "rows" to page.size))
        }
        return ListView(page.map { ListItem(it.id, it.status, it.type, if (staff) it.applicantName else null) }, next)
    }

    private fun encodeCursor(sort: ListSort, r: ru.spbstu.scholarship.applications.repo.ListRow): String {
        val v = when (sort) {
            ListSort.CREATED_ASC, ListSort.CREATED_DESC -> r.createdAt.toString()
            ListSort.SCORE_ASC, ListSort.SCORE_DESC -> r.totalScore.toPlainString()
        }
        return Base64.getUrlEncoder().withoutPadding().encodeToString("${sort.param}|$v|${r.id}".toByteArray())
    }

    private fun applyCursor(f: ListFilter, cursor: String?): ListFilter {
        if (cursor == null) return f
        val bad = { Errors.badRequest("Недействительный cursor") }
        val parts = runCatching { String(Base64.getUrlDecoder().decode(cursor)).split("|") }.getOrNull() ?: throw bad()
        if (parts.size != 3 || parts[0] != f.sort.param) throw bad()
        val id = runCatching { UUID.fromString(parts[2]) }.getOrNull() ?: throw bad()
        return when (f.sort) {
            ListSort.CREATED_ASC, ListSort.CREATED_DESC ->
                f.copy(cursorTs = runCatching { OffsetDateTime.parse(parts[1]) }.getOrNull() ?: throw bad(), cursorId = id)
            ListSort.SCORE_ASC, ListSort.SCORE_DESC ->
                f.copy(cursorScore = parts[1].toBigDecimalOrNull() ?: throw bad(), cursorId = id)
        }
    }

    // ======================================================================= OP-18 подача (D-12)
    @Transactional
    fun submit(user: AuthUser, id: UUID): SubmittedView {
        val app = repo.lockOwn(id, user.id) ?: throw Errors.notFound()
        return when (ApplicationStatus.of(app.status)) {
            // повторная подача уже поданной заявки — не ошибка, а тот же результат (идемпотентно)
            ApplicationStatus.SUBMITTED -> SubmittedView(id, "submitted", repo.submittedAt(id))
            ApplicationStatus.DRAFT -> {
                if (!app.campaignOpen) throw Errors.unprocessable("Приём заявок в кампанию закрыт", "campaign_closed")
                val at = repo.markSubmitted(id)
                audit.write("application.submitted", "application", id, user.id)
                events.publishAfterCommit(Topics.APPLICATION_EVENTS, id.toString(),
                    ApplicationEvent(type = "application.submitted", applicationId = id, campaignId = app.campaignId,
                        recipientId = user.id, status = "submitted"))
                SubmittedView(id, "submitted", at)
            }
            else -> throw Errors.conflict("Заявку в статусе ${app.status} нельзя подать", "invalid_status")
        }
    }

    // ======================================================================= OP-13 отзыв
    @Transactional
    fun withdraw(user: AuthUser, id: UUID) {
        val app = repo.lockOwn(id, user.id) ?: throw Errors.notFound()
        when (ApplicationStatus.of(app.status)) {
            ApplicationStatus.WITHDRAWN -> return // DELETE идемпотентен: повтор не меняет состояние
            ApplicationStatus.DRAFT, ApplicationStatus.SUBMITTED -> {
                if (!app.campaignOpen) throw Errors.unprocessable("Срок приёма истёк — отзыв невозможен", "campaign_closed")
            }
            else -> throw Errors.conflict("Заявка уже на рассмотрении — отзыв невозможен", "invalid_status")
        }
        if (app.status == ApplicationStatus.DRAFT.db) {
            // черновик никогда не подавался — удаляется вместе с вложениями
            val keys = repo.deleteDraft(id)
            audit.write("application.deleted", "application", id, user.id)
            keys.forEach { storage.deleteQuietly(it) }
        } else {
            repo.markWithdrawn(id)
            audit.write("application.withdrawn", "application", id, user.id)
            events.publishAfterCommit(Topics.APPLICATION_EVENTS, id.toString(),
                ApplicationEvent(type = "application.withdrawn", applicationId = id, campaignId = app.campaignId,
                    recipientId = user.id, status = "withdrawn"))
        }
    }

    // ======================================================================= OP-10 ссылка на загрузку
    @Transactional
    fun requestUpload(user: AuthUser, id: UUID, req: AttachmentRequest): UploadView {
        val docType = DocType.parse(req.docType)
        val fileName = req.fileName?.trim().orEmpty()
        if (fileName.isEmpty() || fileName.length > 255 || fileName.any { it.isISOControl() || it == '/' || it == '\\' })
            throw Errors.badRequest("Недопустимое имя файла")
        val contentType = req.contentType?.lowercase()
        if (contentType !in ObjectStorage.ALLOWED_TYPES) throw Errors.badRequest("Допустимы только PDF, JPEG, PNG")
        val size = req.sizeBytes ?: throw Errors.badRequest("Поле size_bytes обязательно")
        if (size <= 0 || size > ObjectStorage.MAX_SIZE) throw Errors.badRequest("Размер файла: до 10 МБ")
        val sha = req.sha256?.lowercase()
        if (sha == null || !sha.matches(Regex("^[0-9a-f]{64}$"))) throw Errors.badRequest("Поле sha256: 64 шестнадцатеричных символа")

        // ссылка выдаётся только после проверки принадлежности заявки (B-07)
        val app = repo.lockOwn(id, user.id) ?: throw Errors.notFound()
        if (app.status != "draft" && app.status != "submitted") throw Errors.conflict("Вложения можно добавлять до начала рассмотрения", "invalid_status")
        if (!app.campaignOpen) throw Errors.unprocessable("Приём заявок в кампанию закрыт", "campaign_closed")
        if (repo.countAttachments(id) >= MAX_ATTACHMENTS) throw Errors.unprocessable("Не более $MAX_ATTACHMENTS вложений", "too_many_attachments")

        // ключ объекта генерирует сервер; имя файла пользователя в ключ не попадает
        val objectKey = "applications/$id/${UUID.randomUUID()}"
        val attachmentId = repo.insertAttachment(id, docType.db, objectKey, fileName, size, sha)
        val form = storage.presignUpload(objectKey, contentType!!, size)
        audit.write("attachment.upload_link_issued", "attachment", attachmentId, user.id,
            details = mapOf("application_id" to id, "size_bytes" to size, "content_type" to contentType))
        return UploadView(attachmentId, "POST", form.url, form.fields, form.expiresAt.toOffsetDateTime())
    }

    companion object {
        const val EP_CREATE = "POST /applications"
        const val MAX_ATTACHMENTS = 10
        const val ENUMERATION_THRESHOLD = 10L
    }
}

// ----------------------------------------------------------------------- DTO
data class CreateApplicationRequest(
    val campaignId: String?, val type: String?, val statement: String?, val declaredGrounds: List<String>?,
)
data class AttachmentRequest(
    val docType: String?, val fileName: String?, val contentType: String?, val sizeBytes: Long?, val sha256: String?,
)

data class ApplicationView(
    val id: UUID, val campaignId: UUID, val type: String, val status: String, val applicantId: UUID,
    val statement: String, val declaredGrounds: List<String>, val submittedAt: OffsetDateTime?,
    val attachments: List<AttachmentView>?, val scores: List<Map<String, Any>>?,
)
data class AttachmentView(val id: UUID, val docType: String, val fileName: String, val sizeBytes: Long, val uploadedAt: OffsetDateTime, val downloadUrl: String)
data class CreatedView(val id: UUID, val status: String, val createdAt: OffsetDateTime)
data class SubmittedView(val id: UUID, val status: String, val submittedAt: OffsetDateTime?)
data class ListItem(val id: UUID, val status: String, val type: String, val applicantName: String?)
data class ListView(val items: List<ListItem>, val nextCursor: String?)
data class UploadView(val attachmentId: UUID, val method: String, val uploadUrl: String, val formFields: Map<String, String>, val expiresAt: OffsetDateTime)

