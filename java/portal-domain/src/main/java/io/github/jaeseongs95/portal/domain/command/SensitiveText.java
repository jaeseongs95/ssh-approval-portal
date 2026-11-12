package io.github.jaeseongs95.portal.domain.command;

import java.util.Objects;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * Text that is judged for secrets before it is shown to anyone else (a model evaluator, a log): it may hold credential material, or it may name a place where
 * secrets live. These are the two rules of 2.x (execution-context.mjs:8-22); they are the product's own and do not depend on the output redactor.
 *
 * <ul>
 *   <li>Credential material: a private key header, a bearer token, or a {@code password}, {@code secret}, {@code token} or {@code api key} assignment. The
 *       normalised reference {@code secret://provider/name} is a public identifier, not a secret, and does not count (a reference followed by a literal
 *       credential does).</li>
 *   <li>A sensitive place: {@code /etc/shadow}, {@code .ssh/id_*}, a {@code secrets} folder, a {@code .env} file. A caller may <em>mention</em> such a place in
 *       a description; a command that reads it still goes to the owner.</li>
 * </ul>
 */
public record SensitiveText(String value) {

    private static final String SPACE = "[\\s\\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff]";
    private static final Pattern CREDENTIAL_MATERIAL = Pattern.compile("-----BEGIN|\\bBearer" + SPACE + "|(?:api[_-]?key|password|secret|token)" + SPACE + "*[=:]",
        Pattern.CASE_INSENSITIVE);
    /** The normalised secret reference, ending at the end of the text or at a character that cannot be part of the name (execution-context.mjs:13). */
    private static final Pattern SECRET_REFERENCE = Pattern.compile("secret://[a-z][a-z0-9-]{0,31}/[A-Za-z0-9][A-Za-z0-9_.-]{0,63}(?=$|[\\s\"'`,;)\\]}])");
    private static final Pattern NAME_CHARACTER = Pattern.compile("[A-Za-z0-9_./:-]");
    private static final Pattern SENSITIVE_PLACE = Pattern.compile("/etc/shadow|\\.ssh/id_|/secrets(?:/|\\b)|\\.env(?:\\b|/)", Pattern.CASE_INSENSITIVE);

    public SensitiveText {
        Objects.requireNonNull(value, "value");
    }

    /** True when the text holds credential material. A well-formed secret reference alone is not credential material. */
    public boolean containsCredential() {
        Matcher match = CREDENTIAL_MATERIAL.matcher(value);
        while (match.find()) {
            if (isReferencePrefix(match)) {
                continue;
            }
            return true;
        }
        return false;
    }

    /** True when the text holds credential material or names a place where secrets live. */
    public boolean isSensitive() {
        return containsCredential() || SENSITIVE_PLACE.matcher(value).find();
    }

    /** A match of exactly {@code secret:} that starts a name-free position and continues as a well-formed reference is the reference scheme, not an assignment. */
    private boolean isReferencePrefix(Matcher match) {
        if (!"secret:".equals(match.group())) {
            return false;
        }
        int start = match.start();
        if (start > 0 && NAME_CHARACTER.matcher(value.substring(start - 1, start)).matches()) {
            return false;
        }
        return SECRET_REFERENCE.matcher(value).region(start, value.length()).lookingAt();
    }
}
