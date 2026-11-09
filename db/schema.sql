-- =====================================================================
-- schema.sql — скрипт создания таблиц из ЛР № 2 (п. 4.2) без изменений.
-- Блок «Права учётных записей сервисов» вынесен в roles.sql: в исходном
-- скрипте пароли ролей были записаны литералами ('CHANGE_ME_*'), а секреты
-- не должны храниться в репозитории (см. журнал расхождений, D-01).
-- Применяется контейнером liquibase (db/changelog.xml).
-- =====================================================================

-- =====================================================================
-- ЛР № 2, вариант 5. Сервис заявок на материальную поддержку и ПГАС
-- PostgreSQL 16. Скрипт выполняется на чистой базе без ошибок.
-- =====================================================================

CREATE EXTENSION IF NOT EXISTS pgcrypto;   -- gen_random_uuid()

-- ---------- Справочники и домены ----------

CREATE TYPE application_type   AS ENUM ('material_aid', 'pgas');
CREATE TYPE application_status AS ENUM ('draft', 'submitted', 'under_review',
                                        'approved', 'rejected', 'withdrawn');
CREATE TYPE check_state        AS ENUM ('queued', 'running', 'done', 'failed');
CREATE TYPE document_type      AS ENUM ('income_certificate', 'disability_document',
                                        'achievement_proof', 'family_composition', 'other');

-- ---------- Подразделения и пользователи ----------

CREATE TABLE units (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name        VARCHAR(200) NOT NULL,
    code        VARCHAR(32)  NOT NULL,
    CONSTRAINT uq_units_code UNIQUE (code)
);

CREATE TABLE users (
    id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    external_id    VARCHAR(64)  NOT NULL,          -- идентификатор в каталоге LDAP/AD (R-09)
    email          VARCHAR(254) NOT NULL,
    full_name      VARCHAR(200) NOT NULL,
    unit_id        UUID         NOT NULL REFERENCES units(id) ON DELETE RESTRICT,
    password_hash  TEXT         NOT NULL,          -- Argon2id: $argon2id$v=19$m=...$соль$хеш
    is_active      BOOLEAN      NOT NULL DEFAULT TRUE,
    created_at     TIMESTAMPTZ  NOT NULL DEFAULT now(),
    CONSTRAINT uq_users_external_id UNIQUE (external_id),
    CONSTRAINT uq_users_email       UNIQUE (email),
    CONSTRAINT ck_users_email_shape CHECK (position('@' in email) > 1)
);

CREATE TABLE roles (
    code        VARCHAR(32) PRIMARY KEY,           -- applicant, reviewer, committee_chair, support, admin
    description VARCHAR(200) NOT NULL
);

CREATE TABLE user_roles (
    user_id     UUID        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    role_code   VARCHAR(32) NOT NULL REFERENCES roles(code) ON DELETE RESTRICT,
    granted_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT pk_user_roles PRIMARY KEY (user_id, role_code)
);

-- ---------- Кампании приёма и критерии ----------

CREATE TABLE campaigns (
    id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    unit_id        UUID             NOT NULL REFERENCES units(id) ON DELETE RESTRICT,
    title          VARCHAR(200)     NOT NULL,
    type           application_type NOT NULL,
    accepts_from   TIMESTAMPTZ      NOT NULL,
    accepts_until  TIMESTAMPTZ      NOT NULL,
    quota          INTEGER          NOT NULL,
    min_amount     NUMERIC(10,2)    NOT NULL,
    max_amount     NUMERIC(10,2)    NOT NULL,
    created_at     TIMESTAMPTZ      NOT NULL DEFAULT now(),
    -- правило предметной области: окно приёма и границы суммы должны быть осмысленными
    CONSTRAINT ck_campaigns_window  CHECK (accepts_until > accepts_from),
    CONSTRAINT ck_campaigns_quota   CHECK (quota > 0),
    CONSTRAINT ck_campaigns_amounts CHECK (min_amount > 0 AND max_amount >= min_amount)
);

CREATE TABLE criteria (
    id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    campaign_id  UUID         NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
    code         VARCHAR(64)  NOT NULL,
    title        VARCHAR(200) NOT NULL,
    max_score    NUMERIC(5,2) NOT NULL,
    CONSTRAINT uq_criteria_code      UNIQUE (campaign_id, code),
    CONSTRAINT ck_criteria_max_score CHECK (max_score > 0)
);

