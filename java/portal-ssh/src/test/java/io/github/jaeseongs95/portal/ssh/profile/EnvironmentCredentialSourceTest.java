package io.github.jaeseongs95.portal.ssh.profile;

import static org.assertj.core.api.Assertions.assertThat;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.HashMap;
import java.util.List;
import java.util.Map;

import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.CsvSource;
import org.springframework.core.env.MapPropertySource;
import org.springframework.core.env.StandardEnvironment;

import io.github.jaeseongs95.portal.app.remote.CredentialLookup;
import io.github.jaeseongs95.portal.app.remote.CredentialMiss;
import io.github.jaeseongs95.portal.app.remote.CredentialPart;
import io.github.jaeseongs95.portal.app.remote.SecretValue;
import io.github.jaeseongs95.portal.app.remote.SshCredential;
import io.github.jaeseongs95.portal.domain.target.AuthMethod;
import io.github.jaeseongs95.portal.domain.target.Setting;
import jakarta.validation.Validation;
import jakarta.validation.Validator;

/**
 * The credentials of a profile from the {@code SSH_MCP_*} settings (vendor rules EV-01 to EV-13, cases VR-375 to VR-403 of vendor-ssh-mcp-rules.md, section 4.3). The
 * environment is a Spring {@link StandardEnvironment} that holds only the values of the test (no variable of the machine), the profiles come from a real profile file, and the
 * keys are real files in a temporary folder. The expectations were traced from vendor config/credential-resolver.js before the first run.
 */
class EnvironmentCredentialSourceTest {

    private static final Validator VALIDATOR = Validation.buildDefaultValidatorFactory().getValidator();

    @TempDir
    Path directory;

    private final TomlProfileLoader loader = new TomlProfileLoader(new FileAccessGuard(List.of(FixedAccessRule.open())), VALIDATOR, new RecordingProfileEvents());

    private StandardEnvironment environment(Map<String, String> values) {
        StandardEnvironment environment = new StandardEnvironment();
        environment.getPropertySources().remove(StandardEnvironment.SYSTEM_PROPERTIES_PROPERTY_SOURCE_NAME);
        environment.getPropertySources().remove(StandardEnvironment.SYSTEM_ENVIRONMENT_PROPERTY_SOURCE_NAME);
        environment.getPropertySources().addFirst(new MapPropertySource("test", new HashMap<String, Object>(values)));
        return environment;
    }

    /** A TOML literal string (no escapes), so that a Windows path can be written as it is. */
    private String literal(Path path) {
        return "'" + path + "'";
    }

    private Path file(String name, String text) throws IOException {
        Path file = directory.resolve(name);
        Files.createDirectories(file.getParent());
        return Files.writeString(file, text);
    }

    /** Loads a file with the one profile {@code name} that has the keys of {@code profileKeys}, and resolves its credential from the values. */
    private CredentialLookup resolve(String name, String profileKeys, Map<String, String> values) throws IOException {
        Path config = Files.writeString(directory.resolve("config-" + name.hashCode() + ".toml"), "[[profiles]]\nname = \"" + name + "\"\nhost = \"h\"\nuser = \"u\"\n"
            + profileKeys + "\n");
        ProfileCatalog catalog = loader.load(config);
        ProfileEntry entry = catalog.entries().get(0);
        return new EnvironmentCredentialSource(environment(values), catalog).resolve(entry.alias(), entry.connection());
    }

    private String revealed(SecretValue secret) {
        return new String(secret.reveal());
    }

    private SshCredential.Password passwordOf(CredentialLookup lookup) {
        assertThat(lookup).isInstanceOf(CredentialLookup.Resolved.class);
        assertThat(((CredentialLookup.Resolved) lookup).credential()).isInstanceOf(SshCredential.Password.class);
        return (SshCredential.Password) ((CredentialLookup.Resolved) lookup).credential();
    }

    private SshCredential.PrivateKey keyOf(CredentialLookup lookup) {
        assertThat(lookup).isInstanceOf(CredentialLookup.Resolved.class);
        assertThat(((CredentialLookup.Resolved) lookup).credential()).isInstanceOf(SshCredential.PrivateKey.class);
        return (SshCredential.PrivateKey) ((CredentialLookup.Resolved) lookup).credential();
    }

    private List<CredentialMiss> missesOf(CredentialLookup lookup) {
        assertThat(lookup).isInstanceOf(CredentialLookup.Missing.class);
        return ((CredentialLookup.Missing) lookup).misses();
    }

