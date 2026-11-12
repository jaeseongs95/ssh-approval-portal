package io.github.jaeseongs95.portal.ssh.sftp;

import io.github.jaeseongs95.portal.app.output.StreamFrame;
import io.github.jaeseongs95.portal.app.output.StreamKind;
import io.github.jaeseongs95.portal.app.remote.ExecutionControl;
import io.github.jaeseongs95.portal.app.remote.ExecutionReport;
import io.github.jaeseongs95.portal.app.remote.ExecutionTimeline;
import io.github.jaeseongs95.portal.app.remote.OutputSink;
import io.github.jaeseongs95.portal.app.remote.RemoteExecution;
import io.github.jaeseongs95.portal.app.remote.RemoteExecutor;
import io.github.jaeseongs95.portal.domain.error.ExecutionErrorCode;
import io.github.jaeseongs95.portal.domain.error.ExecutionFailure;
import io.github.jaeseongs95.portal.domain.error.ExecutionStage;
import io.github.jaeseongs95.portal.domain.error.RemoteOutcome;
import io.github.jaeseongs95.portal.domain.operation.ExecutionOutcome;
import io.github.jaeseongs95.portal.domain.operation.ExecutionReason;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.CopyOnWriteArrayList;
import java.util.function.Function;

/**
 * A {@link RemoteExecutor} for the tests of the file adapter's elevated paths: it runs nothing and answers each command line by a rule the test gives (what the command
 * would print and how it would end). It records every command line and its standard input, in order, so a test can say which fixed commands were sent and which were
 * not. The real executor is another module's work and is tested there.
 */
final class ScriptedExecutor implements RemoteExecutor {

    /** What a command does on the target, as the test wants it: print this and end this way. */
    sealed interface Answer permits Answer.Exits, Answer.NotSent, Answer.Lost {
        record Exits(int code, String stdout) implements Answer {
        }

        /** The connection failed before the request: nothing reached the target. */
        record NotSent() implements Answer {
        }

        /** The request was written and the connection was lost: whether it ran is not known. */
        record Lost() implements Answer {
        }
    }

    /** One command line the executor was asked to run, with its standard input. */
    record Run(String commandLine, byte[] stdin) {
    }

    private final List<Run> runs = new CopyOnWriteArrayList<>();
    private final Function<String, Answer> rule;

    ScriptedExecutor(Function<String, Answer> rule) {
        this.rule = rule;
    }

    /** An executor on which every command ends with 0 and prints nothing. */
    static ScriptedExecutor everythingSucceeds() {
        return new ScriptedExecutor(commandLine -> new Answer.Exits(0, ""));
    }

    List<Run> runs() {
        return new ArrayList<>(runs);
    }

    List<String> commandLines() {
        return runs.stream().map(Run::commandLine).toList();
    }

    @Override
    public ExecutionReport run(RemoteExecution request, OutputSink sink, ExecutionControl control) {
        runs.add(new Run(request.command().commandLine(), request.command().stdin().bytes()));
        Answer answer = rule.apply(request.command().commandLine());
        return switch (answer) {
            case Answer.Exits exits -> {
                if (!exits.stdout().isEmpty()) {
                    sink.accept(new StreamFrame(StreamKind.STDOUT, exits.stdout().getBytes(StandardCharsets.UTF_8)));
                }
                yield new ExecutionReport(ExecutionOutcome.exited(exits.code(), List.of()), ExecutionTimeline.empty());
            }
            case Answer.NotSent notSent -> new ExecutionReport(ExecutionOutcome.notDispatched(ExecutionReason.CHANNEL_OPEN_FAILED, List.of()), ExecutionTimeline.empty());
            case Answer.Lost lost -> new ExecutionReport(ExecutionOutcome.transportLost(
                new ExecutionFailure.Classified(ExecutionStage.SSH_EXECUTION, ExecutionErrorCode.SSH_EXECUTION_FAILED, RemoteOutcome.UNKNOWN), List.of()), ExecutionTimeline.empty());
        };
    }
}
