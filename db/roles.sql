--liquibase formatted sql

-- =====================================================================
-- roles.sql — учётные записи сервисов в PostgreSQL (п. 3.5 / 4.2 ЛР № 2, B-05).
-- Каждый сервис подключается к базе под своей ролью и видит только свои таблицы:
-- успешная SQL-инъекция в одном эндпоинте не даёт доступа ко всем данным.
-- Пароли НЕ записаны в файле: liquibase подставляет их из переменных окружения
-- (${...} — параметры changelog, см. db/run-migrations.sh).
-- Набор GRANT повторяет ЛР № 2; дополнения помечены «D-xx» (журнал расхождений).
-- =====================================================================

--changeset chikilev:roles-create runAlways:true runOnChange:true splitStatements:false
--comment: создание ролей сервисов и синхронизация паролей с окружением
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'svc_auth') THEN
        CREATE ROLE svc_auth LOGIN;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'svc_applications') THEN
        CREATE ROLE svc_applications LOGIN;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'svc_review') THEN
        CREATE ROLE svc_review LOGIN;
    END IF;
END $$;
ALTER ROLE svc_auth         WITH LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT PASSWORD '${svc_auth_password}';
ALTER ROLE svc_applications WITH LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT PASSWORD '${svc_applications_password}';
ALTER ROLE svc_review       WITH LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT PASSWORD '${svc_review_password}';

--changeset chikilev:roles-grants runOnChange:true
--comment: привилегии ролей (ЛР2 п. 4.2) + ужесточение схемы public
-- PostgreSQL 15+ уже не даёт PUBLIC права CREATE в схеме public; фиксируем это явно,
-- чтобы CREATE TABLE под учётной записью приложения гарантированно завершался ошибкой прав.
REVOKE CREATE ON SCHEMA public FROM PUBLIC;
REVOKE ALL ON DATABASE scholarship FROM PUBLIC;
GRANT CONNECT ON DATABASE scholarship TO svc_auth, svc_applications, svc_review;
GRANT USAGE ON SCHEMA public TO svc_auth, svc_applications, svc_review;

-- auth-service: пользователи и роли
GRANT SELECT, INSERT, UPDATE ON users, user_roles TO svc_auth;
GRANT SELECT                 ON units, roles      TO svc_auth;

-- applications-service: заявки и вложения
GRANT SELECT, INSERT, UPDATE, DELETE ON applications, attachments TO svc_applications;
GRANT SELECT ON users, units, campaigns, criteria                 TO svc_applications;
-- D-08: OP-01 отдаёт scores[] сотруднику и комиссии, а заявителю — после публикации итогов
-- (существует протокол). В ЛР2 у svc_applications не было чтения этих таблиц.
GRANT SELECT ON application_scores, protocols TO svc_applications;

-- review-service: проверка, баллы, протокол и реестр выплат
GRANT SELECT, INSERT, UPDATE ON applications, application_scores TO svc_review;
GRANT SELECT, INSERT         ON protocols, payout_entries        TO svc_review;
GRANT SELECT ON users, units, campaigns, criteria, attachments   TO svc_review;

-- журнал аудита: только добавление; UPDATE и DELETE не выданы ни одной прикладной роли
GRANT INSERT ON audit_log TO svc_auth, svc_applications, svc_review;
GRANT SELECT ON audit_log TO svc_review;
GRANT USAGE ON ALL SEQUENCES IN SCHEMA public TO svc_auth, svc_applications, svc_review;

GRANT SELECT, INSERT, DELETE ON idempotency_keys TO svc_applications, svc_review;
