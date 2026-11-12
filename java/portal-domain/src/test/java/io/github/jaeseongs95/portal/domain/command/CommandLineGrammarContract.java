package io.github.jaeseongs95.portal.domain.command;

import static org.assertj.core.api.Assertions.assertThat;

import io.github.jaeseongs95.portal.domain.text.CommandText;
import java.util.List;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

/**
 * The contract every {@link CommandLineGrammar} keeps (stage 2 design 6.3), as a test frame. The POSIX and the PowerShell grammar are built in stage 3; each
 * implementation's test extends this class and supplies the grammar and a few commands of its own language, so the same checks run against both and a new shell
 * gets them for free. Subclassing a test class is the way JUnit shares a contract across implementations.
 *
 * <p>This class has no implementation of its own to run against, so JUnit does not run it here; stage 3 makes it visible to the SSH module's tests.
 */
public abstract class CommandLineGrammarContract {

    /** The grammar under test. */
    protected abstract CommandLineGrammar grammar();

    /** Command lines of the grammar's language that it must read completely: every name known. */
    protected abstract List<String> completeCommands();

    /** Command lines with a construct the grammar does not know (an expansion, a substitution, a quoting it refuses): it must answer incomplete, never throw. */
    protected abstract List<String> unsupportedCommands();

    /** Texts that are names in this grammar. */
    protected abstract List<String> acceptablePolicyNames();

    /** Texts that are not names in this grammar. */
    protected abstract List<String> unacceptablePolicyNames();

    @Test
    @DisplayName("grammar contract: a complete line names at least one program and every name is a comparison key")
    public void completeLinesNameTheirPrograms() {
        assertThat(completeCommands()).isNotEmpty();
        for (String command : completeCommands()) {
            CommandLineAnalysis analysis = grammar().analyze(new CommandText(command));
            assertThat(analysis.isComplete()).as(command).isTrue();
            assertThat(analysis.names()).as(command).isNotEmpty();
            for (String name : analysis.names()) {
                assertThat(grammar().normalize(name)).as(command + " -> " + name).isInstanceOf(NormalizedName.Accepted.class);
            }
        }
    }

    @Test
    @DisplayName("grammar contract: what the grammar does not know is incomplete, not an exception, and the line is left to the full evaluation")
    public void unsupportedLinesAreIncomplete() {
        assertThat(unsupportedCommands()).isNotEmpty();
        for (String command : unsupportedCommands()) {
            CommandLineAnalysis analysis = grammar().analyze(new CommandText(command));
            assertThat(analysis.isComplete()).as(command).isFalse();
        }
    }

    @Test
    @DisplayName("grammar contract: the answer depends on the command text only")
    public void theAnswerIsDeterministic() {
        for (String command : completeCommands()) {
            assertThat(grammar().analyze(new CommandText(command))).as(command).isEqualTo(grammar().analyze(new CommandText(command)));
        }
        for (String command : unsupportedCommands()) {
            assertThat(grammar().analyze(new CommandText(command))).as(command).isEqualTo(grammar().analyze(new CommandText(command)));
        }
    }

    @Test
    @DisplayName("grammar contract: a name is accepted or refused as an answer; a refusal is not an exception")
    public void namesAreAcceptedOrRefused() {
        for (String name : acceptablePolicyNames()) {
            assertThat(grammar().normalize(name)).as(name).isInstanceOf(NormalizedName.Accepted.class);
        }
        for (String name : unacceptablePolicyNames()) {
            assertThat(grammar().normalize(name)).as(name).isInstanceOf(NormalizedName.Rejected.class);
        }
    }

    @Test
    @DisplayName("grammar contract: the grammar states the operating system whose shell it reads")
    public void thePlatformIsStated() {
        assertThat(grammar().platform()).isNotNull();
    }
}
