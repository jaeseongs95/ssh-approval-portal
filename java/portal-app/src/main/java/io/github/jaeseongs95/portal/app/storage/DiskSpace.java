package io.github.jaeseongs95.portal.app.storage;

/** The space a payload store may still use on its file store ({@code FileStore.getUsableSpace()}); 2.x {@code statfsSync}. */
public record DiskSpace(long usableBytes) {

    public DiskSpace {
        if (usableBytes < 0) {
            throw new IllegalArgumentException("usableBytes must not be negative: " + usableBytes);
        }
    }
}
