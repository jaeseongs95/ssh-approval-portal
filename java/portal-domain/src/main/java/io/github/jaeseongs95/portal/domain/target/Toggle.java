package io.github.jaeseongs95.portal.domain.target;

import com.fasterxml.jackson.annotation.JsonCreator;
import com.fasterxml.jackson.annotation.JsonValue;

/**
 * A setting that is either on or off. It stands where 2.x used a boolean, so the domain and the database column share one two-valued type (the column holds the
 * enum name, Principles 4.2). On the wire (the administrator API and the policy document) it is a JSON boolean.
 */
public enum Toggle {
    ON, OFF;

    /** The setting for a boolean; also how a JSON boolean is read. */
    @JsonCreator(mode = JsonCreator.Mode.DELEGATING)
    public static Toggle of(boolean enabled) {
        return enabled ? ON : OFF;
    }

    public boolean isOn() {
        return this == ON;
    }

    /** The JSON boolean 2.x wrote. */
    @JsonValue
    public boolean wire() {
        return isOn();
    }
}
