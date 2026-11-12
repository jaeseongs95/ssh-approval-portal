package io.github.jaeseongs95.portal.app.admission;

/**
 * What the entrance holds now.
 *
 * @param active requests that hold a place
 * @param queued requests that wait for a place
 * @param detached requests that ran on after they gave their place back
 * @param closed whether the entrance takes no new request
 */
public record AdmissionSnapshot(int active, int queued, int detached, boolean closed) {

    public AdmissionSnapshot {
        if (active < 0 || queued < 0 || detached < 0) {
            throw new IllegalArgumentException("A count is not negative");
        }
    }
}
