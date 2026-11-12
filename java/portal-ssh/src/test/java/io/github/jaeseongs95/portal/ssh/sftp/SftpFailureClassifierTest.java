package io.github.jaeseongs95.portal.ssh.sftp;

import static org.assertj.core.api.Assertions.assertThat;

import io.github.jaeseongs95.portal.app.remote.FileDiagnostic;
import io.github.jaeseongs95.portal.domain.error.TransferErrorCode;
import java.io.EOFException;
import java.io.IOException;
import java.nio.channels.ClosedChannelException;
import org.apache.sshd.sftp.common.SftpConstants;
import org.apache.sshd.sftp.common.SftpException;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

/** The meaning of an SFTP failure (stage 3 design 4.5): which status is which code, and what is never mixed with what (defects D-0013 and D-0034). */
class SftpFailureClassifierTest {

    private final SftpFailureClassifier classifier = new SftpFailureClassifier();

    private SftpFailureClassifier.Verdict verdictOfStatus(int status, SftpFailureClassifier.Site site) {
        return classifier.verdict(new SftpException(status, "a message that never becomes data"), site);
    }

    private SftpFailureClassifier.Verdict.Refusal refusalOfStatus(int status, SftpFailureClassifier.Site site) {
        return (SftpFailureClassifier.Verdict.Refusal) verdictOfStatus(status, site);
    }

    @Test
    @DisplayName("S3-SF-19 status 2 is the missing parent for a directory, the missing file for the target and a changed file for our own temporary file")
    void noSuchFileDependsOnWhichPartWasAsked() {
        assertThat(refusalOfStatus(SftpConstants.SSH_FX_NO_SUCH_FILE, SftpFailureClassifier.Site.PARENT_DIRECTORY).code()).isEqualTo(TransferErrorCode.PARENT_NOT_FOUND);
        assertThat(refusalOfStatus(SftpConstants.SSH_FX_NO_SUCH_FILE, SftpFailureClassifier.Site.NEW_FILE).code()).isEqualTo(TransferErrorCode.PARENT_NOT_FOUND);
        assertThat(refusalOfStatus(SftpConstants.SSH_FX_NO_SUCH_FILE, SftpFailureClassifier.Site.TARGET_FILE).code()).isEqualTo(TransferErrorCode.FILE_NOT_FOUND);
        assertThat(refusalOfStatus(SftpConstants.SSH_FX_NO_SUCH_FILE, SftpFailureClassifier.Site.OWN_FILE).code()).isEqualTo(TransferErrorCode.FILE_CHANGED);
        assertThat(refusalOfStatus(SftpConstants.SSH_FX_NO_SUCH_PATH, SftpFailureClassifier.Site.TARGET_FILE).code()).isEqualTo(TransferErrorCode.FILE_NOT_FOUND);
    }

    @Test
    @DisplayName("S3-SF-19 RC-B-512 D-0013 status 3 is PERMISSION_DENIED with the status as the fact, at every part of the path")
    void permissionDeniedIsItsOwnCode() {
        for (SftpFailureClassifier.Site site : SftpFailureClassifier.Site.values()) {
            SftpFailureClassifier.Verdict.Refusal refusal = refusalOfStatus(SftpConstants.SSH_FX_PERMISSION_DENIED, site);
            assertThat(refusal.code()).as(site.name()).isEqualTo(TransferErrorCode.PERMISSION_DENIED);
            assertThat(refusal.diagnostic()).isEqualTo(new FileDiagnostic.SftpStatus(SftpConstants.SSH_FX_PERMISSION_DENIED));
        }
        assertThat(refusalOfStatus(SftpConstants.SSH_FX_WRITE_PROTECT, SftpFailureClassifier.Site.OWN_FILE).code()).isEqualTo(TransferErrorCode.PERMISSION_DENIED);
    }

    @Test
    @DisplayName("S3-SF-19 status 11 is DESTINATION_EXISTS")
    void alreadyExists() {
        assertThat(refusalOfStatus(SftpConstants.SSH_FX_FILE_ALREADY_EXISTS, SftpFailureClassifier.Site.OWN_FILE).code()).isEqualTo(TransferErrorCode.DESTINATION_EXISTS);
    }

    @Test
    @DisplayName("S3-SF-10 D-0034 status 14 and 15 are a full file system, not a permission problem and not a lost connection")
    void noSpaceIsNeitherPermissionNorTransport() {
        for (int status : new int[] {SftpConstants.SSH_FX_NO_SPACE_ON_FILESYSTEM, SftpConstants.SSH_FX_QUOTA_EXCEEDED}) {
            SftpFailureClassifier.Verdict.Refusal refusal = refusalOfStatus(status, SftpFailureClassifier.Site.OWN_FILE);
            assertThat(refusal.code()).as("status %d", status).isEqualTo(TransferErrorCode.STAGING_UNAVAILABLE).isNotEqualTo(TransferErrorCode.PERMISSION_DENIED);
            assertThat(refusal.diagnostic()).isEqualTo(new FileDiagnostic.NoSpace());
        }
    }

