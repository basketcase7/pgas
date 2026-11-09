package ru.spbstu.scholarship.applications.domain

import ru.spbstu.scholarship.platform.util.Hashing
import ru.spbstu.scholarship.platform.web.Errors

/** Значения перечислений совпадают с типами PostgreSQL из schema.sql. Разбор — строго по белому списку. */
enum class ApplicationType(val db: String) {
    MATERIAL_AID("material_aid"), PGAS("pgas");
    companion object {
        fun parse(v: String?, field: String = "type") =
            entries.firstOrNull { it.db == v } ?: throw Errors.badRequest("Поле $field: допустимы material_aid, pgas")
    }
}

enum class ApplicationStatus(val db: String) {
    DRAFT("draft"), SUBMITTED("submitted"), UNDER_REVIEW("under_review"),
    APPROVED("approved"), REJECTED("rejected"), WITHDRAWN("withdrawn");
    companion object {
        fun parse(v: String?) = entries.firstOrNull { it.db == v }
            ?: throw Errors.badRequest("Недопустимое значение status")
        fun of(db: String) = entries.first { it.db == db }
    }
}

/** Справочник заявленных оснований (тип support_ground, D-07). */
enum class Ground(val db: String) {
    LOW_INCOME("low_income"), DISABILITY("disability"), ORPHAN("orphan"), LARGE_FAMILY("large_family"),
    ACADEMIC_EXCELLENCE("academic_excellence"), SCIENCE("science"), SOCIAL_ACTIVITY("social_activity"),
    CULTURE("culture"), SPORTS("sports");
    companion object {
        fun parse(v: String?) = entries.firstOrNull { it.db == v }
            ?: throw Errors.badRequest("Недопустимое основание в declared_grounds: $v".take(120))
    }
}

enum class DocType(val db: String) {
    INCOME_CERTIFICATE("income_certificate"), DISABILITY_DOCUMENT("disability_document"),
    ACHIEVEMENT_PROOF("achievement_proof"), FAMILY_COMPOSITION("family_composition"), OTHER("other");
    companion object {
        fun parse(v: String?) = entries.firstOrNull { it.db == v } ?: throw Errors.badRequest("Недопустимый doc_type")
    }
}

/** Сортировки списка OP-04 — белый список; каждому значению соответствует ЗАРАНЕЕ написанный SQL. */
enum class ListSort(val param: String) {
    CREATED_DESC("-created_at"), CREATED_ASC("created_at"), SCORE_DESC("-total_score"), SCORE_ASC("total_score");
    companion object {
        fun parse(v: String?) = if (v == null) CREATED_DESC else
            entries.firstOrNull { it.param == v } ?: throw Errors.badRequest("Недопустимое значение sort")
    }
}

/**
 * Хеш содержимого заявки (applications.content_hash) — ключ кэша проверки полноты.
 * Формула совпадает с seed.sql: SHA-256(type \n основания-по-алфавиту-через-запятую \n statement).
 */
object ContentHash {
    fun of(type: ApplicationType, grounds: Collection<Ground>, statement: String): String =
        Hashing.sha256Hex("${type.db}\n${grounds.map { it.db }.sorted().joinToString(",")}\n$statement")
}
