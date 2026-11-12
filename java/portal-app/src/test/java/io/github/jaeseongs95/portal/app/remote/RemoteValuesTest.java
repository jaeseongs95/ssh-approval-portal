package io.github.jaeseongs95.portal.app.remote;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import java.util.List;

import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

import io.github.jaeseongs95.portal.domain.id.Digest;
import io.github.jaeseongs95.portal.domain.id.TargetId;
import io.github.jaeseongs95.portal.domain.operation.OverwriteMode;
import io.github.jaeseongs95.portal.domain.operation.UploadInput;
import io.github.jaeseongs95.portal.domain.path.PathSyntax;
import io.github.jaeseongs95.portal.domain.path.RemotePath;
import io.github.jaeseongs95.portal.domain.target.AccessMode;
import io.github.jaeseongs95.portal.domain.target.AuthMethod;
import io.github.jaeseongs95.portal.domain.target.ProfileAlias;
import io.github.jaeseongs95.portal.domain.target.Setting;
import io.github.jaeseongs95.portal.domain.target.TargetRevision;

/** The values the ports are made of: commands, secrets, file requests, plans (stage 3 design 2.2, 2.3, 4.6, 6.1). */
class RemoteValuesTest {

    private static final RemoteTarget TARGET = new RemoteTarget(new TargetId("web-1"), TargetRevision.of("a".repeat(64)), new ProfileAlias("web-rw"), AccessMode.READ_WRITE);
    private static final Digest DIGEST = new Digest("b".repeat(64));
    private static final FixedRemoteCommand PROBE = new FixedRemoteCommand("sudo-probe", "sudo -n true");

    @Test
    @DisplayName("S3-TP-04 a prepared command has a line, input bytes and a kind, and its text shows the sizes and never the line or the input")
    void preparedCommandHidesItsContent() {
        PreparedCommand command = new PreparedCommand("echo secret-token-123", new StdinBytes("password-in-stdin".getBytes(java.nio.charset.StandardCharsets.UTF_8)),
            CommandKind.SOURCE);
        assertThat(command.toString()).doesNotContain("secret-token-123").doesNotContain("password-in-stdin").contains("SOURCE");
        assertThatThrownBy(() -> new PreparedCommand("", StdinBytes.none(), CommandKind.COMMAND)).isInstanceOf(IllegalArgumentException.class);
        assertThatThrownBy(() -> new PreparedCommand("a\0b", StdinBytes.none(), CommandKind.COMMAND)).isInstanceOf(IllegalArgumentException.class);
    }

    @Test
    @DisplayName("S3-TP-06 the input bytes are copied in and out, and two inputs with the same bytes are equal")
    void stdinBytesAreCopied() {
        byte[] source = {1, 2, 3};
        StdinBytes stdin = new StdinBytes(source);
        source[0] = 9;
        assertThat(stdin.bytes()).containsExactly(1, 2, 3);
        stdin.bytes()[1] = 9;
        assertThat(stdin.bytes()).containsExactly(1, 2, 3);
        assertThat(stdin).isEqualTo(new StdinBytes(new byte[] {1, 2, 3})).hasSameHashCodeAs(new StdinBytes(new byte[] {1, 2, 3}));
        assertThat(StdinBytes.none().length()).isZero();
    }

    @Test
    @DisplayName("S3-TP-06 a script argument has no NUL, and the working directory is a value of two variants")
    void sourceArgumentsAndWorkingDirectory() {
        assertThat(new SourceArguments(List.of("a", "b c")).values()).containsExactly("a", "b c");
        assertThat(SourceArguments.none().values()).isEmpty();
        assertThatThrownBy(() -> new SourceArguments(List.of("a\0"))).isInstanceOf(IllegalArgumentException.class);
        assertThat(new WorkingDirectory.At(PathSyntax.POSIX.path("/srv/app")).directory().value()).isEqualTo("/srv/app");
        assertThatThrownBy(() -> new WorkingDirectory.At(null)).isInstanceOf(NullPointerException.class);
    }

