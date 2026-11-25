# Объектное хранилище вложений (A-02) с S3-совместимым API.
# SeaweedFS вместо MinIO: образы MinIO больше не публикуются в Docker Hub (журнал расхождений D-04).
# ЛР5, V-C02: 4.55 вместо 3.97 (Go 1.24.6 и библиотеки с уязвимостями High/Critical, Trivy) и
# запуск от непривилегированного пользователя seaweed (Semgrep missing-user-entrypoint, Trivy DS-0002).
FROM chrislusf/seaweedfs:4.55
COPY entrypoint.sh /entrypoint-s3.sh
USER seaweed
ENTRYPOINT ["sh", "/entrypoint-s3.sh"]
