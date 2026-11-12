package io.github.jaeseongs95.portal.domain.classify;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import io.github.jaeseongs95.portal.domain.text.CommandText;
import java.nio.charset.StandardCharsets;
import java.time.Duration;
import java.util.Arrays;
import java.util.Base64;
import java.util.List;
import java.util.stream.Collectors;
import java.util.stream.IntStream;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.Timeout;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.ValueSource;

/**
 * The vendor cases that need a generated input or an engine of their own, the 2.x overwrite OV-01, and the porting risks of section 8 of
 * docs/migration/vendor-ssh-mcp-rules.md (RK-02, RK-03, RK-04, RK-06, RK-07, RK-10, RK-11, RK-12). The table cases are in {@link VendorClassifierCasesTest}.
 */
class VendorClassifierRulesTest {

    private final VendorCommandClassifier classifier = new VendorCommandClassifier();

    private CommandClass classOf(String command) {
        return classifier.classifyText(command).commandClass();
    }

    private String nested(int substitutions) {
        return "echo $(".repeat(substitutions) + "echo hi" + ")".repeat(substitutions);
    }

    /** The UTF-16LE bytes of the text with no check of the characters: a lone surrogate stays a lone surrogate (String.getBytes would write a question mark). */
    private byte[] utf16le(String text) {
        byte[] bytes = new byte[text.length() * 2];
        for (int i = 0; i < text.length(); i++) {
            bytes[2 * i] = (byte) (text.charAt(i) & 0xFF);
            bytes[2 * i + 1] = (byte) (text.charAt(i) >> 8);
        }
        return bytes;
    }

    private String encodedCommand(String program) {
        return "pwsh -EncodedCommand " + Base64.getEncoder().encodeToString(utf16le(program));
    }

    @Test
    @DisplayName("VR-013, VR-014 (CL-A05): the eighth level of inner commands is privileged, the seventh is read as usual")
    void nestingIsReadToTheEighthLevel() {
        assertThat(classOf(nested(8))).isEqualTo(CommandClass.PRIVILEGED);
        assertThat(classOf(nested(7))).isEqualTo(CommandClass.SAFE);
    }

    @Test
    @DisplayName("VR-133, VR-134 (AW-03): an awk program of 262145 characters is not read and is destructive, one of 262144 is read")
    void anAwkProgramIsReadUpToItsLimit() {
        String longest = "{" + " ".repeat(262142) + "}";
        String tooLong = "{" + " ".repeat(262143) + "}";

        assertThat(longest).hasSize(262144);
        assertThat(classOf("awk '" + longest + "'")).isEqualTo(CommandClass.SAFE);
        assertThat(classOf("awk '" + tooLong + "'")).isEqualTo(CommandClass.DESTRUCTIVE);
    }

    @Test
    @DisplayName("VR-192 (RG-08): a name that two option lists have is rejected")
    void anAmbiguousOptionNameIsRejected() {
        ReaderGrammar grammar = ReaderGrammar.getopt(List.of("-x")).withValueFlags(List.of("-x"));

        GrammarMatch match = grammar.match(List.of("-x"));

        assertThat(match.accepted()).isFalse();
        assertThat(match.word()).isEqualTo("-x");
    }

    @Test
    @DisplayName("VR-204 (RG-12): an operand limit that is not valid counts as zero (the Java type has no 1.5, a negative limit is the invalid one)")
    void anInvalidOperandLimitCountsAsZero() {
        ReaderGrammar grammar = ReaderGrammar.getopt(List.of()).withOperands(OperandRules.atMost(-1));

        GrammarMatch match = grammar.match(List.of("a"));

        assertThat(match.accepted()).isFalse();
        assertThat(match.word()).isEqualTo("a");
    }

