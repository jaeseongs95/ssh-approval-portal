package io.github.jaeseongs95.portal.app.remote;

import java.nio.file.Path;
import java.time.Duration;
import java.util.Objects;

/**
 * The settings of the SSH adapter (stage 3 design 2.2, 3.5, 3.6; the 2.x values of decision D3-07). The binding from {@code bridge.*} properties is stage 4's; stage 3
 * builds the value from settings it is given. No path has a default here: the file of known hosts is an argument, because where it lives is the installation's
 * choice.
 *
 * @param connectTimeout how long a connection and its authentication may take
 * @param heartbeatInterval how often an idle session is asked to answer
 * @param heartbeatNoReplyMax how many heartbeats may go unanswered before the session is closed
 * @param idleProbeAfter how long a session may be idle before it is probed for life before a request uses it
 * @param execReplyTimeout how long the reply to an {@code exec} request is awaited when the platform awaits it
 * @param channelPermits how many channels one session may have open at once
 * @param consecutiveOpenRejections how many channel-open refusals in a row make the session be closed when it has no channel in use
 * @param hostKeyMode how an unpinned host key is checked
 * @param knownHosts the file the recorded host keys are kept in
 */
public record SshSettings(Duration connectTimeout, Duration heartbeatInterval, int heartbeatNoReplyMax, Duration idleProbeAfter, Duration execReplyTimeout, int channelPermits,
                          int consecutiveOpenRejections, HostKeyMode hostKeyMode, Path knownHosts) {

    /** 2.x connection timeout. */
    public static final Duration DEFAULT_CONNECT_TIMEOUT = Duration.ofSeconds(20);
    /** 2.x keepalive interval. */
    public static final Duration DEFAULT_HEARTBEAT_INTERVAL = Duration.ofSeconds(15);
    /** 2.x keepalive count. */
    public static final int DEFAULT_HEARTBEAT_NO_REPLY_MAX = 3;
    /** How long a session rests before it is probed. */
    public static final Duration DEFAULT_IDLE_PROBE_AFTER = Duration.ofSeconds(10);
    /** The wait for the reply to an {@code exec} request. */
    public static final Duration DEFAULT_EXEC_REPLY_TIMEOUT = Duration.ofSeconds(10);
    /** Below the 10 sessions an OpenSSH server allows by default. */
    public static final int DEFAULT_CHANNEL_PERMITS = 8;
    /** Refusals in a row after which the session is dropped. */
    public static final int DEFAULT_CONSECUTIVE_OPEN_REJECTIONS = 3;

    public SshSettings {
        requirePositive(connectTimeout, "connectTimeout");
        requirePositive(heartbeatInterval, "heartbeatInterval");
        requirePositive(idleProbeAfter, "idleProbeAfter");
        requirePositive(execReplyTimeout, "execReplyTimeout");
        Objects.requireNonNull(hostKeyMode, "hostKeyMode");
        Objects.requireNonNull(knownHosts, "knownHosts");
        if (heartbeatNoReplyMax < 1 || channelPermits < 1 || consecutiveOpenRejections < 1) {
            throw new IllegalArgumentException("heartbeatNoReplyMax, channelPermits and consecutiveOpenRejections are at least 1");
        }
    }

    /** The 2.x values, trust on first use, and the given file of known hosts. */
    public static SshSettings defaults(Path knownHosts) {
        return new SshSettings(DEFAULT_CONNECT_TIMEOUT, DEFAULT_HEARTBEAT_INTERVAL, DEFAULT_HEARTBEAT_NO_REPLY_MAX, DEFAULT_IDLE_PROBE_AFTER, DEFAULT_EXEC_REPLY_TIMEOUT,
            DEFAULT_CHANNEL_PERMITS, DEFAULT_CONSECUTIVE_OPEN_REJECTIONS, HostKeyMode.TOFU, knownHosts);
    }

    private static void requirePositive(Duration value, String name) {
        Objects.requireNonNull(value, name);
        if (value.isZero() || value.isNegative()) {
            throw new IllegalArgumentException(name + " must be positive");
        }
    }
}
