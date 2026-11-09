package ru.spbstu.scholarship.platform.catalog

import java.util.Hashtable
import javax.naming.Context
import javax.naming.directory.InitialDirContext
import javax.naming.directory.SearchControls

/** Запись корпоративного каталога R-09 — минимальный набор атрибутов (B-13). */
data class CatalogEntry(
    val uid: String,
    val fullName: String,
    val email: String?,
    val status: String?,     // employeeType: student-active | student-expelled | staff
    val unitCode: String?,   // departmentNumber
) {
    val isActiveStudent: Boolean get() = status == "student-active"
}

class CatalogUnavailableException(cause: Throwable) : RuntimeException("Каталог недоступен", cause)

/**
 * Клиент каталога учётных записей (LDAP). Подключение под учётной записью только для чтения.
 * Поиск выполняется с параметризованным фильтром "(uid={0})": JNDI экранирует значение,
 * поэтому LDAP-инъекция через логин невозможна (аналог параметризованного SQL).
 */
class LdapCatalog(
    private val url: String,
    private val bindDn: String,
    private val bindPassword: String,
    private val baseDn: String = "ou=people,dc=spbstu,dc=local",
) {
    fun find(uid: String): CatalogEntry? {
        val env = Hashtable<String, String>().apply {
            put(Context.INITIAL_CONTEXT_FACTORY, "com.sun.jndi.ldap.LdapCtxFactory")
            put(Context.PROVIDER_URL, url)
            put(Context.SECURITY_AUTHENTICATION, "simple")
            put(Context.SECURITY_PRINCIPAL, bindDn)
            put(Context.SECURITY_CREDENTIALS, bindPassword)
            put("com.sun.jndi.ldap.connect.timeout", "3000")
            put("com.sun.jndi.ldap.read.timeout", "3000")
        }
        val ctx = try { InitialDirContext(env) } catch (e: Exception) { throw CatalogUnavailableException(e) }
        try {
            val controls = SearchControls().apply {
                searchScope = SearchControls.ONELEVEL_SCOPE
                returningAttributes = arrayOf("uid", "cn", "mail", "employeeType", "departmentNumber")
                countLimit = 2
            }
            val results = ctx.search(baseDn, "(uid={0})", arrayOf<Any>(uid), controls)
            if (!results.hasMore()) return null
            val a = results.next().attributes
            fun attr(n: String) = a.get(n)?.get()?.toString()
            return CatalogEntry(attr("uid") ?: uid, attr("cn") ?: "", attr("mail"), attr("employeeType"), attr("departmentNumber"))
        } catch (e: javax.naming.NamingException) {
            throw CatalogUnavailableException(e)
        } finally {
            ctx.close()
        }
    }
}
