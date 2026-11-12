package io.github.jaeseongs95.portal.app.remote;

import java.time.Duration;
import java.util.Objects;

import org.springframework.util.unit.DataSize;

import io.github.jaeseongs95.portal.domain.operation.UploadInput;

/**
 * The limits of one file transfer: the time after which it is stopped and the largest file it carries. The file size never exceeds the 64 MiB of the contract
 * ({@link UploadInput#MAX_BYTES}); an administrator may set it lower.
 *
 * @param deadline the time limit of the transfer, 1 millisecond to 2^31-1 milliseconds as for an execution
 * @param maxFileSize the largest file, 1 byte to {@link UploadInput#MAX_BYTES}
 */
public record TransferLimits(Duration deadline, DataSize maxFileSize) {

    /** The same time limit as an execution ({@link ExecutionLimits#DEFAULT_DEADLINE}). */
    public static final Duration DEFAULT_DEADLINE = ExecutionLimits.DEFAULT_DEADLINE;
    /** The contract's largest file. */
    public static final DataSize DEFAULT_MAX_FILE_SIZE = DataSize.ofBytes(UploadInput.MAX_BYTES);

    public TransferLimits {
        ExecutionLimits.requireSupervisable(deadline, "deadline");
        Objects.requireNonNull(maxFileSize, "maxFileSize");
        if (maxFileSize.toBytes() < 1 || maxFileSize.toBytes() > UploadInput.MAX_BYTES) {
            throw new IllegalArgumentException("Invalid transfer maxFileSize: 1 to " + UploadInput.MAX_BYTES + " bytes");
        }
    }

    /** 120 seconds and the contract's 64 MiB. */
    public static TransferLimits defaults() {
        return new TransferLimits(DEFAULT_DEADLINE, DEFAULT_MAX_FILE_SIZE);
    }
}
