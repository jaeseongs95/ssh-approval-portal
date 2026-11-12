package io.github.jaeseongs95.portal.ssh.sftp;

import io.github.jaeseongs95.portal.app.remote.FileDiagnostic;
import io.github.jaeseongs95.portal.app.remote.ReplaceMethod;
import io.github.jaeseongs95.portal.app.remote.RestoreEvidence;
import io.github.jaeseongs95.portal.app.remote.UnconfirmedCause;
import io.github.jaeseongs95.portal.app.remote.UploadResult;
import io.github.jaeseongs95.portal.domain.error.TransferErrorCode;
import io.github.jaeseongs95.portal.domain.operation.CleanupState;
import io.github.jaeseongs95.portal.domain.operation.OverwriteMode;
import java.io.IOException;
import java.security.SecureRandom;
import java.time.Clock;
import java.util.EnumSet;
import java.util.HexFormat;
import java.util.Objects;
import org.apache.sshd.sftp.client.SftpClient;
import org.apache.sshd.sftp.client.extensions.openssh.OpenSSHFsyncExtension;
import org.apache.sshd.sftp.client.extensions.openssh.OpenSSHPosixRenameExtension;
import org.apache.sshd.sftp.common.extensions.openssh.FsyncExtensionParser;
import org.apache.sshd.sftp.common.extensions.openssh.PosixRenameExtensionParser;
import org.springframework.stereotype.Component;

/**
 * Puts a verified temporary file in place of the target, and says what became of the target (stage 3 design 4.2, defect D-0035). The upload code writes and checks the
 * temporary file; this class does the replacement and what follows it, and an upload is {@link UploadResult.Published} only from here and only after the
 * replacement is read back.
 *
 * <p>How the file is put in place:
 * <ul>
 *   <li>the target does not exist, or must not be replaced: a plain {@code rename}. A server refuses it when the target exists, so the step is atomic and a second
 *       writer to the same name loses ({@link ReplaceMethod#NO_CLOBBER_RENAME});</li>
 *   <li>the target exists and may be replaced, and the server offers {@code posix-rename@openssh.com}: that extension, which replaces in one atomic step
 *       ({@link ReplaceMethod#POSIX_RENAME});</li>
 *   <li>the extension is not offered: the target is renamed to a backup name, the new file renamed in, and the backup removed once the new file is confirmed. When the
 *       second rename or the confirmation fails, the backup is renamed back ({@link ReplaceMethod#BACKUP_SWAP}).</li>
 * </ul>
 * The overload {@code rename(old, new, CopyMode...)} of MINA is never used: with SFTP version 3 and 4, which is what OpenSSH's {@code sftp-server} speaks, an option
 * makes the call throw {@code UnsupportedOperationException} before anything is sent (rule A-LSP; the embedded server negotiates 6 and hides that).
 *
 * <p>What the result says, after the temporary file is complete:
 * <ul>
 *   <li>the file is read back after the replacement (type and size, and one read of it), and only then is the answer {@code Published};</li>
 *   <li>if the read-back fails, the original is put back where a backup exists (and where there was no original, the new file is removed): the result is
 *       {@code RolledBack} when the original is confirmed back, {@code Unconfirmed} when it is not. With the one-step replacement there is no backup, so a failure after
 *       it is {@code Unconfirmed} (the replacement stays, unconfirmed);</li>
 *   <li>the flush of the file ({@code fsync@openssh.com}) is tried only when the server offers it. A server that does not offer it leaves the result
 *       {@code Published}; a flush that is tried and fails is {@code Unconfirmed(DurabilityUnconfirmed)} (decision D3-15);</li>
 *   <li>a temporary or backup file that cannot be removed is {@code Unconfirmed(CleanupUnconfirmed)}, because the target's directory holds something that nobody asked
 *       for.</li>
 * </ul>
 * Before the replacement the target is looked at again and compared with how it looked when the transfer began ({@code FILE_CHANGED} when it differs). The adapter does
 * not retry any step: a step that is not confirmed is reported as it is.
 */
@Component
public class AtomicReplacer {

    private static final String TEMP_PREFIX = ".ssh-approval-";
    private static final String BACKUP_PREFIX = ".ssh-approval-bak-";
    private static final String TEMP_SUFFIX = ".part";
    /** 24 random bytes, shown as 48 hexadecimal characters: the name of a file nobody can guess, made with an exclusive create. */
    private static final int NAME_BYTES = 24;

    private final RemotePathChecker checker;
    private final SftpFailureClassifier classifier;
    private final SecureRandom random;
    private final Clock clock;

