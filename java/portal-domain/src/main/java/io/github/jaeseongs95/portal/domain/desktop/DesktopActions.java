package io.github.jaeseongs95.portal.domain.desktop;

import java.util.List;
import java.util.Objects;

/**
 * The actions of one desktop input request: 1 to 128 actions that cost at most 4096 events together (2.x desktop-lease.mjs:14-35). The list is copied, so the
 * request cannot change after it was checked.
 */
public record DesktopActions(List<DesktopAction> actions) {

    public static final int MAX_ACTIONS = 128;
    public static final int MAX_EVENTS = 4096;

    public DesktopActions {
        Objects.requireNonNull(actions, "actions");
        actions = List.copyOf(actions);
        if (actions.isEmpty() || actions.size() > MAX_ACTIONS) {
            throw new IllegalArgumentException("A desktop input request has 1 to " + MAX_ACTIONS + " actions");
        }
        if (totalEvents(actions) > MAX_EVENTS) {
            throw new IllegalArgumentException("A desktop input request has at most " + MAX_EVENTS + " events");
        }
    }

    /** The events of all actions together. */
    public int eventCount() {
        return totalEvents(actions);
    }

    private static int totalEvents(List<DesktopAction> list) {
        int events = 0;
        for (DesktopAction action : list) {
            events += action.eventCount();
        }
        return events;
    }

    /**
     * Checks that every pointer lies inside a screen of this size ({@code x < width}, {@code y < height}). The size comes from the observed frame, so it is
     * known only when the request is applied, not when it is built.
     *
     * @throws IllegalArgumentException when the size is not positive or an action lies outside
     */
    public void validate(int width, int height) {
        if (width < 1 || height < 1) {
            throw new IllegalArgumentException("A screen has a positive width and height");
        }
        for (DesktopAction action : actions) {
            if (!action.fitsScreen(width, height)) {
                throw new IllegalArgumentException("A pointer lies outside the screen");
            }
        }
    }
}
