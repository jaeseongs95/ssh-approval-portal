package io.github.jaeseongs95.portal.ssh.testkit;

/**
 * One authentication check the test server made. The secret is never recorded.
 *
 * @param user     the user name the client presented
 * @param method   {@code password} or {@code publickey}
 * @param accepted whether the server accepted it
 */
public record AuthAttempt(String user, String method, boolean accepted) {
}
