package io.github.jaeseongs95.portal.domain.desktop;

import java.util.Objects;
import java.util.regex.Pattern;

/**
 * A generation mark of a desktop resource: 64 lowercase hex characters, or none (2.x desktop-state.mjs:15, 18). A missing mark is its own variant, not a null
 * and not an {@code Optional}, so a status always says plainly whether it has one.
 */
public sealed interface DesktopGeneration {

    boolean isPresent();

    /** No generation mark. */
    record NoGeneration() implements DesktopGeneration {

        @Override
        public boolean isPresent() {
            return false;
        }
    }

    /** A generation mark of 64 lowercase hex characters. */
    record GenerationHex(String hex) implements DesktopGeneration {

        private static final Pattern SHAPE = Pattern.compile("[a-f0-9]{64}");

        public GenerationHex {
            Objects.requireNonNull(hex, "hex");
            if (!SHAPE.matcher(hex).matches()) {
                throw new IllegalArgumentException("A desktop generation is 64 lowercase hex characters");
            }
        }

        @Override
        public boolean isPresent() {
            return true;
        }
    }
}
