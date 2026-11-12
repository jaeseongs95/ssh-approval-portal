package io.github.jaeseongs95.portal.ssh.testkit;

import org.apache.sshd.server.Signal;

/**
 * One {@code signal} channel request (RFC 4254 6.9) that the test server delivered to a scripted command through its {@code Environment} signal listener.
 *
 * @param command the exec command text of the channel that received it
 * @param signal  the signal; names MINA does not know are not delivered and so never appear here
 */
public record ReceivedSignal(String command, Signal signal) {
}
