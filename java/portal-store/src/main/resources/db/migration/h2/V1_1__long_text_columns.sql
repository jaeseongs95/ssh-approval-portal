-- The long-text columns of the V1 tables. No type name of long text is common to H2, PostgreSQL, MariaDB and MySQL (H2: CLOB, PostgreSQL: TEXT, MariaDB and
-- MySQL: MEDIUMTEXT), so the columns are added by a script of the vendor; the rest of the schema is common (db/migration/common). Flyway picks this file through the
-- {vendor} placeholder of spring.flyway.locations (https://docs.spring.io/spring-boot/how-to/data-initialization.html). The version 1.1 sits between V1 and V2 so that
-- a later common V7 never runs out of order. The tables are empty at this point, so NOT NULL needs no default.
ALTER TABLE operation_command ADD COLUMN command_text CLOB NOT NULL;
ALTER TABLE operation_command ADD COLUMN caller_context CLOB NOT NULL;
ALTER TABLE operation_command ADD COLUMN display_context CLOB NOT NULL;
ALTER TABLE operation_source ADD COLUMN launcher_command CLOB NOT NULL;
ALTER TABLE operation_source ADD COLUMN argv_json CLOB NOT NULL;
ALTER TABLE operation_source ADD COLUMN caller_context CLOB NOT NULL;
ALTER TABLE operation_source ADD COLUMN display_context CLOB NOT NULL;
ALTER TABLE operation_download ADD COLUMN caller_context CLOB NOT NULL;
ALTER TABLE operation_download ADD COLUMN display_context CLOB NOT NULL;
ALTER TABLE operation_result ADD COLUMN result_texts CLOB NOT NULL;
ALTER TABLE operation_legacy ADD COLUMN original_text CLOB NOT NULL;