    @Test
    @DisplayName("VR-479~482 (OV-01): a command with a line break never stays read-only, the other classes stay")
    void aMultilineCommandIsNotReadOnly() {
        assertThat(classifier.classifyText("ls").forMultiline("ls").commandClass()).isEqualTo(CommandClass.READ_ONLY);
        assertThat(classifier.classifyText("ls\n").commandClass()).as("the vendor trims the line break").isEqualTo(CommandClass.READ_ONLY);
        assertThat(classifier.classifyText("ls\n").forMultiline("ls\n").commandClass()).isEqualTo(CommandClass.SAFE);
        assertThat(classifier.classifyText("ls\nls").forMultiline("ls\nls").commandClass()).isEqualTo(CommandClass.SAFE);
        assertThat(classifier.classifyText("rm -rf /tmp/x\n").forMultiline("rm -rf /tmp/x\n").commandClass()).isEqualTo(CommandClass.DESTRUCTIVE);
    }

    @Test
    @DisplayName("VR-479~482 (OV-01): the same through CommandText, the type the product passes")
    void theMultilineRuleWorksOnACommandText() {
        CommandText single = new CommandText("ls");
        CommandText endsWithLineBreak = new CommandText("ls\n");

        assertThat(classifier.classify(single).forMultiline(single).commandClass()).isEqualTo(CommandClass.READ_ONLY);
        assertThat(classifier.classify(single).binary()).isEqualTo("ls");
        assertThat(classifier.classify(endsWithLineBreak).commandClass()).isEqualTo(CommandClass.READ_ONLY);
        assertThat(classifier.classify(endsWithLineBreak).forMultiline(endsWithLineBreak).commandClass()).isEqualTo(CommandClass.SAFE);
    }

    @Test
    @DisplayName("OV-02: a classification of a class alone, for a target platform that does not use the vendor rules")
    void aClassificationCanStateTheClassAlone() {
        CommandClassification readOnly = CommandClassification.of(CommandClass.READ_ONLY);

        assertThat(readOnly.commandClass()).isEqualTo(CommandClass.READ_ONLY);
        assertThat(readOnly.readOnlyRejection()).isEmpty();
        assertThat(readOnly.forMultiline("a\nb").commandClass()).isEqualTo(CommandClass.SAFE);
        assertThat(CommandClassification.of(CommandClass.SAFE)).isEqualTo(CommandClassification.of(CommandClass.SAFE));
    }

    @Test
    @DisplayName("CL-A08: the full command is the input without the JavaScript white space at its ends")
    void theFullCommandIsTrimmedLikeJavaScript() {
        assertThat(classifier.classifyText("\u00A0 ls /tmp \uFEFF\n").fullCommand()).isEqualTo("ls /tmp");
        assertThat(classifier.classifyText("ls\u0085").fullCommand()).as("U+0085 is not white space in JavaScript").isEqualTo("ls\u0085");
    }

    @Test
    @DisplayName("CommandClass: four classes in the order read-only, safe, destructive, privileged, and their wire form")
    void theClassesAreOrderedAndHaveAWireForm() {
        assertThat(CommandClass.values()).extracting(CommandClass::wire).containsExactly("read-only", "safe", "destructive", "privileged");
        assertThat(CommandClass.SAFE.isHigherThan(CommandClass.READ_ONLY)).isTrue();
        assertThat(CommandClass.SAFE.isHigherThan(CommandClass.SAFE)).isFalse();
        assertThat(CommandClass.SAFE.isAtLeast(CommandClass.SAFE)).isTrue();
        assertThat(CommandClass.DESTRUCTIVE.isAtLeast(CommandClass.PRIVILEGED)).isFalse();
        assertThat(CommandClass.READ_ONLY.max(CommandClass.DESTRUCTIVE)).isEqualTo(CommandClass.DESTRUCTIVE);
        assertThat(CommandClass.PRIVILEGED.max(CommandClass.SAFE)).isEqualTo(CommandClass.PRIVILEGED);
        assertThat(CommandClass.fromWire("privileged")).isEqualTo(CommandClass.PRIVILEGED);
        assertThatThrownBy(() -> CommandClass.fromWire("forbidden")).isInstanceOf(IllegalArgumentException.class).hasMessageContaining("forbidden");
    }

