package ru.spbstu.scholarship.platform.web

import org.springframework.http.HttpStatus

/**
 * Ожидаемая ошибка с кодом из контракта. Сообщение — нейтральное и безопасное
 * для показа клиенту; внутренние подробности сюда не кладутся.
 */
open class ApiException(
    val status: HttpStatus,
    val code: String,
    override val message: String,
    val headers: Map<String, String> = emptyMap(),
) : RuntimeException(message)

object Errors {
    fun badRequest(msg: String, code: String = "invalid_request") = ApiException(HttpStatus.BAD_REQUEST, code, msg)
    fun unauthorized(code: String = "unauthorized") =
        ApiException(HttpStatus.UNAUTHORIZED, code, "Требуется действующий токен доступа",
            mapOf("WWW-Authenticate" to "Bearer"))
    fun forbidden(msg: String = "Недостаточно прав для операции", code: String = "forbidden") =
        ApiException(HttpStatus.FORBIDDEN, code, msg)
    fun notFound(msg: String = "Объект не найден") = ApiException(HttpStatus.NOT_FOUND, "not_found", msg)
    fun conflict(msg: String, code: String = "conflict") = ApiException(HttpStatus.CONFLICT, code, msg)
    fun unprocessable(msg: String, code: String = "unprocessable") = ApiException(HttpStatus.UNPROCESSABLE_ENTITY, code, msg)
    fun preconditionRequired(msg: String) = ApiException(HttpStatus.PRECONDITION_REQUIRED, "precondition_required", msg)
    fun tooMany() = ApiException(HttpStatus.TOO_MANY_REQUESTS, "rate_limited", "Превышена частота запросов")
}
