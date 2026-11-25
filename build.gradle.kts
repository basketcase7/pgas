import io.spring.gradle.dependencymanagement.dsl.DependencyManagementExtension
import org.jetbrains.kotlin.gradle.dsl.KotlinJvmProjectExtension

plugins {
    kotlin("jvm") version "2.1.21" apply false
    kotlin("plugin.spring") version "2.1.21" apply false
    id("org.springframework.boot") version "3.5.16" apply false
    id("io.spring.dependency-management") version "1.1.7" apply false
}

subprojects {
    group = "ru.spbstu.scholarship"
    version = "1.0.0"

    apply(plugin = "org.jetbrains.kotlin.jvm")
    apply(plugin = "org.jetbrains.kotlin.plugin.spring")
    apply(plugin = "io.spring.dependency-management")

    repositories { mavenCentral() }

    // ЛР5, V-C03: Boot 3.5.16 задаёт Jackson 2.21.4, а исправления CVE-2026-89407, -89425,
    // -91776, -91777, -68497 вышли в 2.21.6+ той же ветки. Свойство BOM переопределяется так,
    // чтобы действовало и для автоматического импорта BOM плагином Spring Boot.
    extra["jackson-bom.version"] = "2.21.9"
    // Повторный SCA после обновления: исправления вышли позже Boot 3.5.16 в тех же ветках —
    // Tomcat (CVE-2026-55276, -65182, -65637, -65905, -68525), Netty (CVE-2026-75595, -59901),
    // pgjdbc (CVE-2026-54291)
    extra["tomcat.version"] = "10.1.62"
    extra["netty.version"] = "4.1.141.Final"
    extra["postgresql.version"] = "42.7.15"

    configure<DependencyManagementExtension> {
        imports {
            // ЛР5, V-C03: последние выпуски тех же веток (без смены мажорных версий API)
            mavenBom("org.springframework.boot:spring-boot-dependencies:3.5.16")
            mavenBom("org.springframework.cloud:spring-cloud-dependencies:2025.0.3")
        }
        // ЛР5, V-C03: транзитивные библиотеки с уязвимостями High/Critical (Trivy), которые
        // BOM Spring не задаёт; версия одна для всех модулей (иначе в образах разные bcprov)
        dependencies {
            dependency("org.bouncycastle:bcprov-jdk18on:1.87")   // spring-cloud-gateway, minio, Argon2id
            dependency("org.xerial.snappy:snappy-java:1.1.10.12") // kafka-clients
            dependency("com.google.guava:guava:33.8.0-jre")      // minio
            dependency("at.yawk.lz4:lz4-java:1.14.1")            // kafka-clients (CVE-2026-106451)
        }
    }

    configure<KotlinJvmProjectExtension> {
        jvmToolchain(21)
        compilerOptions { freeCompilerArgs.addAll("-Xjsr305=strict") }
    }

    tasks.withType<Test> { useJUnitPlatform() }
}
