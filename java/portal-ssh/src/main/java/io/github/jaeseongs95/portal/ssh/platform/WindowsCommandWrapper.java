package io.github.jaeseongs95.portal.ssh.platform;

import java.nio.charset.StandardCharsets;
import java.util.Base64;
import java.util.Map;
import java.util.Objects;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

import org.springframework.stereotype.Component;

import io.github.jaeseongs95.portal.app.remote.CommandKind;
import io.github.jaeseongs95.portal.app.remote.PreparedCommand;
import io.github.jaeseongs95.portal.app.remote.StdinBytes;
import io.github.jaeseongs95.portal.app.remote.WorkingDirectory;
import io.github.jaeseongs95.portal.domain.error.ExecutionAttempt;
import io.github.jaeseongs95.portal.domain.error.RequestErrorCode;
import io.github.jaeseongs95.portal.domain.error.RequestRefusedException;
import io.github.jaeseongs95.portal.domain.error.TransferErrorCode;
import io.github.jaeseongs95.portal.domain.id.Digester;
import io.github.jaeseongs95.portal.domain.id.Sha256Digester;
import io.github.jaeseongs95.portal.domain.path.RemotePath;
import io.github.jaeseongs95.portal.domain.path.WindowsRemotePath;
import io.github.jaeseongs95.portal.domain.target.WindowsDirectory;
import io.github.jaeseongs95.portal.domain.text.CommandText;
import io.github.jaeseongs95.portal.domain.text.Utf8Text;

/**
 * Makes the Windows PowerShell command line of a command and cleans the standard error that comes back (2.x windows-command.mjs and the presentStderr of
 * execution-supervisor.mjs).
 *
 * <p>Why this class exists: the command a user submits runs on the target, a Windows machine without a JVM, and the OpenSSH server there gives it to a shell whose
 * quoting rules differ from a POSIX shell. The command and its wrapper are therefore a product feature that Java cannot replace. The sentences are data that this
 * server sends to the target; the server starts no process for them (docs/external-programs).
 *
 * <p>Two ways to a command line, both a single {@code powershell.exe ... -EncodedCommand <base64 of UTF-16LE>} line of at most 8000 characters, the limit of the
 * Windows shell for a command line:
 * <ul>
 *   <li>{@link #prepare}: the user's command. The line carries a gzip receiver; the command itself travels as the standard input, byte for byte. The receiver reads
 *       the input through the end, checks its length and SHA-256, and compiles it only then. The digest binds the transport bytes. It is not a safety or an
 *       authority proof.</li>
 *   <li>{@link #wrap}: a sentence the portal itself fixed (a read-only query). The sentence is part of the line and nothing is sent as input.</li>
 * </ul>
 * The class holds no state that changes, so one instance serves every thread.
 */
@Component
public final class WindowsCommandWrapper {

    /** The longest command line, in characters, the Windows shell takes (2.x windows-command.mjs:22). */
    private static final int MAX_COMMAND_LINE_CHARS = 8000;
    private static final String COMMAND_LINE_PREFIX = "powershell.exe -NoLogo -NoProfile -NonInteractive -WindowStyle Hidden -InputFormat Text -OutputFormat Text -EncodedCommand ";
    private static final String UTILITY_MODULE = "Microsoft.PowerShell.Utility";
    private static final String MANAGEMENT_MODULE = "Microsoft.PowerShell.Management";
    private static final String GET_DATE = UTILITY_MODULE + "\\Get-Date";
    private static final String GET_LOCATION = MANAGEMENT_MODULE + "\\Get-Location";

    /** A white space of the JavaScript sense, the one the 2.x expressions used. */
    private static final String SPACE = "[\\t\\n\\x0B\\f\\r \\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff]";
    private static final String CLIXML_MARK = "#< CLIXML";
    private static final Pattern CLIXML_BLOCK = Pattern.compile("#< CLIXML\\r?\\n(<Objs\\b[^>]*>[\\s\\S]*?</Objs>)");
    private static final Pattern PROGRESS_OBJECT = Pattern.compile("<Obj\\b(?=[^>]*\\bS=[\"']progress[\"'])[^>]*>[\\s\\S]*?</Obj>");
    private static final Pattern PROGRESS_STRING = Pattern.compile("<S\\b(?=[^>]*\\bS=[\"']progress[\"'])[^>]*>[\\s\\S]*?</S>");
    private static final Pattern EMPTY_OBJECTS = Pattern.compile("<Objs\\b[^>]*>" + SPACE + "*</Objs>");

    private final RemoteScripts scripts;
    /** The digest of the command bytes is part of the receiver. The constructor the callers use takes the scripts only, so the SHA-256 of the domain is used directly. */
    private final Digester digester = new Sha256Digester();

    public WindowsCommandWrapper(RemoteScripts scripts) {
        this.scripts = Objects.requireNonNull(scripts, "scripts");
    }