    @Test
    @DisplayName("CL-R001~R068: 68 allow-listed programs, 48 that accept any argument, 17 getopt grammars, 3 exact grammars, 14 two-word names")
    void theReaderTableHasTheVendorEntries() {
        ReaderTable readers = new ReaderTable();

        assertThat(readers.names()).hasSize(68);
        assertThat(readers.names().stream().filter(name -> readers.grammar(name).orElseThrow().style() == ReaderGrammar.Style.ANY)).hasSize(48);
        assertThat(readers.names().stream().filter(name -> readers.grammar(name).orElseThrow().style() == ReaderGrammar.Style.GETOPT)).hasSize(17);
        assertThat(readers.names().stream().filter(name -> readers.grammar(name).orElseThrow().style() == ReaderGrammar.Style.EXACT)).hasSize(3);
        assertThat(readers.names().stream().filter(name -> name.contains(" "))).hasSize(14);
    }

    @Test
    @DisplayName("CL-I01: 21 interpreters; the shells are readable, the other languages are not")
    void theInterpreterTableHasTheVendorEntries() {
        assertThat(Interpreter.values()).hasSize(21);
        assertThat(Arrays.stream(Interpreter.values()).filter(Interpreter::isReadable).map(Interpreter::commandName).collect(Collectors.toSet()))
            .containsExactlyInAnyOrder("sh", "bash", "dash", "zsh", "ksh", "ash");
        assertThat(Interpreter.PWSH.programBearingWords()).containsExactly("-c", "-Command", "-e", "-EncodedCommand");
        assertThat(Interpreter.PWSH.isCaseInsensitive()).isTrue();
        assertThat(Interpreter.PERL.isCaseInsensitive()).isFalse();
    }

    @Test
    @DisplayName("RK-06, CL-I02: the program name is matched exactly, then without .exe .cmd .bat in lower case (ASCII suffix, root locale)")
    void anInterpreterIsFoundByItsExactNameOrItsLowerCaseNameWithoutExtension() {
        assertThat(Interpreter.resolve("pwsh")).contains(Interpreter.PWSH);
        assertThat(Interpreter.resolve("PWSH.EXE")).contains(Interpreter.PWSH);
        assertThat(Interpreter.resolve("rscript")).contains(Interpreter.R_SCRIPT);
        assertThat(Interpreter.resolve("Node.EXE")).contains(Interpreter.NODE);
        assertThat(Interpreter.resolve("sh.BAT")).contains(Interpreter.SH);
        assertThat(Interpreter.resolve("\u212Ash")).as("the Kelvin sign folds to k in JavaScript and in Java").contains(Interpreter.KSH);
        assertThat(Interpreter.resolve("pwsh.exe.exe")).isEmpty();
        assertThat(Interpreter.resolve("ps")).isEmpty();
        assertThat(Interpreter.resolve("Rscr\u0130pt")).isEmpty();
    }

    @ParameterizedTest(name = "case {index}")
    @ValueSource(strings = {"sudo\uFEFFid", "sudo\u2028id", "sudo\u3000id", "sudo\u1680id", "sudo\u2003id", "sudo\u000Bid", "sudo\fid"})
    @DisplayName("RK-03 (CL-T02): the white space of JavaScript separates words: U+FEFF, U+2028, U+3000, U+1680, U+2000-U+200A, VT, FF")
    void javaScriptWhiteSpaceSeparatesWords(String command) {
        assertThat(classOf(command)).isEqualTo(CommandClass.PRIVILEGED);
    }

    @ParameterizedTest(name = "case {index}")
    @ValueSource(strings = {"sudo\u0085id", "sudo\u180Eid", "sudo\u200Bid", "sudo\u200Eid"})
    @DisplayName("RK-03 (CL-T02): what is not white space in JavaScript does not separate words: U+0085, U+180E, U+200B, U+200E")
    void otherCharactersDoNotSeparateWords(String command) {
        assertThat(classOf(command)).isEqualTo(CommandClass.SAFE);
    }