    @Test
    @DisplayName("VR-375: the prefix of the profile aws-local is SSH_MCP_AWS_LOCAL")
    void theCredentialPrefixIsTheUpperCaseName() {
        assertThat(CredentialPrefix.of("aws-local").value()).isEqualTo("SSH_MCP_AWS_LOCAL");
        assertThat(CredentialPrefix.of("aws-local").variable("PASSWORD")).isEqualTo("SSH_MCP_AWS_LOCAL_PASSWORD");
    }

    @ParameterizedTest(name = "VR-376: the name {0} gives the prefix {1}")
    @CsvSource({"a--b,SSH_MCP_A__B", "my.host_1,SSH_MCP_MY_HOST_1", "a b,SSH_MCP_A_B", "ß,SSH_MCP_SS"})
    @DisplayName("VR-376")
    void everyCharacterThatIsNotALetterOrDigitIsAnUnderscore(String name, String expected) {
        assertThat(CredentialPrefix.of(name).value()).isEqualTo(expected);
    }

    @Test
    @DisplayName("VR-377: the password variable of the profile wins over the global one")
    void theProfilePasswordWins() throws IOException {
        CredentialLookup lookup = resolve("aws-local", "auth = \"password\"", Map.of("SSH_MCP_AWS_LOCAL_PASSWORD", "p1", "SSH_MCP_PASSWORD", "p2"));

        assertThat(revealed(passwordOf(lookup).password())).isEqualTo("p1");
    }

    @Test
    @DisplayName("VR-378: the global password is used when the profile has none")
    void theGlobalPasswordIsTheFallback() throws IOException {
        assertThat(revealed(passwordOf(resolve("aws-local", "auth = \"password\"", Map.of("SSH_MCP_PASSWORD", "p2"))).password())).isEqualTo("p2");
    }

    @Test
    @DisplayName("VR-379: an empty variable of the profile is no variable, so the global password is used")
    void anEmptyVariableCountsAsNone() throws IOException {
        CredentialLookup lookup = resolve("aws-local", "auth = \"password\"", Map.of("SSH_MCP_AWS_LOCAL_PASSWORD", "", "SSH_MCP_PASSWORD", "p2"));

        assertThat(revealed(passwordOf(lookup).password())).isEqualTo("p2");
    }

    @Test
    @DisplayName("VR-380: the sudo password variables are not read (2.x never used them): they neither make a password nor take its place")
    void theSudoPasswordIsNotRead() throws IOException {
        Map<String, String> values = Map.of("SSH_MCP_AWS_LOCAL_SUDO_PASSWORD", "s1", "SSH_MCP_SUDO_PASSWORD", "s2");

        assertThat(missesOf(resolve("aws-local", "auth = \"password\"", values))).extracting(CredentialMiss::place).containsExactly("SSH_MCP_AWS_LOCAL_PASSWORD",
            "SSH_MCP_PASSWORD");
        assertThat(revealed(passwordOf(resolve("aws-local", "auth = \"password\"", Map.of("SSH_MCP_PASSWORD", "p", "SSH_MCP_SUDO_PASSWORD", "s2"))).password())).isEqualTo("p");
    }

    @Test
    @DisplayName("VR-381: the passphrase variable of the profile wins over the global one, and the global one is the fallback")
    void thePassphraseFollowsTheSameOrder() throws IOException {
        Path key = file("keys/id", "PRIVATE KEY TEXT\n");
        String keyRef = "auth = \"key\"\nkeyRef = " + literal(key);

        SshCredential.PrivateKey own = keyOf(resolve("aws-local", keyRef, Map.of("SSH_MCP_AWS_LOCAL_PASSPHRASE", "f1", "SSH_MCP_PASSPHRASE", "f2")));
        SshCredential.PrivateKey global = keyOf(resolve("aws-local", keyRef, Map.of("SSH_MCP_PASSPHRASE", "f2")));
        SshCredential.PrivateKey none = keyOf(resolve("aws-local", keyRef, Map.of()));

        assertThat(own.passphrase()).isEqualTo(Setting.given(SecretValue.of("f1")));
        assertThat(global.passphrase()).isEqualTo(Setting.given(SecretValue.of("f2")));
        assertThat(none.passphrase().isGiven()).isFalse();
    }