    /**
     * @param checker looks at the target again before the replacement
     * @param classifier the meaning of an SFTP failure
     * @param random the source of the unguessable names
     * @param clock the one source of time: when a replacement was confirmed
     */
    public AtomicReplacer(RemotePathChecker checker, SftpFailureClassifier classifier, SecureRandom random, Clock clock) {
        this.checker = Objects.requireNonNull(checker, "checker");
        this.classifier = Objects.requireNonNull(classifier, "classifier");
        this.random = Objects.requireNonNull(random, "random");
        this.clock = Objects.requireNonNull(clock, "clock");
    }

    /** The name of a new temporary file: {@code .ssh-approval-<48 hex characters>.part}. */
    public String newTempName() {
        return TEMP_PREFIX + randomHex() + TEMP_SUFFIX;
    }

    /** What the replacement did to the target, never an exception. */
    UploadResult replace(ReplaceJob job) {
        Objects.requireNonNull(job, "job");
        PathInspection now = checker.inspect(job.client(), job.location());
        if (now instanceof PathInspection.Lost) {
            return new UploadResult.Unconfirmed(new UnconfirmedCause.TransportLost(), CleanupState.INCOMPLETE);
        }
        if (now instanceof PathInspection.Refused refused) {
            return refuse(job, refused.code(), refused.diagnostic());
        }
        if (!unchanged(job.original(), now)) {
            // A file that appeared while the upload ran, where none may be replaced, is the same refusal as one that was there at the start (a second writer lost the race).
            boolean appeared = job.original() instanceof PathInspection.Absent && now instanceof PathInspection.Present && job.overwrite() == OverwriteMode.FAIL_IF_EXISTS;
            return refuse(job, appeared ? TransferErrorCode.DESTINATION_EXISTS : TransferErrorCode.FILE_CHANGED, new FileDiagnostic.None());
        }
        boolean replacing = job.original() instanceof PathInspection.Present && job.overwrite() == OverwriteMode.REPLACE;
        if (!replacing) {
            return noClobberRename(job);
        }
        return offers(job.client(), PosixRenameExtensionParser.NAME) ? posixRename(job) : backupSwap(job);
    }

    /** Removes a file of the target's directory; a file that is not there counts as removed. */
    CleanupState remove(SftpClient client, String sftpPath) {
        try {
            client.remove(sftpPath);
            return CleanupState.COMPLETE;
        } catch (IOException e) {
            return classifier.classify(e).kind() == SftpFailure.Kind.NOT_FOUND ? CleanupState.COMPLETE : CleanupState.INCOMPLETE;
        }
    }

    /** Whether the server advertised the extension. */
    boolean offers(SftpClient client, String extension) {
        return client.getServerExtensions().containsKey(extension);
    }

    // ---- the three ways of putting the file in place ----

    private UploadResult noClobberRename(ReplaceJob job) {
        try {
            job.client().rename(job.tempPath(), job.location().file());
        } catch (IOException e) {
            return renameFailed(job, e);
        }
        return afterReplacement(job, ReplaceMethod.NO_CLOBBER_RENAME, new Backup.None());
    }

    private UploadResult posixRename(ReplaceJob job) {
        OpenSSHPosixRenameExtension extension = job.client().getExtension(OpenSSHPosixRenameExtension.class);
        try {
            extension.posixRename(job.tempPath(), job.location().file());
        } catch (IOException e) {
            return renameFailed(job, e);
        }
        return afterReplacement(job, ReplaceMethod.POSIX_RENAME, new Backup.None());
    }

    private UploadResult backupSwap(ReplaceJob job) {
        SftpClient client = job.client();
        String backupName = BACKUP_PREFIX + randomHex();
        String backupPath = job.location().sibling(backupName);
        try {
            client.rename(job.location().file(), backupPath);
        } catch (IOException e) {
            return renameFailed(job, e); // the target was not moved: it is unchanged
        }
        try {
            client.rename(job.tempPath(), job.location().file());
        } catch (IOException e) {
            return switch (classifier.verdict(e, SftpFailureClassifier.Site.OWN_FILE)) {
                case SftpFailureClassifier.Verdict.Refusal refusal -> restoreFromBackup(job, backupName, refusal);
                case SftpFailureClassifier.Verdict.Lost lost -> new UploadResult.Unconfirmed(new UnconfirmedCause.RestoreUnconfirmed(backupName), CleanupState.INCOMPLETE);
            };
        }
        return afterReplacement(job, ReplaceMethod.BACKUP_SWAP, new Backup.Named(backupName));
    }

    // ---- what follows the replacement ----

    private UploadResult afterReplacement(ReplaceJob job, ReplaceMethod method, Backup backup) {
        Confirmation confirmation = confirm(job);
        return switch (confirmation) {
            case Confirmation.Lost lost -> new UploadResult.Unconfirmed(unconfirmedTransport(backup), CleanupState.INCOMPLETE);
            case Confirmation.Failed failed -> undo(job, backup, new SftpFailureClassifier.Verdict.Refusal(failed.code(), failed.diagnostic()));
            case Confirmation.Confirmed confirmed -> finish(job, method, backup, confirmed.durability());
        };
    }