    @Test
    @DisplayName("RK-04 (CL-T09): . does not match the four ECMAScript line terminators and does match U+0085, so a quoted word with U+0085 is unquoted")
    void unquoteTreatsLineTerminatorsLikeJavaScript() {
        ShellText text = new ShellText();

        assertThat(text.unquote("'a\u0085b'")).isEqualTo("a\u0085b");
        assertThat(text.unquote("\"a\u2028b\"")).isEqualTo("\"a\u2028b\"");
        assertThat(text.unquote("'a\nb'")).isEqualTo("'a\nb'");
        assertThat(text.unquote("'a\"")).isEqualTo("'a\"");
        assertThat(text.unquote("''")).isEmpty();
        assertThat(text.unquote("'")).isEqualTo("'");
    }

    @Test
    @DisplayName("RK-02 (CL-D02): $ of the vendor regular expressions is the end of the text, not the place before a final line break: sort \"--output<LF>\" is no --output")
    void theEndOfTextAnchorDoesNotAcceptAFinalLineBreak() {
        assertThat(classOf("sort \"--output\n\" x")).isEqualTo(CommandClass.SAFE);
        assertThat(classOf("sort --output x")).isEqualTo(CommandClass.DESTRUCTIVE);
    }

    @ParameterizedTest(name = "{0}")
    @ValueSource(strings = {"--co", "--com", "--compress", "--compress-program", "--compress-program=x", "--o", "--ou", "--output", "--output=x", "--out=x", "-o", "-ofile", "-mo",
        "-rno"})
    @DisplayName("RK-11, VR-123: the generated sort regular expression takes the unambiguous abbreviations of --output and --compress-program and -o")
    void sortOptionsThatWrite(String argument) {
        assertThat(disqualifying().disqualifies("sort", argument)).isTrue();
    }

    @ParameterizedTest(name = "{0}")
    @ValueSource(strings = {"--c", "--ch", "--check", "--outputx", "--compress-programs", "-tofile", "-k", "-n", "--", "output", "-"})
    @DisplayName("RK-11, VR-124, VR-125: --c is ambiguous with --check, a value option swallows the o, the others are no writes")
    void sortOptionsThatDoNotWrite(String argument) {
        assertThat(disqualifying().disqualifies("sort", argument)).isFalse();
    }

    @Test
    @DisplayName("CL-D01: the find options that delete, execute or write")
    void findOptionsThatWriteOrRun() {
        DisqualifyingArgs disqualifying = disqualifying();

        for (String argument : List.of("-exec", "-execdir", "-ok", "-okdir", "-delete", "-fprint", "-fprintf", "-fls")) {
            assertThat(disqualifying.disqualifies("find", argument)).as(argument).isTrue();
        }
        for (String argument : List.of("-print", "-name", "-exe", "-deleted", "-fprintff", "-ls")) {
            assertThat(disqualifying.disqualifies("find", argument)).as(argument).isFalse();
        }
        assertThat(disqualifying.disqualifies("ls", "-exec")).isFalse();
    }

    private DisqualifyingArgs disqualifying() {
        ShellText text = new ShellText();
        CommandTokenizer tokenizer = new CommandTokenizer(text);
        return new DisqualifyingArgs(text, tokenizer, new LaunchPrefixes(text, tokenizer));
    }

    @Test
    @DisplayName("RK-07, CL-I07: the program of -EncodedCommand is decoded like Node does, with the standard and the URL-safe base64 alphabet")
    void theEncodedCommandIsDecodedLikeNode() {
        EncodedCommandDecoder decoder = new EncodedCommandDecoder(new ShellText());
        String sudoId = Base64.getEncoder().encodeToString(utf16le("sudo id"));

        assertThat(decoder.decode(sudoId)).contains("sudo id");
        assertThat(decoder.decode(sudoId.replace("=", ""))).as("no padding").contains("sudo id");
        assertThat(decoder.decode("cwB1AGQAbwAg*AGkA?ZAA=")).as("characters outside the alphabets are skipped").contains("sudo id");
        assertThat(decoder.decode("cwB1AGQA\nbwAgAGkAZAA=")).as("so is white space").contains("sudo id");
        assertThat(decoder.decode("/wD+AA==")).as("standard alphabet").contains("\u00FF\u00FE");
        assertThat(decoder.decode("_wD-AA")).as("URL-safe alphabet without padding").contains("\u00FF\u00FE");
        assertThat(decoder.decode("cwB1AGQAbwAgAGkAZAA=cwB1AGQAbwAg")).as("the first = ends the input").contains("sudo id");
        assertThat(decoder.decode(Base64.getEncoder().encodeToString(new byte[] {'s', 0, 'u', 0, 'd'}))).as("an odd last byte is dropped").contains("su");
    }

