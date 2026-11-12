package io.github.jaeseongs95.portal.app.storage;

/**
 * The guard of the file stores (2.x {@code PrivateStorage} analogue, defect-free rule of RC-B-004): asks the storage adapter whether the artifact and output folders are
 * real folders that only their owner can use. The adapter does the file-system work (a rule per kind of file store, chosen by what the file store offers), so the
 * use cases of this module know nothing of POSIX permission bits or access control lists. The answer is a value, not an exception: a check that fails is an answer.
 */
public interface StorageProtection {

    /** Checks every area; the first one that is not safe is the answer. Does file I/O, so it is not called inside a transaction. */
    ProtectionCheck check();
}
