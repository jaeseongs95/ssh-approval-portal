package io.github.jaeseongs95.portal.app.remote;

import java.time.Instant;
import java.util.ArrayList;
import java.util.EnumSet;
import java.util.List;
import java.util.Optional;
import java.util.Set;

/**
 * The phases an execution reached, in the order they were noted (stage 3 design 3.4). Every phase is in it at most once and no mark is earlier than the one before it,
 * so a reader can take the time between two marks as the time the step took. The adapter notes the marks from one place, with the injected {@code Clock}.
 *
 * @param marks the marks in the order they were noted
 */
public record ExecutionTimeline(List<PhaseMark> marks) {

    public ExecutionTimeline {
        marks = List.copyOf(marks);
        Set<ExecutionPhase> seen = EnumSet.noneOf(ExecutionPhase.class);
        Instant previous = null;
        for (PhaseMark mark : marks) {
            if (!seen.add(mark.phase())) {
                throw new IllegalArgumentException("A phase is noted once: " + mark.phase());
            }
            if (previous != null && mark.at().isBefore(previous)) {
                throw new IllegalArgumentException("A mark is not earlier than the one before it: " + mark.phase());
            }
            previous = mark.at();
        }
    }

    /** A timeline with no mark yet. */
    public static ExecutionTimeline empty() {
        return new ExecutionTimeline(List.of());
    }

    /** This timeline and one more mark; refused when the phase is already in it or the instant is before the last mark. */
    public ExecutionTimeline marked(ExecutionPhase phase, Instant at) {
        List<PhaseMark> next = new ArrayList<>(marks);
        next.add(new PhaseMark(phase, at));
        return new ExecutionTimeline(next);
    }

    /** The instant of the phase; {@code Optional} has the one meaning "this phase was not reached". */
    public Optional<Instant> at(ExecutionPhase phase) {
        return marks.stream().filter(mark -> mark.phase() == phase).map(PhaseMark::at).findFirst();
    }
}
