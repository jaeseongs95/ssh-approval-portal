package io.github.jaeseongs95.portal.ssh.testkit;

import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.nio.charset.StandardCharsets;
import java.util.Arrays;
import java.util.concurrent.atomic.AtomicBoolean;
import org.apache.sshd.common.SshConstants;
import org.apache.sshd.common.session.Session;
import org.apache.sshd.common.util.buffer.Buffer;
import org.apache.sshd.server.Environment;
import org.apache.sshd.server.ExitCallback;
import org.apache.sshd.server.channel.ChannelSession;
import org.apache.sshd.server.command.Command;
import org.springframework.core.task.TaskExecutor;

/**
 * The server side of one exec channel: plays a {@link ScriptedCommand} and records what the test needs to see (the start, the signals, the destroy).
 * The command runs on the thread that handles the exec request, except {@link ScriptedCommand.EmitsBytes} and {@link ScriptedCommand.EchoesInput}, whose reads and writes can
 * block on the SSH window and so run on the server's {@link TaskExecutor}: a blocked write on the I/O thread would also block the window adjustments that unblock it.
 */
final class ScriptedCommandSession implements Command {

    private static final int CHUNK = 16 * 1024;

    private final String text;
    private final ScriptedCommand script;
    private final TaskExecutor executor;
    private final EventLog<String> started;
    private final EventLog<ReceivedSignal> signals;
    private final EventLog<String> destroyed;
    private final AtomicBoolean ended = new AtomicBoolean();
    private InputStream in;
    private OutputStream out;
    private OutputStream err;
    private ExitCallback exit;

    ScriptedCommandSession(String text, ScriptedCommand script, TaskExecutor executor, EventLog<String> started, EventLog<ReceivedSignal> signals,
        EventLog<String> destroyed) {
        this.text = text;
        this.script = script;
        this.executor = executor;
        this.started = started;
        this.signals = signals;
        this.destroyed = destroyed;
    }

    @Override
    public void setInputStream(InputStream in) {
        this.in = in;
    }

    @Override
    public void setOutputStream(OutputStream out) {
        this.out = out;
    }

    @Override
    public void setErrorStream(OutputStream err) {
        this.err = err;
    }

    @Override
    public void setExitCallback(ExitCallback callback) {
        this.exit = callback;
    }

    @Override
    public void start(ChannelSession channel, Environment env) throws IOException {
        env.addSignalListener((signalChannel, signal) -> {
            signals.add(new ReceivedSignal(text, signal));
            if (script instanceof ScriptedCommand.EndsOnSignal reacting && reacting.signal().equals(signal)) {
                end(reacting.exitCode());
            }
        });
        started.add(text);
        switch (script) {
            case ScriptedCommand.Exits exits -> {
                write(out, exits.stdout());
                write(err, exits.stderr());
                end(exits.exitCode());
            }
            case ScriptedCommand.Hangs hangs -> {
                // Nothing to do: it ends only when the channel is destroyed.
            }
            case ScriptedCommand.PrintsThenHangs prints -> write(out, prints.stdout());
            case ScriptedCommand.EndsOnSignal endsOnSignal -> {
                // It ends from the signal listener above.
            }
            case ScriptedCommand.EmitsBytes emits -> executor.execute(() -> emit(emits));
            case ScriptedCommand.EmitsChunks chunks -> {
                for (byte[] chunk : chunks.chunks()) {
                    out.write(chunk);
                    out.flush();
                }
                end(chunks.exitCode());
            }
            case ScriptedCommand.EchoesInput echoes -> executor.execute(() -> echo(echoes));
            case ScriptedCommand.EndsWithSignal endsWithSignal -> endWithSignal(channel, endsWithSignal.signalName());
            case ScriptedCommand.ClosesChannel closes -> {
                ended.set(true);
                // Graceful: MINA sends SSH_MSG_CHANNEL_CLOSE only for close(false); close(true) closes the server side silently and the client never learns of it
                // (AbstractChannel.GracefulChannelCloseable.close: "immediately" just marks the graceful close done).
                channel.close(false);
            }
            case ScriptedCommand.Refused refused -> throw new IllegalStateException("a refused command is never started: " + text);
            case ScriptedCommand.DropsConnection drops -> throw new IllegalStateException("a connection-dropping command is never started: " + text);
        }
    }

    @Override
    public void destroy(ChannelSession channel) {
        ended.set(true);
        destroyed.add(text);
    }

    private void end(int exitCode) {
        if (ended.compareAndSet(false, true)) {
            exit.onExit(exitCode);
        }
    }

    private void endWithSignal(ChannelSession channel, String signalName) throws IOException {
        if (!ended.compareAndSet(false, true)) {
            return;
        }
        Session session = channel.getSession();
        Buffer buffer = session.createBuffer(SshConstants.SSH_MSG_CHANNEL_REQUEST);
        buffer.putUInt(channel.getRecipient());
        buffer.putString("exit-signal");
        buffer.putBoolean(false);
        buffer.putString(signalName);
        buffer.putBoolean(false); // core dumped
        buffer.putString(""); // error message
        buffer.putString(""); // language tag
        session.writePacket(buffer);
        channel.close(false);
    }

    private void write(OutputStream stream, String content) throws IOException {
        if (!content.isEmpty()) {
            stream.write(content.getBytes(StandardCharsets.UTF_8));
            stream.flush();
        }
    }

    private void emit(ScriptedCommand.EmitsBytes emits) {
        try {
            emitBytes(out, emits.stdoutBytes());
            emitBytes(err, emits.stderrBytes());
        } catch (IOException e) {
            // The client closed the channel (or the session ended): nobody is left to receive the rest, and destroy() has recorded the end.
            return;
        }
        end(emits.exitCode());
    }

    private void echo(ScriptedCommand.EchoesInput echoes) {
        try {
            byte[] buffer = new byte[CHUNK];
            int count = in.read(buffer);
            while (count >= 0) {
                out.write(buffer, 0, count);
                out.flush();
                count = in.read(buffer);
            }
        } catch (IOException e) {
            return;
        }
        end(echoes.exitCode());
    }

    private void emitBytes(OutputStream stream, long total) throws IOException {
        byte[] chunk = new byte[CHUNK];
        Arrays.fill(chunk, (byte) 'x');
        long remaining = total;
        while (remaining > 0) {
            int size = (int) Math.min(chunk.length, remaining);
            stream.write(chunk, 0, size);
            remaining -= size;
        }
        stream.flush();
    }
}
