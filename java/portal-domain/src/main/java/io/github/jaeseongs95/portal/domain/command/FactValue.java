package io.github.jaeseongs95.portal.domain.command;

import java.util.Objects;

/** The value of a server fact: text of at most 2048 characters, a finite number, a flag, or the explicit absence of a value (execution-context.mjs:52-55). */
public sealed interface FactValue permits FactValue.Text, FactValue.Count, FactValue.Flag, FactValue.Absent {

    /** The longest text a fact may hold, in UTF-16 characters. */
    int MAX_TEXT_CHARS = 2048;

    record Text(String value) implements FactValue {
        public Text {
            Objects.requireNonNull(value, "value");
            if (value.length() > MAX_TEXT_CHARS) {
                throw new IllegalArgumentException("A server fact text is at most " + MAX_TEXT_CHARS + " characters");
            }
        }
    }

    record Count(double value) implements FactValue {
        public Count {
            if (!Double.isFinite(value)) {
                throw new IllegalArgumentException("A server fact number is finite");
            }
        }
    }

    record Flag(boolean value) implements FactValue {
    }

    /** The fact is known to be without a value (JSON {@code null}); a fact that is not stated at all is not in {@link ServerFacts}. */
    record Absent() implements FactValue {
    }
}
