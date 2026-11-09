package ru.spbstu.scholarship.platform.token

import java.security.KeyFactory
import java.security.interfaces.RSAPrivateKey
import java.security.interfaces.RSAPublicKey
import java.security.spec.PKCS8EncodedKeySpec
import java.security.spec.X509EncodedKeySpec
import java.util.Base64

/** Загрузка ключей из переменных окружения (PEM, закодированный base64 в одну строку). */
object Pem {
    fun publicKeyFromEnvValue(b64Pem: String): RSAPublicKey {
        val der = decode(b64Pem, "PUBLIC KEY")
        return KeyFactory.getInstance("RSA").generatePublic(X509EncodedKeySpec(der)) as RSAPublicKey
    }

    fun privateKeyFromEnvValue(b64Pem: String): RSAPrivateKey {
        val der = decode(b64Pem, "PRIVATE KEY")
        return KeyFactory.getInstance("RSA").generatePrivate(PKCS8EncodedKeySpec(der)) as RSAPrivateKey
    }

    private fun decode(b64Pem: String, label: String): ByteArray {
        require(b64Pem.isNotBlank()) { "ключ $label не задан в окружении" }
        val pem = String(Base64.getMimeDecoder().decode(b64Pem.trim()))
        val body = pem.replace("-----BEGIN $label-----", "")
            .replace("-----END $label-----", "")
            .replace("\\s".toRegex(), "")
        return Base64.getDecoder().decode(body)
    }
}
