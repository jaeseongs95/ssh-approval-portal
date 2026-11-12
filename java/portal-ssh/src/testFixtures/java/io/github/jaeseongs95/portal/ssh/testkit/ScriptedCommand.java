package io.github.jaeseongs95.portal.ssh.testkit;

import java.util.List;
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

    /** Writes the text to stdout, then behaves like {@link Hangs} (never ends, ignores every signal). */
    record PrintsThenHangs(String stdout) implements ScriptedCommand {
    }

    /** Never ends by itself, but ends with {@code exitCode} when the named signal arrives (a shell that dies on INT ends with 130). Other signals are ignored. */
    record EndsOnSignal(Signal signal, int exitCode) implements ScriptedCommand {
    }

    /** Writes {@code stdoutBytes} and {@code stderrBytes} of the byte {@code x} (stdout first), from another thread, then ends with the exit status. */
    record EmitsBytes(long stdoutBytes, long stderrBytes, int exitCode) implements ScriptedCommand {
    }

    /** Writes each chunk to stdout as a packet of its own (flushed after each), then ends with the exit status: the way to cut a multibyte character between packets. */
    record EmitsChunks(List<byte[]> chunks, int exitCode) implements ScriptedCommand {
        public EmitsChunks {
            chunks = List.copyOf(chunks);
        }
    }

    /** Reads the standard input to its end, writes every byte back to stdout, then ends with the exit status. */
    record EchoesInput(int exitCode) implements ScriptedCommand {
    }

    /** Ends the way a process killed by a signal ends: an {@code exit-signal} request with the name (no {@code SIG} prefix), then the channel is closed; no exit status. */
    record EndsWithSignal(String signalName) implements ScriptedCommand {
    }

    /** The server refuses the exec request: it answers {@code SSH_MSG_CHANNEL_FAILURE} when the client asked for a reply, and nothing at all when it did not. */
    record Refused() implements ScriptedCommand {
    }

    /** Closes its own channel as soon as it starts (no exit status), and leaves the session alone: the way to fail a client's write of the standard input with the session alive. */
    record ClosesChannel() implements ScriptedCommand {
    }

    /** The server cuts the connection (no disconnect message) when the exec request arrives, before it could answer: the client gets no reply and loses the transport. */
    record DropsConnection() implements ScriptedCommand {
    }

    static ScriptedCommand exits(int exitCode, String stdout, String stderr) {
        return new Exits(exitCode, stdout, stderr);
    }

    static ScriptedCommand hangs() {
        return new Hangs();
    }

    static ScriptedCommand printsThenHangs(String stdout) {
        return new PrintsThenHangs(stdout);
    }

    static ScriptedCommand endsOnSignal(Signal signal, int exitCode) {
        return new EndsOnSignal(signal, exitCode);
    }

    static ScriptedCommand emitsBytes(long stdoutBytes, long stderrBytes, int exitCode) {
        return new EmitsBytes(stdoutBytes, stderrBytes, exitCode);
    }

    static ScriptedCommand emitsChunks(List<byte[]> chunks, int exitCode) {
        return new EmitsChunks(chunks, exitCode);
    }

    static ScriptedCommand echoesInput(int exitCode) {
        return new EchoesInput(exitCode);
    }

    static ScriptedCommand endsWithSignal(String signalName) {
        return new EndsWithSignal(signalName);
    }

    static ScriptedCommand refused() {
        return new Refused();
    }

    static ScriptedCommand closesChannel() {
        return new ClosesChannel();
    }

    static ScriptedCommand dropsConnection() {
        return new DropsConnection();
    }
}
