package ru.spbstu.scholarship.auth.bootstrap

import org.slf4j.LoggerFactory
import org.springframework.beans.factory.annotation.Value
import org.springframework.boot.context.event.ApplicationReadyEvent
import org.springframework.context.event.EventListener
import org.springframework.stereotype.Component
import ru.spbstu.scholarship.auth.crypto.PasswordHasher
import ru.spbstu.scholarship.auth.user.UserRepository

/**
 * Тестовые пользователи из seed.sql создаются с маркером '!bootstrap' вместо хеша:
 * готовый хеш в репозитории потребовал бы зафиксировать перец. При старте сервис
 * один раз вычисляет Argon2id(перец, DEMO_USERS_PASSWORD) для каждой такой записи.
 * В базе в итоге лежит только хеш (задание 2.3). Маркер не совпадает ни с одним паролем:
 * PasswordHasher принимает только строки формата $argon2id$.
 */
@Component
class DemoPasswordBootstrap(
    private val users: UserRepository,
    private val hasher: PasswordHasher,
    @Value("\${security.demo-users-password:}") private val demoPassword: String,
) {
    private val log = LoggerFactory.getLogger(DemoPasswordBootstrap::class.java)

    @EventListener(ApplicationReadyEvent::class)
    fun run() {
        if (demoPassword.isBlank()) return
        val ids = users.idsWithBootstrapMarker()
        ids.forEach { users.updatePassword(it, hasher.hash(demoPassword)) }
        if (ids.isNotEmpty()) log.info("Заданы пароли тестовых учётных записей: {}", ids.size)
    }
}
