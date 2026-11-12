package io.github.jaeseongs95.portal.app.remote;

import java.util.Objects;

import io.github.jaeseongs95.portal.domain.path.RemotePath;

/** Where a remote command starts: in the directory the login gives it, or in a directory the profile names. It stands where a nullable path would. */
public sealed interface WorkingDirectory permits WorkingDirectory.Default, WorkingDirectory.At {

    /** The directory the login starts in. */
    record Default() implements WorkingDirectory {
    }

    /** A directory on the target, written in the target's own path syntax. */
    record At(RemotePath directory) implements WorkingDirectory {

        public At {
            Objects.requireNonNull(directory, "directory");
        }
    }
}
