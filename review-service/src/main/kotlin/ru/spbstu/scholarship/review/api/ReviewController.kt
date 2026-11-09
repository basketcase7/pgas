package ru.spbstu.scholarship.review.api

import org.springframework.http.HttpHeaders
import org.springframework.http.ResponseEntity
import org.springframework.web.bind.annotation.GetMapping
import org.springframework.web.bind.annotation.PatchMapping
import org.springframework.web.bind.annotation.PathVariable
import org.springframework.web.bind.annotation.PostMapping
import org.springframework.web.bind.annotation.RequestBody
import org.springframework.web.bind.annotation.RequestHeader
import org.springframework.web.bind.annotation.RequestMapping
import org.springframework.web.bind.annotation.RestController
import ru.spbstu.scholarship.platform.idempotency.IdempotencyStore
import ru.spbstu.scholarship.platform.security.AuthUser
import ru.spbstu.scholarship.platform.security.Permission
import ru.spbstu.scholarship.platform.web.Errors
import java.util.UUID

@RestController
@RequestMapping("/api/v1")
class ReviewController(private val service: ReviewService) {

    /**
     * OP-03. PATCH /applications/{id}/review
     * 403 — роль не reviewer (авторизация на ОПЕРАЦИЮ); 428 — нет If-Match.
     * Авторизация на ОБЪЕКТ — в ReviewService (подразделение, конфликт интересов).
     */
    @PatchMapping("/applications/{id}/review")
    fun review(
        user: AuthUser,
        @PathVariable id: UUID,
        @RequestHeader(HttpHeaders.IF_MATCH, required = false) ifMatch: String?,
        @RequestBody body: ReviewRequest,
    ): ResponseEntity<ReviewView> {
        if (!user.has(Permission.APPLICATIONS_REVIEW)) throw Errors.forbidden("Роль не вправе проверять заявки")
        if (ifMatch.isNullOrBlank()) throw Errors.preconditionRequired("Заголовок If-Match обязателен (версия из ETag)")
        val version = ifMatch.trim().removePrefix("W/").trim('"').toIntOrNull()
            ?: throw Errors.badRequest("If-Match должен содержать версию заявки")
        val view = service.review(user, id, version, body)
        return ResponseEntity.ok().eTag("\"${view.version}\"").body(view)
    }

    /** OP-05. POST /campaigns/{id}/payout-registry — только committee_chair. */
    @PostMapping("/campaigns/{id}/payout-registry")
    fun registry(
        user: AuthUser,
        @PathVariable id: UUID,
        @RequestHeader("Idempotency-Key", required = false) idemKey: String?,
        @RequestBody body: RegistryRequest,
    ): ResponseEntity<RegistryView> {
        // R-03 получает отказ даже по своей кампании: права payout:create у роли reviewer нет
        if (!user.has(Permission.PAYOUT_CREATE)) throw Errors.forbidden("Операция доступна только председателю комиссии")
        val key = IdempotencyStore.parseKey(idemKey) { throw Errors.preconditionRequired("Заголовок Idempotency-Key обязателен") }
        val (status, view) = service.createRegistry(user, id, key, body)
        return ResponseEntity.status(status).body(view)
    }

    /** OP-12. GET /campaigns/{id}/ranking — R-03, R-04. */
    @GetMapping("/campaigns/{id}/ranking")
    fun ranking(user: AuthUser, @PathVariable id: UUID): ResponseEntity<Map<String, Any?>> {
        if (!user.has(Permission.RANKING_READ)) throw Errors.forbidden()
        return ResponseEntity.ok().header(HttpHeaders.CACHE_CONTROL, "no-store").body(service.ranking(user, id))
    }
}
