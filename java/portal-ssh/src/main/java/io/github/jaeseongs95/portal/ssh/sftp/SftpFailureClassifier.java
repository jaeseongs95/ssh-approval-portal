package io.github.jaeseongs95.portal.ssh.sftp;

import io.github.jaeseongs95.portal.app.remote.FileDiagnostic;
import io.github.jaeseongs95.portal.domain.error.TransferErrorCode;
import java.io.IOException;
import java.util.Objects;
import org.apache.sshd.sftp.common.SftpConstants;
import org.apache.sshd.sftp.common.SftpException;
import org.springframework.stereotype.Component;

/**
 * Turns the failure of one SFTP request into what the file transfer reports (stage 3 design 4.5, replacing the {@code errno} table of the 2.x file helper,
 * {@code file-helper.py:27-30}). It keeps apart what the helper's {@code OPERATION_FAILED} used to blur:
 * <ul>
 *   <li>status 3 is {@code PERMISSION_DENIED}, and nothing else is: a permission problem is never reported as a lost connection or a full disk (defects D-0013 and
 *       D-0034);</li>
 *   <li>status 2 is a missing file or a missing parent, depending on which of them the request asked for;</li>
 *   <li>status 11 is {@code DESTINATION_EXISTS};</li>
 *   <li>status 14 and 15 are a full file system, which is {@code STAGING_UNAVAILABLE} with the {@link FileDiagnostic.NoSpace} fact (the temporary file could not be
 *       written, and not for lack of permission); a plain status 4 may be the same thing, which the caller confirms with a space query;</li>
 *   <li>status 6 and 7, and every failure that is no status at all (a closed channel, a dead session), are a lost connection.</li>
 * </ul>
 * The classifier holds no state and reads no message of the server: a message never becomes diagnostic data. The owner and DACL codes of the 2.x Windows helper
 * ({@code UNTRUSTED_OWNER}, {@code MISSING_DACL}, {@code UNSAFE_ANCESTOR}, {@code UNTRUSTED_WRITER}, {@code UNSUPPORTED_ACE}, {@code SECURITY_DESCRIPTOR_TOO_LARGE}) are
 * never produced here (decision D3-02): the checks that raised them guarded a SYSTEM-owned staging root that 3.0 does not have, SFTP runs with the rights of the
 * login account, so the operating system's own permission check is the first control, and the same check raised the false refusals of defect D-0001. The codes stay in
 * the enum for the compatibility of the contract. What remains is the race between the checks and the replacement, described in the transfer's class comment.
 */
@Component
public class SftpFailureClassifier {

    /** Which part of a path a request was about; the same status means something else for a parent directory, the target file and the temporary file. */
    public enum Site {
        /** A directory on the way to the file, or the directory that holds it. */
        PARENT_DIRECTORY,
        /** The file the request names. */
        TARGET_FILE,
        /** The temporary file the adapter made, or the backup file of a replacement: a file the request did not name and that must be there. */
        OWN_FILE,
        /** A file the adapter is about to create next to the target (the temporary file): it is missing only when its directory is. */
        NEW_FILE
    }

    /** What the failure comes to for the transfer's result. */
    public sealed interface Verdict permits Verdict.Refusal, Verdict.Lost {
        /**
         * The server answered and refused.
         *
         * @param code why
         * @param diagnostic the closed fact behind the code
         */
        record Refusal(TransferErrorCode code, FileDiagnostic diagnostic) implements Verdict {
            public Refusal {
                Objects.requireNonNull(code, "code");
                Objects.requireNonNull(diagnostic, "diagnostic");
            }
        }

        /** The connection is gone; the server did not answer. */
        record Lost() implements Verdict {
        }
    }

