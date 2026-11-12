-- The preservation baseline of a maintenance reservation (up to 4 MiB of text); MariaDB type MEDIUMTEXT. See db/migration/h2/V1_1__long_text_columns.sql.
ALTER TABLE maintenance_reservation ADD COLUMN baseline MEDIUMTEXT;