-- ---------- Заявки ----------

CREATE TABLE applications (
    id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    -- поле владельца: на нём держится проверка принадлежности объекта (OP-01, OP-04, OP-06)
    applicant_id  UUID               NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
    campaign_id   UUID               NOT NULL REFERENCES campaigns(id) ON DELETE RESTRICT,
    type          application_type   NOT NULL,
    status        application_status NOT NULL DEFAULT 'draft',
    statement     TEXT               NOT NULL,
    content_hash  CHAR(64)           NOT NULL,     -- SHA-256 содержимого, ключ кэша проверки полноты
    version       INTEGER            NOT NULL DEFAULT 1,   -- оптимистическая блокировка (If-Match)
    created_at    TIMESTAMPTZ        NOT NULL DEFAULT now(),
    submitted_at  TIMESTAMPTZ,
    reviewed_by   UUID               REFERENCES users(id) ON DELETE RESTRICT,
    reviewed_at   TIMESTAMPTZ,
    reject_reason VARCHAR(1000),
    -- правило предметной области: один заявитель — одна заявка в кампанию
    CONSTRAINT uq_application_per_campaign UNIQUE (campaign_id, applicant_id),
    CONSTRAINT ck_applications_statement   CHECK (char_length(statement) BETWEEN 1 AND 4000),
    CONSTRAINT ck_applications_version     CHECK (version > 0),
    -- отклонение без причины недопустимо
    CONSTRAINT ck_applications_reject      CHECK (status <> 'rejected' OR reject_reason IS NOT NULL),
    -- поданная заявка обязана иметь отметку времени подачи по часам сервера
    CONSTRAINT ck_applications_submitted   CHECK (status = 'draft' OR submitted_at IS NOT NULL)
);

-- индексы: проверка прав, фильтрация и ранжирование
CREATE INDEX idx_applications_applicant ON applications(applicant_id);
CREATE INDEX idx_applications_campaign_status ON applications(campaign_id, status);
CREATE INDEX idx_applications_created_at ON applications(created_at DESC);

CREATE TABLE attachments (
    id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    application_id UUID          NOT NULL REFERENCES applications(id) ON DELETE CASCADE,
    doc_type       document_type NOT NULL,
    object_key     VARCHAR(512)  NOT NULL,   -- ключ в объектном хранилище, сам файл в БД не хранится
    file_name      VARCHAR(255)  NOT NULL,
    size_bytes     BIGINT        NOT NULL,
    sha256         CHAR(64)      NOT NULL,
    uploaded_at    TIMESTAMPTZ   NOT NULL DEFAULT now(),
    CONSTRAINT uq_attachments_object_key UNIQUE (object_key),
    CONSTRAINT ck_attachments_size       CHECK (size_bytes > 0 AND size_bytes <= 10485760)
);

CREATE INDEX idx_attachments_application ON attachments(application_id);

-- связь «многие ко многим» применений и критериев, раскрытая в отдельную таблицу
CREATE TABLE application_scores (
    application_id UUID         NOT NULL REFERENCES applications(id) ON DELETE CASCADE,
    criterion_id   UUID         NOT NULL REFERENCES criteria(id) ON DELETE RESTRICT,
    value          NUMERIC(5,2) NOT NULL,
    scored_by      UUID         NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
    scored_at      TIMESTAMPTZ  NOT NULL DEFAULT now(),
    CONSTRAINT pk_application_scores PRIMARY KEY (application_id, criterion_id),
    CONSTRAINT ck_application_scores_value CHECK (value >= 0)
);

CREATE INDEX idx_application_scores_criterion ON application_scores(criterion_id);

-- ---------- Проверка полноты языковой моделью ----------

CREATE TABLE completeness_checks (
    id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    application_id    UUID        NOT NULL REFERENCES applications(id) ON DELETE CASCADE,
    requested_by      UUID        NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
    state             check_state NOT NULL DEFAULT 'queued',
    content_hash      CHAR(64)    NOT NULL,   -- хеш заявки на момент запроса
    model             VARCHAR(100),
    prompt_sha256     CHAR(64),               -- хеш промпта; сам промпт не хранится
    result            JSONB,                  -- строго по схеме: missing_documents, conflicts, confidence
    confidence        NUMERIC(3,2),
    error_code        VARCHAR(64),
    created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
    completed_at      TIMESTAMPTZ,
    -- повторная проверка того же содержимого не запускается и не оплачивается дважды
    CONSTRAINT uq_completeness_per_content UNIQUE (application_id, content_hash),
    CONSTRAINT ck_completeness_confidence  CHECK (confidence IS NULL OR (confidence >= 0 AND confidence <= 1)),
    CONSTRAINT ck_completeness_done        CHECK (state <> 'done' OR result IS NOT NULL)
);

