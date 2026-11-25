package ru.spbstu.scholarship.platform.web

import com.fasterxml.jackson.core.JsonParser
import com.fasterxml.jackson.databind.DeserializationContext
import com.fasterxml.jackson.databind.deser.std.StdScalarDeserializer
import com.fasterxml.jackson.databind.deser.std.StringDeserializer
import com.fasterxml.jackson.databind.exc.InvalidFormatException

/**
 * ЛР5, V-D05 (найдено OWASP ZAP): символ U+0000 в строке JSON проходил разбор и доходил до
 * PostgreSQL, который не хранит NUL в text («invalid byte sequence for encoding UTF8: 0x00») —
 * запрос завершался 500, а отказ не попадал в журнал как ошибка клиента.
 * Строка с NUL отклоняется при разборе тела (400 «Неверный формат поля») во всех сервисах:
 * десериализатор подключается в PlatformWebConfig и действует и для List<String>.
 */
class NulRejectingStringDeserializer : StdScalarDeserializer<String>(String::class.java) {
    override fun deserialize(p: JsonParser, ctxt: DeserializationContext): String? {
        val value = StringDeserializer.instance.deserialize(p, ctxt)
        if (value != null && value.indexOf('\u0000') >= 0) {
            throw InvalidFormatException(p, "Строка содержит символ U+0000", "<NUL>", String::class.java)
        }
        return value
    }
}
