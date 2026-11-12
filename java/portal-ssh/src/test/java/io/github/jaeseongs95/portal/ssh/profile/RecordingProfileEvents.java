package io.github.jaeseongs95.portal.ssh.profile;

import java.util.ArrayList;
import java.util.List;

/** {@link ProfileEvents} for tests: it keeps what the loader reported, in order. */
final class RecordingProfileEvents implements ProfileEvents {

    private final List<String> accessWarnings = new ArrayList<>();
    private int policyReports;

    @Override
    public synchronized void accessWarning(String reason) {
        accessWarnings.add(reason);
    }

    @Override
    public synchronized void policyNotEnforced() {
        policyReports++;
    }

    /** The access warnings so far, in order. */
    synchronized List<String> accessWarnings() {
        return List.copyOf(accessWarnings);
    }

    /** How many times the loader said that a {@code [policy]} table is not enforced. */
    synchronized int policyReports() {
        return policyReports;
    }
}
