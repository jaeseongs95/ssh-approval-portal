package io.github.jaeseongs95.portal.domain.target;

import java.util.Objects;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * The name of a secret in a secret store, never the secret itself: {@code secret://provider/name}. The provider is a lowercase letter and up to 31 of {@code a-z 0-9 -};
 * the name starts with a letter or digit and has up to 63 more of {@code A-Z a-z 0-9 _ . -} (2.x secret-service.mjs:6-9). A configuration refers to credentials by this
 * text and the application layer resolves it.
 */
public record SecretReference(String provider, String name) {

    private static final Pattern SHAPE = Pattern.compile("secret://([a-z][a-z0-9-]{0,31})/([A-Za-z0-9][A-Za-z0-9_.-]{0,63})");
    private static final Pattern PROVIDER = Pattern.compile("[a-z][a-z0-9-]{0,31}");
    private static final Pattern NAME = Pattern.compile("[A-Za-z0-9][A-Za-z0-9_.-]{0,63}");

    public SecretReference {
        Objects.requireNonNull(provider, "provider");
        Objects.requireNonNull(name, "name");
        if (!PROVIDER.matcher(provider).matches() || !NAME.matcher(name).matches()) {
            throw new IllegalArgumentException("Invalid secret reference");
        }
    }

    /** Reads {@code secret://provider/name}. */
    public static SecretReference parse(String text) {
        Objects.requireNonNull(text, "text");
        Matcher matcher = SHAPE.matcher(text);
        if (!matcher.matches()) {
            throw new IllegalArgumentException("Invalid secret reference");
        }
        return new SecretReference(matcher.group(1), matcher.group(2));
    }

    /** The reference as written. */
    public String text() {
        return "secret://" + provider + "/" + name;
    }
}
