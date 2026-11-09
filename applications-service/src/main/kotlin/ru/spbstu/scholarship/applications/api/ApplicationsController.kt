package ru.spbstu.scholarship.applications.api

import org.springframework.http.HttpHeaders
import org.springframework.http.HttpStatus
import org.springframework.http.ResponseEntity
import org.springframework.web.bind.annotation.DeleteMapping
import org.springframework.web.bind.annotation.GetMapping
import org.springframework.web.bind.annotation.PathVariable
import org.springframework.web.bind.annotation.PostMapping
import org.springframework.web.bind.annotation.RequestBody
import org.springframework.web.bind.annotation.RequestHeader
import org.springframework.web.bind.annotation.RequestMapping
import org.springframework.web.bind.annotation.RequestMethod
import org.springframework.web.bind.annotation.RequestParam
import org.springframework.web.bind.annotation.RestController
import ru.spbstu.scholarship.applications.repo.ApplicationRepository
import ru.spbstu.scholarship.platform.idempotency.IdempotencyStore
import ru.spbstu.scholarship.platform.security.AuthUser
import ru.spbstu.scholarship.platform.security.Permission
import ru.spbstu.scholarship.platform.web.Errors
import java.net.URI
import java.util.UUID

/**
 * Контроллер applications-service. Идентификатор текущего пользователя — параметр
 * AuthUser, который берётся только из проверенного токена (AuthenticationFilter),
 * никогда из тела или параметров запроса.
 */
@RestController
@RequestMapping("/api/v1")
class ApplicationsController(
    private val service: ApplicationService,
    private val repo: ApplicationRepository,
) {
    private fun require(user: AuthUser, p: Permission) {
        if (!user.has(p)) throw Errors.forbidden()
    }

    /**
     * OP-01. GET /applications/{id}?include=attachments
     * Принимается только include; applicant_id, status, fields и любые другие параметры
     * игнорируются: «посмотреть от имени другого» не имеет синтаксиса.
     */
    @GetMapping("/applications/{id}")
    fun get(user: AuthUser, @PathVariable id: UUID, @RequestParam(required = false) include: String?): ResponseEntity<ApplicationView> {
        require(user, Permission.APPLICATIONS_READ)
        val (view, version) = service.get(user, id, include == "attachments")
        // версия для If-Match в OP-03 передаётся заголовком ETag
        return ResponseEntity.ok().eTag("\"$version\"").header(HttpHeaders.CACHE_CONTROL, "no-store").body(view)
    }

    /** OP-02. POST /applications (Idempotency-Key обязателен). */
    @PostMapping("/applications")
    fun create(
        user: AuthUser,
        @RequestHeader("Idempotency-Key", required = false) idemKey: String?,
        @RequestBody body: CreateApplicationRequest,
    ): ResponseEntity<CreatedView> {
        require(user, Permission.APPLICATIONS_CREATE)
        val key = IdempotencyStore.parseKey(idemKey) { throw Errors.badRequest("Заголовок Idempotency-Key обязателен") }
        val out = service.create(user, key, body)
        return ResponseEntity.status(out.status).location(URI.create("/api/v1/applications/${out.body.id}")).body(out.body)
    }

    /** OP-04. GET /applications — область выборки задаёт сервер, фильтры только сужают. */
    @GetMapping("/applications")
    fun list(
        user: AuthUser,
        @RequestParam(name = "campaign_id", required = false) campaignId: String?,
        @RequestParam(required = false) status: String?,
        @RequestParam(required = false) type: String?,
        @RequestParam(required = false) sort: String?,
        @RequestParam(required = false) limit: String?,
        @RequestParam(required = false) cursor: String?,
    ): ResponseEntity<ListView> {
        require(user, Permission.APPLICATIONS_LIST)
        return ResponseEntity.ok().header(HttpHeaders.CACHE_CONTROL, "no-store")
            .body(service.list(user, campaignId, status, type, sort, limit, cursor))
    }

    /** OP-18 (D-12). POST /applications/{id}/submit — подача черновика. */
    @PostMapping("/applications/{id}/submit")
    fun submit(user: AuthUser, @PathVariable id: UUID): SubmittedView {
        require(user, Permission.APPLICATIONS_SUBMIT)
        return service.submit(user, id)
    }

    /** OP-13. DELETE /applications/{id} — отзыв собственной заявки до дедлайна. */
    @DeleteMapping("/applications/{id}")
    fun withdraw(user: AuthUser, @PathVariable id: UUID): ResponseEntity<Void> {
        require(user, Permission.APPLICATIONS_WITHDRAW)
        service.withdraw(user, id)
        return ResponseEntity.noContent().build()
    }

    /** OP-10. POST /applications/{id}/attachments — ссылка на загрузку вложения в хранилище. */
    @PostMapping("/applications/{id}/attachments")
    fun attachment(user: AuthUser, @PathVariable id: UUID, @RequestBody body: AttachmentRequest): ResponseEntity<UploadView> {
        require(user, Permission.ATTACHMENTS_CREATE)
        return ResponseEntity.status(HttpStatus.CREATED).body(service.requestUpload(user, id, body))
    }

    /**
     * OP-06 / OP-11 — проверка полноты языковой моделью. По условию ЛР3 интеграция с моделью
     * не реализуется: эндпоинт оставлен заглушкой 501 (контейнер llm-orchestrator не развёрнут).
     */
    @RequestMapping("/applications/{id}/completeness-check", method = [RequestMethod.POST, RequestMethod.GET])
    fun completeness(user: AuthUser, @PathVariable id: UUID): ResponseEntity<Map<String, String>> {
        require(user, Permission.COMPLETENESS_REQUEST)
        return ResponseEntity.status(HttpStatus.NOT_IMPLEMENTED).body(mapOf(
            "error" to "not_implemented",
            "message" to "Проверка полноты языковой моделью в этой версии не реализована"))
    }

    /** OP-17 (D-11). GET /campaigns — кампании и критерии для форм клиента. */
    @GetMapping("/campaigns")
    fun campaigns(user: AuthUser): Map<String, Any> {
        require(user, Permission.CAMPAIGNS_READ)
        return mapOf("items" to repo.campaigns(user.id, user.isUnitScoped()))
    }
}
