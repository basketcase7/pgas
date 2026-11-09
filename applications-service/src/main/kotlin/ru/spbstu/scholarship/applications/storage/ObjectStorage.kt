package ru.spbstu.scholarship.applications.storage

import io.minio.GetPresignedObjectUrlArgs
import io.minio.MinioClient
import io.minio.PostPolicy
import io.minio.RemoveObjectArgs
import io.minio.http.Method
import org.slf4j.LoggerFactory
import org.springframework.beans.factory.annotation.Value
import org.springframework.stereotype.Component
import java.net.URI
import java.time.Duration
import java.time.ZonedDateTime
import java.util.concurrent.TimeUnit

data class UploadForm(val url: String, val fields: Map<String, String>, val expiresAt: ZonedDateTime)

/**
 * Объектное хранилище вложений (B-07). Файлы не проходят через API: сервис только
 * выписывает ограниченные по сроку подписанные ссылки после проверки принадлежности заявки.
 *
 * Загрузка — presigned POST с политикой: хранилище само отклонит файл другого размера
 * (content-length-range) или типа (Content-Type), загрузку под другим ключом и после истечения срока.
 * Ссылки возвращаются относительными путями: браузер обращается к хранилищу через
 * reverse-proxy своего веб-контейнера (same-origin, D-05).
 */
@Component
class ObjectStorage(
    @Value("\${storage.endpoint}") endpoint: String,
    @Value("\${storage.bucket}") private val bucket: String,
    @Value("\${storage.access-key}") accessKey: String,
    @Value("\${storage.secret-key}") secretKey: String,
) {
    private val log = LoggerFactory.getLogger(ObjectStorage::class.java)
    private val client: MinioClient = MinioClient.builder()
        .endpoint(endpoint).region(REGION).credentials(accessKey, secretKey).build()

    fun presignUpload(objectKey: String, contentType: String, sizeBytes: Long, ttl: Duration = UPLOAD_TTL): UploadForm {
        val expires = ZonedDateTime.now().plus(ttl)
        val policy = PostPolicy(bucket, expires).apply {
            addEqualsCondition("key", objectKey)
            addEqualsCondition("Content-Type", contentType)
            addContentLengthRangeCondition(sizeBytes, sizeBytes)
        }
        val fields = client.getPresignedPostFormData(policy) +
            mapOf("key" to objectKey, "Content-Type" to contentType)
        return UploadForm("/$bucket/", fields, expires)
    }

    /**
     * Ссылка на скачивание (presigned GET, 5 минут). Файл отдаётся как вложение:
     * заголовок Content-Disposition: attachment ставит nginx клиентского контейнера
     * (SeaweedFS не поддерживает параметр response-content-disposition), имя файла
     * подставляет атрибут download у ссылки в интерфейсе.
     */
    fun presignDownload(objectKey: String, ttl: Duration = DOWNLOAD_TTL): String {
        val url = client.getPresignedObjectUrl(
            GetPresignedObjectUrlArgs.builder().method(Method.GET).bucket(bucket).`object`(objectKey)
                .expiry(ttl.seconds.toInt(), TimeUnit.SECONDS).build(),
        )
        val u = URI(url)
        return u.rawPath + "?" + u.rawQuery
    }

    fun deleteQuietly(objectKey: String) {
        runCatching { client.removeObject(RemoveObjectArgs.builder().bucket(bucket).`object`(objectKey).build()) }
            .onFailure { log.warn("Не удалось удалить объект {}", objectKey, it) }
    }

    companion object {
        const val REGION = "us-east-1"
        val UPLOAD_TTL: Duration = Duration.ofMinutes(15)   // B-03: срок ссылки 15 минут
        val DOWNLOAD_TTL: Duration = Duration.ofMinutes(5)
        const val MAX_SIZE = 10L * 1024 * 1024               // ck_attachments_size
        val ALLOWED_TYPES = setOf("application/pdf", "image/jpeg", "image/png")
    }
}