CREATE INDEX idx_completeness_application ON completeness_checks(application_id, created_at DESC);

-- ---------- Протокол комиссии и реестр выплат ----------

CREATE TABLE protocols (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    campaign_id UUID        NOT NULL REFERENCES campaigns(id) ON DELETE RESTRICT,
    number      VARCHAR(64) NOT NULL,
    signed_date DATE        NOT NULL,
    created_by  UUID        NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    checksum    CHAR(64)    NOT NULL,   -- SHA-256 нормализованного состава реестра
    -- правило предметной области: по кампании не может быть двух протоколов
    CONSTRAINT uq_protocol_per_campaign UNIQUE (campaign_id),
    CONSTRAINT uq_protocol_number       UNIQUE (number, signed_date)
);

CREATE TABLE payout_entries (
    id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    protocol_id    UUID          NOT NULL REFERENCES protocols(id) ON DELETE RESTRICT,
    application_id UUID          NOT NULL REFERENCES applications(id) ON DELETE RESTRICT,
    -- поле владельца дублируется намеренно: строка реестра принадлежит человеку, а не только заявке
    recipient_id   UUID          NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
    amount         NUMERIC(10,2) NOT NULL,
    created_at     TIMESTAMPTZ   NOT NULL DEFAULT now(),
    -- правило предметной области: по одной заявке не может быть двух начислений
    CONSTRAINT ck_payout_amount            CHECK (amount > 0),
    CONSTRAINT uq_payout_per_application   UNIQUE (application_id)
);

CREATE INDEX idx_payout_entries_protocol  ON payout_entries(protocol_id);
CREATE INDEX idx_payout_entries_recipient ON payout_entries(recipient_id);

-- ---------- Идемпотентность и журнал ----------

CREATE TABLE idempotency_keys (
    key           UUID        NOT NULL,
    user_id       UUID        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    endpoint      VARCHAR(128) NOT NULL,
    request_hash  CHAR(64)    NOT NULL,
    response_code INTEGER     NOT NULL,
    response_body JSONB       NOT NULL,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    expires_at    TIMESTAMPTZ NOT NULL DEFAULT now() + INTERVAL '24 hours',
    -- ключ действует в пределах одного субъекта и одного эндпоинта
    CONSTRAINT pk_idempotency PRIMARY KEY (key, user_id, endpoint)
);

CREATE INDEX idx_idempotency_expires ON idempotency_keys(expires_at);

CREATE TABLE audit_log (
    id          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    occurred_at TIMESTAMPTZ  NOT NULL DEFAULT now(),
    actor_id    UUID         REFERENCES users(id) ON DELETE RESTRICT,  -- NULL для неудачного входа
    action      VARCHAR(64)  NOT NULL,     -- application.created, application.reviewed, payout.created...
    object_type VARCHAR(64)  NOT NULL,
    object_id   UUID,
    request_id  UUID         NOT NULL,
    result      VARCHAR(16)  NOT NULL,     -- success | denied | error
    details     JSONB,                     -- прежние и новые значения; текст заявки и токены сюда не пишутся
    CONSTRAINT ck_audit_result CHECK (result IN ('success', 'denied', 'error'))
);

CREATE INDEX idx_audit_object ON audit_log(object_type, object_id, occurred_at DESC);
CREATE INDEX idx_audit_actor  ON audit_log(actor_id, occurred_at DESC);


INSERT INTO roles (code, description) VALUES
    ('applicant',       'Заявитель (обучающийся), роль R-02'),
    ('reviewer',        'Ответственный сотрудник подразделения, роль R-03'),
    ('committee_chair', 'Председатель стипендиальной комиссии, роль R-04'),
    ('support',         'Служба поддержки пользователей, роль R-07'),
    ('admin',           'Технический специалист, роль R-05');
