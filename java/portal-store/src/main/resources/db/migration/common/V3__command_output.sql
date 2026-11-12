-- Command output manifest (2.x manifest.sqlite table outputs, command-output.mjs:53); the payload bytes stay in files (design 8.5). ANSI types only, see V1
-- (including why a list of values is checked with CASE and not with IN).

CREATE TABLE command_output (
    id               CHAR(48)     NOT NULL,
    execution_id     CHAR(48)     NOT NULL,
    target_id        VARCHAR(32),
    target_revision  CHAR(64),
    state            VARCHAR(11)  NOT NULL,
    expires_at       TIMESTAMP(6) NOT NULL,
    size_bytes       BIGINT,
    charge_bytes     BIGINT       NOT NULL,
    stream_state     VARCHAR(8)   NOT NULL,
    stream_bytes     BIGINT,
    stream_size      BIGINT,
    stream_sha256    CHAR(64),
    stdout_cursor    BIGINT,
    stderr_cursor    BIGINT,
    stream_truncated VARCHAR(9),
    version          BIGINT       NOT NULL,
    CONSTRAINT pk_command_output PRIMARY KEY (id),
    CONSTRAINT fk_command_output_op FOREIGN KEY (execution_id) REFERENCES operation (id),
    CONSTRAINT ck_command_output_state CHECK (CASE WHEN state = 'PENDING' THEN 1 WHEN state = 'READY' THEN 1 WHEN state = 'UNAVAILABLE' THEN 1 ELSE 0 END = 1),
    CONSTRAINT ck_command_output_stream CHECK (CASE WHEN stream_state = 'NONE' THEN 1 WHEN stream_state = 'OPEN' THEN 1 WHEN stream_state = 'COMPLETE' THEN 1 ELSE 0 END = 1),
    CONSTRAINT ck_command_output_trunc CHECK (CASE WHEN stream_truncated IS NULL THEN 1 WHEN stream_truncated = 'TRUNCATED' THEN 1 WHEN stream_truncated = 'COMPLETE' THEN 1 ELSE 0 END = 1),
    CONSTRAINT ck_command_output_charge CHECK (charge_bytes >= 0)
);
CREATE INDEX ix_command_output_expiry ON command_output (state, expires_at);

CREATE TABLE command_output_format (
    output_id    CHAR(48)   NOT NULL,
    format       VARCHAR(4) NOT NULL,
    offset_bytes BIGINT     NOT NULL,
    size_bytes   BIGINT     NOT NULL,
    sha256       CHAR(64)   NOT NULL,
    CONSTRAINT pk_command_output_format PRIMARY KEY (output_id, format),
    CONSTRAINT fk_command_output_format FOREIGN KEY (output_id) REFERENCES command_output (id),
    CONSTRAINT ck_command_output_format CHECK (CASE WHEN format = 'JSON' THEN 1 WHEN format = 'TEXT' THEN 1 ELSE 0 END = 1)
);

CREATE TABLE command_output_page (
    output_id CHAR(48)   NOT NULL,
    format    VARCHAR(4) NOT NULL,
    page_no   INTEGER    NOT NULL,
    sha256    CHAR(64)   NOT NULL,
    CONSTRAINT pk_command_output_page PRIMARY KEY (output_id, format, page_no),
    CONSTRAINT fk_command_output_page FOREIGN KEY (output_id, format) REFERENCES command_output_format (output_id, format)
);
