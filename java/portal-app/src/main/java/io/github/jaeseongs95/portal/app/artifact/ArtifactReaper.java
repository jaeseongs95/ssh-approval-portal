package io.github.jaeseongs95.portal.app.artifact;

import java.time.Clock;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.scheduling.annotation.Scheduled;
import org.springframework.stereotype.Component;

import io.github.jaeseongs95.portal.app.storage.ReapGate;
import io.github.jaeseongs95.portal.app.storage.ReapPermission;
import io.github.jaeseongs95.portal.app.storage.ReapReport;

/**
 * Removes the artifacts whose time has come: the bytes, the row and the charge of each (2.x {@code reap}). It asks the {@link ReapGate} before every run, so a
 * maintenance reservation (RC-A-173) and a failing guard of the file stores (RC-B-004) hold the whole run back: nothing is deleted and nothing is un-charged until they are
 * gone. An artifact that is pinned by a submitted operation is never listed by the registry; a consumed one has no bytes and loses only its row.
 *
 * <p>The order for the others is the registry's: the row goes to {@code DELETING} first, then the bytes are deleted, then the row is released, so a crash in the middle
 * leaves a row that the start-up check finishes. One artifact that cannot be removed is counted and kept for the next run; it does not stop the run.
 */
@Component
public class ArtifactReaper {

    private static final Logger LOG = LoggerFactory.getLogger(ArtifactReaper.class);

    private final ArtifactRegistry registry;
    private final ArtifactPayloadStore payloads;
    private final ReapGate gate;
    private final Clock clock;

    public ArtifactReaper(ArtifactRegistry registry, ArtifactPayloadStore payloads, ReapGate gate, Clock clock) {
        this.registry = registry;
        this.payloads = payloads;
        this.gate = gate;
        this.clock = clock;
    }

    /** One run. The scheduler calls {@link #reapOnSchedule()}; a caller that wants the report (a test, the lifecycle) calls this. */
    public ReapReport reap() {
        if (gate.permission() instanceof ReapPermission.Suspended suspended) {
            return new ReapReport.Suspended(suspended.reason());
        }
        int removed = 0;
        int failed = 0;
        for (ArtifactRecord expired : registry.expired(clock.instant())) {
            try {
                remove(expired);
                removed++;
            } catch (RuntimeException e) {
                // One artifact that cannot be removed (a locked file, a conflicting writer) must not stop the others; it is listed again by the next run.
                failed++;
                LOG.warn("The expired artifact " + expired.id().value() + " could not be removed and stays until the next run", e);
            }
        }
        return new ReapReport.Reaped(removed, failed);
    }

    /** One minute after the start and one minute after each run (2.x reaped on a timer; the interval is a setting of stage 4). */
    @Scheduled(initialDelay = 60_000L, fixedDelay = 60_000L)
    public void reapOnSchedule() {
        reap();
    }

    private void remove(ArtifactRecord expired) {
        if (expired.state() != ArtifactState.CONSUMED) {
            registry.beginDelete(expired.id());
            payloads.delete(expired.id());
        }
        registry.release(expired.id(), ReleaseReason.EXPIRED);
    }
}
