-- The preservation baseline of a maintenance reservation (up to 4 MiB of text, maintenance-state.mjs:26-31); H2 type CLOB. See V1_1 for why this script exists per vendor.
ALTER TABLE maintenance_reservation ADD COLUMN baseline CLOB;
