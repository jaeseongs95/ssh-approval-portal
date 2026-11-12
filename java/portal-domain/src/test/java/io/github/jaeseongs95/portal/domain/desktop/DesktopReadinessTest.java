package io.github.jaeseongs95.portal.domain.desktop;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatCode;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import java.time.Instant;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.Collections;
import java.util.List;
import java.util.stream.Stream;

import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.MethodSource;

import io.github.jaeseongs95.portal.domain.desktop.DesktopGeneration.GenerationHex;
import io.github.jaeseongs95.portal.domain.desktop.DesktopGeneration.NoGeneration;
import io.github.jaeseongs95.portal.domain.desktop.DesktopOsSessionId.NoOsSessionId;
import io.github.jaeseongs95.portal.domain.desktop.DesktopOsSessionId.OsSessionNumber;
import io.github.jaeseongs95.portal.domain.desktop.DesktopSessionRef.NoSessionRef;
import io.github.jaeseongs95.portal.domain.desktop.DesktopSessionRef.SessionRefName;

/** The status a trusted host adapter reports about a desktop (2.x desktop-state.mjs:7-30). A status is a fact; the lease that uses it belongs to stage 5. */
class DesktopReadinessTest {

    private final DesktopReadinessBuilder builder = new DesktopReadinessBuilder();

    @Test
    @DisplayName("S2-DE-10 the plain transport status has no generation, no session, an unknown lock, nothing verified and one blocker")
    void transportStatusIsTheHandshakeOnly() {
        DesktopReadiness status = DesktopReadiness.transportReady(Instant.ofEpochMilli(5));

        assertThat(status.state()).isEqualTo(DesktopState.TRANSPORT_READY);
        assertThat(status.observedAt()).isEqualTo(Instant.ofEpochMilli(5));
        assertThat(status.generation()).isEqualTo(new NoGeneration());
        assertThat(status.osSessionId()).isEqualTo(new NoOsSessionId());
        assertThat(status.locked()).isEqualTo(LockState.UNKNOWN);
        assertThat(status.sessionBindingVerified()).isFalse();
        assertThat(status.displayBindingVerified()).isFalse();
        assertThat(status.inputVerified()).isFalse();
        assertThat(status.inputAllowed()).isTrue();
        assertThat(status.ownerOnly()).isFalse();
        assertThat(status.blockers()).containsExactly(DesktopBlocker.DESKTOP_SESSION_BINDING_UNVERIFIED);
        assertThat(status.sessionRef()).isEqualTo(new NoSessionRef());
        assertThat(status.resourceGeneration()).isEqualTo(new NoGeneration());
    }

    @Test
    @DisplayName("S2-DE-11 a complete ready status is accepted and keeps every part")
    void acceptsAReadyStatus() {
        builder.blockers = List.of();
        DesktopReadiness status = builder.build();

        assertThat(status.state()).isEqualTo(DesktopState.DESKTOP_READY);
        assertThat(status.sessionRef()).isEqualTo(new SessionRefName("session-1"));
        assertThat(status.generation()).isEqualTo(new GenerationHex("a".repeat(64)));
        assertThat(status.osSessionId()).isEqualTo(new OsSessionNumber(2));
        assertThat(status.locked()).isEqualTo(LockState.UNLOCKED);
        assertThat(status.ownerOnly()).isTrue();
    }

    @Test
    @DisplayName("S2-DE-12 a ready status needs the session binding, the display binding and the input all verified")
    void readyNeedsThreeVerifications() {
        builder.sessionBindingVerified = false;
        assertThatThrownBy(builder::build).as("session binding").isInstanceOf(IllegalArgumentException.class);
        builder.sessionBindingVerified = true;

        builder.displayBindingVerified = false;
        assertThatThrownBy(builder::build).as("display binding").isInstanceOf(IllegalArgumentException.class);
        builder.displayBindingVerified = true;

        builder.inputVerified = false;
        assertThatThrownBy(builder::build).as("input").isInstanceOf(IllegalArgumentException.class);
        builder.inputVerified = true;

        assertThatCode(builder::build).doesNotThrowAnyException();
    }

    @Test
    @DisplayName("S2-DE-13 a ready status cannot be locked")
    void readyCannotBeLocked() {
        builder.locked = LockState.LOCKED;

        assertThatThrownBy(builder::build).isInstanceOf(IllegalArgumentException.class);
    }

