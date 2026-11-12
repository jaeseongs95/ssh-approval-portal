package io.github.jaeseongs95.portal.domain.target;

import com.fasterxml.jackson.annotation.JsonValue;
import java.util.Locale;

/** The operating system family of a target, chosen by the administrator (2.x target-platform.mjs:6). The wire values are {@code linux} and {@code windows}. */
public enum TargetOs {
    LINUX, WINDOWS;

    @JsonValue
    public String wire() {
        return name().toLowerCase(Locale.ROOT);
    }
}