    @Test
    @DisplayName("S3-SS-10 a secret does not appear in its own text, in the text of a credential, or in the text of the Setting that holds it")
    void secretsAreNotPrinted() {
        SecretValue password = SecretValue.of("hunter2-password");
        SecretValue passphrase = SecretValue.of("correct-horse-passphrase");
        SecretValue pem = SecretValue.of("-----BEGIN PRIVATE KEY-----body-----END PRIVATE KEY-----");
        List<Object> credentials = List.of(new SshCredential.Password(password), new SshCredential.PrivateKey(pem, Setting.given(passphrase), Setting.given("ssh-ed25519-cert")),
            new CredentialLookup.Resolved(new SshCredential.Password(password)), password);
        for (Object credential : credentials) {
            assertThat(credential.toString()).doesNotContain("hunter2").doesNotContain("correct-horse").doesNotContain("BEGIN PRIVATE KEY").doesNotContain("body");
        }
        assertThat(password).hasToString("SecretValue[redacted]");
        assertThat(new String(password.reveal())).isEqualTo("hunter2-password");
        assertThat(password.length()).isEqualTo("hunter2-password".length());
    }

    @Test
    @DisplayName("S3-SS-10 a secret is copied, equal by content, and never empty")
    void secretsAreCopiedAndNotEmpty() {
        SecretValue secret = SecretValue.of("abc");
        char[] revealed = secret.reveal();
        revealed[0] = 'z';
        assertThat(new String(secret.reveal())).isEqualTo("abc");
        assertThat(secret).isEqualTo(SecretValue.of("abc")).isNotEqualTo(SecretValue.of("abd"));
        assertThatThrownBy(() -> SecretValue.of("")).isInstanceOf(IllegalArgumentException.class);
    }

    @Test
    @DisplayName("S3-SS-10 a credential lookup that missed names at least one place, and a miss names its place")
    void missingCredentialsNameWhereTheyWereSearched() {
        CredentialMiss miss = new CredentialMiss(CredentialPart.PASSWORD, "the profile password setting");
        assertThat(new CredentialLookup.Missing(List.of(miss)).misses()).containsExactly(miss);
        assertThatThrownBy(() -> new CredentialLookup.Missing(List.of())).isInstanceOf(IllegalArgumentException.class);
        assertThatThrownBy(() -> new CredentialMiss(CredentialPart.KEY_REFERENCE, " ")).isInstanceOf(IllegalArgumentException.class);
        assertThat(new CredentialLookup.Unsupported(AuthMethod.KEYCHAIN).method()).isEqualTo(AuthMethod.KEYCHAIN);
    }

    @Test
    @DisplayName("S3-SF-12 a file mode is nine permission bits and is written as three octal digits")
    void fileModeIsNineBits() {
        assertThat(new FileMode(0600).octal()).isEqualTo("600");
        assertThat(new FileMode(0).octal()).isEqualTo("000");
        assertThat(new FileMode(0777).octal()).isEqualTo("777");
        assertThatThrownBy(() -> new FileMode(01000)).isInstanceOf(IllegalArgumentException.class);
        assertThatThrownBy(() -> new FileMode(-1)).isInstanceOf(IllegalArgumentException.class);
    }

    @Test
    @DisplayName("S3-EL-04 an elevated file access needs a plan the target supports, and a plan is a value that carries its probe")
    void elevatedAccessNeedsASupportedPlan() {
        assertThat(new FileAccess.Elevated(new ElevationPlan.SudoNonInteractive(PROBE)).plan()).isInstanceOf(ElevationPlan.SudoNonInteractive.class);
        assertThat(new FileAccess.Elevated(new ElevationPlan.WindowsAdministratorCheck(PROBE)).plan()).isInstanceOf(ElevationPlan.WindowsAdministratorCheck.class);
        assertThatThrownBy(() -> new FileAccess.Elevated(new ElevationPlan.NotSupported())).isInstanceOf(IllegalArgumentException.class);
        assertThatThrownBy(() -> new ElevationPlan.SudoNonInteractive(null)).isInstanceOf(NullPointerException.class);
    }

