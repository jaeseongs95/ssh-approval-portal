package io.github.jaeseongs95.portal.ssh.exec;

import io.github.jaeseongs95.portal.app.remote.ExecutionPhase;
import io.github.jaeseongs95.portal.app.remote.ExecutionTimeline;
import java.time.Clock;
import java.time.Instant;

/**
 * Notes the phases of one execution (stage 3 design 3.4, defect D-0038) from the one place that owns the injected {@link Clock}. A phase is noted once, and a mark is
 * never earlier than the one before it, even if the clock steps back, so {@link ExecutionTimeline} accepts every mark. Called from MINA's threads and from the timers.
 */
final class TimelineRecorder {

    private final Clock clock;
    private ExecutionTimeline timeline = ExecutionTimeline.empty();
    private Instant last;

    TimelineRecorder(Clock clock) {
        this.clock = clock;
    }

    /** Notes the phase now; does nothing when it was noted already. */
    synchronized void mark(ExecutionPhase phase) {
        if (timeline.at(phase).isPresent()) {
            return;
        }
        Instant now = clock.instant();
        if (last != null && now.isBefore(last)) {
            now = last;
        }
        timeline = timeline.marked(phase, now);
        last = now;
    }

    /** The phases noted so far. */
    synchronized ExecutionTimeline timeline() {
        return timeline;
    }
}
