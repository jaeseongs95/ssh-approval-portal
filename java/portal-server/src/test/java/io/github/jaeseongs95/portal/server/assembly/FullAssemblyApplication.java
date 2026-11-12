package io.github.jaeseongs95.portal.server.assembly;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Duration;

import org.springframework.boot.autoconfigure.EnableAutoConfiguration;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.context.annotation.Import;
import org.springframework.context.annotation.Primary;

import io.github.jaeseongs95.portal.app.artifact.StagingTimes;
import io.github.jaeseongs95.portal.app.remote.FilePathPolicy;
import io.github.jaeseongs95.portal.app.remote.PathPolicyDecision;
import io.github.jaeseongs95.portal.domain.id.Digester;
import io.github.jaeseongs95.portal.ssh.profile.ProfileCatalog;
import io.github.jaeseongs95.portal.ssh.profile.TestFiles;
import io.github.jaeseongs95.portal.ssh.testkit.EmbeddedSshServer;
import io.github.jaeseongs95.portal.ssh.testkit.ScriptedCommand;
import io.github.jaeseongs95.portal.store.artifact.ArtifactLimits;

/**
 * The context of the full assembly tests: {@link DefaultAssembly} as the product has it (the real storage adapters over the embedded H2 database and real files, the real use
 * cases, the real dispatcher, the real SSH adapter, and every default value of {@link AssemblyDefaults}) with only the world around it made by the test: a MINA SSH server
 * in this JVM on a free loopback port with an SFTP root, the profile file that names it, the storage settings below a temporary folder, one target, and the path policy of the
 * test-server mode. The beans of the test are {@code @Primary} where {@link AssemblyDefaults} has a bean of the same type (the targets, the path policy), so no bean is
 * overridden by name. The limits of the storage are small numbers a test can reach: a 100,000 byte budget, files of at most 10,000 bytes.
 */
@Configuration(proxyBeanMethods = false)
@EnableAutoConfiguration
@Import(DefaultAssembly.class)
class FullAssemblyApplication {

    /** The login of the embedded server and the value of {@code SSH_MCP_PASSWORD} that {@code EnvironmentCredentialSource} reads (set in {@link FullAssemblyTest}). */
    static final String USER = "tester";
    static final String PASSWORD = "embedded-test-password";

    /** The command the server answers: its exact text, what it prints. */
    static final String COMMAND = "echo ok";
    static final String COMMAND_OUTPUT = "ok\n";

    @Bean
    EmbeddedSshServer sshServer() throws IOException {
        Path root = Files.createTempDirectory("portal-full-sftp");
        return EmbeddedSshServer.builder().password(USER, PASSWORD).script(COMMAND, new ScriptedCommand.Exits(0, COMMAND_OUTPUT, "")).sftp(root).start();
    }

    @Bean
    StorageSettings storageSettings() throws IOException {
        Path base = Files.createTempDirectory("portal-full");
        return new StorageSettings(base.resolve("artifacts"), base.resolve("outputs"), base.resolve("audit").resolve("audit.jsonl"),
            new ArtifactLimits(100_000L, 10_000L, ArtifactLimits.CHUNK_BYTES, ArtifactLimits.UPLOAD_TTL, 0L), new StagingTimes(Duration.ofMinutes(10), Duration.ofHours(1)));
    }

    /**
     * The two profiles of the embedded server, in a profile file that only its owner may use (the loader refuses a file that others can read): the read-only one and the
     * read-write one, both pinned to the host key of the server, both logging in with the password.
     */
    @Bean
    ConnectionFiles connectionFiles(EmbeddedSshServer server) throws IOException {
        Path folder = TestFiles.privateFolder(Files.createTempDirectory("portal-full-config"));
        Path profiles = TestFiles.privateFile(Files.writeString(folder.resolve("profiles.toml"), profileFile(server), StandardCharsets.UTF_8));
        return new ConnectionFiles(profiles, folder.resolve("known_hosts"));
    }

    @Bean
    @Primary
    EmbeddedTargets embeddedTargets(ProfileCatalog catalog, Digester digester) {
        return new EmbeddedTargets(catalog, digester);
    }

    /** The test-server mode: the root rule is lifted, the files of the embedded server are below its SFTP root anyway. */
    @Bean
    @Primary
    FilePathPolicy testServerPathPolicy() {
        return (target, path) -> new PathPolicyDecision.Bypass();
    }

    private static String profileFile(EmbeddedSshServer server) {
        return profile(EmbeddedTargets.READ_PROFILE.value(), server, true) + profile(EmbeddedTargets.WRITE_PROFILE.value(), server, false);
    }

    private static String profile(String name, EmbeddedSshServer server, boolean readOnly) {
        return "[[profiles]]\n"
            + "name = \"" + name + "\"\n"
            + "host = \"" + server.host() + "\"\n"
            + "port = " + server.port() + "\n"
            + "user = \"" + USER + "\"\n"
            + "auth = \"password\"\n"
            + "trustedHostKey = \"" + server.hostKeyFingerprint() + "\"\n"
            + "readOnly = " + readOnly + "\n\n";
    }
}
