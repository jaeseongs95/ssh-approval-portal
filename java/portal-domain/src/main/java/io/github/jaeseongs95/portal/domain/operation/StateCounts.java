package io.github.jaeseongs95.portal.domain.operation;

import java.util.Collections;
import java.util.EnumMap;
import java.util.Map;
import java.util.Objects;

/** How many operations there are in each state. A state that is not listed has none. It is what the approval and the scheduling policies judge on. */
public record StateCounts(Map<OperationState, Integer> counts) {

    public StateCounts {
        Objects.requireNonNull(counts, "counts");
        EnumMap<OperationState, Integer> copy = new EnumMap<>(OperationState.class);
        for (Map.Entry<OperationState, Integer> entry : counts.entrySet()) {
            if (entry.getValue() < 0) {
                throw new IllegalArgumentException("A count is not negative");
            }
            copy.put(entry.getKey(), entry.getValue());
        }
        counts = Collections.unmodifiableMap(copy);
    }

    /** The counts of no operations at all. */
    public static StateCounts none() {
        return new StateCounts(Map.of());
    }

    public int of(OperationState state) {
        return counts.getOrDefault(state, 0);
    }

    /** The number of operations in the states, summed. */
    public int sum(OperationState... states) {
        int total = 0;
        for (OperationState state : states) {
            total += of(state);
        }
        return total;
    }

    /** The number of operations that still occupy the approval store: every one that is not terminal. A terminal operation is history. */
    public int open() {
        int total = 0;
        for (OperationState state : OperationState.values()) {
            if (!state.isTerminal()) {
                total += of(state);
            }
        }
        return total;
    }

    /** The number of operations that hold an execution slot. */
    public int active() {
        return sum(OperationState.STARTING, OperationState.RUNNING, OperationState.TERMINATING);
    }
}
