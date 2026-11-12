package io.github.jaeseongs95.portal.store.artifact;

/**
 * The bytes that stay on the disk of the artifact store without a row: payloads the start-up check moved to quarantine, and that nothing deletes. They use the same
 * disk as the staged files, so the staging budget counts them (design 13.6, RC-A-169, RC-A-170: leaving them out would let the real use exceed the configured budget).
 * The read is file I/O, so the caller makes it outside a transaction (Principles 4.4).
 */
public interface RetainedPayloads {

    /** The total size of the files in quarantine; zero when there is none. */
    long retainedBytes();
}
