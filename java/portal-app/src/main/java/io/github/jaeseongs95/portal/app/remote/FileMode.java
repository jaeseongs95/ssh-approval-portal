package io.github.jaeseongs95.portal.app.remote;

/**
 * The permission bits of a file: owner, group and others, read, write and execute, 0 to 0777. The special bits (setuid, setgid, sticky) are not part of it.
 *
 * @param bits the nine permission bits as an integer
 */
public record FileMode(int bits) {

    private static final int MAX = 0777;

    public FileMode {
        if (bits < 0 || bits > MAX) {
            throw new IllegalArgumentException("A file mode is 0 to 0777");
        }
    }

    /** The mode as three octal digits, for example {@code 600}. */
    public String octal() {
        String digits = Integer.toOctalString(bits);
        return "0".repeat(3 - digits.length()) + digits;
    }
}
