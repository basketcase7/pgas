package ru.spbstu.scholarship.notifier

import com.fasterxml.jackson.core.JsonProcessingException
import org.apache.kafka.common.TopicPartition
import org.slf4j.LoggerFactory
import org.springframework.boot.autoconfigure.SpringBootApplication
import org.springframework.boot.runApplication
import org.springframework.context.annotation.Bean
import org.springframework.kafka.core.KafkaTemplate
import org.springframework.kafka.listener.DeadLetterPublishingRecoverer
import org.springframework.kafka.listener.DefaultErrorHandler
import org.springframework.util.backoff.FixedBackOff

@SpringBootApplication
class NotifierApplication {
    private val log = LoggerFactory.getLogger(NotifierApplication::class.java)

    /**
     * Обработка сбоев (B-09: «ограниченное число попыток, DLQ»):
     *  - временная ошибка (почта или auth-service недоступны) — 3 повтора с паузой 2 с,
     *    затем сообщение перекладывается в <топик>.DLT и обработка очереди продолжается;
     *  - битое сообщение (не разбирается JSON) — сразу в DLT, без повторов.
     * Spring Boot автоматически подключает этот обработчик к @KafkaListener.
     */
    @Bean
    fun errorHandler(template: KafkaTemplate<String, String>): DefaultErrorHandler {
        val recoverer = DeadLetterPublishingRecoverer(template) { rec, ex ->
            val root = generateSequence(ex as Throwable) { it.cause }.last()
            log.error("Сообщение отправлено в DLT: topic={} offset={} причина={}: {}", rec.topic(), rec.offset(),
                root.javaClass.simpleName, root.message?.take(300))
            TopicPartition(rec.topic() + ".DLT", 0)
        }
        return DefaultErrorHandler(recoverer, FixedBackOff(2000L, 3L)).apply {
            addNotRetryableExceptions(JsonProcessingException::class.java, IllegalArgumentException::class.java)
        }
    }
}

fun main(args: Array<String>) {
    runApplication<NotifierApplication>(*args)
}
