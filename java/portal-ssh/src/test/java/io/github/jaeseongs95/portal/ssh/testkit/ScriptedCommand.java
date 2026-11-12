package io.github.jaeseongs95.portal.ssh.testkit;

import org.apache.sshd.server.Signal;

/**
 * What a fake exec command does on the test server. The server runs no shell: it looks the command text up in its script table
 * ({@link EmbeddedSshServer.Builder#script(String, ScriptedCommand)}) and plays the script. Every script records the {@code signal} requests it receives
 * ({@link EmbeddedSshServer#receivedSignals()}); only {@link EndsOnSignal} reacts to one, so every other script ignores signals.
 */
public sealed interface ScriptedCommand {

    /** Writes the two texts (UTF-8) and ends with the exit status. */
    record Exits(int exitCode, String stdout, String stderr) implements ScriptedCommand {
    }

    /** Never ends by itself and ignores every signal; only the end of the channel (the server calls {@code destroy}) or the end of the session stops it. */
    record Hangs() implements ScriptedCommand {
    }

    /** Never ends by itself, but ends with {@code exitCode} when the named signal arrives (a shell that dies on INT ends with 130). Other signals are ignored. */
    record EndsOnSignal(Signal signal, int exitCode) implements ScriptedCommand {
    }

    /** Writes {@code stdoutBytes} and {@code stderrBytes} of the byte {@code x} (stdout first), from another thread, then ends with the exit status. */
    record EmitsBytes(long stdoutBytes, long stderrBytes, int exitCode) implements ScriptedCommand {
    }

    /** The server refuses the exec request: it answers {@code SSH_MSG_CHANNEL_FAILURE} when the client asked for a reply, and nothing at all when it did not. */
    record Refused() implements ScriptedCommand {
    }

    static ScriptedCommand exits(int exitCode, String stdout, String stderr) {
        return new Exits(exitCode, stdout, stderr);
    }

    static ScriptedCommand hangs() {
        return new Hangs();
    }

    static ScriptedCommand endsOnSignal(Signal signal, int exitCode) {
        return new EndsOnSignal(signal, exitCode);
    }

    static ScriptedCommand emitsBytes(long stdoutBytes, long stderrBytes, int exitCode) {
        return new EmitsBytes(stdoutBytes, stderrBytes, exitCode);
    }

    static ScriptedCommand refused() {
        return new Refused();
    }
}
