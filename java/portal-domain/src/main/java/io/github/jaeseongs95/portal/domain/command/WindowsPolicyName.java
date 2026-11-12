package io.github.jaeseongs95.portal.domain.command;

import com.fasterxml.jackson.annotation.JsonValue;
import io.github.jaeseongs95.portal.domain.text.Utf8Text;
import java.util.Locale;
import java.util.Objects;
import java.util.Optional;
import java.util.regex.Pattern;

/**
 * A command name on a Windows PowerShell 5.1 target: a module-qualified cmdlet ({@code Microsoft.PowerShell.Utility\Get-Date}), an executable file name with an
 * extension ({@code .exe .com .cmd .bat}) or an absolute path to one (also {@code .ps1}). A bare name without an extension is refused because it may be an alias or
 * a function that only a full evaluation can resolve. Names are compared case-insensitively and an absolute path with {@code /} equals the one with {@code \}
 * (2.x windows-command-line.mjs:11-19 {@code windowsPolicyName}); {@link #key()} is that normal form.
 */
public record WindowsPolicyName(@JsonValue String text) implements PolicyName {

    private static final int MAX_BYTES = 512;
    private static final Pattern MODULE_COMMAND = Pattern.compile("[a-z0-9_][a-z0-9_.-]*\\\\[a-z][a-z0-9]*-[a-z][a-z0-9]*", Pattern.CASE_INSENSITIVE);
    private static final Pattern EXECUTABLE = Pattern.compile("[a-z0-9_][a-z0-9_.+-]*\\.(?:exe|com|cmd|bat)", Pattern.CASE_INSENSITIVE);
    private static final Pattern ABSOLUTE_EXECUTABLE = Pattern.compile("[a-z]:[\\\\/].+\\.(?:exe|com|cmd|bat|ps1)", Pattern.CASE_INSENSITIVE);
    /** PowerShell reads curved quotes as string delimiters, mixed with ASCII ones. The text is not normalised; a name that has one goes to a full evaluation. */
    private static final Pattern CURVED_QUOTE = Pattern.compile("[\\u2018\\u2019\\u201c\\u201d]");
    private static final Pattern FORBIDDEN_IN_PATH = Pattern.compile("[<>\"|?*`$]");
    private static final Pattern PATH_SEPARATOR = Pattern.compile("[\\\\/]");

    public WindowsPolicyName {
        Objects.requireNonNull(text, "text");
        if (normalForm(text).isEmpty()) {
            throw new IllegalArgumentException("Not a Windows policy name: a module-qualified cmdlet, an executable file name or an absolute executable path");
        }
    }

    /** The answer of {@link CommandLineGrammar#normalize(String)} for a Windows target: the name, or a refusal for text that is not a policy name. */
    public static NormalizedName parse(String proposed) {
        Objects.requireNonNull(proposed, "proposed");
        return normalForm(proposed).isPresent() ? new NormalizedName.Accepted(new WindowsPolicyName(proposed)) : new NormalizedName.Rejected();
    }

    @Override
    public String key() {
        return normalForm(text).orElseThrow();
    }

    private static Optional<String> normalForm(String value) {
        if (!Utf8Text.isWellFormed(value)) {
            return Optional.empty();
        }
        Utf8Text candidate = new Utf8Text(value);
        if (candidate.byteLength() > MAX_BYTES || candidate.hasOuterWhitespace() || CURVED_QUOTE.matcher(value).find() || candidate.hasHiddenCharacters()) {
            return Optional.empty();
        }
        if (MODULE_COMMAND.matcher(value).matches() || EXECUTABLE.matcher(value).matches()) {
            return Optional.of(value.toLowerCase(Locale.ROOT));
        }
        if (!ABSOLUTE_EXECUTABLE.matcher(value).matches() || FORBIDDEN_IN_PATH.matcher(value).find() || value.substring(2).indexOf(':') >= 0) {
            return Optional.empty();
        }
        String[] parts = PATH_SEPARATOR.split(value, -1);
        for (int index = 1; index < parts.length; index++) {
            String part = parts[index];
            if (part.isEmpty() || ".".equals(part) || "..".equals(part) || part.endsWith(".") || part.endsWith(" ")) {
                return Optional.empty();
            }
        }
        return Optional.of(value.replace('/', '\\').toLowerCase(Locale.ROOT));
    }
}
