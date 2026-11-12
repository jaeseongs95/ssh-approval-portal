package io.github.jaeseongs95.portal.domain.desktop;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatCode;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import java.util.ArrayList;
import java.util.Collections;
import java.util.List;

import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.ValueSource;

import io.github.jaeseongs95.portal.domain.desktop.DesktopAction.KeyAction;
import io.github.jaeseongs95.portal.domain.desktop.DesktopAction.PointerAction;
import io.github.jaeseongs95.portal.domain.desktop.DesktopAction.TextAction;

/** The actions of one desktop input request (2.x desktop-lease.mjs:14-35). The 2.x tests of the lease itself (A-694 to A-714) belong to stage 5. */
class DesktopActionsTest {

    @ParameterizedTest(name = "[{index}] keysym {0}")
    @ValueSource(ints = {1, 65, 0xff0d, 0x1fffffff})
    @DisplayName("S2-DE-04 a key action takes a keysym from 1 to 0x1fffffff")
    void acceptsAKeysymInRange(int keysym) {
        assertThat(new KeyAction(keysym, true).keysym()).isEqualTo(keysym);
    }

    @ParameterizedTest(name = "[{index}] keysym {0}")
    @ValueSource(ints = {0, -1, 0x20000000, Integer.MIN_VALUE, Integer.MAX_VALUE})
    @DisplayName("S2-DE-04 a key action with a keysym outside 1 to 0x1fffffff is refused")
    void refusesAKeysymOutOfRange(int keysym) {
        assertThatThrownBy(() -> new KeyAction(keysym, false)).isInstanceOf(IllegalArgumentException.class);
    }

    @Test
    @DisplayName("S2-DE-05 a pointer action takes buttons from 0 to 255 and non-negative coordinates")
    void checksThePointerFields() {
        assertThat(new PointerAction(0, 0, 0).buttons()).isZero();
        assertThat(new PointerAction(10, 20, 255).buttons()).isEqualTo(255);
        assertThatThrownBy(() -> new PointerAction(0, 0, -1)).isInstanceOf(IllegalArgumentException.class);
        assertThatThrownBy(() -> new PointerAction(0, 0, 256)).isInstanceOf(IllegalArgumentException.class);
        assertThatThrownBy(() -> new PointerAction(-1, 0, 0)).isInstanceOf(IllegalArgumentException.class);
        assertThatThrownBy(() -> new PointerAction(0, -1, 0)).isInstanceOf(IllegalArgumentException.class);
    }

    @Test
    @DisplayName("S2-DE-06 a text action takes 1 to 2048 characters of well-formed text")
    void checksTheText() {
        assertThat(new TextAction("a").text()).isEqualTo("a");
        assertThat(new TextAction("a".repeat(2048)).text()).hasSize(2048);
        assertThat(new TextAction("😀").text()).hasSize(2);
        assertThatThrownBy(() -> new TextAction("")).as("empty").isInstanceOf(IllegalArgumentException.class);
        assertThatThrownBy(() -> new TextAction("a".repeat(2049))).as("too long").isInstanceOf(IllegalArgumentException.class);
        assertThatThrownBy(() -> new TextAction("\uD800")).as("lone high surrogate").isInstanceOf(IllegalArgumentException.class);
        assertThatThrownBy(() -> new TextAction("a\uDC00")).as("lone low surrogate").isInstanceOf(IllegalArgumentException.class);
        assertThatThrownBy(() -> new TextAction(null)).as("missing").isInstanceOf(NullPointerException.class);
    }

    @Test
    @DisplayName("S2-DE-07 a key or pointer action is one event and a text is two events per character, a surrogate pair counting once")
    void countsEvents() {
        assertThat(new KeyAction(65, true).eventCount()).isEqualTo(1);
        assertThat(new PointerAction(1, 2, 0).eventCount()).isEqualTo(1);
        assertThat(new TextAction("ab").eventCount()).isEqualTo(4);
        assertThat(new TextAction("😀").eventCount()).isEqualTo(2);
        assertThat(new TextAction("a😀b").eventCount()).isEqualTo(6);
    }

