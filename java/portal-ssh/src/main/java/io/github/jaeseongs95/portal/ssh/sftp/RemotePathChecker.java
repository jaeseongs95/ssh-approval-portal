package io.github.jaeseongs95.portal.ssh.sftp;

import io.github.jaeseongs95.portal.app.remote.FileDiagnostic;
import io.github.jaeseongs95.portal.app.remote.FilePathPolicy;
import io.github.jaeseongs95.portal.app.remote.PathPolicyBinding;
import io.github.jaeseongs95.portal.app.remote.PathPolicyDecision;
import io.github.jaeseongs95.portal.domain.error.TransferErrorCode;
import io.github.jaeseongs95.portal.domain.id.TargetId;
import io.github.jaeseongs95.portal.domain.path.PathSyntax;
import io.github.jaeseongs95.portal.domain.path.PosixRemotePath;
import io.github.jaeseongs95.portal.domain.path.RemotePath;
import io.github.jaeseongs95.portal.domain.path.WindowsRemotePath;
import java.io.IOException;
import java.util.Objects;
import org.apache.sshd.sftp.client.SftpClient;
import org.springframework.stereotype.Component;

/**
 * The checks of a path that come before any byte of a file is read or written (stage 3 design 4.3). There are two, and they ask different things.
 *
 * <p>The allowed-root rule ({@link #judgePolicy}) is a question about the written path and no server is asked: the {@link FilePathPolicy} says whether the root is
 * enforced, lifted or unknown, and the containment is decided by {@code RemotePath#isWithin} (case-insensitive on Windows), not by cutting strings here.
 * An unknown policy is a refusal ({@code PATH_POLICY_UNSUPPORTED}), never an allowance.
 *
 * <p>The inspection ({@link #inspect}) asks the server. The 2.x helpers walked the path from the root with a handle on every directory, so that a link swapped in later
 * could not redirect them. SFTP has no operation that opens a file relative to a directory handle, so that strength cannot be had. What is done instead: every
 * directory on the way and the file itself are looked at with {@code lstat} (which does not follow links), and a link, a directory where a file should be, a FIFO or any
 * other kind is {@code UNSAFE_PATH}. The server's {@code realpath} is not used: what it answers is formatted by the server (a Windows server answers {@code /C:/x}, a
 * chrooted one a path of its own) and cannot be compared with the request; asking each component is exact. The file is looked at again right before the replacement
 * ({@code FILE_CHANGED} when it differs). What stays open is the time between those checks and the use: an attacker who can swap a directory for a link in that time
 * already has the rights of the login account over that directory, which is the residual risk of decision D3-02 and goes to the security audit.
 */
@Component
public class RemotePathChecker {

    private final FilePathPolicy policy;
    private final SftpFailureClassifier classifier;

    /**
     * @param policy the allowed-root rule and the test-server bypass; stage 4 implements it, stage 3 tests use a plain class
     * @param classifier the meaning of an SFTP failure
     */
    public RemotePathChecker(FilePathPolicy policy, SftpFailureClassifier classifier) {
        this.policy = Objects.requireNonNull(policy, "policy");
        this.classifier = Objects.requireNonNull(classifier, "classifier");
    }

    /**
     * What the allowed-root rule says about the path. A target without such a rule ({@link PathPolicyBinding.NoRootPolicy}) is not asked.
     *
     * @param target the target the path is on
     * @param path the path of the request
     * @param binding whether the target has a root rule and in which syntax it is compared
     * @return cleared, or refused with {@code PATH_OUTSIDE_ALLOWED_ROOT}, {@code PATH_POLICY_UNSUPPORTED} or {@code INVALID_REQUEST}
     */
    public PolicyVerdict judgePolicy(TargetId target, RemotePath path, PathPolicyBinding binding) {
        Objects.requireNonNull(target, "target");
        Objects.requireNonNull(path, "path");
        return switch (Objects.requireNonNull(binding, "binding")) {
            case PathPolicyBinding.NoRootPolicy none -> new PolicyVerdict.Cleared();
            case PathPolicyBinding.RootPolicy rooted -> judgeRoot(target, path, rooted.syntax());
        };
    }

    private PolicyVerdict judgeRoot(TargetId target, RemotePath path, PathSyntax syntax) {
        boolean sameSyntax = switch (syntax) {
            case POSIX -> path instanceof PosixRemotePath;
            case WINDOWS -> path instanceof WindowsRemotePath;
        };
        if (!sameSyntax) {
            return new PolicyVerdict.Refused(TransferErrorCode.INVALID_REQUEST, new FileDiagnostic.None());
        }
        return switch (policy.decide(target, path)) {
            case PathPolicyDecision.Enforce enforce -> path.isWithin(enforce.allowedRoot())
                ? new PolicyVerdict.Cleared()
                : new PolicyVerdict.Refused(TransferErrorCode.PATH_OUTSIDE_ALLOWED_ROOT, new FileDiagnostic.None());
            case PathPolicyDecision.Bypass bypass -> new PolicyVerdict.Cleared();
            case PathPolicyDecision.NotApplicable notApplicable -> new PolicyVerdict.Cleared();
            case PathPolicyDecision.Unconfirmed unconfirmed -> new PolicyVerdict.Refused(TransferErrorCode.PATH_POLICY_UNSUPPORTED, new FileDiagnostic.None());
        };
    }

    /**
     * Looks at every directory on the way to the file and at the file itself.
     *
     * @param client the SFTP client of the session
     * @param location where the file is
     * @return no file there, a regular file there, a refusal, or a lost connection
     */
    public PathInspection inspect(SftpClient client, SftpLocation location) {
        Objects.requireNonNull(client, "client");
        Objects.requireNonNull(location, "location");
        for (String directory : location.ancestors()) {
            SftpClient.Attributes attributes;
            try {
                attributes = client.lstat(directory);
            } catch (IOException e) {
                return failed(e, SftpFailureClassifier.Site.PARENT_DIRECTORY);
            }
            if (FileKind.of(attributes) != FileKind.DIRECTORY) {
                return new PathInspection.Refused(TransferErrorCode.UNSAFE_PATH, new FileDiagnostic.None());
            }
        }
        SftpClient.Attributes attributes;
        try {
            attributes = client.lstat(location.file());
        } catch (IOException e) {
            SftpFailure failure = classifier.classify(e);
            if (failure.kind() == SftpFailure.Kind.NOT_FOUND) {
                return new PathInspection.Absent();
            }
            return failed(failure, SftpFailureClassifier.Site.TARGET_FILE);
        }
        return switch (FileKind.of(attributes)) {
            case REGULAR -> new PathInspection.Present(LeafState.of(attributes));
            case DIRECTORY, SYMBOLIC_LINK, OTHER -> new PathInspection.Refused(TransferErrorCode.UNSAFE_PATH, new FileDiagnostic.None());
        };
    }

    private PathInspection failed(IOException cause, SftpFailureClassifier.Site site) {
        return failed(classifier.classify(cause), site);
    }

    private PathInspection failed(SftpFailure failure, SftpFailureClassifier.Site site) {
        return switch (classifier.verdict(failure, site)) {
            case SftpFailureClassifier.Verdict.Refusal refusal -> new PathInspection.Refused(refusal.code(), refusal.diagnostic());
            case SftpFailureClassifier.Verdict.Lost lost -> new PathInspection.Lost();
        };
    }
}
