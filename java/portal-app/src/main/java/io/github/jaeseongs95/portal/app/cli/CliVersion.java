package io.github.jaeseongs95.portal.app.cli;

import java.util.Objects;
import java.util.regex.Pattern;

/** The version of an installed agent CLI: three numbers without a leading zero, each at most 6 digits (2.x {@code agent-cli-state.mjs:55}). */
public record CliVersion(String value) {

    private static final Pattern FORMAT = Pattern.compile("(0|[1-9][0-9]{0,5})\\.(0|[1-9][0-9]{0,5})\\.(0|[1-9][0-9]{0,5})");

    public CliVersion {
        Objects.requireNonNull(value, "value");
        if (!FORMAT.matcher(value).matches()) {
            throw new IllegalArgumentException("Not a CLI version: " + value);
        }
    }
}
