package io.github.jaeseongs95.portal.ssh.hostkey;

import java.util.ArrayList;
import java.util.List;

/** {@link HostKeyEvents} for tests: it keeps what the policy reported, in order. The policy and the test run on different threads, so the lists are guarded. */
final class RecordingHostKeyEvents implements HostKeyEvents {

    private final List<HostKeyRefusal> refusals = new ArrayList<>();
    private int insecureReports;

    @Override
    public synchronized void refused(HostKeyRefusal refusal) {
        refusals.add(refusal);
    }

    @Override
    public synchronized void insecureModeActive() {
        insecureReports++;
    }

    /** The refusals so far, in order. */
    synchronized List<HostKeyRefusal> refusals() {
        return List.copyOf(refusals);
    }

    /** How many times the insecure mode was reported. */
    synchronized int insecureReports() {
        return insecureReports;
    }
}
