package io.github.jaeseongs95.portal.ssh.platform;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatCode;

import io.github.jaeseongs95.portal.domain.command.CommandLineAnalysis;
import io.github.jaeseongs95.portal.domain.command.Completeness;
import io.github.jaeseongs95.portal.domain.command.NormalizedName;
import io.github.jaeseongs95.portal.domain.command.SudoUse;
import io.github.jaeseongs95.portal.domain.text.CommandText;
import java.util.List;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

/**
 * The PowerShell command-line name grammar, against the cases of 2.x test/windows-command-line.test.mjs and test/multiline-commands.test.mjs. The checks of
 * {@code CommandLineGrammarContract} are written out here (the contract class is not on the classpath of this module's tests): a complete line names its programs
 * and every name is a comparison key, an unknown construct is incomplete and not an exception, the answer depends on the text only, and a name is accepted or
 * refused as an answer.
 */
class WindowsCommandLineGrammarTest {

    private static final CommandLineAnalysis NOTHING_KNOWN = new CommandLineAnalysis(List.of(), Completeness.INCOMPLETE, SudoUse.NO_SUDO);

    private final WindowsCommandLineGrammar grammar = new WindowsCommandLineGrammar();

    /** A line the grammar reads completely and the names (comparison keys) it must find, in the order it finds them. */
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
            assertThat(analysis.sudo()).as(expected.line()).isEqualTo(SudoUse.NO_SUDO);
        }
    }

    private void assertIncomplete(List<String> lines) {
        for (String line : lines) {
            assertThat(analyze(line).isComplete()).as(line).isFalse();
        }
    }

    // ---- the checks of CommandLineGrammarContract ----

    @Test
    @DisplayName("grammar contract: a complete line names at least one program and every name is a comparison key")
    void completeLinesNameTheirPrograms() {
        List<String> completeCommands = List.of("whoami.exe /user", "Microsoft.PowerShell.Utility\\Get-Date -Format \"yyyy-MM-dd\"",
            "& 'C:/Program Files/Tool.EXE' 'owner''s data'", "whoami.exe | hostname.exe; whoami.exe");
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
        List<String> unsupportedCommands = List.of("ls", "Get-Date", "$name arg", "whoami.exe |", "whoami.exe\n", "whoami.exe > out.txt", "whoami.exe `x", "& {whoami.exe}");
        for (String command : unsupportedCommands) {
            assertThatCode(() -> analyze(command)).as(command).doesNotThrowAnyException();
            assertThat(analyze(command).completeness()).as(command).isEqualTo(Completeness.INCOMPLETE);
        }
    }

    @Test
    @DisplayName("grammar contract: the answer depends on the command text only")
    void theAnswerIsDeterministic() {
        List<String> commands = List.of("whoami.exe | hostname.exe", "& 'C:/Program Files/Tool.EXE' arg", "whoami.exe |", "ls");
        for (String command : commands) {
            CommandLineAnalysis first = analyze(command);
            analyze("whoami.exe '");
            analyze("hostname.exe; calc.exe");
            assertThat(analyze(command)).as(command).isEqualTo(first);
            assertThat(new WindowsCommandLineGrammar().analyze(new CommandText(command))).as(command + " by another instance").isEqualTo(first);
        }
    }

    @Test
    @DisplayName("grammar contract: a name is accepted or refused as an answer; a refusal is not an exception")
    void namesAreAcceptedOrRefused() {
        for (String name : List.of("whoami.exe", "Microsoft.PowerShell.Utility\\Get-Date", "C:/Program Files/Tool.EXE", "C:\\Windows\\System32\\cmd.exe", "tool.cmd")) {
            assertThat(grammar.normalize(name)).as(name).isInstanceOf(NormalizedName.Accepted.class);
        }
        for (String name : List.of("", "ls", "Get-Date", " git.exe", "git.exe ", "C:\\a:stream.exe", "C:\\" + "가".repeat(171) + ".exe", "C:\\a\\..\\whoami.exe",
            "whoami\u2019.exe")) {
            assertThat(grammar.normalize(name)).as(name).isInstanceOf(NormalizedName.Rejected.class);
        }
    }

    @Test
    @DisplayName("grammar contract: the grammar states the operating system whose shell it reads (RC-B-623 platform windows)")
    void thePlatformIsStated() {
        assertThat(grammar.platform().wire()).isEqualTo("windows");
    }

    // ---- 2.x cases ----

    @Test
    @DisplayName("RC-B-566: a static whole-line name is recognised and its case is normalised (6 inputs of windows-command-line.test.mjs:245)")
    void staticNamesAreRecognisedAndCaseFolded() {
        List<Reads> cases = List.of(
            reads("WHOAMI.EXE /user", "whoami.exe"),
            reads("Microsoft.PowerShell.Utility\\Get-Date -Format \"yyyy-MM-dd\"", "microsoft.powershell.utility\\get-date"),
            reads("& 'C:/Program Files/Tool.EXE' 'owner''s data'", "c:\\program files\\tool.exe"),
            reads("whoami.exe | Microsoft.PowerShell.Utility\\Select-Object -First 1; hostname.exe", "whoami.exe", "microsoft.powershell.utility\\select-object", "hostname.exe"),
            reads("whoami.exe '$env:NAME; $(literal)'", "whoami.exe"),
            reads("whoami.exe;", "whoami.exe"));
        assertThat(cases).hasSize(6);
        assertReadsCompletely(cases);
    }

    @Test
    @DisplayName("RC-B-566: windowsPolicyName gives the comparison key of a path and of a module-qualified name")
    void policyNamesAreNormalised() {
        assertThat(grammar.normalize("C:/Program Files/Tool.EXE")).isInstanceOfSatisfying(NormalizedName.Accepted.class,
            accepted -> assertThat(accepted.name().key()).isEqualTo("c:\\program files\\tool.exe"));
        assertThat(grammar.normalize("Microsoft.PowerShell.Utility\\Get-Date")).isInstanceOfSatisfying(NormalizedName.Accepted.class,
            accepted -> assertThat(accepted.name().key()).isEqualTo("microsoft.powershell.utility\\get-date"));
    }

    @Test
    @DisplayName("RC-B-566: the order of the names is the order they are found in and a repeated name (any case) is listed once")
    void namesKeepInsertionOrderWithoutDuplicates() {
        assertReadsCompletely(List.of(
            reads("whoami.exe; hostname.exe; whoami.exe", "whoami.exe", "hostname.exe"),
            reads("WHOAMI.EXE | whoami.exe", "whoami.exe"),
            reads("whoami.exe|hostname.exe", "whoami.exe", "hostname.exe"),
            reads("&whoami.exe", "whoami.exe"),
            reads("& 'whoami.exe' | & \"hostname.exe\" arg", "whoami.exe", "hostname.exe"),
            reads("C:\\Windows\\System32\\whoami.exe /all", "c:\\windows\\system32\\whoami.exe"),
            reads("whoami.exe 'a;b|c' \"d e\"", "whoami.exe"),
            reads("Microsoft.PowerShell.Utility\\Get-Date", "microsoft.powershell.utility\\get-date")));
    }

    @Test
    @DisplayName("RC-B-566: PowerShell never uses sudo, and a line that names sudo is not a name of this grammar")
    void sudoIsNeverUsed() {
        CommandLineAnalysis analysis = analyze("sudo -n whoami.exe");
        assertThat(analysis.isComplete()).isFalse();
        assertThat(analysis.usesSudo()).isFalse();
        assertThat(analysis.sudo()).isEqualTo(SudoUse.NO_SUDO);
    }

    @Test
    @DisplayName("RC-B-567: an incomplete or risky construct gives up the name approval (21 inputs of windows-command-line.test.mjs:245)")
    void incompleteOrRiskyConstructsAreIncomplete() {
        List<String> lines = List.of("ls", "Get-Date", "customFunction arg", "$name arg", "& $name", "& {whoami.exe}", "whoami.exe \"$env:USER\"", "whoami.exe $(hostname.exe)",
            "whoami.exe `x", "whoami.exe > out.txt", "whoami.exe --% %USER%", "whoami.exe |", "whoami.exe || hostname.exe", "whoami.exe && hostname.exe", "'C:\\tool.exe'",
            "function x {whoami.exe}; x", "whoami.exe @args", "whoami.exe # hidden", "whoami.exe 'closed'unquoted", "C:\\a\\..\\whoami.exe", "whoami.exe\n");
        assertThat(lines).as("the inputs of windows-command-line.test.mjs:245").hasSize(21);
        assertIncomplete(lines);
    }

    @Test
    @DisplayName("RC-B-567: more incomplete shapes: a dangling or doubled separator, an unclosed quote, a bare call operator, a TAB (a control character)")
    void moreIncompleteShapes() {
        assertIncomplete(List.of("; whoami.exe", "whoami.exe;;", "whoami.exe ; | hostname.exe", "whoami.exe '", "whoami.exe \"abc", "&", "& ", "whoami.exe\t/all",
            "whoami.exe 'a'b", "whoami.exe (1)", "whoami.exe {x}", "whoami.exe [x]", "whoami.exe a,b", "whoami.exe a~b", "whoami.exe a&b"));
        CommandLineAnalysis found = analyze("whoami.exe | ls");
        assertThat(found.isComplete()).isFalse();
        assertThat(found.names()).containsExactly("whoami.exe");
    }

    @Test
    @DisplayName("RC-B-567: text that is not a policy name is refused as an answer (the non-null names of windows-command-line.test.mjs:245)")
    void invalidPolicyNamesAreRefused() {
        for (String name : List.of("Get-Date", " git.exe", "git.exe ", "C:\\a:stream.exe", "C:\\" + "가".repeat(171) + ".exe")) {
            assertThat(grammar.normalize(name)).as(name).isInstanceOf(NormalizedName.Rejected.class);
        }
    }

    @Test
    @DisplayName("RC-B-569: a curved quote anywhere gives up the whole name approval: no name, incomplete, no sudo (7 shapes x 4 quotes)")
    void curvedQuotesGiveUpEverything() {
        CommandLineAnalysis attack = analyze("whoami.exe 'ok\u2019; calc.exe; #'");
        assertThat(attack).isEqualTo(NOTHING_KNOWN);
        int shapes = 0;
        for (String quote : List.of("\u2018", "\u2019", "\u201c", "\u201d")) {
            List<String> lines = List.of(quote + "whoami.exe" + quote, "C:/dir" + quote + "/tool.exe", "& 'C:/dir" + quote + "/tool.exe'", "whoami.exe bare" + quote + "argument",
                "whoami.exe " + quote + "argument" + quote, "whoami.exe 'mixed" + quote + "; calc.exe; #'", "whoami.exe \"mixed" + quote + "; calc.exe; #\"");
            assertThat(lines).hasSize(7);
            for (String line : lines) {
                assertThat(analyze(line)).as(line).isEqualTo(NOTHING_KNOWN);
                shapes++;
            }
        }
        assertThat(shapes).isEqualTo(28);
    }

    @Test
    @DisplayName("RC-B-569: a name with a curved quote is refused as a policy name (3 shapes x 4 quotes)")
    void policyNamesWithCurvedQuotesAreRefused() {
        for (String quote : List.of("\u2018", "\u2019", "\u201c", "\u201d")) {
            for (String name : List.of("whoami" + quote + ".exe", "C:/dir" + quote + "/tool.exe", "C:/dir/tool" + quote + ".exe")) {
                assertThat(grammar.normalize(name)).as(name).isInstanceOf(NormalizedName.Rejected.class);
            }
        }
    }

    @Test
    @DisplayName("RC-B-569: a line with plain quotes is still read: two names")
    void plainQuotesAreStillRead() {
        CommandLineAnalysis analysis = analyze("whoami.exe 'ok'; hostname.exe");
        assertThat(analysis.isComplete()).isTrue();
        assertThat(analysis.names()).containsExactly("whoami.exe", "hostname.exe");
        assertThat(analysis.usesSudo()).isFalse();
    }

    @Test
    @DisplayName("RC-B-075: a multiline command never gives a partial name approval (3 PowerShell programs and 3 more lines of multiline-commands.test.mjs:105)")
    void multilineCommandsAreIncomplete() {
        List<String> lines = List.of(
            "$value = @'\n한글 $env:PATH 'literal'\n'@\n[Console]::Write($value)",
            "$value = @\"\r\n한글 `\"quoted`\"\r\n\"@\r\n[Console]::Write($value)",
            "\t[Console]::Write('first')\r\n[Console]::Write('second')\r\n",
            "whoami.exe\nwhoami.exe", "Microsoft.PowerShell.Utility\\Get-Date\n", "\r\nMicrosoft.PowerShell.Management\\Get-Location");
        assertThat(lines).hasSize(6);
        for (String line : lines) {
            CommandLineAnalysis analysis = analyze(line);
            assertThat(analysis.isComplete()).as(line).isFalse();
            assertThat(analysis.names()).as(line).isEmpty();
            assertThat(analysis.usesSudo()).as(line).isFalse();
        }
    }
}