    private UploadResult finish(ReplaceJob job, ReplaceMethod method, Backup backup, Durability durability) {
        CleanupState cleanup = switch (backup) {
            case Backup.None none -> CleanupState.COMPLETE;
            case Backup.Named named -> remove(job.client(), job.location().sibling(named.name()));
        };
        if (durability == Durability.FAILED) {
            return new UploadResult.Unconfirmed(new UnconfirmedCause.DurabilityUnconfirmed(), cleanup);
        }
        if (cleanup != CleanupState.COMPLETE && backup instanceof Backup.Named named) {
            return new UploadResult.Unconfirmed(new UnconfirmedCause.CleanupUnconfirmed(named.name()), CleanupState.INCOMPLETE);
        }
        return new UploadResult.Published(job.expectedSha256(), clock.instant(), method);
    }

    /** The replacement happened and could not be confirmed: put the original back where that is possible, and say whether it is confirmed. */
    private UploadResult undo(ReplaceJob job, Backup backup, SftpFailureClassifier.Verdict.Refusal reason) {
        return switch (backup) {
            case Backup.Named named -> restoreFromBackup(job, named.name(), reason);
            case Backup.None none -> job.original() instanceof PathInspection.Absent
                ? removeNewFile(job, reason)
                : new UploadResult.Unconfirmed(new UnconfirmedCause.DurabilityUnconfirmed(), CleanupState.COMPLETE);
        };
    }

    /** The target did not exist before: its original state comes back by removing the new file, and that is confirmed by looking for it. */
    private UploadResult removeNewFile(ReplaceJob job, SftpFailureClassifier.Verdict.Refusal reason) {
        String name = job.location().file();
        if (remove(job.client(), name) == CleanupState.COMPLETE && checker.inspect(job.client(), job.location()) instanceof PathInspection.Absent) {
            return new UploadResult.RolledBack(reason.code(), reason.diagnostic(), new RestoreEvidence(clock.instant()));
        }
        return new UploadResult.Unconfirmed(new UnconfirmedCause.DurabilityUnconfirmed(), CleanupState.INCOMPLETE);
    }

    /** Puts the original back from its backup name and reads it back; without that proof the result is unknown, and the backup name is the lead for the owner. */
    private UploadResult restoreFromBackup(ReplaceJob job, String backupName, SftpFailureClassifier.Verdict.Refusal reason) {
        SftpClient client = job.client();
        UnconfirmedCause unconfirmed = new UnconfirmedCause.RestoreUnconfirmed(backupName);
        try {
            try {
                client.remove(job.location().file()); // what the failed replacement left in the target's place, if anything
            } catch (IOException e) {
                if (classifier.classify(e).kind() != SftpFailure.Kind.NOT_FOUND) {
                    return new UploadResult.Unconfirmed(unconfirmed, CleanupState.INCOMPLETE);
                }
            }
            client.rename(job.location().sibling(backupName), job.location().file());
        } catch (IOException e) {
            return new UploadResult.Unconfirmed(unconfirmed, CleanupState.INCOMPLETE);
        }
        PathInspection back = checker.inspect(client, job.location());
        boolean original = back instanceof PathInspection.Present present && job.original() instanceof PathInspection.Present before && present.state().equals(before.state());
        if (!original) {
            return new UploadResult.Unconfirmed(unconfirmed, CleanupState.INCOMPLETE);
        }
        if (remove(client, job.tempPath()) != CleanupState.COMPLETE) {
            return new UploadResult.Unconfirmed(new UnconfirmedCause.CleanupUnconfirmed(job.tempName()), CleanupState.INCOMPLETE);
        }
        return new UploadResult.RolledBack(reason.code(), reason.diagnostic(), new RestoreEvidence(clock.instant()));
    }

    // ---- reading the replacement back ----

    private Confirmation confirm(ReplaceJob job) {
        SftpClient client = job.client();
        String file = job.location().file();
        try {
            SftpClient.Attributes attributes = client.lstat(file);
            if (FileKind.of(attributes) != FileKind.REGULAR) {
                return new Confirmation.Failed(TransferErrorCode.UNSAFE_PATH, new FileDiagnostic.None());
            }
            if (attributes.getSize() != job.expectedSize()) {
                return new Confirmation.Failed(TransferErrorCode.FILE_CHANGED, new FileDiagnostic.None());
            }
        } catch (IOException e) {
            return confirmationFailed(e);
        }
        try (SftpClient.CloseableHandle handle = client.open(file, EnumSet.of(SftpClient.OpenMode.Read))) {
            if (client.stat(handle).getSize() != job.expectedSize()) {
                return new Confirmation.Failed(TransferErrorCode.FILE_CHANGED, new FileDiagnostic.None());
            }
            return new Confirmation.Confirmed(flush(client, handle));
        } catch (IOException e) {
            return confirmationFailed(e);
        }
    }

