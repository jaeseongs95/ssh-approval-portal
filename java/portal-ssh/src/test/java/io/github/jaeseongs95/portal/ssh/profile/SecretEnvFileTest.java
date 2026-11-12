package io.github.jaeseongs95.portal.ssh.profile;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import java.util.HashMap;
import java.util.Map;
import java.util.Set;

import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.springframework.core.env.MapPropertySource;
import org.springframework.core.env.StandardEnvironment;

import io.github.jaeseongs95.portal.app.remote.SecretValue;

/**
 * The secret environment file that 2.x named by {@code BRIDGE_SECRET_ENV_FILE} and the way its {@code SSH_MCP_*} entries reach the credential source (vendor rules EV 4.2,
 * cases VR-404 to VR-408 of vendor-ssh-mcp-rules.md, section 4.3). The expectations were traced from 2.x src/adapters/config/secrets.mjs and src/adapters/ssh/vendor.mjs:177.
 */
class SecretEnvFileTest {

    private final SecretEnvFile reader = new SecretEnvFile(Set.of("BRIDGE_ADMIN_TOKEN"));

    private String revealed(SecretValue secret) {
        return new String(secret.reveal());
    }

    @Test
    @DisplayName("VR-404: an SSH_MCP_ line is an entry of the environment, and the value of the file wins over the variable of the process")
    void aFileEntryWinsOverTheProcessEnvironment() {
        Map<String, SecretValue> entries = reader.parse("# comment\n\nSSH_MCP_AWS_LOCAL_PASSPHRASE=synthetic\n");
        StandardEnvironment environment = new StandardEnvironment();
        environment.getPropertySources().remove(StandardEnvironment.SYSTEM_PROPERTIES_PROPERTY_SOURCE_NAME);
        environment.getPropertySources().remove(StandardEnvironment.SYSTEM_ENVIRONMENT_PROPERTY_SOURCE_NAME);
        environment.getPropertySources().addFirst(new MapPropertySource("process", Map.of("SSH_MCP_AWS_LOCAL_PASSPHRASE", "from the process")));
        environment.getPropertySources().addFirst(new SecretEnvPropertySource("secret file", entries));

        assertThat(revealed(entries.get("SSH_MCP_AWS_LOCAL_PASSPHRASE"))).isEqualTo("synthetic");
        assertThat(environment.getProperty("SSH_MCP_AWS_LOCAL_PASSPHRASE")).isEqualTo("synthetic");
    }

    @Test
    @DisplayName("VR-405: SSH_MCP_lower and SSH_FOO are not supported entries, and the error names the line and not its text")
    void aNameThatIsNotAllowedIsRefused() {
        assertThatThrownBy(() -> reader.parse("SSH_MCP_lower=secret-text")).isInstanceOf(ProfileConfigException.class)
            .hasMessage("Unsupported secret configuration entry (line 1)");
        assertThatThrownBy(() -> reader.parse("SSH_MCP_A=1\nSSH_FOO=secret-text")).isInstanceOf(ProfileConfigException.class)
            .hasMessage("Unsupported secret configuration entry (line 2)");
        assertThatThrownBy(() -> reader.parse("not an assignment")).isInstanceOf(ProfileConfigException.class).hasMessageContaining("Unsupported secret configuration entry");
    }

    @Test
    @DisplayName("VR-405: a name that the installation allows besides SSH_MCP_* is accepted")
    void anAllowedNameIsAccepted() {
        assertThat(reader.parse("BRIDGE_ADMIN_TOKEN=token\n")).containsOnlyKeys("BRIDGE_ADMIN_TOKEN");
    }

    @Test
    @DisplayName("VR-406: one pair of quotes around a value is removed, and a pair that does not match stays")
    void aPairOfQuotesIsRemoved() {
        Map<String, SecretValue> entries = reader.parse("SSH_MCP_FIXTURE2_KEY=\"private-value\"\nSSH_MCP_B='single'\nSSH_MCP_C=\"unmatched'\nSSH_MCP_D=  spaced  \n");

        assertThat(revealed(entries.get("SSH_MCP_FIXTURE2_KEY"))).isEqualTo("private-value");
        assertThat(revealed(entries.get("SSH_MCP_B"))).isEqualTo("single");
        assertThat(revealed(entries.get("SSH_MCP_C"))).isEqualTo("\"unmatched'");
        assertThat(revealed(entries.get("SSH_MCP_D"))).isEqualTo("spaced");
    }

    @Test
    @DisplayName("VR-407: a value with a NUL character makes the file unusable")
    void aNulCharacterIsRefused() {
        assertThatThrownBy(() -> reader.parse("SSH_MCP_A=ab\0cd")).isInstanceOf(ProfileConfigException.class).hasMessage("Invalid secret configuration value (line 1)");
    }

    @Test
    @DisplayName("VR-408: only the names that start with SSH_MCP_ in capitals are copied to the environment")
    void onlySshMcpNamesAreCopied() {
        Map<String, SecretValue> entries = new HashMap<>();
        entries.put("SSH_MCP_X", SecretValue.of("1"));
        entries.put("ssh_mcp_y", SecretValue.of("2"));
        entries.put("OTHER", SecretValue.of("3"));

        SecretEnvPropertySource source = new SecretEnvPropertySource("secret file", entries);

        assertThat(source.getProperty("SSH_MCP_X")).isEqualTo("1");
        assertThat(source.getProperty("ssh_mcp_y")).isNull();
        assertThat(source.getProperty("OTHER")).isNull();
    }

    @Test
    @DisplayName("EV-02, D3-09: an empty value is no entry, and the text of the entries and of the property source holds no secret")
    void noSecretIsInTheText() {
        Map<String, SecretValue> entries = reader.parse("SSH_MCP_A=correct horse\nSSH_MCP_EMPTY=\n");

        assertThat(entries).containsOnlyKeys("SSH_MCP_A");
        assertThat(entries.toString()).doesNotContain("correct horse");
        assertThat(new SecretEnvPropertySource("secret file", entries).toString()).doesNotContain("correct horse");
    }
}
