package io.github.jaeseongs95.portal.domain.target;

import io.github.jaeseongs95.portal.domain.id.CanonicalForm;
import java.util.Objects;
import java.util.function.Function;

/**
 * A configuration value the administrator may leave out: not set, or given. It is the sealed form of "nothing" for the values of a target and of its connection
 * profile (a Windows working directory, a pinned host key, a capacity that overrides the default); no record component is ever null and none is an
 * {@link java.util.Optional}. The meaning of "not set" belongs to the type that holds the setting (an unset capacity inherits the default).
 */
public sealed interface Setting<T> permits Setting.Unset, Setting.Given {

    /** The setting that was left out. */
    static <T> Setting<T> unset() {
        return new Unset<>();
    }

    /** The setting that was given; the value is not null. */
    static <T> Setting<T> given(T value) {
        return new Given<>(value);
    }

    boolean isGiven();

    /** The value when the setting was given, the fallback when it was not. */
    T orElse(T fallback);

    /** Writes the setting into a canonical form: the text of the value, or a marker for none. */
    CanonicalForm describeTo(CanonicalForm form, String name, Function<? super T, String> text);

    /** The setting was left out. */
    record Unset<T>() implements Setting<T> {

        @Override
        public boolean isGiven() {
            return false;
        }

        @Override
        public T orElse(T fallback) {
            return fallback;
        }

        @Override
        public CanonicalForm describeTo(CanonicalForm form, String name, Function<? super T, String> text) {
            return form.absent(name);
        }
    }

    /** The setting was given. */
    record Given<T>(T value) implements Setting<T> {

        public Given {
            Objects.requireNonNull(value, "value");
        }

        @Override
        public boolean isGiven() {
            return true;
        }

        @Override
        public T orElse(T fallback) {
            return value;
        }

        @Override
        public CanonicalForm describeTo(CanonicalForm form, String name, Function<? super T, String> text) {
            return form.field(name, text.apply(value));
        }
    }
}
