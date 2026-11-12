package io.github.jaeseongs95.portal.ssh.sftp;

import io.github.jaeseongs95.portal.app.remote.ExecutionControl;
import io.github.jaeseongs95.portal.app.remote.RemoteTarget;
import io.github.jaeseongs95.portal.app.remote.TransferFailureCause;
import io.github.jaeseongs95.portal.app.remote.TransferLimits;
import io.github.jaeseongs95.portal.domain.path.RemotePath;
import java.util.Objects;

/**
 * A check for links that the SFTP server of some targets does not show (defect of the Windows path check, found by the real-server test S3-RW-04). {@link RemotePathChecker}
 * asks the server with {@code lstat}; that finds every link a POSIX server has. The Win32-OpenSSH server reports a link only for a symbolic link: its {@code lstat} marks a
 * path as a link when the path has the reparse attribute <em>and</em> {@code readlink} succeeds, and its {@code readlink} accepts the symbolic link tag only
 * ({@code fileio_stat_or_lstat_internal} and {@code fileio_readlink} of {@code contrib/win32/win32compat/fileio.c} in PowerShell/openssh-portable). A junction (a mount
 * point reparse point) therefore looks like a plain directory to every SFTP request, {@code readlink} included, and a transfer through it would leave the folder that was
 * asked for. The 2.x helper refused every reparse point ({@code windows-file-native.cs}: the handle of each component was opened without following and the reparse attribute
 * was refused, case RC-B-621). A target of that kind is therefore checked with one fixed read-only command, and the answer is a value of this type.
 *
 * <p>The probes of the application are the beans of this type; a path is checked by the first one that {@link #applies}, and a path that none of them wants (a POSIX path)
 * has nothing to check beyond the SFTP inspection.
 */
public interface HiddenLinkProbe {

    /** What the probe found. */
    sealed interface Verdict permits Clear, Linked, Unverified, NotRun {
    }

    /** No component of the path is a link of the hidden kind (or a component is missing, which the SFTP inspection answers). */
    record Clear() implements Verdict {
    }

    /** A directory on the way to the file, or the file itself, is a link. */
    record Linked() implements Verdict {
    }

    /** The command ran and did not give an answer that can be read (it failed for another reason): the path cannot be called safe. */
    record Unverified() implements Verdict {
    }

    /**
     * The command did not run or its end was not seen: the connection failed, the time ran out or the owner cancelled.
     *
     * @param cause why
     */
    record NotRun(TransferFailureCause cause) implements Verdict {
        public NotRun {
            Objects.requireNonNull(cause, "cause");
        }
    }

    /** Whether this probe is the one for a path of this syntax. */
    boolean applies(RemotePath path);

    /**
     * Looks at the path.
     *
     * @param target where the path is
     * @param path the path of the request
     * @param limits the time limit of the transfer
     * @param control the owner's cancel and the check before dispatch
     * @return what was found
     */
    Verdict check(RemoteTarget target, RemotePath path, TransferLimits limits, ExecutionControl control);
}
