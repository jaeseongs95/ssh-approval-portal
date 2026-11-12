package io.github.jaeseongs95.portal.ssh.platform;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatCode;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import io.github.jaeseongs95.portal.domain.command.CommandLineAnalysis;
import io.github.jaeseongs95.portal.domain.command.Completeness;
import io.github.jaeseongs95.portal.domain.command.NormalizedName;
import io.github.jaeseongs95.portal.domain.command.SudoUse;
import io.github.jaeseongs95.portal.domain.text.CommandText;
import java.nio.charset.StandardCharsets;
import java.util.List;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

/**
 * The POSIX command-line name grammar, against the cases of 2.x test/command-line.test.mjs, test/command-limits.test.mjs and test/multiline-commands.test.mjs.
 * The four checks of {@code CommandLineGrammarContract} are written out here (the contract class is not on the classpath of this module's tests): a complete
 * line names its programs and every name is a comparison key, an unknown construct is incomplete and not an exception, the answer depends on the text only, and a
 * name is accepted or refused as an answer.
 */
class PosixCommandLineGrammarTest {

    private final PosixCommandLineGrammar grammar = new PosixCommandLineGrammar();

    /** A line the grammar reads completely and the names it must find, in the order it finds them. */
    private record Reads(String line, List<String> names) {
    }

    private static Reads reads(String line, String... names) {
        return new Reads(line, List.of(names));
    }

    private CommandLineAnalysis analyze(String line) {
        return grammar.analyze(new CommandText(line));
    }

    private void assertReadsCompletely(List<Reads> cases) {
        for (Reads expected : cases) {
            CommandLineAnalysis analysis = analyze(expected.line());
            assertThat(analysis.isComplete()).as(expected.line()).isTrue();
            assertThat(analysis.names()).as(expected.line()).containsExactlyElementsOf(expected.names());
        }
    }

    private void assertIncomplete(List<String> lines) {
        for (String line : lines) {
            assertThat(analyze(line).isComplete()).as(line).isFalse();
        }
    }

    // ---- the four checks of CommandLineGrammarContract ----

    @Test
    @DisplayName("grammar contract: a complete line names at least one program and every name is a comparison key")
    void completeLinesNameTheirPrograms() {
        List<String> completeCommands = List.of("ls -la /tmp", "ls && pwd | grep home", "sudo -n ls", "bash -lc \"ls && pwd\"", "ls $(pwd)", "ls > /tmp/file");
        for (String command : completeCommands) {
            CommandLineAnalysis analysis = analyze(command);
            assertThat(analysis.isComplete()).as(command).isTrue();
            assertThat(analysis.names()).as(command).isNotEmpty();
            for (String name : analysis.names()) {
                assertThat(grammar.normalize(name)).as(command + " -> " + name).isInstanceOf(NormalizedName.Accepted.class);
            }
        }
    }

    @Test
    @DisplayName("grammar contract: what the grammar does not know is incomplete, not an exception, and the line is left to the full evaluation")
    void unsupportedLinesAreIncomplete() {
        List<String> unsupportedCommands = List.of("ls &&", "${CMD} x", "ls\nrm x", "cat <<EOF", "(ls; rm x)", "ls \"unterminated", "if true; then rm x; fi", "ls <(id)");
        for (String command : unsupportedCommands) {
            assertThatCode(() -> analyze(command)).as(command).doesNotThrowAnyException();
            assertThat(analyze(command).completeness()).as(command).isEqualTo(Completeness.INCOMPLETE);
        }
    }

    @Test
    @DisplayName("grammar contract: the answer depends on the command text only")
    void theAnswerIsDeterministic() {
        List<String> commands = List.of("ls && pwd", "sudo -n ls", "ls $(id)", "ls &&", "bash -c \"ls\"");
        for (String command : commands) {
            CommandLineAnalysis first = analyze(command);
            analyze("sudo -l");
            analyze("ls $(unterminated");
            assertThat(analyze(command)).as(command).isEqualTo(first);
            assertThat(new PosixCommandLineGrammar().analyze(new CommandText(command))).as(command + " by another instance").isEqualTo(first);
        }
    }

