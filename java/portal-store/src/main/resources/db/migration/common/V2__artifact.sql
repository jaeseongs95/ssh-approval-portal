-- Artifact metadata (2.x kept it in <id>.json manifest files, artifacts.mjs:91-149; the bytes stay in files, design 8.5). ANSI types only, see V1 for the rules
-- (including why a list of values is checked with CASE and not with IN).

CREATE TABLE artifact (
    id                      CHAR(48)      NOT NULL,
    direction               VARCHAR(8)    NOT NULL,
    purpose                 VARCHAR(8)    NOT NULL,
    state                   VARCHAR(9)    NOT NULL,
    public_uuid             CHAR(36),
    owner_id                VARCHAR(512),
    operation_key           VARCHAR(128),
    file_name               VARCHAR(255)  NOT NULL,
    remote_path             VARCHAR(4096),
    size_bytes              BIGINT        NOT NULL,
    received_bytes          BIGINT        NOT NULL,
    chunk_count             INTEGER       NOT NULL,
    sha256                  CHAR(64),
    target_id               VARCHAR(32),
    target_revision         CHAR(64),
    file_target_binding     VARCHAR(7)    NOT NULL,
    upload_protocol         VARCHAR(11)   NOT NULL,
    overwrite_mode          VARCHAR(15)   NOT NULL,
    elevation               VARCHAR(4)    NOT NULL,
    retention               VARCHAR(10)   NOT NULL,
    expires_at              TIMESTAMP(6)  NOT NULL,
    submission_id           CHAR(48),
    consume_reason          VARCHAR(7),
    provenance_source_uuid  CHAR(36),
    provenance_owner_id     VARCHAR(512),
    provenance_request_id   CHAR(48),
    version                 BIGINT        NOT NULL,
    created_at              TIMESTAMP(6)  NOT NULL,
    CONSTRAINT pk_artifact PRIMARY KEY (id),
    CONSTRAINT uq_artifact_public_uuid UNIQUE (public_uuid),
    CONSTRAINT uq_artifact_owner_key UNIQUE (owner_id, operation_key),
    CONSTRAINT ck_artifact_direction CHECK (CASE WHEN direction = 'UPLOAD' THEN 1 WHEN direction = 'DOWNLOAD' THEN 1 ELSE 0 END = 1),
    CONSTRAINT ck_artifact_purpose CHECK (CASE WHEN purpose = 'STAGED' THEN 1 WHEN purpose = 'TRANSFER' THEN 1 ELSE 0 END = 1),
    CONSTRAINT ck_artifact_state CHECK (CASE WHEN state = 'STAGING' THEN 1 WHEN state = 'READY' THEN 1 WHEN state = 'DELETING' THEN 1 WHEN state = 'CONSUMING' THEN 1 WHEN state = 'CONSUMED' THEN 1 ELSE 0 END = 1),
    CONSTRAINT ck_artifact_binding CHECK (CASE WHEN file_target_binding = 'BOUND' THEN 1 WHEN file_target_binding = 'UNBOUND' THEN 1 ELSE 0 END = 1),
    CONSTRAINT ck_artifact_protocol CHECK (CASE WHEN upload_protocol = 'UNSPECIFIED' THEN 1 WHEN upload_protocol = 'MCP_JSON_V1' THEN 1 ELSE 0 END = 1),
    CONSTRAINT ck_artifact_overwrite CHECK (CASE WHEN overwrite_mode = 'REPLACE' THEN 1 WHEN overwrite_mode = 'FAIL_IF_EXISTS' THEN 1 ELSE 0 END = 1),
    CONSTRAINT ck_artifact_elevation CHECK (CASE WHEN elevation = 'NONE' THEN 1 WHEN elevation = 'SUDO' THEN 1 ELSE 0 END = 1),
    CONSTRAINT ck_artifact_retention CHECK (CASE WHEN retention = 'PINNED' THEN 1 WHEN retention = 'RELEASABLE' THEN 1 ELSE 0 END = 1),
    CONSTRAINT ck_artifact_consume CHECK (CASE WHEN consume_reason IS NULL THEN 1 WHEN consume_reason = 'MOVED' THEN 1 WHEN consume_reason = 'REMOVED' THEN 1 ELSE 0 END = 1),
    CONSTRAINT ck_artifact_sizes CHECK (size_bytes >= 0 AND size_bytes <= 67108864 AND received_bytes >= 0 AND received_bytes <= size_bytes AND chunk_count >= 0),
    CONSTRAINT ck_artifact_staged CHECK (purpose <> 'STAGED' OR (public_uuid IS NOT NULL AND owner_id IS NOT NULL AND operation_key IS NOT NULL AND remote_path IS NULL AND target_id IS NULL))
);
CREATE INDEX ix_artifact_state_expiry ON artifact (state, expires_at);

CREATE TABLE artifact_chunk (
    artifact_id CHAR(48) NOT NULL,
    chunk_no    INTEGER  NOT NULL,
    size_bytes  INTEGER  NOT NULL,
    sha256      CHAR(64) NOT NULL,
    CONSTRAINT pk_artifact_chunk PRIMARY KEY (artifact_id, chunk_no),
    CONSTRAINT fk_artifact_chunk FOREIGN KEY (artifact_id) REFERENCES artifact (id),
    CONSTRAINT ck_artifact_chunk_size CHECK (size_bytes >= 1 AND size_bytes <= 262144)
);

CREATE TABLE staged_action (
    artifact_id     CHAR(48)      NOT NULL,
    operation_key   VARCHAR(128)  NOT NULL,
    request_key     VARCHAR(128)  NOT NULL,
    input_digest    CHAR(64)      NOT NULL,
    request_id      CHAR(48)      NOT NULL,
    action          VARCHAR(4)    NOT NULL,
    state           VARCHAR(9)    NOT NULL,
    target_id       VARCHAR(32)   NOT NULL,
    target_revision CHAR(64)      NOT NULL,
    remote_path     VARCHAR(4096) NOT NULL,
    overwrite_mode  VARCHAR(15)   NOT NULL,
    elevation       VARCHAR(4)    NOT NULL,
    CONSTRAINT pk_staged_action PRIMARY KEY (artifact_id, operation_key),
    CONSTRAINT fk_staged_action FOREIGN KEY (artifact_id) REFERENCES artifact (id),
    CONSTRAINT ck_staged_action_kind CHECK (CASE WHEN action = 'COPY' THEN 1 WHEN action = 'MOVE' THEN 1 ELSE 0 END = 1),
    CONSTRAINT ck_staged_action_state CHECK (CASE WHEN state = 'RESERVED' THEN 1 WHEN state = 'SUBMITTED' THEN 1 WHEN state = 'REFUSED' THEN 1 WHEN state = 'SETTLED' THEN 1 ELSE 0 END = 1),
    CONSTRAINT ck_staged_action_overwrite CHECK (CASE WHEN overwrite_mode = 'REPLACE' THEN 1 WHEN overwrite_mode = 'FAIL_IF_EXISTS' THEN 1 ELSE 0 END = 1),
    CONSTRAINT ck_staged_action_elev CHECK (CASE WHEN elevation = 'NONE' THEN 1 WHEN elevation = 'SUDO' THEN 1 ELSE 0 END = 1)
);
