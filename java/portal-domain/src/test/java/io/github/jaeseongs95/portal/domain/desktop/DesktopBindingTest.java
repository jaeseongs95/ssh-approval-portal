package io.github.jaeseongs95.portal.domain.desktop;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.ValueSource;

import io.github.jaeseongs95.portal.domain.id.Digest;
import io.github.jaeseongs95.portal.domain.id.TargetId;
import io.github.jaeseongs95.portal.domain.target.TargetRevision;

/** The owner, target and epoch a desktop lease is bound to (2.x desktop-lease.mjs:6-12). The target id and revision check themselves in their own types. */
class DesktopBindingTest {

    private final TargetId target = new TargetId("alpha");
    private final TargetRevision revision = new TargetRevision(new Digest("a".repeat(64)));

    @Test
    @DisplayName("S2-DE-01 a binding keeps its owner, target, revision and epoch")
    void keepsItsParts() {
        DesktopBinding binding = new DesktopBinding("owner-1", target, revision, 1);

        assertThat(binding.ownerId()).isEqualTo("owner-1");
        assertThat(binding.targetId()).isEqualTo(target);
        assertThat(binding.targetRevision()).isEqualTo(revision);
        assertThat(binding.epoch()).isEqualTo(1);
        assertThat(binding).isEqualTo(new DesktopBinding("owner-1", target, revision, 1));
        assertThat(binding).isNotEqualTo(new DesktopBinding("owner-1", target, revision, 2));
    }

    @Test
    @DisplayName("S2-DE-02 an owner id of 1 to 256 characters is accepted and an empty, longer or missing one is refused")
    void checksTheOwnerLength() {
        assertThat(new DesktopBinding("o", target, revision, 1).ownerId()).hasSize(1);
        assertThat(new DesktopBinding("o".repeat(256), target, revision, 1).ownerId()).hasSize(256);
        assertThatThrownBy(() -> new DesktopBinding("", target, revision, 1)).isInstanceOf(IllegalArgumentException.class);
        assertThatThrownBy(() -> new DesktopBinding("o".repeat(257), target, revision, 1)).isInstanceOf(IllegalArgumentException.class);
        assertThatThrownBy(() -> new DesktopBinding(null, target, revision, 1)).isInstanceOf(NullPointerException.class);
        assertThatThrownBy(() -> new DesktopBinding("owner-1", null, revision, 1)).isInstanceOf(NullPointerException.class);
        assertThatThrownBy(() -> new DesktopBinding("owner-1", target, null, 1)).isInstanceOf(NullPointerException.class);
    }

    @ParameterizedTest(name = "[{index}] epoch {0}")
    @ValueSource(longs = {0, -1, Long.MIN_VALUE, 9_007_199_254_740_992L, Long.MAX_VALUE})
    @DisplayName("S2-DE-03 an epoch below 1 or beyond the largest exactly readable integer is refused")
    void refusesAnEpochOutOfRange(long epoch) {
        assertThatThrownBy(() -> new DesktopBinding("owner-1", target, revision, epoch)).isInstanceOf(IllegalArgumentException.class);
    }

    @Test
    @DisplayName("S2-DE-03 the epoch bounds 1 and 2^53-1 are accepted")
    void acceptsTheEpochBounds() {
        assertThat(new DesktopBinding("owner-1", target, revision, 1).epoch()).isEqualTo(1);
        assertThat(new DesktopBinding("owner-1", target, revision, 9_007_199_254_740_991L).epoch()).isEqualTo(9_007_199_254_740_991L);
    }
}
