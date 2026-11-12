-- The long-text columns of the V1 tables, PostgreSQL type TEXT (see db/migration/h2/V1_1__long_text_columns.sql for why this script exists per vendor).
ALTER TABLE operation_command ADD COLUMN command_text TEXT NOT NULL;
ALTER TABLE operation_command ADD COLUMN caller_context TEXT NOT NULL;
ALTER TABLE operation_command ADD COLUMN display_context TEXT NOT NULL;
ALTER TABLE operation_source ADD COLUMN launcher_command TEXT NOT NULL;
ALTER TABLE operation_source ADD COLUMN argv_json TEXT NOT NULL;
ALTER TABLE operation_source ADD COLUMN caller_context TEXT NOT NULL;
ALTER TABLE operation_source ADD COLUMN display_context TEXT NOT NULL;
ALTER TABLE operation_download ADD COLUMN caller_context TEXT NOT NULL;
ALTER TABLE operation_download ADD COLUMN display_context TEXT NOT NULL;
ALTER TABLE operation_result ADD COLUMN result_texts TEXT NOT NULL;
ALTER TABLE operation_legacy ADD COLUMN original_text TEXT NOT NULL;
