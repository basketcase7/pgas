package ru.spbstu.scholarship.auth

import com.fasterxml.jackson.databind.ObjectMapper
import org.springframework.beans.factory.annotation.Value
import org.springframework.boot.autoconfigure.SpringBootApplication
import org.springframework.boot.runApplication
import org.springframework.context.annotation.Bean
import org.springframework.context.annotation.Import
import org.springframework.jdbc.core.namedparam.NamedParameterJdbcTemplate
import org.springframework.kafka.core.KafkaTemplate
import ru.spbstu.scholarship.platform.audit.AuditLog
import ru.spbstu.scholarship.platform.catalog.LdapCatalog
import ru.spbstu.scholarship.platform.events.EventPublisher
import ru.spbstu.scholarship.platform.web.PlatformWebConfig

@SpringBootApplication
@Import(PlatformWebConfig::class)
class AuthApplication {
    @Bean
    fun auditLog(jdbc: NamedParameterJdbcTemplate, om: ObjectMapper, tx: org.springframework.transaction.PlatformTransactionManager) = AuditLog(jdbc, om, tx)

    @Bean
    fun eventPublisher(kafka: KafkaTemplate<String, String>, om: ObjectMapper) = EventPublisher(kafka, om)

    @Bean
    fun ldapCatalog(
        @Value("\${catalog.url}") url: String,
        @Value("\${catalog.bind-dn}") dn: String,
        @Value("\${catalog.bind-password}") pwd: String,
    ) = LdapCatalog(url, dn, pwd)
}

fun main(args: Array<String>) {
    runApplication<AuthApplication>(*args)
}