    /**
     * The command line and the input of a user command (2.x prepareWindowsCommand).
     *
     * @param command the command, sent unchanged as the UTF-8 bytes of the standard input
     * @param workdir where the command starts; a directory must be a {@link WindowsRemotePath} of at most 512 UTF-8 bytes
     * @return the line, the input and the kind {@link CommandKind#COMMAND}
     * @throws IllegalArgumentException when the directory is not a Windows path
     * @throws RequestRefusedException {@link RequestErrorCode#INVALID_OPERATION_INPUT} when the directory is longer than 512 UTF-8 bytes;
     *     {@link TransferErrorCode#WINDOWS_COMMAND_TOO_LARGE} when the line would be longer than 8000 characters
     */
    public PreparedCommand prepare(CommandText command, WorkingDirectory workdir) {
        Objects.requireNonNull(command, "command");
        Objects.requireNonNull(workdir, "workdir");
        byte[] bytes = command.value().getBytes(StandardCharsets.UTF_8);
        String errorReport = scripts.line(RemoteScript.WINDOWS_ERROR_REPORT);
        String receiver = scripts.fill(RemoteScript.WINDOWS_COMMAND_RECEIVER, Map.of(
            "STDIN_READER", scripts.line(RemoteScript.WINDOWS_STDIN_READER),
            "BUFFER_LENGTH", Integer.toString(bytes.length + 1),
            "BYTE_COUNT", Integer.toString(bytes.length),
            "SHA256", digester.digest(bytes).hex(),
            "PRELUDE", workdirPrelude(workdir) + modulePrelude(command.value()),
            "ERROR_REPORT", errorReport));
        String stub = scripts.fill(RemoteScript.WINDOWS_RECEIVER_STUB, Map.of("PACKED", scripts.gzipBase64(receiver), "ERROR_REPORT", errorReport));
        return new PreparedCommand(encodedCommandLine(stub), new StdinBytes(bytes), CommandKind.COMMAND);
    }

    /**
     * The command line of a sentence the portal fixed (2.x wrapWindowsCommand). The sentence has no user input; it is checked like a command all the same, so a
     * hidden character cannot get in.
     *
     * @param script the PowerShell sentence
     * @return the line, no input, the kind {@link CommandKind#COMMAND}
     * @throws IllegalArgumentException when the sentence is not a valid command text
     * @throws RequestRefusedException {@link TransferErrorCode#WINDOWS_COMMAND_TOO_LARGE} when the line would be longer than 8000 characters
     */
    public PreparedCommand wrap(String script) {
        CommandText command = new CommandText(script);
        String wrapped = scripts.fill(RemoteScript.WINDOWS_WRAPPED_COMMAND, Map.of(
            "PRELUDE", modulePrelude(command.value()),
            "COMMAND", command.value(),
            "ERROR_REPORT", scripts.line(RemoteScript.WINDOWS_ERROR_REPORT)));
        return new PreparedCommand(encodedCommandLine(wrapped), StdinBytes.none(), CommandKind.COMMAND);
    }

    /**
     * The standard error as it is shown: the progress records of PowerShell are taken out of a CLIXML block (2.x presentStderr). Only the progress records go. Every
     * other record stays as it is, and a block with progress only becomes an empty text. The CLIXML is never parsed as a document. The caller keeps the original
     * standard error; this text is for display only.
     */
    public String presentStderr(String stderr) {
        Objects.requireNonNull(stderr, "stderr");
        if (!stderr.contains(CLIXML_MARK)) {
            return stderr;
        }
        return CLIXML_BLOCK.matcher(stderr).replaceAll(block -> {
            String withoutProgress = PROGRESS_STRING.matcher(PROGRESS_OBJECT.matcher(block.group(1)).replaceAll("")).replaceAll("");
            String shown = EMPTY_OBJECTS.matcher(withoutProgress).matches() ? "" : CLIXML_MARK + "\n" + withoutProgress;
            return Matcher.quoteReplacement(shown);
        });
    }

    /** The lines that move into the directory; empty for the directory the login gives. The path goes in as base64 data, so no character of it can become code. */
    private String workdirPrelude(WorkingDirectory workdir) {
        return switch (workdir) {
            case WorkingDirectory.Default() -> "";
            case WorkingDirectory.At(RemotePath directory) -> {
                if (!(directory instanceof WindowsRemotePath windows)) {
                    throw new IllegalArgumentException("A Windows target takes a Windows path");
                }
                byte[] bytes = windows.value().getBytes(StandardCharsets.UTF_8);
                if (bytes.length > WindowsDirectory.MAX_BYTES) {
                    throw new RequestRefusedException(RequestErrorCode.INVALID_OPERATION_INPUT);
                }
                yield scripts.fill(RemoteScript.WINDOWS_WORKDIR, Map.of(
                    "IMPORT_MANAGEMENT", importModule(MANAGEMENT_MODULE, false),
                    "WORKDIR_BASE64", Base64.getEncoder().encodeToString(bytes)));
            }
        };
    }

    /**
     * For the two read-only queries of the portal (a module-qualified Get-Date or Get-Location) the module is loaded from the PowerShell installation first, with the
     * autoloading off, because a qualified name would still autoload through the user's module path. Any other command gets nothing.
     */
    private String modulePrelude(String command) {
        String name = new Utf8Text(command).trimmed().value();
        if (GET_DATE.equalsIgnoreCase(name)) {
            return importModule(UTILITY_MODULE, true);
        }
        return GET_LOCATION.equalsIgnoreCase(name) ? importModule(MANAGEMENT_MODULE, true) : "";
    }

    private String importModule(String module, boolean autoloadOff) {
        String autoload = autoloadOff ? scripts.line(RemoteScript.WINDOWS_AUTOLOAD_OFF) : "";
        return autoload + scripts.fill(RemoteScript.WINDOWS_IMPORT_MODULE, Map.of("MODULE", module));
    }

    private static String encodedCommandLine(String script) {
        String line = COMMAND_LINE_PREFIX + Base64.getEncoder().encodeToString(script.getBytes(StandardCharsets.UTF_16LE));
        if (line.length() > MAX_COMMAND_LINE_CHARS) {
            // The line is refused before it is sent, so nothing was attempted on the target; the default of a TransferErrorCode says UNKNOWN.
            throw new RequestRefusedException(TransferErrorCode.WINDOWS_COMMAND_TOO_LARGE, false, ExecutionAttempt.NOT_ATTEMPTED);
        }
        return line;
    }
}