    @Test
    @DisplayName("S3-AG-10 a fixed command has a short lower-case label and a line without NUL; nothing of a caller is in it")
    void fixedCommandsAreChecked() {
        assertThat(PROBE.label()).isEqualTo("sudo-probe");
        assertThatThrownBy(() -> new FixedRemoteCommand("Upper", "true")).isInstanceOf(IllegalArgumentException.class);
        assertThatThrownBy(() -> new FixedRemoteCommand("a".repeat(33), "true")).isInstanceOf(IllegalArgumentException.class);
        assertThatThrownBy(() -> new FixedRemoteCommand("ok", " ")).isInstanceOf(IllegalArgumentException.class);
        assertThatThrownBy(() -> new FixedRemoteCommand("ok", "true\0")).isInstanceOf(IllegalArgumentException.class);
    }

    @Test
    @DisplayName("S3-SF-07 an upload request holds a file of 0 to 64 MiB, and every part of a file request is required")
    void uploadRequestBoundsTheSize() {
        RemotePath path = PathSyntax.POSIX.path("/srv/app/file.txt");
        PathPolicyBinding none = new PathPolicyBinding.NoRootPolicy();
        assertThat(new UploadRequest(TARGET, path, 0, DIGEST, OverwriteMode.REPLACE, new FileAccess.Direct(), none, TransferLimits.defaults()).sizeBytes()).isZero();
        assertThat(new UploadRequest(TARGET, path, UploadInput.MAX_BYTES, DIGEST, OverwriteMode.FAIL_IF_EXISTS, new FileAccess.Direct(), none, TransferLimits.defaults())
            .sizeBytes()).isEqualTo(UploadInput.MAX_BYTES);
        assertThatThrownBy(() -> new UploadRequest(TARGET, path, UploadInput.MAX_BYTES + 1, DIGEST, OverwriteMode.REPLACE, new FileAccess.Direct(), none, TransferLimits.defaults()))
            .isInstanceOf(IllegalArgumentException.class);
        assertThatThrownBy(() -> new UploadRequest(TARGET, path, -1, DIGEST, OverwriteMode.REPLACE, new FileAccess.Direct(), none, TransferLimits.defaults()))
            .isInstanceOf(IllegalArgumentException.class);
        assertThatThrownBy(() -> new UploadRequest(TARGET, null, 1, DIGEST, OverwriteMode.REPLACE, new FileAccess.Direct(), none, TransferLimits.defaults()))
            .isInstanceOf(NullPointerException.class);
        assertThatThrownBy(() -> new DownloadRequest(TARGET, path, null, none, TransferLimits.defaults())).isInstanceOf(NullPointerException.class);
    }

    @Test
    @DisplayName("S3-SF-15 a path policy binding says whether a target has a root rule and in which syntax; a decision names the root it enforces")
    void pathPolicyValues() {
        assertThat(new PathPolicyBinding.RootPolicy(PathSyntax.WINDOWS).syntax()).isEqualTo(PathSyntax.WINDOWS);
        assertThatThrownBy(() -> new PathPolicyBinding.RootPolicy(null)).isInstanceOf(NullPointerException.class);
        assertThat(new PathPolicyDecision.Enforce(PathSyntax.WINDOWS.path("C:\\root")).allowedRoot().value()).isEqualTo("C:\\root");
        assertThatThrownBy(() -> new PathPolicyDecision.Enforce(null)).isInstanceOf(NullPointerException.class);
    }

    @Test
    @DisplayName("S3-EX-01 a remote target and a remote execution need every part")
    void remoteTargetAndExecutionNeedEveryPart() {
        PreparedCommand command = new PreparedCommand("true", StdinBytes.none(), CommandKind.COMMAND);
        RemoteExecution execution = new RemoteExecution(TARGET, command, ExecutionLimits.defaults(), ExecReply.AWAITED);
        assertThat(execution.target().access()).isEqualTo(AccessMode.READ_WRITE);
        assertThatThrownBy(() -> new RemoteExecution(TARGET, command, ExecutionLimits.defaults(), null)).isInstanceOf(NullPointerException.class);
        assertThatThrownBy(() -> new RemoteTarget(null, TARGET.revision(), TARGET.profile(), AccessMode.READ_ONLY)).isInstanceOf(NullPointerException.class);
        assertThatThrownBy(() -> new ForwardRequest(TARGET, "example.invalid", 0)).isInstanceOf(IllegalArgumentException.class);
    }
}
