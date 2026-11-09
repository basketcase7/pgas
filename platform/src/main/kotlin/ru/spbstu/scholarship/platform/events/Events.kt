package ru.spbstu.scholarship.platform.events

import com.fasterxml.jackson.databind.ObjectMapper
import org.slf4j.LoggerFactory
import org.springframework.kafka.core.KafkaTemplate
import org.springframework.transaction.support.TransactionSynchronization
import org.springframework.transaction.support.TransactionSynchronizationManager
import java.time.Instant
import java.util.UUID

object Topics {
    const val APPLICATION_EVENTS = "applications.events"
    const val PASSWORD_RESET = "auth.password-reset"
}

/**
 * Событие заявки (B-08): только идентификаторы — без текста заявки, ФИО, адресов и сумм.
 * event_id — ключ идемпотентности для обработчика (повторная доставка не шлёт второе письмо).
 */
data class ApplicationEvent(
    val eventId: UUID = UUID.randomUUID(),
    val type: String,            // application.submitted | application.withdrawn | application.status_changed
    val applicationId: UUID,
    val campaignId: UUID,
    val recipientId: UUID,       // кому уведомление; адрес notifier получает у auth-service (D-15)
    val status: String,
    val occurredAt: Instant = Instant.now(),
)

/** Запрос на письмо восстановления доступа. Топик хранит сообщения 15 минут = срок действия кода. */
data class PasswordResetEvent(
    val eventId: UUID = UUID.randomUUID(),
    val userId: UUID,
    val resetToken: String,
    val expiresAt: Instant,
)

/**
 * Публикация события ПОСЛЕ фиксации транзакции: сообщение о том, чего нет в базе
 * (откат), в брокер не попадёт. Обратная сторона — при недоступности брокера в момент
 * публикации уведомление теряется (основная операция при этом уже выполнена) — это
 * осознанный компромисс, описанный в отчёте.
 */
class EventPublisher(private val kafka: KafkaTemplate<String, String>, private val om: ObjectMapper) {
    private val log = LoggerFactory.getLogger(EventPublisher::class.java)

    fun publishAfterCommit(topic: String, key: String, event: Any) {
        val send = { send(topic, key, event) }
        if (TransactionSynchronizationManager.isSynchronizationActive()) {
            TransactionSynchronizationManager.registerSynchronization(object : TransactionSynchronization {
                override fun afterCommit() = send()
            })
        } else send()
    }

    fun send(topic: String, key: String, event: Any) {
        val payload = om.writeValueAsString(event)
        kafka.send(topic, key, payload).whenComplete { r, e ->
            if (e != null) log.error("Не удалось опубликовать событие в {} (key={})", topic, key, e)
            else log.info("Событие опубликовано: topic={} partition={} offset={} key={}",
                topic, r.recordMetadata.partition(), r.recordMetadata.offset(), key)
        }
    }
}