    private Durability flush(SftpClient client, SftpClient.Handle handle) {
        if (!offers(client, FsyncExtensionParser.NAME)) {
            return Durability.NOT_OFFERED;
        }
        try {
            client.getExtension(OpenSSHFsyncExtension.class).fsync(handle);
            return Durability.FLUSHED;
        } catch (IOException e) {
            return Durability.FAILED;
        }
    }

    private Confirmation confirmationFailed(IOException cause) {
        return switch (classifier.verdict(cause, SftpFailureClassifier.Site.TARGET_FILE)) {
            case SftpFailureClassifier.Verdict.Refusal refusal -> new Confirmation.Failed(refusal.code(), refusal.diagnostic());
            case SftpFailureClassifier.Verdict.Lost lost -> new Confirmation.Lost();
        };
    }

    // ---- shared parts ----

    private UploadResult renameFailed(ReplaceJob job, IOException cause) {
        SftpFailure failure = classifier.classify(cause);
        if (failure.kind() == SftpFailure.Kind.TRANSPORT_LOST) {
            return new UploadResult.Unconfirmed(new UnconfirmedCause.TransportLost(), CleanupState.INCOMPLETE);
        }
        boolean refusedByExistingFile = failure.kind() == SftpFailure.Kind.ALREADY_EXISTS || failure.kind() == SftpFailure.Kind.PLAIN_FAILURE;
        if (refusedByExistingFile && targetExists(job)) {
            // Where the transfer wanted no replacement the server did what was asked; where it did, a file appeared that was not there a moment ago.
            return refuse(job, job.overwrite() == OverwriteMode.FAIL_IF_EXISTS ? TransferErrorCode.DESTINATION_EXISTS : TransferErrorCode.FILE_CHANGED,
                new FileDiagnostic.SftpStatus(failure.status()));
        }
        return switch (classifier.verdict(failure, SftpFailureClassifier.Site.OWN_FILE)) {
            case SftpFailureClassifier.Verdict.Refusal refusal -> refuse(job, refusal.code(), refusal.diagnostic());
            case SftpFailureClassifier.Verdict.Lost lost -> new UploadResult.Unconfirmed(new UnconfirmedCause.TransportLost(), CleanupState.INCOMPLETE);
        };
    }

    private boolean targetExists(ReplaceJob job) {
        try {
            job.client().lstat(job.location().file());
            return true;
        } catch (IOException e) {
            return false;
        }
    }

    /** The target is unchanged: remove the temporary file and report the refusal, or report that the file could not be removed. */
    private UploadResult refuse(ReplaceJob job, TransferErrorCode code, FileDiagnostic diagnostic) {
        if (remove(job.client(), job.tempPath()) == CleanupState.COMPLETE) {
            return new UploadResult.Refused(code, diagnostic, CleanupState.COMPLETE);
        }
        return new UploadResult.Unconfirmed(new UnconfirmedCause.CleanupUnconfirmed(job.tempName()), CleanupState.INCOMPLETE);
    }

    private boolean unchanged(PathInspection before, PathInspection now) {
        return switch (before) {
            case PathInspection.Absent absent -> now instanceof PathInspection.Absent;
            case PathInspection.Present present -> now instanceof PathInspection.Present current && present.state().equals(current.state());
            case PathInspection.Refused refused -> false;
            case PathInspection.Lost lost -> false;
        };
    }

    private UnconfirmedCause unconfirmedTransport(Backup backup) {
        return switch (backup) {
            case Backup.None none -> new UnconfirmedCause.TransportLost();
            case Backup.Named named -> new UnconfirmedCause.RestoreUnconfirmed(named.name());
        };
    }

    private String randomHex() {
        byte[] bytes = new byte[NAME_BYTES];
        random.nextBytes(bytes);
        return HexFormat.of().formatHex(bytes);
    }

    /** Whether the original is kept under a backup name until the new file is confirmed. */
    private sealed interface Backup permits Backup.None, Backup.Named {
        record None() implements Backup {
        }

        record Named(String name) implements Backup {
        }
    }

    /** What reading the replacement back showed. */
    private sealed interface Confirmation permits Confirmation.Confirmed, Confirmation.Failed, Confirmation.Lost {
        record Confirmed(Durability durability) implements Confirmation {
        }

        record Failed(TransferErrorCode code, FileDiagnostic diagnostic) implements Confirmation {
        }

        record Lost() implements Confirmation {
        }
    }

    /** What became of the flush of the new file. */
    private enum Durability {
        /** The server does not offer {@code fsync@openssh.com}: nothing was tried. */
        NOT_OFFERED,
        FLUSHED,
        /** The flush was tried and failed. */
        FAILED
    }
}
