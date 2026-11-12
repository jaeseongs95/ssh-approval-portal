package io.github.jaeseongs95.portal.ssh.profile;

import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Objects;
import java.util.Set;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

import io.github.jaeseongs95.portal.app.remote.SecretValue;

/**
 * Reads the text of a secret environment file, the file that 2.x named by {@code BRIDGE_SECRET_ENV_FILE} (src/adapters/config/secrets.mjs:5-17, vendor {@code SSH_MCP_*}
 * rules of EV 4.2). A line is {@code NAME=value}; blank lines and lines that start with {@code #} are skipped; the name is {@code [A-Z_][A-Z0-9_]*} and is either one of
 * the allowed names or {@code SSH_MCP_} followed by {@code [A-Z0-9_]+}; the value is stripped, and one pair of matching quotes around it is removed. An entry that does not
 * fit, or a value with a NUL character, makes the whole file unusable ({@link ProfileConfigException.Code#SECRET_FILE_ENTRY}). An entry with an empty value is left out,
 * because an empty variable counts as no variable (EV-02). The values are {@link SecretValue}s and the exceptions name the line, never the line's text.
 *
 * <p>Why a reader of our own (Principles 2.1, 2.2 category 13): the format is the one of 2.x and has no standard parser. {@code java.util.Properties.load} would take
 * {@code :} and blanks as separators and read backslash escapes and line continuations, which changes secrets that contain a backslash, and Spring Boot reads no such file
 * on its own. The official documents were not opened again for this decision (unconfirmed, see the report). The reader takes lines with {@link String#lines()}.
 *
 * <p>Which settings besides {@code SSH_MCP_*} a file may carry is stage 4's ({@code BRIDGE_*} secrets); the names come in as an argument.
 */
public final class SecretEnvFile {

    private static final Pattern LINE = Pattern.compile("([A-Z_][A-Z0-9_]*)=(.*)");
    private static final Pattern SSH_MCP_NAME = Pattern.compile("SSH_MCP_[A-Z0-9_]+");

    private final Set<String> allowedNames;

    /** A reader that accepts the names of {@code allowedNames} besides every {@code SSH_MCP_*} name. */
    public SecretEnvFile(Set<String> allowedNames) {
        this.allowedNames = Set.copyOf(allowedNames);
    }

    /**
     * The entries of the text, in the order of the text; a name that appears twice has its last value.
     *
     * @throws ProfileConfigException for an entry that is not allowed or not in the form {@code NAME=value}, or a value with a NUL character
     */
    public Map<String, SecretValue> parse(String text) {
        Objects.requireNonNull(text, "text");
        Map<String, SecretValue> entries = new LinkedHashMap<>();
        List<String> lines = text.lines().toList();
        for (int i = 0; i < lines.size(); i++) {
            String line = lines.get(i);
            if (line.isBlank() || line.stripLeading().startsWith("#")) {
                continue;
            }
            Matcher match = LINE.matcher(line);
            if (!match.matches() || !allowedNames.contains(match.group(1)) && !SSH_MCP_NAME.matcher(match.group(1)).matches()) {
                throw new ProfileConfigException(ProfileConfigException.Code.SECRET_FILE_ENTRY, "Unsupported secret configuration entry (line " + (i + 1) + ")");
            }
            String value = unquoted(match.group(2).strip());
            if (value.indexOf('\0') >= 0) {
                throw new ProfileConfigException(ProfileConfigException.Code.SECRET_FILE_ENTRY, "Invalid secret configuration value (line " + (i + 1) + ")");
            }
            if (value.isEmpty()) {
                entries.remove(match.group(1));
            } else {
                entries.put(match.group(1), SecretValue.of(value));
            }
        }
        return entries;
    }

    private String unquoted(String value) {
        if (value.length() >= 2 && (value.charAt(0) == '"' || value.charAt(0) == '\'') && value.charAt(value.length() - 1) == value.charAt(0)) {
            return value.substring(1, value.length() - 1);
        }
        return value;
    }
}