    @Test
    @DisplayName("VR-382, VR-383, VR-384: the key file is the keyRef of the profile, then SSH_MCP_<PROFILE>_KEY, then SSH_MCP_KEY")
    void theKeyFileComesFromThreePlaces() throws IOException {
        Path a = file("keys/a", "key a\n");
        Path b = file("keys/b", "key b\n");
        Path c = file("keys/c", "key c\n");
        Map<String, String> values = Map.of("SSH_MCP_AWS_LOCAL_KEY", b.toString(), "SSH_MCP_KEY", c.toString());

        assertThat(revealed(keyOf(resolve("aws-local", "auth = \"key\"\nkeyRef = " + literal(a), values)).pem())).isEqualTo("key a\n");
        assertThat(revealed(keyOf(resolve("aws-local", "auth = \"key\"", values)).pem())).isEqualTo("key b\n");
        assertThat(revealed(keyOf(resolve("aws-local", "auth = \"key\"", Map.of("SSH_MCP_KEY", c.toString()))).pem())).isEqualTo("key c\n");
    }

    @Test
    @DisplayName("VR-385: a leading ~ of the key path is the home folder")
    void aTildeIsTheHomeFolder() throws IOException {
        Path home = directory.resolve("home");
        file("home/.ssh/id", "home key\n");

        CredentialLookup lookup = resolve("aws-local", "auth = \"key\"\nkeyRef = '~/.ssh/id'", Map.of("HOME", home.toString()));

        assertThat(revealed(keyOf(lookup).pem())).isEqualTo("home key\n");
    }

    @Test
    @DisplayName("VR-386 (2.x와 다름: 2.x turned ~u/x into HOME + u/x and read a file of another name; a name with a user after the ~ is not a home path, so it is not expanded): the key is not found")
    void aTildeBeforeAUserNameIsNotExpanded() throws IOException {
        Path home = directory.resolve("h");
        file("hu/x", "the file 2.x would have read\n");

        CredentialLookup lookup = resolve("aws-local", "auth = \"key\"\nkeyRef = '~u/x'", Map.of("HOME", home.toString()));

        assertThat(missesOf(lookup)).extracting(CredentialMiss::place).singleElement().asString().contains("does not exist");
    }

    @Test
    @DisplayName("VR-387 (2.x와 다름: 2.x read a folder named ~ under the working directory; a path is never searched in the working directory by accident): ~/k with no home known is not expanded and is not found")
    void aTildeWithoutAHomeIsNotExpanded() throws IOException {
        CredentialLookup lookup = resolve("aws-local", "auth = \"key\"\nkeyRef = '~/k'", Map.of());

        assertThat(missesOf(lookup)).extracting(CredentialMiss::place).singleElement().asString().contains("does not exist");
    }

    @Test
    @DisplayName("VR-387 (2.x와 다름: 2.x had no home on Windows, where HOME is not set; user.home is the home folder of the account the product runs as): without HOME the user.home setting is the home folder")
    void theUserHomeIsTheFallbackHome() throws IOException {
        file("userhome/k", "fallback key\n");

        CredentialLookup lookup = resolve("aws-local", "auth = \"key\"\nkeyRef = '~/k'", Map.of("user.home", directory.resolve("userhome").toString()));

        assertThat(revealed(keyOf(lookup).pem())).isEqualTo("fallback key\n");
    }

    @Test
    @DisplayName("VR-388: a key file that does not exist is skipped by a profile that does not use a key, and the password is used")
    void aMissingKeyDoesNotStopAPasswordProfile() throws IOException {
        CredentialLookup lookup = resolve("aws-local", "auth = \"password\"\nkeyRef = " + literal(directory.resolve("no-such-key")), Map.of("SSH_MCP_PASSWORD", "p"));

        assertThat(revealed(passwordOf(lookup).password())).isEqualTo("p");
    }

    @Test
    @DisplayName("VR-388 (2.x와 다름: 2.x skipped a missing key file and went on with the other sources; a key profile with no key is a failure that names the file, not a silent fallback to a weaker method): a profile that uses a key and whose key file does not exist gets a miss that names the file")
    void aMissingKeyFileIsAMiss() throws IOException {
        Path missing = directory.resolve("no-such-key");

        CredentialLookup lookup = resolve("aws-local", "auth = \"key\"\nkeyRef = " + literal(missing), Map.of("SSH_MCP_PASSWORD", "p"));

        assertThat(missesOf(lookup)).singleElement().satisfies(miss -> {
            assertThat(miss.part()).isEqualTo(CredentialPart.PRIVATE_KEY);
            assertThat(miss.place()).contains(missing.toString()).contains("does not exist");
        });
    }

