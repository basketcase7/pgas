# ЛР5, V-C01: nginx без root и без известных уязвимостей High/Critical.
#  - официальный образ стабильной ветки 1.30 (1.30.8; в nginxinc/nginx-unprivileged пока 1.30.6
#    с Critical в самом nginx) + обновление пакетов ОС при сборке (libexpat, curl, musl, libxml2…);
#  - запуск от пользователя nginx (uid 101): pid и временные файлы в /tmp, порт 8080 —
#    так же устроен nginxinc/nginx-unprivileged (Trivy DS-0002 «Image user should not be 'root'»).
FROM nginx:1.30.8-alpine
RUN apk upgrade --no-cache \
 && sed -i -e '/^user /d' -e 's,^pid .*,pid /tmp/nginx.pid;,' /etc/nginx/nginx.conf \
 && sed -i '/^http {/a \    client_body_temp_path /tmp/client_temp;\n    proxy_temp_path /tmp/proxy_temp;\n    fastcgi_temp_path /tmp/fastcgi_temp;\n    uwsgi_temp_path /tmp/uwsgi_temp;\n    scgi_temp_path /tmp/scgi_temp;' /etc/nginx/nginx.conf \
 && chown -R 101:101 /var/cache/nginx /etc/nginx/conf.d
COPY nginx.conf /etc/nginx/conf.d/default.conf
COPY public/ /usr/share/nginx/html/
USER 101
EXPOSE 8080
