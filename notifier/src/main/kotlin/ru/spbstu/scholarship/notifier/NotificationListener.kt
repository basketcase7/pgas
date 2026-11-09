package ru.spbstu.scholarship.notifier

import com.fasterxml.jackson.databind.ObjectMapper
import org.apache.kafka.clients.consumer.ConsumerRecord
import org.slf4j.LoggerFactory
import org.slf4j.MDC
import org.springframework.beans.factory.annotation.Value
import org.springframework.data.redis.core.StringRedisTemplate
import org.springframework.http.client.SimpleClientHttpRequestFactory
import org.springframework.kafka.annotation.KafkaListener
import org.springframework.mail.SimpleMailMessage
import org.springframework.mail.javamail.JavaMailSender
import org.springframework.stereotype.Component
import org.springframework.web.client.HttpClientErrorException
import org.springframework.web.client.RestClient
import ru.spbstu.scholarship.platform.events.ApplicationEvent
import ru.spbstu.scholarship.platform.events.PasswordResetEvent
import ru.spbstu.scholarship.platform.events.Topics
import java.time.Duration
import java.time.Instant
import java.util.UUID

/**
 * Обработчик очереди уведомлений (B-09 → B-14).
 *
 * Гарантия доставки — «хотя бы один раз»: смещение в Kafka фиксируется только после
 * успешной отправки письма. Если notifier упадёт до фиксации, сообщение придёт снова.
 * Повторная доставка не приводит ко второму письму: идентификатор события event_id
 * отмечается в Redis (notifier:done:{event_id}, TTL 7 суток) после отправки, и
 * уже обработанное событие пропускается.
 */
@Component
class NotificationListener(
    private val om: ObjectMapper,
    private val mail: JavaMailSender,
    private val redis: StringRedisTemplate,
    // билдер из контекста Spring: те же конвертеры и ObjectMapper (snake_case), что у сервиса
    restClientBuilder: RestClient.Builder,
    @Value("\${notifier.auth-service-url}") authUrl: String,
    @Value("\${notifier.service-token}") private val serviceToken: String,
    @Value("\${notifier.reset-link-base}") private val resetLinkBase: String,
    @Value("\${notifier.applicant-web-url}") private val webUrl: String,
    @Value("\${notifier.from}") private val from: String,
) {
    private val log = LoggerFactory.getLogger(NotificationListener::class.java)
    private val auth = restClientBuilder.baseUrl(authUrl)
        .requestFactory(SimpleClientHttpRequestFactory().apply { setConnectTimeout(3000); setReadTimeout(3000) })
        .build()

    data class Contact(val email: String, val fullName: String)

    @KafkaListener(topics = [Topics.APPLICATION_EVENTS], groupId = "notifier")
    fun onApplicationEvent(record: ConsumerRecord<String, String>) {
        val e = om.readValue(record.value(), ApplicationEvent::class.java)
        process(e.eventId, record) {
            val contact = contact(e.recipientId) ?: return@process
            val number = e.applicationId.toString().takeLast(12)
            // B-14: в письме нет сведений об основаниях и сумм — только факт смены статуса
            val text = when (e.type) {
                "application.submitted" -> "Заявка № $number подана и принята к рассмотрению."
                "application.withdrawn" -> "Заявка № $number отозвана."
                "application.status_changed" -> "Статус заявки № $number изменён: ${STATUS_RU[e.status] ?: e.status}."
                else -> { log.warn("Неизвестный тип события {}", e.type); return@process }
            }
            send(contact.email, "Заявка № $number: ${STATUS_RU[e.status] ?: e.status}",
                "Здравствуйте, ${contact.fullName}!\n\n$text\nПодробности — в личном кабинете: $webUrl\n\nПисьмо отправлено автоматически.")
        }
    }

    @KafkaListener(topics = [Topics.PASSWORD_RESET], groupId = "notifier")
    fun onPasswordReset(record: ConsumerRecord<String, String>) {
        val e = om.readValue(record.value(), PasswordResetEvent::class.java)
        process(e.eventId, record) {
            if (e.expiresAt.isBefore(Instant.now())) { log.info("Код восстановления уже истёк — письмо не отправляется"); return@process }
            val contact = contact(e.userId) ?: return@process
            send(contact.email, "Восстановление доступа",
                "Здравствуйте, ${contact.fullName}!\n\nДля смены пароля перейдите по ссылке (действует 15 минут, однократно):\n" +
                    "$resetLinkBase?token=${e.resetToken}\n\nЕсли вы не запрашивали восстановление, просто проигнорируйте письмо.")
        }
    }

    private fun process(eventId: UUID, record: ConsumerRecord<String, String>, action: () -> Unit) {
        MDC.put("event_id", eventId.toString())
        try {
            val doneKey = "notifier:done:$eventId"
            if (redis.hasKey(doneKey)) {
                log.info("Повторная доставка события — уже обработано, пропуск (topic={} offset={})", record.topic(), record.offset())
                return
            }
            log.info("Получено событие: topic={} partition={} offset={}", record.topic(), record.partition(), record.offset())
            action()
            redis.opsForValue().set(doneKey, Instant.now().toString(), Duration.ofDays(7))
        } finally {
            MDC.remove("event_id")
        }
    }

    /** Адрес получателя запрашивается у auth-service (сервисный токен); в сообщении брокера ПДн нет. */
    private fun contact(userId: UUID): Contact? = try {
        auth.get().uri("/internal/users/{id}/contact", userId)
            .header("X-Service-Token", serviceToken)
            .retrieve().body(Contact::class.java)
    } catch (e: HttpClientErrorException.NotFound) {
        log.warn("Получатель {} не найден — уведомление пропущено", userId)
        null
    }

    private fun send(to: String, subject: String, text: String) {
        mail.send(SimpleMailMessage().apply { setFrom(from); setTo(to); setSubject(subject); setText(text) })
        log.info("Письмо отправлено (тема: {})", subject)
    }

    companion object {
        val STATUS_RU = mapOf(
            "submitted" to "подана", "under_review" to "на рассмотрении", "approved" to "одобрена",
            "rejected" to "отклонена", "withdrawn" to "отозвана",
        )
    }
}