    @Test
    @DisplayName("VR-389 (2.x와 다름: 2.x threw the read error; the port answers with a result, not an exception, and the cause is logged): a key path that is a folder is not skipped: the lookup is a miss that says the file cannot be read")
    void aKeyPathThatIsAFolderIsNotSkipped() throws IOException {
        Path folder = Files.createDirectory(directory.resolve("a-folder"));

        CredentialLookup lookup = resolve("aws-local", "auth = \"key\"\nkeyRef = " + literal(folder), Map.of("SSH_MCP_PASSWORD", "p"));

        assertThat(missesOf(lookup)).singleElement().satisfies(miss -> assertThat(miss.place()).contains(folder.toString()).contains("cannot be read"));
    }

    @Test
    @DisplayName("VR-390: with cert = true the certificate is read from <key>-cert.pub")
    void theCertificateIsNamedAfterTheKey() throws IOException {
        Path key = file("keys/id", "the key\n");
        file("keys/id-cert.pub", "the certificate\n");

        SshCredential.PrivateKey credential = keyOf(resolve("aws-local", "auth = \"key\"\ncert = true\nkeyRef = " + literal(key), Map.of()));

        assertThat(revealed(credential.pem())).isEqualTo("the key\n");
        assertThat(credential.certificate()).isEqualTo(Setting.given("the certificate\n"));
    }

    @Test
    @DisplayName("VR-391: the .pub of a key path is dropped before -cert.pub is added")
    void aPubSuffixIsDropped() throws IOException {
        Path key = file("keys/id.pub", "the key\n");
        file("keys/id-cert.pub", "the certificate\n");

        SshCredential.PrivateKey credential = keyOf(resolve("aws-local", "auth = \"key\"\ncert = true\nkeyRef = " + literal(key), Map.of()));

        assertThat(credential.certificate()).isEqualTo(Setting.given("the certificate\n"));
    }

    @Test
    @DisplayName("VR-392: SSH_MCP_<PROFILE>_CERT names the certificate file")
    void theCertificateVariableWins() throws IOException {
        Path key = file("keys/id", "the key\n");
        Path certificate = file("elsewhere/x", "another certificate\n");

        SshCredential.PrivateKey credential = keyOf(resolve("aws-local", "auth = \"key\"\ncert = true\nkeyRef = " + literal(key),
            Map.of("SSH_MCP_AWS_LOCAL_CERT", certificate.toString())));

        assertThat(credential.certificate()).isEqualTo(Setting.given("another certificate\n"));
    }

    @Test
    @DisplayName("VR-393: a certificate file that does not exist is skipped, and a profile with cert = false never reads one")
    void aMissingCertificateIsSkipped() throws IOException {
        Path key = file("keys/id", "the key\n");

        assertThat(keyOf(resolve("aws-local", "auth = \"key\"\ncert = true\nkeyRef = " + literal(key), Map.of())).certificate().isGiven()).isFalse();
        file("keys/id-cert.pub", "the certificate\n");
        assertThat(keyOf(resolve("aws-local", "auth = \"key\"\nkeyRef = " + literal(key), Map.of())).certificate().isGiven()).isFalse();
    }

    @Test
    @DisplayName("VR-394: an agent profile gets the agent when SSH_AUTH_SOCK is set")
    void anAgentProfileGetsTheAgent() throws IOException {
        CredentialLookup lookup = resolve("aws-local", "auth = \"agent\"", Map.of("SSH_AUTH_SOCK", "/run/agent.sock"));

        assertThat(lookup).isEqualTo(new CredentialLookup.Resolved(new SshCredential.Agent()));
    }

    @Test
    @DisplayName("VR-395: a key profile does not use the agent")
    void aKeyProfileDoesNotUseTheAgent() throws IOException {
        Path key = file("keys/id", "the key\n");

        CredentialLookup lookup = resolve("aws-local", "auth = \"key\"\nkeyRef = " + literal(key), Map.of("SSH_AUTH_SOCK", "/run/agent.sock"));

        assertThat(keyOf(lookup).pem()).isNotNull();
    }

