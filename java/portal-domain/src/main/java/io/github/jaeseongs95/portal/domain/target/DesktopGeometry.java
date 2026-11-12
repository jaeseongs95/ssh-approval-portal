package io.github.jaeseongs95.portal.domain.target;

/**
 * The size of the remote desktop picture in pixels: width and height from 320 to 4096, and no more than 4194304 pixels together (2.x targets.mjs:48-52). The
 * default is 1280 by 720.
 */
public record DesktopGeometry(int width, int height) {

    public static final int MIN_SIDE = 320;
    public static final int MAX_SIDE = 4096;
    public static final int MAX_PIXELS = 4194304;

    public DesktopGeometry {
        if (width < MIN_SIDE || width > MAX_SIDE || height < MIN_SIDE || height > MAX_SIDE) {
            throw new IllegalArgumentException("Invalid desktop geometry");
        }
        if ((long) width * height > MAX_PIXELS) {
            throw new IllegalArgumentException("Desktop geometry exceeds framebuffer limit");
        }
    }

    /** The default size, 1280 by 720. */
    public static DesktopGeometry standard() {
        return new DesktopGeometry(1280, 720);
    }
}
