package ru.spbstu.scholarship.platform.web

import com.fasterxml.jackson.databind.exc.UnrecognizedPropertyException
import com.fasterxml.jackson.databind.exc.MismatchedInputException
import jakarta.servlet.http.HttpServletRequest
import org.slf4j.LoggerFactory
import org.springframework.http.HttpHeaders
import org.springframework.http.HttpStatus
import org.springframework.http.ResponseEntity
import org.springframework.http.converter.HttpMessageNotReadableException
import org.springframework.web.HttpMediaTypeNotSupportedException
import org.springframework.web.HttpRequestMethodNotSupportedException
import org.springframework.web.bind.MissingRequestHeaderException
import org.springframework.web.bind.MissingServletRequestParameterException
import org.springframework.web.bind.annotation.ExceptionHandler
import org.springframework.web.bind.annotation.RestControllerAdvice
import org.springframework.web.method.annotation.MethodArgumentTypeMismatchException
import org.springframework.web.servlet.resource.NoResourceFoundException
import org.springframework.web.bind.annotation.PathVariable

/**
 * Единая обработка ошибок (задание 4.5 ЛР3).
 * Клиент получает только код и нейтральное сообщение + request_id для обращения
 * в поддержку. Текст исключения, стек вызовов и SQL уходят только в журнал.
 */
@RestControllerAdvice
class ApiErrorHandler {
    private val log = LoggerFactory.getLogger(ApiErrorHandler::class.java)

    @ExceptionHandler(ApiException::class)
    fun api(e: ApiException, req: HttpServletRequest): ResponseEntity<Map<String, Any?>> {
        val b = ResponseEntity.status(e.status)
        e.headers.forEach { (k, v) -> b.header(k, v) }
        if (e.status == HttpStatus.TOO_MANY_REQUESTS) b.header(HttpHeaders.RETRY_AFTER, "60")
        return b.body(body(e.code, e.message, req))
    }

    /** Битый JSON, лишнее поле (FAIL_ON_UNKNOWN_PROPERTIES) или неверный тип поля → 400. */
    @ExceptionHandler(HttpMessageNotReadableException::class)
    fun unreadable(e: HttpMessageNotReadableException, req: HttpServletRequest): ResponseEntity<Map<String, Any?>> {
        val msg = when (val c = e.cause) {
            is UnrecognizedPropertyException -> "Недопустимое поле в теле запроса: ${c.propertyName}"
            is MismatchedInputException -> "Неверный формат поля: ${c.path.joinToString(".") { it.fieldName ?: "[${it.index}]" }}"
            else -> "Тело запроса не соответствует схеме"
        }
        return ResponseEntity.badRequest().body(body("invalid_request", msg, req))
    }

    /** Неверный UUID в пути — это «объекта нет» (404); неверный query-параметр — 400. */
    @ExceptionHandler(MethodArgumentTypeMismatchException::class)
    fun typeMismatch(e: MethodArgumentTypeMismatchException, req: HttpServletRequest): ResponseEntity<Map<String, Any?>> {
        val isPath = e.parameter.hasParameterAnnotation(PathVariable::class.java)
        return if (isPath) ResponseEntity.status(404).body(body("not_found", "Объект не найден", req))
        else ResponseEntity.badRequest().body(body("invalid_request", "Недопустимое значение параметра ${e.name}", req))
    }

    @ExceptionHandler(MissingRequestHeaderException::class, MissingServletRequestParameterException::class)
    fun missing(e: Exception, req: HttpServletRequest) =
        ResponseEntity.badRequest().body(body("invalid_request", "Не передан обязательный параметр", req))

    @ExceptionHandler(HttpRequestMethodNotSupportedException::class)
    fun method(e: Exception, req: HttpServletRequest) =
        ResponseEntity.status(405).body(body("method_not_allowed", "Метод не поддерживается", req))

    @ExceptionHandler(HttpMediaTypeNotSupportedException::class)
    fun media(e: Exception, req: HttpServletRequest) =
        ResponseEntity.status(415).body(body("unsupported_media_type", "Ожидается application/json", req))

    @ExceptionHandler(NoResourceFoundException::class)
    fun noResource(e: Exception, req: HttpServletRequest) =
        ResponseEntity.status(404).body(body("not_found", "Объект не найден", req))

    /** Всё непредвиденное: 500 с нейтральным текстом; подробности — только в журнал. */
    @ExceptionHandler(Exception::class)
    fun unexpected(e: Exception, req: HttpServletRequest): ResponseEntity<Map<String, Any?>> {
        log.error("Непредвиденная ошибка {} {}", req.method, req.requestURI, e)
        return ResponseEntity.status(500).body(body("internal_error", "Внутренняя ошибка сервиса", req))
    }

    private fun body(code: String, message: String, req: HttpServletRequest) =
        mapOf("error" to code, "message" to message, "request_id" to RequestIds.current(req)?.toString())
}
