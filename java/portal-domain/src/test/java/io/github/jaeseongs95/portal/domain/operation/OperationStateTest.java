package io.github.jaeseongs95.portal.domain.operation;

import static io.github.jaeseongs95.portal.domain.operation.OperationState.ACCEPTED;
import static io.github.jaeseongs95.portal.domain.operation.OperationState.CANCELLED;
import static io.github.jaeseongs95.portal.domain.operation.OperationState.COMPLETED;
import static io.github.jaeseongs95.portal.domain.operation.OperationState.DENIED;
import static io.github.jaeseongs95.portal.domain.operation.OperationState.EVALUATING;
import static io.github.jaeseongs95.portal.domain.operation.OperationState.EXPIRED;
import static io.github.jaeseongs95.portal.domain.operation.OperationState.FAILED;
import static io.github.jaeseongs95.portal.domain.operation.OperationState.PENDING;
import static io.github.jaeseongs95.portal.domain.operation.OperationState.QUEUED;
import static io.github.jaeseongs95.portal.domain.operation.OperationState.RUNNING;
import static io.github.jaeseongs95.portal.domain.operation.OperationState.STARTING;
import static io.github.jaeseongs95.portal.domain.operation.OperationState.TERMINATING;
import static io.github.jaeseongs95.portal.domain.operation.OperationState.UNKNOWN;
import static org.assertj.core.api.Assertions.assertThat;

import java.util.Arrays;
import java.util.EnumSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import tools.jackson.databind.json.JsonMapper;

class OperationStateTest {

    /** The moves of design 2.3, transitions T1 to T25, written out by the state they start in. */
    private static final Map<OperationState, Set<OperationState>> ALLOWED = Map.of(
        ACCEPTED, EnumSet.of(EVALUATING, PENDING, EXPIRED, CANCELLED, UNKNOWN),
        EVALUATING, EnumSet.of(PENDING, DENIED, EXPIRED, CANCELLED, UNKNOWN),
        PENDING, EnumSet.of(QUEUED, DENIED, EXPIRED, CANCELLED, FAILED),
        QUEUED, EnumSet.of(STARTING, DENIED, EXPIRED, CANCELLED, FAILED, UNKNOWN),
        STARTING, EnumSet.of(RUNNING, TERMINATING, COMPLETED, FAILED, CANCELLED, EXPIRED, UNKNOWN),
        RUNNING, EnumSet.of(TERMINATING, COMPLETED, FAILED, CANCELLED, UNKNOWN),
        TERMINATING, EnumSet.of(COMPLETED, FAILED, CANCELLED, UNKNOWN),
        UNKNOWN, EnumSet.of(COMPLETED, FAILED, CANCELLED));

    @Test
    @DisplayName("S2-ST-01 all 13 x 13 = 169 combinations: only the moves of 2.3 are possible, the five final states move nowhere, unknown moves only to a confirmed result")
    void everyCombination() {
        int possible = 0;
        for (OperationState from : OperationState.values()) {
            for (OperationState to : OperationState.values()) {
                boolean expected = ALLOWED.getOrDefault(from, EnumSet.noneOf(OperationState.class)).contains(to);
                assertThat(from.canMoveTo(to)).as("%s to %s", from, to).isEqualTo(expected);
                if (expected) {
                    possible++;
                }
            }
        }
        assertThat(possible).isEqualTo(40);
        for (OperationState finalState : List.of(COMPLETED, FAILED, CANCELLED, DENIED, EXPIRED)) {
            assertThat(EnumSet.allOf(OperationState.class).stream().anyMatch(finalState::canMoveTo)).as("%s is final", finalState).isFalse();
        }
        assertThat(EnumSet.allOf(OperationState.class).stream().filter(UNKNOWN::canMoveTo)).containsExactlyInAnyOrder(COMPLETED, FAILED, CANCELLED);
    }

    @Test
    @DisplayName("S2-ST-01 nothing moves back to ACCEPTED, no state skips the approval, and an execution is not undone")
    void forbiddenMoves() {
        for (OperationState from : OperationState.values()) {
            assertThat(from.canMoveTo(ACCEPTED)).as("%s to accepted", from).isFalse();
        }
        for (OperationState from : List.of(ACCEPTED, EVALUATING, PENDING)) {
            assertThat(from.canMoveTo(STARTING)).isFalse();
            assertThat(from.canMoveTo(RUNNING)).isFalse();
        }
        assertThat(EVALUATING.canMoveTo(QUEUED)).as("an evaluation ends in the owner's step").isFalse();
        assertThat(QUEUED.canMoveTo(RUNNING)).as("a claim comes first").isFalse();
        assertThat(RUNNING.canMoveTo(EXPIRED)).isFalse();
        assertThat(RUNNING.canMoveTo(DENIED)).isFalse();
        for (OperationState active : List.of(STARTING, RUNNING, TERMINATING)) {
            assertThat(List.of(QUEUED, PENDING, EVALUATING, ACCEPTED)).noneMatch(active::canMoveTo);
        }
    }

    @Test
    @DisplayName("S2-ST-01 the classes of states: terminal six, final five, active three, before dispatch four")
    void stateClasses() {
        assertThat(Arrays.stream(OperationState.values()).filter(OperationState::isTerminal)).containsExactlyInAnyOrder(COMPLETED, FAILED, CANCELLED, DENIED, EXPIRED, UNKNOWN);
        assertThat(Arrays.stream(OperationState.values()).filter(OperationState::isFinal)).containsExactlyInAnyOrder(COMPLETED, FAILED, CANCELLED, DENIED, EXPIRED);
        assertThat(Arrays.stream(OperationState.values()).filter(OperationState::isActive)).containsExactlyInAnyOrder(STARTING, RUNNING, TERMINATING);
        assertThat(Arrays.stream(OperationState.values()).filter(OperationState::isPreDispatch)).containsExactlyInAnyOrder(ACCEPTED, EVALUATING, PENDING, QUEUED);
    }

    @Test
    @DisplayName("S2-CO-04 the wire values are the thirteen of public-contract.mjs:15, in that order, written by Jackson as lowercase JSON text")
    void wireValues() throws Exception {
        List<String> contract = List.of("accepted", "pending", "evaluating", "queued", "starting", "running", "terminating", "completed", "failed", "cancelled", "denied", "expired",
            "unknown");
        assertThat(Arrays.stream(OperationState.values()).map(OperationState::wire)).containsExactlyElementsOf(contract);
        JsonMapper mapper = new JsonMapper();
        for (OperationState state : OperationState.values()) {
            assertThat(mapper.writeValueAsString(state)).isEqualTo("\"" + state.wire() + "\"");
        }
        assertThat(RUNNING).as("the constant is the upper case name the database column holds").hasToString("RUNNING");
    }
}
