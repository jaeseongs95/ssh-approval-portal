-- The long-text columns of the V1 tables, MySQL type MEDIUMTEXT (16 MiB; TEXT would stop at 64 KiB) (see db/migration/h2/V1_1__long_text_columns.sql for why this script exists per vendor).
ALTER TABLE operation_command ADD COLUMN command_text MEDIUMTEXT NOT NULL;
ALTER TABLE operation_command ADD COLUMN caller_context MEDIUMTEXT NOT NULL;
ALTER TABLE operation_command ADD COLUMN display_context MEDIUMTEXT NOT NULL;
ALTER TABLE operation_source ADD COLUMN launcher_command MEDIUMTEXT NOT NULL;
ALTER TABLE operation_source ADD COLUMN argv_json MEDIUMTEXT NOT NULL;
ALTER TABLE operation_source ADD COLUMN caller_context MEDIUMTEXT NOT NULL;
ALTER TABLE operation_source ADD COLUMN display_context MEDIUMTEXT NOT NULL;
ALTER TABLE operation_download ADD COLUMN caller_context MEDIUMTEXT NOT NULL;
ALTER TABLE operation_download ADD COLUMN display_context MEDIUMTEXT NOT NULL;
ALTER TABLE operation_result ADD COLUMN result_texts MEDIUMTEXT NOT NULL;
ALTER TABLE operation_legacy ADD COLUMN original_text MEDIUMTEXT NOT NULL;
