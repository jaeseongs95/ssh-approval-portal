package io.github.jaeseongs95.portal.domain.desktop;

import java.util.Objects;
import java.util.regex.Pattern;

/**
 * The name a host adapter gives the verified desktop session: 1 to 256 characters of {@code A-Z a-z 0-9 _ . : -}, or none (2.x desktop-state.mjs:17). The whole
 * text must match, so a final line feed does not pass.
 */
public sealed interface DesktopSessionRef {

    boolean isPresent();

    /** No session reference. */
    record NoSessionRef() implements DesktopSessionRef {

        @Override
        public boolean isPresent() {
            return false;
        }
    }

    /** A session reference. */
    record SessionRefName(String value) implements DesktopSessionRef {

        private static final Pattern SHAPE = Pattern.compile("[A-Za-z0-9_.:-]{1,256}");

        public SessionRefName {
            Objects.requireNonNull(value, "value");
            if (!SHAPE.matcher(value).matches()) {
                throw new IllegalArgumentException("A desktop session reference is 1 to 256 characters of A-Z a-z 0-9 _ . : -");
            }
        }

        @Override
        public boolean isPresent() {
            return true;
        }
    }
}
