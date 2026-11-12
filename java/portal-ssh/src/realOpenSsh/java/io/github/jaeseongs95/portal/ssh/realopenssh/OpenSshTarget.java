package io.github.jaeseongs95.portal.ssh.realopenssh;

import java.nio.file.Path;

/**
 * The real OpenSSH server the tests of the {@code realOpenSsh} source set run against, described by the system properties that the Gradle task {@code realOpenSshTest}
 * passes on from the Gradle properties {@code portal.test.openssh.*} (see portal-ssh/build.gradle.kts). A property that is not set fails the test with a message: no test
 * stands in for a missing server and none is skipped. System properties are read here because this is test code outside Spring; the product code never reads them.
 *
 * @param host       the host name or address of the server
 * @param port       its port
 * @param user       the account the tests log in as
 * @param keyFile    the private key file of that account (an unencrypted key)
 * @param knownHosts the known_hosts file that holds the server's host key
 * @param platform   the operating system of the server
 */
record OpenSshTarget(String host, int port, String user, Path keyFile, Path knownHosts, Platform platform) {

    /** The operating system of the server; the tests choose the commands of that system's default shell by it. */
    enum Platform {
        LINUX, WINDOWS;

        static Platform parse(String text) {
            return switch (text) {
                case "linux" -> LINUX;
                case "windows" -> WINDOWS;
                default -> throw new IllegalStateException("portal.test.openssh.platform must be linux or windows, not: " + text);
            };
        }
    }

    private static final String PREFIX = "portal.test.openssh.";

    /** Reads the target from the system properties; fails when one is missing. */
    static OpenSshTarget fromSystemProperties() {
        return new OpenSshTarget(
            required("host"),
            Integer.parseInt(required("port")),
            required("user"),
            Path.of(required("key-file")),
            Path.of(required("known-hosts")),
            Platform.parse(required("platform")));
    }

    private static String required(String name) {
        String value = System.getProperty(PREFIX + name);
        if (value == null || value.isBlank()) {
            throw new IllegalStateException("the system property " + PREFIX + name + " is not set: run these tests with the Gradle task realOpenSshTest and its properties");
        }
        return value;
    }
}
