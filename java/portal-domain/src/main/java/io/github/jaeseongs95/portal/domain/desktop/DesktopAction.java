package io.github.jaeseongs95.portal.domain.desktop;

import io.github.jaeseongs95.portal.domain.text.Utf8Text;
import java.util.Objects;

/**
 * One input event a request sends to a desktop: a key, a pointer state or a text (2.x desktop-lease.mjs:14-35). The three kinds are the permitted variants, so a
 * new kind is a compile-time change to every code that handles them. Each variant checks its own fields; what needs the screen size or the other actions of the
 * request is checked by {@link DesktopActions}.
 */
public sealed interface DesktopAction {

    /** How many protocol events the action costs: a key or pointer action is one, a text is two per character (a press and a release). */
    int eventCount();

    /** Whether the action lies inside a screen of this size; only a pointer has a place on the screen. */
    default boolean fitsScreen(int width, int height) {
        return true;
    }

    /** A key press ({@code down}) or release, by X11 keysym. */
    record KeyAction(int keysym, boolean down) implements DesktopAction {

        public static final int MAX_KEYSYM = 0x1fffffff;

        public KeyAction {
            if (keysym < 1 || keysym > MAX_KEYSYM) {
                throw new IllegalArgumentException("A keysym is from 1 to 0x1fffffff");
            }
        }

        @Override
        public int eventCount() {
            return 1;
        }
    }

    /** The pointer at a position with the buttons that are held (bit mask 0..255). */
    record PointerAction(int x, int y, int buttons) implements DesktopAction {

        public static final int MAX_BUTTONS = 255;

        public PointerAction {
            if (x < 0 || y < 0) {
                throw new IllegalArgumentException("A pointer position is not negative");
            }
            if (buttons < 0 || buttons > MAX_BUTTONS) {
                throw new IllegalArgumentException("Pointer buttons are a bit mask from 0 to 255");
            }
        }

        @Override
        public int eventCount() {
            return 1;
        }

        @Override
        public boolean fitsScreen(int width, int height) {
            return x < width && y < height;
        }
    }

    /** Text typed as key events. It must be well-formed UTF-16, so a lone surrogate never reaches the desktop. */
    record TextAction(String text) implements DesktopAction {

        public static final int MAX_CHARS = 2048;

        public TextAction {
            Objects.requireNonNull(text, "text");
            if (text.isEmpty() || text.length() > MAX_CHARS) {
                throw new IllegalArgumentException("A text action has 1 to " + MAX_CHARS + " characters");
            }
            if (!Utf8Text.isWellFormed(text)) {
                throw new IllegalArgumentException("A text action must be well-formed Unicode text");
            }
        }

        /** Two events per character; a surrogate pair is one character. */
        @Override
        public int eventCount() {
            return text.codePointCount(0, text.length()) * 2;
        }
    }
}
