package io.github.jaeseongs95.portal.app.operation;

import static org.assertj.core.api.Assertions.assertThat;

import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

import io.github.jaeseongs95.portal.app.remote.CancelSource;
import io.github.jaeseongs95.portal.domain.id.OperationId;

/** The cancel of a running execution (stage 3 design 3.3; cases B-194, B-241). */
class RunningExecutionsTest {

    private static final OperationId ID = new OperationId("d".repeat(48));
    private static final OperationId OTHER = new OperationId("e".repeat(48));

    @Test
    @DisplayName("RC-B-194 RC-B-241 a cancel reaches the execution that is registered, and only that one")
    void cancelReachesTheRegisteredExecutionOnly() {
        RunningExecutions running = new RunningExecutions();
        CancelSource mine = running.register(ID);
        CancelSource other = running.register(OTHER);
        assertThat(running.register(ID)).isSameAs(mine);
        assertThat(running.count()).isEqualTo(2);
        assertThat(running.cancel(ID)).isTrue();
        assertThat(mine.requested()).isTrue();
        assertThat(other.requested()).isFalse();
    }

    @Test
    @DisplayName("RC-B-194 a cancel of an execution that is not registered, or was released, asks nobody and answers false; a release is idempotent")
    void cancelOfNothingIsFalse() {
        RunningExecutions running = new RunningExecutions();
        assertThat(running.cancel(ID)).isFalse();
        CancelSource source = running.register(ID);
        running.release(ID);
        running.release(ID);
        assertThat(running.cancel(ID)).isFalse();
        assertThat(source.requested()).isFalse();
        assertThat(running.count()).isZero();
    }
}
