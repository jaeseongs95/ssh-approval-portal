package io.github.jaeseongs95.portal.app.output;

import java.time.Clock;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.scheduling.annotation.Scheduled;
import org.springframework.stereotype.Component;

import io.github.jaeseongs95.portal.app.storage.ReapGate;
import io.github.jaeseongs95.portal.app.storage.ReapPermission;
import io.github.jaeseongs95.portal.app.storage.ReapReport;

/**
 * Removes the command outputs whose retention has ended: the bytes first, then the row, so a crash leaves a row whose bytes are gone, never bytes without a row
 * (2.x {@code reap}). It asks the {@link ReapGate} before every run: while a maintenance reservation holds the installation, or while the guard of the file stores
 * fails, nothing is deleted and the expired bytes stay as they are (RC-B-004: a protection that fails keeps the expired output, and the application does not start without it).
 * An output that cannot be removed is counted and kept for the next run.
 */
@Component
public class OutputReaper {

    private static final Logger LOG = LoggerFactory.getLogger(OutputReaper.class);

    private final OutputManifestStore manifests;
    private final OutputPayloadStore payloads;
    private final ReapGate gate;
    private final Clock clock;

    public OutputReaper(OutputManifestStore manifests, OutputPayloadStore payloads, ReapGate gate, Clock clock) {
        this.manifests = manifests;
        this.payloads = payloads;
        this.gate = gate;
        this.clock = clock;
    }

    /** One run. The scheduler calls {@link #reapOnSchedule()}; a caller that wants the report calls this. */
    public ReapReport reap() {
        if (gate.permission() instanceof ReapPermission.Suspended suspended) {
            return new ReapReport.Suspended(suspended.reason());
        }
        int removed = 0;
        int failed = 0;
        for (OutputManifest expired : manifests.expired(clock.instant())) {
            try {
                payloads.delete(expired.id());
                manifests.delete(expired.id());
                removed++;
            } catch (RuntimeException e) {
                // One output that cannot be removed must not stop the others; it is listed again by the next run.
                failed++;
                LOG.warn("The expired output " + expired.id().value() + " could not be removed and stays until the next run", e);
            }
        }
        return new ReapReport.Reaped(removed, failed);
    }

    /** One minute after the start and one minute after each run (the interval is a setting of stage 4). */
    @Scheduled(initialDelay = 60_000L, fixedDelay = 60_000L)
    public void reapOnSchedule() {
        reap();
    }
}
