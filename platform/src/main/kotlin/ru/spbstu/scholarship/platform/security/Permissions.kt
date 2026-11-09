package ru.spbstu.scholarship.platform.security

import java.util.UUID

/** Роли системы (таблица roles, реестр ролей ЛР1). */
object Roles {
    const val APPLICANT = "applicant"             // R-02
    const val REVIEWER = "reviewer"               // R-03
    const val COMMITTEE_CHAIR = "committee_chair" // R-04
    const val SUPPORT = "support"                 // R-07
    const val ADMIN = "admin"                     // R-05 (в прикладном API прав нет)

    /** Роли, для которых область видимости — кампании своего подразделения. */
    val UNIT_SCOPED = setOf(REVIEWER, COMMITTEE_CHAIR, SUPPORT)
}

/**
 * Права на ОПЕРАЦИЮ (п. «Права на операцию» в контрактах ЛР2).
 * Единственное место, где роль сопоставляется с правом; права на ОБЪЕКТ
 * проверяются отдельно — в SQL-запросе выборки (владелец / подразделение).
 */
enum class Permission(val code: String) {
    APPLICATIONS_READ("applications:read"),        // OP-01
    APPLICATIONS_CREATE("applications:create"),    // OP-02
    APPLICATIONS_REVIEW("applications:review"),    // OP-03
    APPLICATIONS_LIST("applications:list"),        // OP-04
    PAYOUT_CREATE("payout:create"),                // OP-05
    COMPLETENESS_REQUEST("completeness:request"),  // OP-06 / OP-11
    ATTACHMENTS_CREATE("attachments:create"),      // OP-10
    RANKING_READ("ranking:read"),                  // OP-12
    APPLICATIONS_WITHDRAW("applications:withdraw"),// OP-13
    APPLICATIONS_SUBMIT("applications:submit"),    // OP-18 (D-12)
    CAMPAIGNS_READ("campaigns:read"),              // OP-17 (D-11)
}

object RolePermissions {
    private val matrix: Map<String, Set<Permission>> = mapOf(
        Roles.APPLICANT to setOf(
            Permission.APPLICATIONS_READ, Permission.APPLICATIONS_CREATE, Permission.APPLICATIONS_LIST,
            Permission.COMPLETENESS_REQUEST, Permission.ATTACHMENTS_CREATE, Permission.APPLICATIONS_WITHDRAW,
            Permission.APPLICATIONS_SUBMIT, Permission.CAMPAIGNS_READ,
        ),
        Roles.REVIEWER to setOf(
            Permission.APPLICATIONS_READ, Permission.APPLICATIONS_REVIEW, Permission.APPLICATIONS_LIST,
            Permission.COMPLETENESS_REQUEST, Permission.RANKING_READ, Permission.CAMPAIGNS_READ,
        ),
        Roles.COMMITTEE_CHAIR to setOf(
            Permission.APPLICATIONS_READ, Permission.APPLICATIONS_LIST, Permission.PAYOUT_CREATE,
            Permission.RANKING_READ, Permission.CAMPAIGNS_READ,
        ),
        Roles.SUPPORT to setOf(Permission.APPLICATIONS_READ, Permission.CAMPAIGNS_READ),
        Roles.ADMIN to emptySet(),
    )

    fun of(roles: Set<String>): Set<Permission> = roles.flatMap { matrix[it] ?: emptySet() }.toSet()
}

/** Аутентифицированный субъект запроса — берётся ТОЛЬКО из проверенного токена. */
data class AuthUser(
    val id: UUID,
    val sessionId: String,
    val roles: Set<String>,
    val unitId: UUID?,
) {
    val permissions: Set<Permission> by lazy { RolePermissions.of(roles) }
    fun has(p: Permission) = p in permissions
    fun hasRole(r: String) = r in roles
    fun isApplicant() = Roles.APPLICANT in roles
    fun isUnitScoped() = roles.any { it in Roles.UNIT_SCOPED }
}
