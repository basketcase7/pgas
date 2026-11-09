package ru.spbstu.scholarship.auth.crypto

import org.springframework.beans.factory.annotation.Value
import org.springframework.security.crypto.argon2.Argon2PasswordEncoder
import org.springframework.stereotype.Component
import java.util.Base64
import javax.crypto.Mac
import javax.crypto.spec.SecretKeySpec

/**
 * Хеширование паролей по п. 4.3 ЛР2.
 *  - функция: Argon2id, память 64 МБ (65536 КиБ), 3 итерации, параллелизм 4;
 *    соль 16 байт — своя у каждого пользователя, хранится внутри строки PHC
 *    ($argon2id$v=19$m=65536,t=3,p=4$<соль>$<хеш>), отдельного поля salt нет;
 *  - перец: 32-байтный секрет из окружения (PASSWORD_PEPPER_B64), в базе его нет.
 *    Примешивается как HMAC-SHA256(перец, пароль) ДО Argon2id: без перца дамп БД
 *    не позволяет перебирать пароли.
 */
@Component
class PasswordHasher(@Value("\${security.pepper-b64}") pepperB64: String) {
    private val pepper: ByteArray = Base64.getDecoder().decode(pepperB64.trim()).also {
        require(it.size >= 32) { "перец должен быть не короче 32 байт" }
    }

    private val argon2 = Argon2PasswordEncoder(
        /* saltLength = */ 16,
        /* hashLength = */ 32,
        /* parallelism = */ 4,
        /* memory (KiB) = */ 65536,
        /* iterations = */ 3,
    )

    /** Хеш-заглушка: проверка против неё выполняется, когда пользователя нет, — время ответа одинаковое. */
    private val dummyHash: String = argon2.encode(peppered("dummy-password-for-timing"))

    fun hash(password: String): String = argon2.encode(peppered(password))

    fun matches(password: String, phc: String?): Boolean {
        if (phc == null || !phc.startsWith("\$argon2id\$")) {
            argon2.matches(peppered(password), dummyHash) // выравнивание времени
            return false
        }
        return argon2.matches(peppered(password), phc)
    }

    private fun peppered(password: String): String {
        val mac = Mac.getInstance("HmacSHA256")
        mac.init(SecretKeySpec(pepper, "HmacSHA256"))
        return Base64.getEncoder().encodeToString(mac.doFinal(password.toByteArray(Charsets.UTF_8)))
    }
}