    @Test
    @DisplayName("grammar contract: a name is accepted or refused as an answer; a refusal is not an exception")
    void namesAreAcceptedOrRefused() {
        for (String name : List.of("ls", "git-lfs", "python3.12", "g++", "_x", "A9", "a".repeat(80))) {
            assertThat(grammar.normalize(name)).as(name).isInstanceOf(NormalizedName.Accepted.class);
        }
        for (String name : List.of("", "-ls", ".hidden", "ls rm", "ls;rm", "/usr/bin/ls", "가나", "a".repeat(81))) {
            assertThat(grammar.normalize(name)).as(name).isInstanceOf(NormalizedName.Rejected.class);
        }
        assertThat(grammar.normalize("git-lfs")).isInstanceOfSatisfying(NormalizedName.Accepted.class, accepted -> assertThat(accepted.name().key()).isEqualTo("git-lfs"));
    }

    @Test
    @DisplayName("grammar contract: the grammar states the operating system whose shell it reads")
    void thePlatformIsStated() {
        assertThat(grammar.platform().wire()).isEqualTo("linux");
    }

    // ---- 2.x cases ----

    @Test
    @DisplayName("RC-A-464: every shell segment and literal substitution contributes a name, and argument risk is not looked at (23 inputs of command-line.test.mjs:5)")
    void everySegmentAndLiteralSubstitutionContributesNames() {
        List<Reads> cases = List.of(
            reads("env CMD=rm sh -c \"$CMD\"", "env"),
            reads("python3 -c \"code\"", "python3"),
            reads("find /tmp -exec rm {} +", "find"),
            reads("bash script.sh", "bash"),
            reads("ls -la /tmp", "ls"),
            reads("rm -rf /tmp/fixture", "rm"),
            reads("ls && pwd", "ls", "pwd"),
            reads("ls; pwd | grep home || id", "ls", "pwd", "grep", "id"),
            reads("ls & pwd", "ls", "pwd"),
            reads("ls \"a; rm x\"", "ls"),
            reads("grep '$(rm x)' /tmp/data", "grep"),
            reads("ls $(pwd)", "pwd", "ls"),
            reads("ls \"$(id)\"", "id", "ls"),
            reads("ls `pwd`", "pwd", "ls"),
            reads("bash -lc \"ls && pwd\"", "bash", "ls", "pwd"),
            reads("sh -ec \"ls && pwd\"", "sh", "ls", "pwd"),
            reads("bash --noprofile -l -c \"ls && pwd\" extra", "bash", "ls", "pwd"),
            reads("sh -c \"ls && pwd\"", "sh", "ls", "pwd"),
            reads("ls > /tmp/file", "ls"),
            reads("2>/tmp/file rm x", "rm"),
            reads("ls 2> /tmp/file", "ls"),
            reads("ls >$(pwd)", "pwd", "ls"),
            reads("l's' /tmp", "ls"));
        assertThat(cases).as("the inputs of command-line.test.mjs:5").hasSize(23);
        assertReadsCompletely(cases);
    }

    @Test
    @DisplayName("RC-A-464: the names keep the order they are found in; a name that appears twice is listed once")
    void namesKeepInsertionOrderWithoutDuplicates() {
        assertReadsCompletely(List.of(
            reads("pwd;pwd && ls", "pwd", "ls"),
            reads("ls $(ls $(pwd))", "pwd", "ls"),
            reads("grep a | grep b | sort", "grep", "sort")));
    }

    @Test
    @DisplayName("RC-A-465: syntax the grammar is not sure of cannot establish an all-names approval (17 inputs and a 25-level nesting of command-line.test.mjs:16)")
    void uncertainSyntaxIsIncomplete() {
        List<String> lines = List.of("ls &&", "ls |", "ls ||", "ls; ; rm x", "ls \"unterminated", "ls $(id", "${CMD} x", "$(pwd) x", "ls\nrm x", "if true; then rm x; fi",
            "(ls; rm x)", "ls <(id)", "cat <<EOF", "ls $((1+1))", "'A=x' ls", "A=x ls", "ls custom");
        assertThat(lines).as("the inputs of command-line.test.mjs:16").hasSize(17);
        assertIncomplete(lines);
        String nested = "ls";
        for (int level = 0; level < 25; level++) {
            nested = "ls $(" + nested + ")";
        }
        assertThat(analyze(nested).isComplete()).as("25 levels of $(...)").isFalse();
    }