    @Test
    @DisplayName("S2-DE-14 a ready status needs a session reference, or an operating-system session that is known to be unlocked")
    void readyNeedsASessionIdentity() {
        builder.sessionRef = new NoSessionRef();
        assertThatCode(builder::build).as("os session and unlocked").doesNotThrowAnyException();

        builder.locked = LockState.UNKNOWN;
        assertThatThrownBy(builder::build).as("os session and unknown lock").isInstanceOf(IllegalArgumentException.class);

        builder.locked = LockState.UNLOCKED;
        builder.osSessionId = new NoOsSessionId();
        assertThatThrownBy(builder::build).as("no os session").isInstanceOf(IllegalArgumentException.class);

        builder.sessionRef = new SessionRefName("session-1");
        builder.locked = LockState.UNKNOWN;
        assertThatCode(builder::build).as("session reference alone").doesNotThrowAnyException();
    }

    @Test
    @DisplayName("S2-DE-15 a ready status needs a resource generation or a generation")
    void readyNeedsAGeneration() {
        builder.generation = new NoGeneration();
        builder.resourceGeneration = new NoGeneration();
        assertThatThrownBy(builder::build).as("neither").isInstanceOf(IllegalArgumentException.class);

        builder.resourceGeneration = new GenerationHex("b".repeat(64));
        assertThatCode(builder::build).as("resource generation only").doesNotThrowAnyException();

        builder.resourceGeneration = new NoGeneration();
        builder.generation = new GenerationHex("a".repeat(64));
        assertThatCode(builder::build).as("generation only").doesNotThrowAnyException();
    }

    @Test
    @DisplayName("S2-DE-16 a status whose capture is unavailable cannot allow input")
    void captureUnavailableCannotAllowInput() {
        builder.state = DesktopState.CAPTURE_UNAVAILABLE;
        builder.inputAllowed = true;
        assertThatThrownBy(builder::build).isInstanceOf(IllegalArgumentException.class);

        builder.inputAllowed = false;
        assertThatCode(builder::build).doesNotThrowAnyException();
    }

    @Test
    @DisplayName("S2-DE-16 a status that needs a login keeps the readiness rules off and may allow input")
    void authRequiredHasNoReadyRules() {
        builder.state = DesktopState.AUTH_REQUIRED;
        builder.sessionBindingVerified = false;
        builder.displayBindingVerified = false;
        builder.inputVerified = false;
        builder.locked = LockState.LOCKED;
        builder.sessionRef = new NoSessionRef();
        builder.generation = new NoGeneration();
        builder.inputAllowed = true;

        assertThatCode(builder::build).doesNotThrowAnyException();
    }

    @Test
    @DisplayName("S2-DE-17 the observation time may not lie before the epoch")
    void checksTheObservationTime() {
        builder.observedAt = Instant.EPOCH;
        assertThatCode(builder::build).doesNotThrowAnyException();

        builder.observedAt = Instant.EPOCH.minusMillis(1);
        assertThatThrownBy(builder::build).isInstanceOf(IllegalArgumentException.class);

        builder.observedAt = null;
        assertThatThrownBy(builder::build).isInstanceOf(NullPointerException.class);
    }

    @Test
    @DisplayName("S2-DE-18 up to 8 blockers are accepted, more are refused, and the list is copied")
    void checksTheBlockers() {
        builder.blockers = Collections.nCopies(8, DesktopBlocker.DESKTOP_AUTH_REQUIRED);
        assertThatCode(builder::build).as("8").doesNotThrowAnyException();

        builder.blockers = Collections.nCopies(9, DesktopBlocker.DESKTOP_AUTH_REQUIRED);
        assertThatThrownBy(builder::build).as("9").isInstanceOf(IllegalArgumentException.class);

        builder.blockers = Collections.singletonList(null);
        assertThatThrownBy(builder::build).as("missing blocker").isInstanceOf(NullPointerException.class);

        List<DesktopBlocker> list = new ArrayList<>();
        list.add(DesktopBlocker.DESKTOP_CAPTURE_UNAVAILABLE);
        builder.blockers = list;
        DesktopReadiness status = builder.build();
        list.add(DesktopBlocker.DESKTOP_AUTH_REQUIRED);
        assertThat(status.blockers()).containsExactly(DesktopBlocker.DESKTOP_CAPTURE_UNAVAILABLE);
        assertThatThrownBy(() -> status.blockers().add(DesktopBlocker.DESKTOP_AUTH_REQUIRED)).isInstanceOf(UnsupportedOperationException.class);
    }

