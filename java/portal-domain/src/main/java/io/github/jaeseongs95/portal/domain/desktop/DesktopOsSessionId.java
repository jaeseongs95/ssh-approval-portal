package io.github.jaeseongs95.portal.domain.desktop;

/** The identifier the operating system gave the desktop session: a positive number, or none (2.x desktop-state.mjs:16). */
public sealed interface DesktopOsSessionId {

    boolean isPresent();

    /** The session id is not known. */
    record NoOsSessionId() implements DesktopOsSessionId {

        @Override
        public boolean isPresent() {
            return false;
        }
    }

    /** A session id from 1 to 2^53-1 (the largest integer a JavaScript client reads exactly, as in 2.x). */
    record OsSessionNumber(long value) implements DesktopOsSessionId {

        public OsSessionNumber {
            if (value < 1 || value > DesktopBinding.MAX_EPOCH) {
                throw new IllegalArgumentException("An operating-system session id is from 1 to 2^53-1");
            }
        }

        @Override
        public boolean isPresent() {
            return true;
        }
    }
}