    @Test
    @DisplayName("RC-A-465: nesting is read up to 16 levels; the 17th makes the line incomplete")
    void nestingIsBoundedBySixteen() {
        assertThat(analyze(nestedSubstitutions(16)).isComplete()).as("16 levels").isTrue();
        assertThat(analyze(nestedSubstitutions(17)).isComplete()).as("17 levels").isFalse();
    }

    private String nestedSubstitutions(int levels) {
        String nested = "ls";
        for (int level = 0; level < levels; level++) {
            nested = "ls $(" + nested + ")";
        }
        return nested;
    }

    @Test
    @DisplayName("RC-A-465: a line the grammar cannot finish names what it found and says it is incomplete")
    void incompleteLinesKeepTheNamesFound() {
        CommandLineAnalysis analysis = analyze("sh -c \"ls &&\"");
        assertThat(analysis.isComplete()).isFalse();
        assertThat(analysis.names()).containsExactly("sh", "ls");
        assertThat(analyze("ls &&").names()).containsExactly("ls");
    }

    @Test
    @DisplayName("RC-A-465: an unclosed or dangling construct is incomplete and never an exception")
    void danglingConstructsDoNotThrow() {
        List<String> lines = List.of("ls \\", "ls $", "`", ")", "&", ">", "$(", "'", "\"", "#", "ls `pwd", "ls `a\\b`", "ls 2>", "ls >", "ls >>", "ls <<", "ls >&2",
            "sh -c", "sh -c \"$X\"", "bash +c \"ls\"", "ls $(ls |)", "ls $()", "ls $(", "ls ${A}", "ls $(( 1 ))");
        for (String line : lines) {
            assertThatCode(() -> analyze(line)).as(line).doesNotThrowAnyException();
            assertThat(analyze(line).isComplete()).as(line).isFalse();
        }
    }

    @Test
    @DisplayName("RC-A-466: sudo is a separate authority and the program behind it still contributes a name")
    void sudoIsSeparateAuthorityAndItsProgramStillContributesAName() {
        List<Reads> cases = List.of(
            reads("bash +e -c \"sudo id\"", "bash", "sudo", "id"),
            reads("bash -lc \"sudo id\"", "bash", "sudo", "id"),
            reads("sudo -n ls", "sudo", "ls"),
            reads("sudo -u root rm -rf /tmp/x", "sudo", "rm"),
            reads("sudo --user=root id", "sudo", "id"),
            reads("sudo -l", "sudo"),
            reads("ls $(sudo -n id)", "sudo", "id", "ls"));
        assertThat(cases).as("the inputs of command-line.test.mjs:22").hasSize(7);
        assertReadsCompletely(cases);
        for (Reads expected : cases) {
            assertThat(analyze(expected.line()).usesSudo()).as(expected.line()).isTrue();
            assertThat(analyze(expected.line()).sudo()).as(expected.line()).isEqualTo(SudoUse.USES_SUDO);
        }
    }

    @Test
    @DisplayName("RC-A-466: sudo by a path is seen as sudo but is not a name the grammar can match; sudo inside a quoted word is not a use of sudo")
    void sudoByPathAndSudoInsideAString() {
        CommandLineAnalysis byPath = analyze("/usr/bin/sudo -n ls");
        assertThat(byPath.usesSudo()).isTrue();
        assertThat(byPath.isComplete()).isFalse();
        CommandLineAnalysis quoted = analyze("printf 'sudo rm' ");
        assertThat(quoted.usesSudo()).isFalse();
        assertThat(quoted.sudo()).isEqualTo(SudoUse.NO_SUDO);
        assertThat(quoted.isComplete()).isTrue();
        assertThat(quoted.names()).containsExactly("printf");
    }

    @Test
    @DisplayName("RC-A-466: the sudo flag table (branches of command-line.mjs beyond the 2.x test)")
    void sudoFlagTable() {
        assertReadsCompletely(List.of(
            reads("sudo -E -n ls", "sudo", "ls"),
            reads("sudo -- ls", "sudo", "ls"),
            reads("sudo -g wheel -H id", "sudo", "id"),
            reads("sudo --list", "sudo"),
            reads("sudo sudo id", "sudo", "id")));
        assertIncomplete(List.of("sudo", "sudo -u", "sudo -u $USER ls", "sudo -x ls", "sudo -l ls", "sudo -- ", "sudo $X"));
        assertThat(analyze("sudo -x ls").usesSudo()).isTrue();
    }

