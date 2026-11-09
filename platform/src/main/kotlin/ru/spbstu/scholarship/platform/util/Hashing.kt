package ru.spbstu.scholarship.platform.util

import java.security.MessageDigest
import java.util.HexFormat

object Hashing {
    fun sha256Hex(s: String): String = sha256Hex(s.toByteArray(Charsets.UTF_8))
    fun sha256Hex(b: ByteArray): String = HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(b))

    /** Сравнение за постоянное время (секреты, токены). */
    fun constantTimeEquals(a: String, b: String): Boolean =
        MessageDigest.isEqual(a.toByteArray(Charsets.UTF_8), b.toByteArray(Charsets.UTF_8))
}
