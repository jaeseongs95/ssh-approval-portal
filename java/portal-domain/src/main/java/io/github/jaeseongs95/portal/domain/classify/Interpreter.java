package io.github.jaeseongs95.portal.domain.classify;

import java.util.Arrays;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Optional;
import java.util.function.Function;
import java.util.regex.Pattern;
import java.util.stream.Collectors;

/**
 * A program that takes another program as an argument (vendor {@code INTERPRETERS}, policy/classifier.js:689-721, rule CL-I01): 21 of them. The
 * {@code programBearingWords} are the words after which the next word is the program text ({@code -c}, {@code -e}, {@code eval}, ...). A {@code readable}
 * interpreter is a shell: the program it is given is classified as a command of its own, so the shell itself is not unreadable. The others run a language the
 * classifier cannot read, so a command line that gives them a program is {@code destructive} from the flag alone.
 */
enum Interpreter {
    SH("sh", true, "-c"),
    BASH("bash", true, "-c"),
    DASH("dash", true, "-c"),
    ZSH("zsh", true, "-c"),
    KSH("ksh", true, "-c"),
    ASH("ash", true, "-c"),
    PYTHON("python", false, "-c"),
    PYTHON2("python2", false, "-c"),
    PYTHON3("python3", false, "-c"),
    PERL("perl", false, "-e", "-E"),
    RUBY("ruby", false, "-e"),
    NODE("node", false, "-e", "--eval", "-p", "--print"),
    PHP("php", false, "-r"),
    OSASCRIPT("osascript", false, "-e"),
    LUA("lua", false, "-e"),
    R_SCRIPT("Rscript", false, "-e"),
    BUN("bun", false, "-e"),
    TCLSH("tclsh", false),
    DENO("deno", false, "eval"),
    PWSH("pwsh", false, "-c", "-Command", "-e", "-EncodedCommand"),
    POWERSHELL("powershell", false, "-c", "-Command", "-e", "-EncodedCommand");

    /** {@code /\.(exe|cmd|bat)$/i}: the extension a Windows program name may carry (CL-I02). The case folding is ASCII only, as in JavaScript without the u flag. */
    private static final Pattern WINDOWS_EXE_SUFFIX = Pattern.compile("\\.(?:exe|cmd|bat)\\z", Pattern.CASE_INSENSITIVE);

    private static final Map<String, Interpreter> BY_NAME = Arrays.stream(values()).collect(Collectors.toUnmodifiableMap(Interpreter::commandName, Function.identity()));

    private static final Map<String, Interpreter> BY_LOWERCASE_NAME = Arrays.stream(values())
        .collect(Collectors.toUnmodifiableMap(interpreter -> interpreter.commandName.toLowerCase(Locale.ROOT), Function.identity()));

    private final String commandName;
    private final boolean readable;
    private final List<String> programBearingWords;

    Interpreter(String commandName, boolean readable, String... programBearingWords) {
        this.commandName = commandName;
        this.readable = readable;
        this.programBearingWords = List.copyOf(Arrays.asList(programBearingWords));
    }

    /**
     * The interpreter a program word names: the exact name first, else the name without {@code .exe}, {@code .cmd} or {@code .bat} in lower case (so
     * {@code PWSH.EXE} and {@code rscript} are interpreters, {@code Node.EXE} too). Flag case is the interpreter's own business ({@link #isCaseInsensitive()}).
     */
    static Optional<Interpreter> resolve(String word) {
        Interpreter exact = BY_NAME.get(word);
        if (exact != null) {
            return Optional.of(exact);
        }
        return Optional.ofNullable(BY_LOWERCASE_NAME.get(WINDOWS_EXE_SUFFIX.matcher(word).replaceFirst("").toLowerCase(Locale.ROOT)));
    }

    String commandName() {
        return commandName;
    }

    boolean isReadable() {
        return readable;
    }

    List<String> programBearingWords() {
        return programBearingWords;
    }

    /** True for PowerShell, the one family whose flags are not case sensitive; it is the one that has {@code -EncodedCommand} (CL-I05). */
    boolean isCaseInsensitive() {
        return programBearingWords.contains("-EncodedCommand");
    }
}
