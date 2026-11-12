package io.github.jaeseongs95.portal.store.storage;

import java.io.Serial;

/**
 * A folder or a file that holds artifact bytes, output bytes or the audit lines is not protected as the product requires: it is a link, it is not a regular file, or
 * somebody besides the owner may read or write it. It is the one signal of the {@link PrivateStorage} rules; each store turns it into the refusal of its own contract
 * ({@code ARTIFACT_STORAGE_UNSAFE} for the artifacts, the output code for the outputs). The text names the path and the reason, never the content.
 */
public final class UnsafeStorageException extends RuntimeException {

    @Serial
    private static final long serialVersionUID = 1L;

    private final String path;

    public UnsafeStorageException(String path, String reason) {
        super("The storage " + path + " is not private: " + reason);
        this.path = path;
    }

    /** The path as text. */
    public String path() {
        return path;
    }
}
