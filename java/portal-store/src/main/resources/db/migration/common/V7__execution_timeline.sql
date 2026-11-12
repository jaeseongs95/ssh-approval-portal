-- Execution timeline and one more failure code of an executed operation (stage 3 design 3.4, decisions D3-03 and D3-04). ANSI statements only, common to H2, PostgreSQL,
-- MariaDB and MySQL: no vendor script V7_1 is needed because every statement below is understood by all four (ALTER TABLE ... ADD COLUMN, DROP CONSTRAINT and ADD CONSTRAINT
-- ... CHECK; MySQL knows DROP CONSTRAINT for a CHECK from 8.0.19, MariaDB from 10.2.1). A statement that one of them did not understand would go to
-- db/migration/{vendor}/V7_1__*.sql, as V1_1 and V6_1 do. No CLOB, no IDENTITY, no function.
--
-- 1. Three instants of one execution, written by the use case after the operation settled (defect D-0038: the time between the steps of one execution tells a connection that
--    failed at once from one that was lost later). They are NULL while the step was not reached and for every result that existed before this script; the other phases of the
--    timeline (connect started, channel opened, first output, exit seen) are logged, not stored.
--      exec_connected_at   the session was authenticated and ready                      (phase CONNECTED)
--      exec_dispatched_at  the exec request, or the first write of a transfer, was sent  (phase REQUEST_SENT)
--      exec_closed_at      the channel was closed                                        (phase CLOSED)
-- NULL is written out: MySQL and MariaDB with explicit_defaults_for_timestamp off would otherwise make a TIMESTAMP column NOT NULL with a default.
ALTER TABLE operation_result ADD COLUMN exec_connected_at TIMESTAMP(6) NULL;
ALTER TABLE operation_result ADD COLUMN exec_dispatched_at TIMESTAMP(6) NULL;
ALTER TABLE operation_result ADD COLUMN exec_closed_at TIMESTAMP(6) NULL;

-- 2. The download of a file is an execution that fails with ARTIFACT_STORAGE_FULL when the disk cannot take the bytes of its reservation (decision D3-03, ExecutionErrorCode).
--    V1 allowed seven failure codes; the CHECK is replaced by one that also allows the eighth. The list is checked with CASE and not with IN for the reason given in V1.
ALTER TABLE operation_result DROP CONSTRAINT ck_operation_result_fcode;
ALTER TABLE operation_result ADD CONSTRAINT ck_operation_result_fcode CHECK (CASE WHEN failure_code IS NULL THEN 1 WHEN failure_code = 'SSH_CONNECT_FAILED' THEN 1 WHEN failure_code = 'SSH_CHANNEL_OPEN_FAILED' THEN 1 WHEN failure_code = 'SSH_EXECUTION_FAILED' THEN 1 WHEN failure_code = 'OUTPUT_CAPACITY' THEN 1 WHEN failure_code = 'OUTPUT_CAPTURE_FAILED' THEN 1 WHEN failure_code = 'OPERATION_FAILED' THEN 1 WHEN failure_code = 'ARTIFACT_QUOTA' THEN 1 WHEN failure_code = 'ARTIFACT_STORAGE_FULL' THEN 1 ELSE 0 END = 1);