    /**
     * What the failure of an SFTP request means.
     *
     * @param cause the exception a MINA SFTP call threw
     * @return the failure kind and the status code it came with
     */
    public SftpFailure classify(IOException cause) {
        Objects.requireNonNull(cause, "cause");
        if (!(cause instanceof SftpException status)) {
            return new SftpFailure(SftpFailure.Kind.TRANSPORT_LOST, SftpFailure.NO_STATUS);
        }
        int code = status.getStatus();
        SftpFailure.Kind kind = switch (code) {
            case SftpConstants.SSH_FX_NO_SUCH_FILE, SftpConstants.SSH_FX_NO_SUCH_PATH -> SftpFailure.Kind.NOT_FOUND;
            case SftpConstants.SSH_FX_PERMISSION_DENIED, SftpConstants.SSH_FX_WRITE_PROTECT -> SftpFailure.Kind.PERMISSION_DENIED;
            case SftpConstants.SSH_FX_FILE_ALREADY_EXISTS -> SftpFailure.Kind.ALREADY_EXISTS;
            case SftpConstants.SSH_FX_NO_SPACE_ON_FILESYSTEM, SftpConstants.SSH_FX_QUOTA_EXCEEDED -> SftpFailure.Kind.NO_SPACE;
            case SftpConstants.SSH_FX_FAILURE -> SftpFailure.Kind.PLAIN_FAILURE;
            case SftpConstants.SSH_FX_NOT_A_DIRECTORY, SftpConstants.SSH_FX_FILE_IS_A_DIRECTORY, SftpConstants.SSH_FX_LINK_LOOP, SftpConstants.SSH_FX_DIR_NOT_EMPTY ->
                SftpFailure.Kind.NOT_A_REGULAR_PATH;
            case SftpConstants.SSH_FX_NO_CONNECTION, SftpConstants.SSH_FX_CONNECTION_LOST -> SftpFailure.Kind.TRANSPORT_LOST;
            default -> SftpFailure.Kind.OTHER;
        };
        return new SftpFailure(kind, code);
    }

    /**
     * The result a failure comes to for a request about the given part of the path.
     *
     * @param failure the classified failure
     * @param site which part of the path the request was about
     * @return the refusal code and fact, or {@link Verdict.Lost}
     */
    public Verdict verdict(SftpFailure failure, Site site) {
        Objects.requireNonNull(failure, "failure");
        Objects.requireNonNull(site, "site");
        FileDiagnostic status = failure.status() < 0 ? new FileDiagnostic.None() : new FileDiagnostic.SftpStatus(failure.status());
        return switch (failure.kind()) {
            case NOT_FOUND -> new Verdict.Refusal(switch (site) {
                case PARENT_DIRECTORY, NEW_FILE -> TransferErrorCode.PARENT_NOT_FOUND;
                case TARGET_FILE -> TransferErrorCode.FILE_NOT_FOUND;
                case OWN_FILE -> TransferErrorCode.FILE_CHANGED;
            }, status);
            case PERMISSION_DENIED -> new Verdict.Refusal(TransferErrorCode.PERMISSION_DENIED, status);
            case ALREADY_EXISTS -> new Verdict.Refusal(TransferErrorCode.DESTINATION_EXISTS, status);
            case NO_SPACE -> new Verdict.Refusal(TransferErrorCode.STAGING_UNAVAILABLE, new FileDiagnostic.NoSpace());
            case PLAIN_FAILURE -> new Verdict.Refusal(site == Site.OWN_FILE || site == Site.NEW_FILE ? TransferErrorCode.STAGING_UNAVAILABLE : TransferErrorCode.INVALID_REQUEST,
                status);
            case NOT_A_REGULAR_PATH -> new Verdict.Refusal(TransferErrorCode.UNSAFE_PATH, status);
            case TRANSPORT_LOST -> new Verdict.Lost();
            case OTHER -> new Verdict.Refusal(TransferErrorCode.INVALID_REQUEST, status);
        };
    }

    /**
     * The result of an exception: {@link #classify} and {@link #verdict} in one step.
     *
     * @param cause the exception a MINA SFTP call threw
     * @param site which part of the path the request was about
     * @return the refusal code and fact, or {@link Verdict.Lost}
     */
    public Verdict verdict(IOException cause, Site site) {
        return verdict(classify(cause), site);
    }
}