    @Test
    @DisplayName("S2-DE-08 a request has 1 to 128 actions")
    void checksTheActionCount() {
        DesktopAction key = new KeyAction(65, true);

        assertThat(new DesktopActions(List.of(key)).actions()).hasSize(1);
        assertThat(new DesktopActions(Collections.nCopies(128, key)).actions()).hasSize(128);
        assertThatThrownBy(() -> new DesktopActions(List.of())).as("none").isInstanceOf(IllegalArgumentException.class);
        assertThatThrownBy(() -> new DesktopActions(Collections.nCopies(129, key))).as("129").isInstanceOf(IllegalArgumentException.class);
        assertThatThrownBy(() -> new DesktopActions(null)).as("missing list").isInstanceOf(NullPointerException.class);
        assertThatThrownBy(() -> new DesktopActions(Collections.singletonList(null))).as("missing action").isInstanceOf(NullPointerException.class);
    }

    @Test
    @DisplayName("S2-DE-08 a request has at most 4096 events")
    void checksTheEventCount() {
        DesktopAction fullText = new TextAction("a".repeat(2048));
        DesktopAction key = new KeyAction(65, true);

        DesktopActions atLimit = new DesktopActions(List.of(fullText));
        assertThat(atLimit.eventCount()).isEqualTo(4096);
        assertThat(new DesktopActions(List.of(new TextAction("a".repeat(2047)), key, key)).eventCount()).isEqualTo(4096);
        assertThatThrownBy(() -> new DesktopActions(List.of(fullText, key))).isInstanceOf(IllegalArgumentException.class);
        assertThatThrownBy(() -> new DesktopActions(List.of(fullText, fullText))).isInstanceOf(IllegalArgumentException.class);
    }

    @Test
    @DisplayName("S2-DE-08 the request keeps its own copy of the list")
    void copiesTheList() {
        List<DesktopAction> list = new ArrayList<>();
        list.add(new KeyAction(65, true));
        DesktopActions actions = new DesktopActions(list);

        list.add(new KeyAction(66, true));

        assertThat(actions.actions()).hasSize(1);
        assertThatThrownBy(() -> actions.actions().add(new KeyAction(67, true))).isInstanceOf(UnsupportedOperationException.class);
    }

    @Test
    @DisplayName("S2-DE-09 a pointer must lie left of the width and above the height of the screen")
    void checksThePointerAgainstTheScreen() {
        DesktopActions inside = new DesktopActions(List.of(new PointerAction(1279, 719, 1), new KeyAction(65, true), new TextAction("x")));
        DesktopActions rightEdge = new DesktopActions(List.of(new PointerAction(1280, 0, 0)));
        DesktopActions bottomEdge = new DesktopActions(List.of(new PointerAction(0, 720, 0)));

        assertThatCode(() -> inside.validate(1280, 720)).doesNotThrowAnyException();
        assertThatThrownBy(() -> rightEdge.validate(1280, 720)).as("x equals width").isInstanceOf(IllegalArgumentException.class);
        assertThatThrownBy(() -> bottomEdge.validate(1280, 720)).as("y equals height").isInstanceOf(IllegalArgumentException.class);
        assertThatThrownBy(() -> inside.validate(0, 720)).as("no width").isInstanceOf(IllegalArgumentException.class);
        assertThatThrownBy(() -> inside.validate(1280, -1)).as("negative height").isInstanceOf(IllegalArgumentException.class);
    }

    @Test
    @DisplayName("S2-DE-09 a request without a pointer fits every screen")
    void keysAndTextFitEveryScreen() {
        DesktopActions actions = new DesktopActions(List.of(new KeyAction(65, true), new TextAction("x")));

        assertThatCode(() -> actions.validate(1, 1)).doesNotThrowAnyException();
    }
}
