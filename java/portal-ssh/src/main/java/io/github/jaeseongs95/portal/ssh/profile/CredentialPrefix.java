package io.github.jaeseongs95.portal.ssh.profile;

import java.util.Locale;
import java.util.Objects;

/**
 * The prefix of the environment variables of one profile: {@code SSH_MCP_}, then the profile name in upper case with every character that is not {@code A-Z} or
 * {@code 0-9} replaced by {@code _} (2.x EV-01, vendor config/credential-resolver.js:34). {@code aws-local} gives {@code SSH_MCP_AWS_LOCAL}. Runs of replaced characters
 * are not merged, so two different names can give one prefix ({@code a-b} and {@code a_b}); the loader refuses such a configuration.
 *
 * @param value the prefix, for example {@code SSH_MCP_AWS_LOCAL}
 */
public record CredentialPrefix(String value) {

    private static final String START = "SSH_MCP_";

    public CredentialPrefix {
        Objects.requireNonNull(value, "value");
    }

    /** The prefix of a profile name. The name is made upper case without a locale (the one of the machine would make {@code i} a dotted capital in Turkish). */
    public static CredentialPrefix of(String profileName) {
        Objects.requireNonNull(profileName, "profileName");
        String upper = profileName.toUpperCase(Locale.ROOT);
        StringBuilder prefix = new StringBuilder(START);
        for (int i = 0; i < upper.length(); i++) {
            char c = upper.charAt(i);
            prefix.append(c >= 'A' && c <= 'Z' || c >= '0' && c <= '9' ? c : '_');
        }
        return new CredentialPrefix(prefix.toString());
    }

    /** The name of the variable for a part of the credential of this profile, for example {@code SSH_MCP_AWS_LOCAL_PASSWORD}. */
    public String variable(String suffix) {
        return value + "_" + suffix;
    }
}