    @Test
    @DisplayName("VR-396, VR-397 (2.x와 다름: 2.x asked the system keychain; 3.0 has no keychain access, decision D3-09, and says so with Unsupported instead of falling back to another source): a keychain profile is unsupported, whatever its entry says")
    void aKeychainProfileIsUnsupported() throws IOException {
        assertThat(resolve("aws-local", "auth = \"keychain\"\nkeychainEntry = \"svc/acct\"\nkeyRef = " + literal(file("keys/id", "k\n")), Map.of("SSH_MCP_PASSWORD", "p")))
            .isEqualTo(new CredentialLookup.Unsupported(AuthMethod.KEYCHAIN));
        assertThat(resolve("aws-local", "auth = \"keychain\"\nkeychainEntry = \"/\"", Map.of())).isEqualTo(new CredentialLookup.Unsupported(AuthMethod.KEYCHAIN));
    }

    @Test
    @DisplayName("VR-398 (2.x와 다름: 2.x collected every source whatever the method; the credential type has one variant per method, so a profile gets what its method uses and nothing weaker is offered): a password profile gets the password only")
    void aPasswordProfileGetsThePasswordOnly() throws IOException {
        Path key = file("keys/id", "the key\n");

        CredentialLookup lookup = resolve("aws-local", "auth = \"password\"\nkeyRef = " + literal(key), Map.of("SSH_MCP_PASSWORD", "p"));

        assertThat(revealed(passwordOf(lookup).password())).isEqualTo("p");
    }

    @Test
    @DisplayName("VR-399 (2.x와 다름: 2.x threw a sentence; the port answers with the misses, each naming a variable, and the caller words the error): a password profile with no password variable gets a miss that names both variables")
    void aMissingPasswordNamesBothVariables() throws IOException {
        CredentialLookup lookup = resolve("aws-local", "auth = \"password\"", Map.of());

        assertThat(missesOf(lookup)).containsExactly(new CredentialMiss(CredentialPart.PASSWORD, "SSH_MCP_AWS_LOCAL_PASSWORD"),
            new CredentialMiss(CredentialPart.PASSWORD, "SSH_MCP_PASSWORD"));
    }

    @Test
    @DisplayName("VR-400 (2.x와 다름: 2.x fell back to a password in the environment when there was no agent; an agent profile with no agent is a miss, not a fallback to a weaker method): an agent profile without SSH_AUTH_SOCK gets a miss that names SSH_AUTH_SOCK")
    void aMissingAgentNamesTheSocketVariable() throws IOException {
        assertThat(missesOf(resolve("aws-local", "auth = \"agent\"", Map.of("SSH_MCP_PASSWORD", "p")))).containsExactly(new CredentialMiss(CredentialPart.PRIVATE_KEY, "SSH_AUTH_SOCK"));
    }

    @Test
    @DisplayName("VR-400: a key profile that names no key anywhere gets a miss for each place that was searched")
    void aKeyProfileWithoutAKeyNamesThePlaces() throws IOException {
        assertThat(missesOf(resolve("aws-local", "auth = \"key\"", Map.of()))).extracting(CredentialMiss::place).containsExactly("keyRef of the profile", "SSH_MCP_AWS_LOCAL_KEY",
            "SSH_MCP_KEY");
    }

    @Test
    @DisplayName("VR-401: SSH_MCP_TEST and SSH_MCP_DISABLE_MAIN are switches of the vendor program and mean nothing here")
    void theVendorSwitchesMeanNothing() throws IOException {
        CredentialLookup lookup = resolve("aws-local", "auth = \"password\"", Map.of("SSH_MCP_TEST", "1", "SSH_MCP_DISABLE_MAIN", "1"));

        assertThat(missesOf(lookup)).hasSize(2);
    }

    @Test
    @DisplayName("EV-02, D3-09: no secret is in the text of a credential, of a lookup or of a miss")
    void noSecretIsInAnyText() throws IOException {
        Path key = file("keys/id", "TOP SECRET KEY TEXT\n");

        CredentialLookup password = resolve("aws-local", "auth = \"password\"", Map.of("SSH_MCP_PASSWORD", "hunter2"));
        CredentialLookup privateKey = resolve("aws-local", "auth = \"key\"\nkeyRef = " + literal(key), Map.of("SSH_MCP_PASSPHRASE", "open sesame"));
        CredentialLookup missing = resolve("aws-local", "auth = \"key\"\nkeyRef = " + literal(directory.resolve("none")), Map.of("SSH_MCP_PASSWORD", "hunter2"));

        assertThat(password.toString()).doesNotContain("hunter2");
        assertThat(privateKey.toString()).doesNotContain("TOP SECRET").doesNotContain("open sesame");
        assertThat(missing.toString()).doesNotContain("hunter2");
    }
}
