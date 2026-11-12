-- Maintenance reservation and runtime capacity (2.x maintenance-state.mjs:14 and runtime-capacity-state.mjs:12). ANSI types only, see V1.
-- maintenance_reservation.baseline (up to 4 MiB of text) comes from the vendor script V6_1.

CREATE TABLE maintenance_reservation (
    id         INTEGER  NOT NULL,
    owner_hash CHAR(64) NOT NULL,
    CONSTRAINT pk_maintenance_reservation PRIMARY KEY (id),
    CONSTRAINT ck_maintenance_reservation_single CHECK (id = 1)
);

CREATE TABLE maintenance_release (
    id         INTEGER  NOT NULL,
    owner_hash CHAR(64) NOT NULL,
    CONSTRAINT pk_maintenance_release PRIMARY KEY (id),
    CONSTRAINT ck_maintenance_release_single CHECK (id = 1)
);

CREATE TABLE runtime_capacity (
    id              INTEGER  NOT NULL,
    revision        CHAR(32) NOT NULL,
    queue_capacity  INTEGER  NOT NULL,
    max_concurrency INTEGER  NOT NULL,
    version         BIGINT   NOT NULL,
    CONSTRAINT pk_runtime_capacity PRIMARY KEY (id),
    CONSTRAINT ck_runtime_capacity_single CHECK (id = 1),
    CONSTRAINT ck_runtime_capacity_range CHECK (queue_capacity >= 1 AND max_concurrency >= 1)
);

-- No foreign key to the target list: an override of a target that left the configuration is kept (runtime-capacity.mjs:21).
CREATE TABLE runtime_capacity_target (
    target_id       VARCHAR(32) NOT NULL,
    queue_capacity  INTEGER,
    max_concurrency INTEGER,
    CONSTRAINT pk_runtime_capacity_target PRIMARY KEY (target_id),
    CONSTRAINT ck_runtime_capacity_target CHECK ((queue_capacity IS NULL OR queue_capacity >= 1) AND (max_concurrency IS NULL OR max_concurrency >= 1))
);
