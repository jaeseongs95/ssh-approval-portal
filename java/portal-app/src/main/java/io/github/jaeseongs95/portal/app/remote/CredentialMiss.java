package io.github.jaeseongs95.portal.app.remote;

import java.util.Objects;

/**
 * One place a source looked for a part of a credential and did not find it. It names the place (for example the name of a setting), never a value.
 *
 * @param part what was looked for
 * @param place where, as a non-blank name
 */
public record CredentialMiss(CredentialPart part, String place) {

    public CredentialMiss {
        Objects.requireNonNull(part, "part");
        Objects.requireNonNull(place, "place");
        if (place.isBlank()) {
            throw new IllegalArgumentException("A place is not blank");
        }
    }
}
