# Объектное хранилище вложений (A-02) с S3-совместимым API.
# SeaweedFS вместо MinIO: образы MinIO больше не публикуются в Docker Hub (журнал расхождений D-04).
FROM chrislusf/seaweedfs:3.97
COPY entrypoint.sh /entrypoint-s3.sh
ENTRYPOINT ["sh", "/entrypoint-s3.sh"]