    @Test
    @DisplayName("S3-SF-19 status 4 is the plain failure: STAGING_UNAVAILABLE for our own file, INVALID_REQUEST with the status where the server's file was asked about")
    void plainFailure() {
        assertThat(refusalOfStatus(SftpConstants.SSH_FX_FAILURE, SftpFailureClassifier.Site.OWN_FILE).code()).isEqualTo(TransferErrorCode.STAGING_UNAVAILABLE);
        assertThat(refusalOfStatus(SftpConstants.SSH_FX_FAILURE, SftpFailureClassifier.Site.NEW_FILE).code()).isEqualTo(TransferErrorCode.STAGING_UNAVAILABLE);
        SftpFailureClassifier.Verdict.Refusal onTarget = refusalOfStatus(SftpConstants.SSH_FX_FAILURE, SftpFailureClassifier.Site.TARGET_FILE);
        assertThat(onTarget.code()).isEqualTo(TransferErrorCode.INVALID_REQUEST);
        assertThat(onTarget.diagnostic()).isEqualTo(new FileDiagnostic.SftpStatus(SftpConstants.SSH_FX_FAILURE));
    }

    @Test
    @DisplayName("S3-SF-19 D-0013 status 6 and 7 and a failure without a status are a lost connection, never a refusal")
    void transportFailures() {
        assertThat(verdictOfStatus(SftpConstants.SSH_FX_NO_CONNECTION, SftpFailureClassifier.Site.TARGET_FILE)).isInstanceOf(SftpFailureClassifier.Verdict.Lost.class);
        assertThat(verdictOfStatus(SftpConstants.SSH_FX_CONNECTION_LOST, SftpFailureClassifier.Site.TARGET_FILE)).isInstanceOf(SftpFailureClassifier.Verdict.Lost.class);
        for (IOException withoutStatus : new IOException[] {new IOException("channel closed"), new EOFException(), new ClosedChannelException()}) {
            assertThat(classifier.verdict(withoutStatus, SftpFailureClassifier.Site.TARGET_FILE)).as(withoutStatus.getClass().getSimpleName())
                .isInstanceOf(SftpFailureClassifier.Verdict.Lost.class);
            assertThat(classifier.classify(withoutStatus)).isEqualTo(new SftpFailure(SftpFailure.Kind.TRANSPORT_LOST, SftpFailure.NO_STATUS));
        }
    }

    @Test
    @DisplayName("S3-SF-19 a link loop, a directory where a file is and a file where a directory is are UNSAFE_PATH; an unknown status is INVALID_REQUEST with the status")
    void pathShapesAndUnknownStatuses() {
        for (int status : new int[] {SftpConstants.SSH_FX_LINK_LOOP, SftpConstants.SSH_FX_FILE_IS_A_DIRECTORY, SftpConstants.SSH_FX_NOT_A_DIRECTORY}) {
            assertThat(refusalOfStatus(status, SftpFailureClassifier.Site.TARGET_FILE).code()).as("status %d", status).isEqualTo(TransferErrorCode.UNSAFE_PATH);
        }
        SftpFailureClassifier.Verdict.Refusal unsupported = refusalOfStatus(SftpConstants.SSH_FX_OP_UNSUPPORTED, SftpFailureClassifier.Site.TARGET_FILE);
        assertThat(unsupported.code()).isEqualTo(TransferErrorCode.INVALID_REQUEST);
        assertThat(unsupported.diagnostic()).isEqualTo(new FileDiagnostic.SftpStatus(SftpConstants.SSH_FX_OP_UNSUPPORTED));
    }

    @Test
    @DisplayName("D3-02 the owner and DACL codes of the 2.x Windows helper are never produced, whatever the status")
    void theSixWindowsHelperCodesAreNeverProduced() {
        java.util.Set<TransferErrorCode> notProduced = java.util.EnumSet.of(TransferErrorCode.UNTRUSTED_OWNER, TransferErrorCode.MISSING_DACL, TransferErrorCode.UNSAFE_ANCESTOR,
            TransferErrorCode.UNTRUSTED_WRITER, TransferErrorCode.UNSUPPORTED_ACE, TransferErrorCode.SECURITY_DESCRIPTOR_TOO_LARGE);
        for (int status = 0; status <= 30; status++) {
            for (SftpFailureClassifier.Site site : SftpFailureClassifier.Site.values()) {
                if (verdictOfStatus(status, site) instanceof SftpFailureClassifier.Verdict.Refusal refusal) {
                    assertThat(notProduced).as("status %d at %s", status, site).doesNotContain(refusal.code());
                }
            }
        }
    }
}