    @Test
    @DisplayName("RK-07, CL-I07: a text with only white space, an empty operand, or nothing decodable gives no program")
    void anEncodedCommandWithoutAProgramGivesNothing() {
        EncodedCommandDecoder decoder = new EncodedCommandDecoder(new ShellText());

        assertThat(decoder.decode(Base64.getEncoder().encodeToString(utf16le("  \u00A0\n")))).isEmpty();
        assertThat(decoder.decode("")).isEmpty();
        assertThat(decoder.decode("***")).isEmpty();
        assertThat(decoder.decode("A")).isEmpty();
    }

    @Test
    @DisplayName("RK-07: a program with a lone surrogate behind a pwsh -EncodedCommand is still classified (Java's UTF-16LE decoder would have replaced it)")
    void aLoneSurrogateDoesNotHideTheProgram() {
        assertThat(classOf(encodedCommand("sudo id \uD800"))).isEqualTo(CommandClass.PRIVILEGED);
        assertThat(classOf(encodedCommand("sudo id"))).isEqualTo(CommandClass.PRIVILEGED);
        assertThat(classOf(encodedCommand("ls"))).isEqualTo(CommandClass.DESTRUCTIVE);
    }

    @Test
    @DisplayName("RK-07, VR-102, intended behavior change: a replacement character in the program does not hide it (the vendor drops such a program and answers destructive)")
    void aReplacementCharacterDoesNotHideTheProgram() {
        assertThat(classOf(encodedCommand("sudo id \uFFFD"))).isEqualTo(CommandClass.PRIVILEGED);
        assertThat(classOf(encodedCommand("   "))).as("nothing to read: destructive from the flag alone").isEqualTo(CommandClass.DESTRUCTIVE);
    }

    @Test
    @DisplayName("RK-12, CL-A01: a command with a backslash is read in both dialects and the higher class wins; the same instance gives the same answer on every thread")
    void oneInstanceServesManyThreads() {
        List<String> commands = List.of("find . -name \\*.conf", "ls C:\\Users", "s\\udo id", "echo hi", nested(8), "rm -fr /", "awk 'BEGIN{system(\"sudo id\")}'");
        List<CommandClass> expected = commands.stream().map(this::classOf).toList();

        List<CommandClass> parallel = IntStream.range(0, 140).parallel().mapToObj(i -> classOf(commands.get(i % commands.size()))).toList();

        assertThat(expected).containsExactly(CommandClass.SAFE, CommandClass.READ_ONLY, CommandClass.PRIVILEGED, CommandClass.READ_ONLY, CommandClass.PRIVILEGED,
            CommandClass.DESTRUCTIVE, CommandClass.PRIVILEGED);
        for (int i = 0; i < parallel.size(); i++) {
            assertThat(parallel.get(i)).as("command %d", i % commands.size()).isEqualTo(expected.get(i % commands.size()));
        }
    }

    @Test
    @Timeout(value = 60)
    @DisplayName("RK-10: a 64 KiB command of words that the word rules look at is classified in linear time (the vendor replaced a regular expression that took 65 s)")
    void aLargeCommandIsClassifiedInReasonableTime() {
        String unit = "dd curl wget chown -R x ";
        String command = unit.repeat(65536 / unit.length() + 1);

        long start = System.nanoTime();
        CommandClass result = classOf(command);

        assertThat(result).isEqualTo(CommandClass.SAFE);
        assertThat(Duration.ofNanos(System.nanoTime() - start)).isLessThan(Duration.ofSeconds(30));
    }
}
