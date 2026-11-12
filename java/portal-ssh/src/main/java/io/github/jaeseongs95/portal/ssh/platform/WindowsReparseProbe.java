package io.github.jaeseongs95.portal.ssh.platform;

import io.github.jaeseongs95.portal.app.remote.ExecReply;
import io.github.jaeseongs95.portal.app.remote.ExecutionControl;
import io.github.jaeseongs95.portal.app.remote.ExecutionLimits;
import io.github.jaeseongs95.portal.app.remote.PreparedCommand;
import io.github.jaeseongs95.portal.app.remote.RemoteExecution;
import io.github.jaeseongs95.portal.app.remote.RemoteExecutor;
import io.github.jaeseongs95.portal.app.remote.RemoteTarget;
import io.github.jaeseongs95.portal.app.remote.SinkResult;
import io.github.jaeseongs95.portal.app.remote.TransferFailureCause;
import io.github.jaeseongs95.portal.app.remote.TransferLimits;
import io.github.jaeseongs95.portal.app.remote.WorkingDirectory;
import io.github.jaeseongs95.portal.domain.error.ExecutionErrorCode;
import io.github.jaeseongs95.portal.domain.operation.ExecutionOutcome;
import io.github.jaeseongs95.portal.domain.operation.ExecutionReason;
import io.github.jaeseongs95.portal.domain.operation.ExitStatus;
import io.github.jaeseongs95.portal.domain.path.RemotePath;
import io.github.jaeseongs95.portal.domain.path.WindowsRemotePath;
import io.github.jaeseongs95.portal.domain.text.CommandText;
import io.github.jaeseongs95.portal.ssh.sftp.HiddenLinkProbe;
import java.nio.charset.StandardCharsets;
import java.util.Base64;
import java.util.Objects;
import org.springframework.stereotype.Component;
import org.springframework.util.unit.DataSize;

/**
 * Finds the links of a path on a Windows target that its SFTP server does not show: junctions (mount point reparse points), and any other reparse point (stage 3 design 4.3,
 * 4.4 line 19; the reason is in {@link HiddenLinkProbe}). One fixed read-only PowerShell command looks at every component of the path from the drive down, without following
 * anything, and ends with 3 when one has the {@code ReparsePoint} attribute, with 0 when none has (a component that is not there ends the walk: the SFTP inspection answers
 * a missing directory), and with another code (4 when a component could not be looked at) when it failed; only "not there" counts as clear, every other error is not an answer. As in the 2.x helper, any reparse point is refused, not only the junction: a placeholder or a deduplicated file
 * is no regular file the owner meant either.
 *
 * <p>The path is data, never code: it travels as the base64 of its UTF-8 bytes, which holds no character PowerShell reads, and the script is sent as standard input through
 * the same wrapper that runs an owner's command ({@link WindowsCommandWrapper#prepare}). The command is an external program of the target, not of this server; Java cannot
 * replace it, because the information is only in the target's file system and its SFTP server does not pass it on (docs/external-programs). Nothing is started on this server.
 * Only a Windows path is looked at: a POSIX target's SFTP server shows its links, and {@code RemotePathChecker} refuses them.
 */
@Component
public final class WindowsReparseProbe implements HiddenLinkProbe {

    private static final int FOUND = 3;
    /** The walk could not look at a component or the path has no drive form; the path is not called safe ({@link Unverified}). */
    private static final int UNREADABLE = 4;
    private static final String PLACEHOLDER = "@@PATH@@";
    /**
     * Walks the components of the path (the text after the drive) and ends with 3 at the first reparse point. Only a component that is not there ({@code FileNotFoundException},
     * {@code DirectoryNotFoundException}) ends the walk with 0: the SFTP inspection answers a missing directory. Any other error (access denied, an I/O error, a path that is
     * too long) ends with 4, never with 0, so that a component that could not be looked at is not taken for a clear one. {@link WindowsRemotePath} accepts only the drive form
     * {@code X:\} or {@code X:/} (its pattern {@code [A-Za-z]:[\\/].*}), which is what {@code Substring(0,3)} takes as the root; the script checks the form again and ends with 4 for
     * anything else, so that it does not depend on the caller.
     */
    private static final String SCRIPT = "$ErrorActionPreference='Stop';"
        + "$p=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('" + PLACEHOLDER + "')).Replace('/','\\');"
        + "if($p -notmatch '^[A-Za-z]:\\\\.'){exit " + UNREADABLE + "};"
        + "$c=$p.Substring(0,3);"
        + "foreach($x in $p.Substring(3).Split('\\')){$c=[IO.Path]::Combine($c,$x);"
        + "try{$a=[IO.File]::GetAttributes($c)}catch [IO.FileNotFoundException],[IO.DirectoryNotFoundException]{break}catch{exit " + UNREADABLE + "};"
        + "if($a -band [IO.FileAttributes]::ReparsePoint){exit " + FOUND + "}};exit 0";

    private final WindowsCommandWrapper wrapper;
    private final RemoteExecutor executor;

    /**
     * @param wrapper wraps the script for PowerShell
     * @param executor runs it on the target; it sends it at most once
     */
    public WindowsReparseProbe(WindowsCommandWrapper wrapper, RemoteExecutor executor) {
        this.wrapper = Objects.requireNonNull(wrapper, "wrapper");
        this.executor = Objects.requireNonNull(executor, "executor");
    }

    @Override
    public boolean applies(RemotePath path) {
        return path instanceof WindowsRemotePath;
    }

    @Override
    public Verdict check(RemoteTarget target, RemotePath path, TransferLimits limits, ExecutionControl control) {
        Objects.requireNonNull(path, "path");
        String encoded = Base64.getEncoder().encodeToString(path.value().getBytes(StandardCharsets.UTF_8));
        PreparedCommand command = wrapper.prepare(new CommandText(SCRIPT.replace(PLACEHOLDER, encoded)), new WorkingDirectory.Default());
        ExecutionLimits executionLimits = new ExecutionLimits(limits.deadline(), ExecutionLimits.DEFAULT_STOP_GRACE, DataSize.ofKilobytes(16));
        ExecutionOutcome outcome = executor.run(new RemoteExecution(target, command, executionLimits, ExecReply.NOT_AWAITED), frame -> new SinkResult.Accepted(), control).outcome();
        if (outcome.reason() == ExecutionReason.EXIT && outcome.exit() instanceof ExitStatus.Exited exited && outcome.failure().code() != ExecutionErrorCode.SSH_CONNECT_FAILED) {
            return switch (exited.code()) {
                case 0 -> new Clear();
                case FOUND -> new Linked();
                default -> new Unverified();
            };
        }
        return new NotRun(causeOf(outcome));
    }

    private TransferFailureCause causeOf(ExecutionOutcome outcome) {
        if (outcome.failure().code() == ExecutionErrorCode.SSH_CONNECT_FAILED) {
            return TransferFailureCause.CONNECT_FAILED;
        }
        return switch (outcome.reason()) {
            case EXIT, TRANSPORT_LOST -> TransferFailureCause.TRANSPORT_LOST;
            case DEADLINE -> TransferFailureCause.DEADLINE;
            case CANCEL -> TransferFailureCause.CANCELLED;
            case CHANNEL_OPEN_FAILED -> TransferFailureCause.CHANNEL_OPEN_FAILED;
            case INPUT_FAILED -> TransferFailureCause.LOCAL_IO_FAILED;
        };
    }
}
