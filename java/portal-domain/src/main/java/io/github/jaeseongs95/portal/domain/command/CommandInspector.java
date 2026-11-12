package io.github.jaeseongs95.portal.domain.command;

import io.github.jaeseongs95.portal.domain.classify.CommandClass;
import io.github.jaeseongs95.portal.domain.classify.CommandClassifier;
import io.github.jaeseongs95.portal.domain.text.CommandText;
import io.github.jaeseongs95.portal.domain.text.Utf8Text;
import java.util.Objects;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * Reads a command line the way 2.x {@code inspectCommand} did: the name matching of a policy ignores arguments, so a separate conservative scan looks at the
 * whole line. The classifier is injected; the class it answers is vendor-neutral ({@link CommandClass}) and the rule that "safe" is the classifier's
 * default for an unknown program, not a safety proof, is applied here: only {@code read-only} is not risky.
 */
public final class CommandInspector {

    private static final String SPACE = "[\\s\\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff]";
    private static final Pattern EXECUTABLE = Pattern.compile("^" + SPACE + "*([A-Za-z0-9_][A-Za-z0-9_.+-]*)(?:" + SPACE + "|$)");
    private static final Pattern SHELL_META = Pattern.compile("[;&|<>`$(){}\\n\\r\\\\*?\\[\\]~]");
    /** Only the unambiguous spelling {@code sudo} or {@code sudo -n} is looked through; every other form is judged as it stands. */
    private static final Pattern SUDO_PREFIX = Pattern.compile("^" + SPACE + "*sudo" + SPACE + "+(?:-n" + SPACE + "+)?");

    private final CommandClassifier classifier;

    public CommandInspector(CommandClassifier classifier) {
        this.classifier = Objects.requireNonNull(classifier, "classifier");
    }

    public CommandInspection inspect(CommandText command) {
        String text = command.value();
        Matcher first = EXECUTABLE.matcher(text);
        CommandInspection.ExecutableName executable = first.find()
            ? new CommandInspection.ExecutableName.Named(first.group(1))
            : new CommandInspection.ExecutableName.NoExecutable();
        boolean sensitive = new SensitiveText(text).isSensitive();
        boolean shell = SHELL_META.matcher(text).find();
        boolean notReadOnly = classOf(text, executable) != CommandClass.READ_ONLY;
        boolean noExecutable = executable instanceof CommandInspection.ExecutableName.NoExecutable;
        return new CommandInspection(executable, sensitive, sensitive || shell || noExecutable || notReadOnly);
    }

    /** The class of the line, looking through a leading {@code sudo [-n]}. A line that is nothing after the prefix is judged unknown, which is not read-only. */
    private CommandClass classOf(String text, CommandInspection.ExecutableName executable) {
        boolean sudo = executable instanceof CommandInspection.ExecutableName.Named named && "sudo".equals(named.name());
        String evaluated = sudo ? SUDO_PREFIX.matcher(text).replaceFirst("") : text;
        if (new Utf8Text(evaluated).isBlank()) {
            return CommandClass.SAFE;
        }
        return classifier.classify(new CommandText(evaluated)).commandClass();
    }
}
