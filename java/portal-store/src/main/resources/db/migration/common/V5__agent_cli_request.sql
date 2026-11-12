-- Agent CLI install request (2.x agent-cli.sqlite requests, agent-cli-state.mjs:20); the common operation row is V1's operation with kind AGENT_CLI. ANSI types only,
-- see V1 (including why a list of values is checked with CASE and not with IN).

CREATE TABLE agent_cli_request (
    operation_id                   CHAR(48)     NOT NULL,
    provider                       VARCHAR(6)   NOT NULL,
    action                         VARCHAR(7)   NOT NULL,
    package_name                   VARCHAR(100) NOT NULL,
    release_version                VARCHAR(20)  NOT NULL,
    release_tarball                VARCHAR(512) NOT NULL,
    release_integrity              VARCHAR(100) NOT NULL,
    release_digest                 CHAR(71)     NOT NULL,
    expected_installation_revision CHAR(64)     NOT NULL,
    intent_digest                  CHAR(71)     NOT NULL,
    plan_expires_at                TIMESTAMP(6) NOT NULL,
    remote_state                   VARCHAR(10),
    remote_version                 VARCHAR(20),
    remote_error                   VARCHAR(14),
    remote_cleanup_failures        INTEGER,
    CONSTRAINT pk_agent_cli_request PRIMARY KEY (operation_id),
    CONSTRAINT fk_agent_cli_request_op FOREIGN KEY (operation_id) REFERENCES operation (id),
    CONSTRAINT ck_agent_cli_provider CHECK (CASE WHEN provider = 'CODEX' THEN 1 WHEN provider = 'CLAUDE' THEN 1 ELSE 0 END = 1),
    CONSTRAINT ck_agent_cli_action CHECK (CASE WHEN action = 'INSTALL' THEN 1 WHEN action = 'UPDATE' THEN 1 ELSE 0 END = 1),
    CONSTRAINT ck_agent_cli_remote CHECK (CASE WHEN remote_state IS NULL THEN 1 WHEN remote_state = 'NOT_FOUND' THEN 1 WHEN remote_state = 'UNKNOWN' THEN 1 WHEN remote_state = 'PREPARING' THEN 1 WHEN remote_state = 'INSTALLING' THEN 1 WHEN remote_state = 'COMPLETED' THEN 1 WHEN remote_state = 'REUSED' THEN 1 WHEN remote_state = 'FAILED' THEN 1 ELSE 0 END = 1),
    CONSTRAINT ck_agent_cli_error CHECK (remote_error IS NULL OR remote_error = 'INSTALL_FAILED'),
    CONSTRAINT ck_agent_cli_cleanup CHECK (remote_cleanup_failures IS NULL OR remote_cleanup_failures > 0)
);
