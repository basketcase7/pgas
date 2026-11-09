package ru.spbstu.scholarship.review

import com.fasterxml.jackson.databind.ObjectMapper
import org.springframework.boot.autoconfigure.SpringBootApplication
import org.springframework.boot.runApplication
import org.springframework.context.annotation.Bean
import org.springframework.context.annotation.Import
import org.springframework.jdbc.core.namedparam.NamedParameterJdbcTemplate
import org.springframework.kafka.core.KafkaTemplate
import org.springframework.transaction.PlatformTransactionManager
import ru.spbstu.scholarship.platform.audit.AuditLog
import ru.spbstu.scholarship.platform.events.EventPublisher
import ru.spbstu.scholarship.platform.idempotency.IdempotencyStore
import ru.spbstu.scholarship.platform.web.PlatformWebConfig

@SpringBootApplication
@Import(PlatformWebConfig::class)
class ReviewApplication {
    @Bean fun auditLog(jdbc: NamedParameterJdbcTemplate, om: ObjectMapper, tx: PlatformTransactionManager) = AuditLog(jdbc, om, tx)
    @Bean fun idempotencyStore(jdbc: NamedParameterJdbcTemplate) = IdempotencyStore(jdbc)
    @Bean fun eventPublisher(kafka: KafkaTemplate<String, String>, om: ObjectMapper) = EventPublisher(kafka, om)
}

fun main(args: Array<String>) {
    runApplication<ReviewApplication>(*args)
}
