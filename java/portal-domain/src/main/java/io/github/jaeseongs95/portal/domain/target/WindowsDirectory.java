package io.github.jaeseongs95.portal.domain.target;

import io.github.jaeseongs95.portal.domain.path.WindowsRemotePath;
import io.github.jaeseongs95.portal.domain.text.Utf8Text;
import java.util.Objects;
import java.util.regex.Pattern;

/**
 * An absolute directory or file location on a Windows target that the administrator configures: a drive root ({@code C:\} or {@code C:/}), or a path that is valid as
 * a {@link WindowsRemotePath}; at most 512 UTF-8 bytes (2.x targets.mjs:7-11).
 */
public record WindowsDirectory(String value) {

    /** The upper bound in UTF-8 bytes. */
    public static final int MAX_BYTES = 512;

    private static final Pattern DRIVE_ROOT = Pattern.compile("[A-Za-z]:[\\\\/]");

    public WindowsDirectory {
        Objects.requireNonNull(value, "value");
        if (new Utf8Text(value).byteLength() > MAX_BYTES) {
            throw new IllegalArgumentException("Invalid Windows working directory");
        }
        if (!DRIVE_ROOT.matcher(value).matches()) {
            new WindowsRemotePath(value);
        }
    }
}