    @Test
    @DisplayName("S2-DE-19 the six blocker codes and the three lock states are the 2.x sets")
    void blockerAndLockSets() {
        assertThat(Arrays.stream(DesktopBlocker.values()).map(DesktopBlocker::name).toList()).containsExactly("DESKTOP_AUTH_REQUIRED",
                "DESKTOP_SESSION_BINDING_UNVERIFIED", "DESKTOP_SESSION_QUERY_FAILED", "DESKTOP_SESSION_QUERY_UNSUPPORTED", "DESKTOP_AUTH_BROKER_UNAVAILABLE",
                "DESKTOP_CAPTURE_UNAVAILABLE");
        assertThat(LockState.values()).containsExactly(LockState.LOCKED, LockState.UNLOCKED, LockState.UNKNOWN);
    }

    @Test
    @DisplayName("S2-DE-19 the four states have the 2.x wire names, and any other name is refused")
    void stateWireNames() {
        assertThat(Arrays.stream(DesktopState.values()).map(DesktopState::wire).toList())
                .containsExactly("transport_ready", "auth_required", "desktop_ready", "capture_unavailable");
        assertThat(DesktopState.parse("desktop_ready")).isEqualTo(DesktopState.DESKTOP_READY);
        assertThatThrownBy(() -> DesktopState.parse("DESKTOP_READY")).isInstanceOf(IllegalArgumentException.class);
        assertThatThrownBy(() -> DesktopState.parse("ready")).isInstanceOf(IllegalArgumentException.class);
        assertThatThrownBy(() -> DesktopState.parse(null)).isInstanceOf(IllegalArgumentException.class);
    }

    @ParameterizedTest(name = "[{index}] {0}")
    @MethodSource("badGenerations")
    @DisplayName("S2-DE-20 a generation that is not 64 lowercase hex characters is refused")
    void refusesABadGeneration(String hex) {
        assertThatThrownBy(() -> new GenerationHex(hex)).isInstanceOf(IllegalArgumentException.class);
    }

    static Stream<String> badGenerations() {
        return Stream.of("", "A", "a".repeat(63), "a".repeat(65), "g".repeat(64), "a".repeat(64) + "\n");
    }

    @Test
    @DisplayName("S2-DE-20 a generation is 64 lowercase hex characters, upper case is refused, and a missing one is not present")
    void checksTheGeneration() {
        assertThat(new GenerationHex("0123456789abcdef".repeat(4)).isPresent()).isTrue();
        assertThat(new NoGeneration().isPresent()).isFalse();
        assertThatThrownBy(() -> new GenerationHex("A".repeat(64))).isInstanceOf(IllegalArgumentException.class);
        assertThatThrownBy(() -> new GenerationHex(null)).isInstanceOf(NullPointerException.class);
    }

    @Test
    @DisplayName("S2-DE-21 an operating-system session id is a positive number")
    void checksTheOsSessionId() {
        assertThat(new OsSessionNumber(1).isPresent()).isTrue();
        assertThat(new NoOsSessionId().isPresent()).isFalse();
        assertThatThrownBy(() -> new OsSessionNumber(0)).isInstanceOf(IllegalArgumentException.class);
        assertThatThrownBy(() -> new OsSessionNumber(-1)).isInstanceOf(IllegalArgumentException.class);
        assertThatThrownBy(() -> new OsSessionNumber(9_007_199_254_740_992L)).isInstanceOf(IllegalArgumentException.class);
    }

    @Test
    @DisplayName("S2-DE-22 a session reference is 1 to 256 characters of letters, digits and _ . : - with nothing after")
    void checksTheSessionReference() {
        assertThat(new SessionRefName("a").isPresent()).isTrue();
        assertThat(new SessionRefName("Abc_1.2:3-x").value()).isEqualTo("Abc_1.2:3-x");
        assertThat(new SessionRefName("a".repeat(256)).value()).hasSize(256);
        assertThat(new NoSessionRef().isPresent()).isFalse();
        assertThatThrownBy(() -> new SessionRefName("")).as("empty").isInstanceOf(IllegalArgumentException.class);
        assertThatThrownBy(() -> new SessionRefName("a".repeat(257))).as("257").isInstanceOf(IllegalArgumentException.class);
        assertThatThrownBy(() -> new SessionRefName("a b")).as("space").isInstanceOf(IllegalArgumentException.class);
        assertThatThrownBy(() -> new SessionRefName("abc\n")).as("final line feed").isInstanceOf(IllegalArgumentException.class);
        assertThatThrownBy(() -> new SessionRefName("a/b")).as("slash").isInstanceOf(IllegalArgumentException.class);
        assertThatThrownBy(() -> new SessionRefName(null)).as("missing").isInstanceOf(NullPointerException.class);
    }
}