    @Test
    @DisplayName("RC-A-479: a long command is read to its tail (ls, 32000 spaces, then rm)")
    void aLongCommandIsReadToItsTail() {
        CommandLineAnalysis analysis = analyze("ls " + " ".repeat(32000) + "; rm /tmp/synthetic-only");
        assertThat(analysis.isComplete()).isTrue();
        assertThat(analysis.names()).containsExactly("ls", "rm");
    }

    @Test
    @DisplayName("RC-A-479: a command of exactly 32 KiB is read completely (command-limits.test.mjs:15, LIMIT-ASCII)")
    void aCommandOfExactly32KiBIsRead() {
        String tail = "END_MARKER";
        String printf = "printf " + "x".repeat(32768 - 7 - tail.length()) + tail;
        String spaces = "ls" + " ".repeat(32766);
        for (String command : List.of(printf, spaces)) {
            assertThat(command.getBytes(StandardCharsets.UTF_8)).hasSize(32768);
            CommandLineAnalysis analysis = analyze(command);
            assertThat(analysis.isComplete()).isTrue();
            assertThat(analysis.names()).hasSize(1);
        }
        assertThat(analyze(spaces).names()).containsExactly("ls");
        assertThat(analyze(printf).names()).containsExactly("printf");
    }

    @Test
    @DisplayName("RC-A-479: a command above 32 KiB cannot be made at all; CommandText refuses it before the grammar is asked")
    void aCommandAbove32KiBIsRefusedByCommandText() {
        assertThatThrownBy(() -> new CommandText("ls" + " ".repeat(32767))).isInstanceOf(IllegalArgumentException.class);
    }

    @Test
    @DisplayName("RC-A-480: repeated sudo beyond the bounded grammar is incomplete; two sudo are complete")
    void repeatedSudoBeyondTheBoundIsIncomplete() {
        assertThat(analyze("sudo ".repeat(17) + "id").isComplete()).as("17 sudo").isFalse();
        assertThat(analyze("sudo ".repeat(6500) + "id").isComplete()).as("6500 sudo (the largest repetition CommandText allows is about 6550)").isFalse();
        CommandLineAnalysis twice = analyze("sudo sudo id");
        assertThat(twice.isComplete()).isTrue();
        assertThat(twice.names()).containsExactly("sudo", "id");
        assertThat(twice.usesSudo()).isTrue();
        // 2.x also read 10000 repetitions (50 000 bytes) as incomplete; here that text is above the 32 KiB limit of CommandText and cannot reach the grammar.
        assertThatThrownBy(() -> new CommandText("sudo ".repeat(10000) + "id")).isInstanceOf(IllegalArgumentException.class);
        assertThat(analyze("sudo ".repeat(16) + "id").isComplete()).as("16 sudo").isTrue();
    }

    @Test
    @DisplayName("RC-B-075: a multiline command never gives a partial name approval (9 Linux inputs of multiline-commands.test.mjs:99)")
    void multilineCommandsAreIncomplete() {
        List<String> lines = List.of(
            "cat <<'EOF'\n한글 $HOME `literal`\nEOF\n",
            "VALUE=expanded\ncat <<EOF\n$VALUE\nEOF\n",
            "cat <<-'EOF'\n\t한글\n\tEOF\n",
            "cat <<'EOF' | tr a-z A-Z\nhello\nEOF\nprintf 'done'\n",
            "ls\nid", "ls\r\nid", "ls\n", "\nls", "ls\nrm synthetic");
        assertThat(lines).hasSize(9);
        assertIncomplete(lines);
        for (String line : lines) {
            assertThat(analyze(line).names()).as(line).doesNotContain("rm");
        }
    }

    @Test
    @DisplayName("RC-B-075: a TAB is only a word separator, so a TAB-separated line is still read (only line breaks make a line incomplete)")
    void aTabIsNotALineBreak() {
        CommandLineAnalysis analysis = analyze("ls\t-la\t/tmp");
        assertThat(analysis.isComplete()).isTrue();
        assertThat(analysis.names()).containsExactly("ls");
    }
}
