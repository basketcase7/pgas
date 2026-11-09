package ru.spbstu.scholarship.auth.user

import org.springframework.jdbc.core.namedparam.MapSqlParameterSource
import org.springframework.jdbc.core.namedparam.NamedParameterJdbcTemplate
import org.springframework.stereotype.Repository
import java.util.UUID

data class UserRecord(
    val id: UUID,
    val externalId: String,
    val email: String,
    val fullName: String,
    val unitId: UUID,
    val passwordHash: String,
    val isActive: Boolean,
)

/** Доступ к users / user_roles. Только параметризованные запросы — склейки SQL нет. */
@Repository
class UserRepository(private val jdbc: NamedParameterJdbcTemplate) {

    private val columns = "id, external_id, email, full_name, unit_id, password_hash, is_active"

    private fun map(rs: java.sql.ResultSet) = UserRecord(
        rs.getObject("id", UUID::class.java), rs.getString("external_id"), rs.getString("email"),
        rs.getString("full_name"), rs.getObject("unit_id", UUID::class.java), rs.getString("password_hash"),
        rs.getBoolean("is_active"),
    )

    /** Вход допускается по external_id (логину каталога) или по e-mail. */
    fun findByLogin(login: String): UserRecord? = jdbc.query(
        "SELECT $columns FROM users WHERE external_id = :login OR lower(email) = lower(:login) LIMIT 1",
        MapSqlParameterSource("login", login),
    ) { rs, _ -> map(rs) }.firstOrNull()

    fun findById(id: UUID): UserRecord? = jdbc.query(
        "SELECT $columns FROM users WHERE id = :id", MapSqlParameterSource("id", id),
    ) { rs, _ -> map(rs) }.firstOrNull()

    fun findByEmail(email: String): UserRecord? = jdbc.query(
        "SELECT $columns FROM users WHERE lower(email) = lower(:email)", MapSqlParameterSource("email", email),
    ) { rs, _ -> map(rs) }.firstOrNull()

    fun rolesOf(id: UUID): List<String> = jdbc.queryForList(
        "SELECT role_code FROM user_roles WHERE user_id = :id ORDER BY role_code",
        MapSqlParameterSource("id", id), String::class.java,
    )

    fun existsByExternalIdOrEmail(externalId: String, email: String): Boolean = jdbc.queryForObject(
        "SELECT EXISTS (SELECT 1 FROM users WHERE external_id = :ext OR lower(email) = lower(:email))",
        MapSqlParameterSource().addValue("ext", externalId).addValue("email", email), Boolean::class.java,
    ) == true

    fun unitIdByCode(code: String): UUID? = jdbc.query(
        "SELECT id FROM units WHERE code = :code", MapSqlParameterSource("code", code),
    ) { rs, _ -> rs.getObject("id", UUID::class.java) }.firstOrNull()

    @org.springframework.transaction.annotation.Transactional
    fun insertApplicant(externalId: String, email: String, fullName: String, unitId: UUID, passwordHash: String): UUID {
        val id = jdbc.queryForObject(
            """
            INSERT INTO users (external_id, email, full_name, unit_id, password_hash)
            VALUES (:ext, :email, :name, :unit, :hash) RETURNING id
            """.trimIndent(),
            MapSqlParameterSource().addValue("ext", externalId).addValue("email", email)
                .addValue("name", fullName).addValue("unit", unitId).addValue("hash", passwordHash),
            UUID::class.java,
        )!!
        // роль назначает сервер: при регистрации — только applicant, клиент роль не выбирает
        jdbc.update("INSERT INTO user_roles (user_id, role_code) VALUES (:id, 'applicant')", MapSqlParameterSource("id", id))
        return id
    }

    fun updatePassword(id: UUID, hash: String) = jdbc.update(
        "UPDATE users SET password_hash = :hash WHERE id = :id",
        MapSqlParameterSource().addValue("hash", hash).addValue("id", id),
    )

    fun idsWithBootstrapMarker(): List<UUID> = jdbc.query(
        "SELECT id FROM users WHERE password_hash = '!bootstrap'", MapSqlParameterSource(),
    ) { rs, _ -> rs.getObject("id", UUID::class.java) }
}
