package io.github.jaeseongs95.portal.domain.operation;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import io.github.jaeseongs95.portal.domain.error.OperationErrorCode;
import io.github.jaeseongs95.portal.domain.error.RequestRefusedException;
import io.github.jaeseongs95.portal.domain.id.Digester;
import io.github.jaeseongs95.portal.domain.id.OperationId;
import io.github.jaeseongs95.portal.domain.id.OwnerId;
import io.github.jaeseongs95.portal.domain.id.RequestKey;
import io.github.jaeseongs95.portal.domain.id.Sha256Digester;
import io.github.jaeseongs95.portal.domain.id.TargetId;
import io.github.jaeseongs95.portal.domain.target.ProfileAlias;
import io.github.jaeseongs95.portal.domain.target.TargetRevision;
import io.github.jaeseongs95.portal.domain.text.CommandText;
import io.github.jaeseongs95.portal.domain.text.Utf8Text;
import java.time.Instant;
import org.assertj.core.api.ThrowableAssert.ThrowingCallable;

/** Builders of operations in each state, shared by the operation, approval, schedule and failure tests. Every step of a chain is one second after the one before. */
public final class OperationFixtures {

    public static final Instant T0 = Instant.parse("2026-11-12T00:00:00Z");
    public static final TargetRevision REVISION = TargetRevision.of("a".repeat(64));
    public static final Digester DIGESTER = new Sha256Digester();

    private OperationFixtures() {
    }

    public static OperationId id(char digit) {
        return new OperationId(String.valueOf(digit).repeat(48));
    }

    public static NewOperation command(String key, String text) {
        return command(key, text, "alpha", new ConflictKey.None(), new Deadline.None());
    }

    public static NewOperation command(String key, String text, String target, ConflictKey conflict, Deadline requestedExpiry) {
        return NewOperation.of(DIGESTER, new RequestKey(key), new OwnerId("fixture-owner"), new TargetId(target), REVISION, new ProfileAlias("write-profile"),
            new CommandInput(new CommandText(text), new Utf8Text(""), new Utf8Text("")), conflict, requestedExpiry);
    }

    public static Operation accepted() {
        return Operation.accept(command("fixture-key-000001", "printf ok"), id('1'), T0);
    }

    public static Operation evaluating() {
        return accepted().beginEvaluation(T0.plusSeconds(1));
    }

    public static Operation pending() {
        return accepted().awaitOwnerDecision(T0.plusSeconds(1));
    }

    public static Operation queued() {
        return pending().enqueue(new StartAuthority.Owner(), T0.plusSeconds(2));
    }

    public static Operation starting() {
        return queued().claim(T0.plusSeconds(3));
    }

    public static Operation running() {
        return starting().markRunning(T0.plusSeconds(4));
    }

    public static Operation terminating() {
        return running().requestCancel(T0.plusSeconds(5));
    }

    public static void assertInvalidTransition(ThrowingCallable call) {
        assertThatThrownBy(call).isInstanceOfSatisfying(RequestRefusedException.class, e -> assertThat(e.code()).isEqualTo(OperationErrorCode.INVALID_OPERATION_TRANSITION));
    }
}
