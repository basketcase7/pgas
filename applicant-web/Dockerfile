# ЛР5, V-C01: официальный образ NGINX, работающий без root (uid 101, порт 8080, pid и
# временные файлы в /tmp); стабильная ветка 1.30 вместо 1.27 — закрывает уязвимости
# пакетов ОС базового образа (Trivy) и DS-0002 «Image user should not be 'root'».
FROM nginxinc/nginx-unprivileged:1.30.6-alpine
COPY nginx.conf /etc/nginx/conf.d/default.conf
COPY public/ /usr/share/nginx/html/
USER 101
EXPOSE 8080
