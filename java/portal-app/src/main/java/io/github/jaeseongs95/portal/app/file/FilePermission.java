package io.github.jaeseongs95.portal.app.file;

import java.util.Objects;

import io.github.jaeseongs95.portal.app.remote.FileMode;

/**
 * Whether the request asked for permission bits. The platform's default publication (a Linux file is written with the owner's rights only, 2.x {@code file-helper.py:126})
 * needs no request and is skipped on a target that cannot set bits; an explicit mode on such a target is refused with {@code TARGET_CAPABILITY_UNSUPPORTED} and never
 * ignored silently (design 4.6).
 */
public sealed interface FilePermission permits FilePermission.PlatformDefault, FilePermission.Explicit {

    /** The request named no mode. */
    record PlatformDefault() implements FilePermission {
    }

    /** The request named the mode the published file must have. */
    record Explicit(FileMode mode) implements FilePermission {

        public Explicit {
            Objects.requireNonNull(mode, "mode");
        }
    }
}
