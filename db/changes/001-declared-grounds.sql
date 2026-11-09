--liquibase formatted sql

-- =====================================================================
-- D-07. Контракт OP-02 принимает поле declared_grounds[] (заявленные основания
-- из справочника), но в schema.sql ЛР2 для него не было ни столбца, ни справочника:
-- данные молча терялись бы. Добавлены тип-справочник и столбец; значения входят
-- в content_hash заявки.
-- =====================================================================

--changeset chikilev:001-declared-grounds
CREATE TYPE support_ground AS ENUM (
    'low_income',          -- малоимущность (материальная поддержка)
    'disability',          -- инвалидность
    'orphan',              -- сирота / без попечения родителей
    'large_family',        -- многодетная семья
    'academic_excellence', -- учебная деятельность (ПГАС)
    'science',             -- научная деятельность (ПГАС)
    'social_activity',     -- общественная деятельность (ПГАС)
    'culture',             -- культурно-творческая деятельность (ПГАС)
    'sports'               -- спортивная деятельность (ПГАС)
);

ALTER TABLE applications
    ADD COLUMN declared_grounds support_ground[] NOT NULL DEFAULT '{}';

-- заявка подаётся хотя бы по одному основанию
ALTER TABLE applications
    ADD CONSTRAINT ck_applications_grounds CHECK (cardinality(declared_grounds) BETWEEN 1 AND 9);
--rollback ALTER TABLE applications DROP CONSTRAINT ck_applications_grounds; ALTER TABLE applications DROP COLUMN declared_grounds; DROP TYPE support_ground;
