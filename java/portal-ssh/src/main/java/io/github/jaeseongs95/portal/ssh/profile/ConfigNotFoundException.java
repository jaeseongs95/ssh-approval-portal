package io.github.jaeseongs95.portal.ssh.profile;

import java.io.Serial;

/** There is no configuration file at the path (2.x {@code ConfigNotFoundError}, code {@code ENOENT}). A path that exists but cannot be read is a {@link ProfileConfigException} of another code. */
public final class ConfigNotFoundException extends ProfileConfigException {

    @Serial
    private static final long serialVersionUID = 1L;

    private final String path;

    public ConfigNotFoundException(String path, Throwable cause) {
        super(Code.NOT_FOUND, "Config file " + path + " was not found", cause);
        this.path = path;
    }

    /** The path as it was given, without any expansion. */
    public String path() {
        return path;
    }
}
