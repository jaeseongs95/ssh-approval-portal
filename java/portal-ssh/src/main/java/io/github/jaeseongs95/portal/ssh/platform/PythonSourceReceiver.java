package io.github.jaeseongs95.portal.ssh.platform;

import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.Base64;
import java.util.List;
import java.util.Map;
import java.util.Objects;
import java.util.regex.Pattern;
import java.util.stream.Collectors;

import org.springframework.stereotype.Component;

import io.github.jaeseongs95.portal.app.remote.CommandKind;
import io.github.jaeseongs95.portal.app.remote.PreparedCommand;
import io.github.jaeseongs95.portal.app.remote.SourceArguments;
import io.github.jaeseongs95.portal.app.remote.StdinBytes;
import io.github.jaeseongs95.portal.domain.error.ExecutionAttempt;
import io.github.jaeseongs95.portal.domain.error.RequestErrorCode;
import io.github.jaeseongs95.portal.domain.error.RequestRefusedException;
import io.github.jaeseongs95.portal.domain.error.TransferErrorCode;
import io.github.jaeseongs95.portal.domain.id.Digest;
import io.github.jaeseongs95.portal.domain.id.Digester;
import io.github.jaeseongs95.portal.domain.target.WindowsDirectory;
import io.github.jaeseongs95.portal.domain.target.WindowsPythonExecutable;
import io.github.jaeseongs95.portal.domain.text.SourceText;
import io.github.jaeseongs95.portal.domain.text.Utf8Text;

/**
 * Makes the command line and the standard input that run a Python source on a target (2.x python-source.mjs and windows-python-source.mjs, contract
 * {@code python-source-v1}).
 *
 * <p>Why this class exists: the source a user submits runs on the target, which has a Python and no JVM, so the thing that receives the source there has to be
 * Python (and, on Windows, PowerShell that starts it). That is a product feature that Java cannot replace. The receivers are data that this server sends; the
 * server starts no process for them (docs/external-programs).
 *
 * <p>What the receivers do: they read the standard input through the end, and only then check the length and the SHA-256 and compile. A source that is cut off, changed
 * or followed by more bytes is refused with exit code 125 before it has any effect; a source that is not UTF-8 or does not compile gets exit code 126. This is
 * transport integrity. It is not a sandbox and not an authority to run anything.
 *
 * <p>A POSIX target gets the source as the standard input and the length, the hash, the directory and the arguments as arguments of the interpreter. A Windows
 * target gets a frame as the standard input (the length of a JSON header, a line break, the header, then the source), and the command line holds only the fixed
 * receiver and the length and hash of the frame: the source, the arguments and the directory never appear in the command line the Windows shell parses.
 */
@Component
public final class PythonSourceReceiver {

    private static final int MAX_ARGUMENTS = 16;
    private static final int MAX_ARGUMENT_BYTES = 512;
    private static final int MAX_ARGUMENTS_JSON_BYTES = 4096;
    private static final int MAX_CWD_BYTES = 512;
    private static final int MAX_POSIX_COMMAND_LINE_CHARS = 2000;
    private static final int MAX_WINDOWS_COMMAND_LINE_CHARS = 8000;

    private static final String POSIX_INTERPRETER = "/usr/bin/python3";
    private static final List<String> START_FLAGS = List.of("-I", "-B", "-S", "-X", "utf8", "-c");
    private static final String WINDOWS_COMMAND_PREFIX = "powershell.exe -NoLogo -NoProfile -NonInteractive -WindowStyle Hidden -Command \"";

    /** The environment a POSIX receiver gives the source (python-receiver-posix.py sets the same three variables). Its hash is the revision of the policy. */
    private static final String LINUX_ENVIRONMENT_POLICY = "{\"LANG\":\"C.UTF-8\",\"LC_ALL\":\"C.UTF-8\",\"PATH\":\"/usr/bin:/bin\"}";
    /** The environment a Windows receiver gives the source (python-receiver-windows.py keeps these variables and builds PATH from the interpreter directory). */
    private static final String WINDOWS_ENVIRONMENT_POLICY = "{\"inherit\":[\"SystemRoot\",\"WINDIR\",\"TEMP\",\"TMP\",\"USERPROFILE\",\"HOMEDRIVE\",\"HOMEPATH\","
        + "\"LOCALAPPDATA\",\"APPDATA\",\"PROGRAMDATA\"],\"path\":\"interpreter-directory;SystemRoot\\\\System32;SystemRoot\"}";

    /** The receiver arguments are put into a PowerShell string as they are, so they may hold printable ASCII, TAB, CR and LF only. */
    private static final Pattern FIXED_ARGUMENTS = Pattern.compile("[\\t\\r\\n\\x20-\\x7e]+");

    private final RemoteScripts scripts;
    private final Digester digester;

    public PythonSourceReceiver(RemoteScripts scripts, Digester digester) {
        this.scripts = Objects.requireNonNull(scripts, "scripts");
        this.digester = Objects.requireNonNull(digester, "digester");
    }

    /**
     * The command of a source run on a POSIX target (2.x buildPythonSource): {@code [sudo -n --] /usr/bin/python3 -I -B -S -X utf8 -c <receiver> <length> <sha256>
     * <cwd> <arguments...>}, every word in single quotes. The standard input is the UTF-8 bytes of the source.
     *
     * @param source the source text
     * @param args the arguments, at most 16, each at most 512 UTF-8 bytes without CR, LF or NUL, together at most 4096 bytes as JSON
     * @param cwd the working directory: absolute (starts with {@code /}), at most 512 UTF-8 bytes, no control character
     * @param elevate whether {@code sudo -n --} goes first
     * @return the command with the kind {@link CommandKind#SOURCE}
     * @throws RequestRefusedException {@link RequestErrorCode#INVALID_OPERATION_INPUT} for a bad argument or directory, or a command longer than 2000 characters
     */
    public PreparedCommand prepareLinux(SourceText source, SourceArguments args, String cwd, boolean elevate) {
        Objects.requireNonNull(source, "source");
        Objects.requireNonNull(cwd, "cwd");
        List<String> arguments = checkedArguments(args);
        requirePosixDirectory(cwd);
        byte[] bytes = source.value().getBytes(StandardCharsets.UTF_8);
        List<String> words = new ArrayList<>();
        if (elevate) {
            words.addAll(List.of("sudo", "-n", "--"));
        }
        words.add(POSIX_INTERPRETER);
        words.addAll(START_FLAGS);
        words.add(scripts.text(RemoteScript.PYTHON_RECEIVER_POSIX));
        words.add(Integer.toString(bytes.length));
        words.add(digester.digest(bytes).hex());
        words.add(cwd);
        words.addAll(arguments);
        String line = words.stream().map(PythonSourceReceiver::singleQuoted).collect(Collectors.joining(" "));
        if (line.length() > MAX_POSIX_COMMAND_LINE_CHARS) {
            throw new RequestRefusedException(RequestErrorCode.INVALID_OPERATION_INPUT);
        }
        return new PreparedCommand(line, new StdinBytes(bytes), CommandKind.SOURCE);
    }

    /**
     * The command of a source run on a Windows target (2.x prepareWindowsPythonSource). The line is {@code powershell.exe ... -Command "<bootstrap>"}; the bootstrap
     * unpacks a fixed launcher that starts the Python interpreter with the fixed receiver and copies the standard input to it byte by byte. The standard input is the
     * frame: the UTF-8 length of the header, a line break, the JSON header ({@code sourceBytes}, {@code sourceSha256}, {@code argv}, {@code cwd}, {@code elevate}), then
     * the source. When {@code elevate} is true the receiver refuses to run without an administrator token (exit code 126); nothing here asks Windows to raise rights.
     *
     * @param source the source text
     * @param args the arguments, with the limits of {@link #prepareLinux}
     * @param cwd the working directory on the target
     * @param interpreter the absolute path of the Python executable on the target
     * @param elevate whether the receiver demands an administrator token
     * @return the command with the kind {@link CommandKind#SOURCE}
     * @throws RequestRefusedException {@link RequestErrorCode#INVALID_OPERATION_INPUT} for a bad argument;
     *     {@link TransferErrorCode#WINDOWS_COMMAND_TOO_LARGE} when the line would be longer than 8000 characters
     */
    public PreparedCommand prepareWindows(SourceText source, SourceArguments args, WindowsDirectory cwd, WindowsPythonExecutable interpreter, boolean elevate) {
        Objects.requireNonNull(source, "source");
        Objects.requireNonNull(cwd, "cwd");
        Objects.requireNonNull(interpreter, "interpreter");
        List<String> arguments = checkedArguments(args);
        byte[] sourceBytes = source.value().getBytes(StandardCharsets.UTF_8);
        String header = "{\"sourceBytes\":" + sourceBytes.length + ",\"sourceSha256\":" + jsonString(digester.digest(sourceBytes).hex())
            + ",\"argv\":" + jsonArray(arguments) + ",\"cwd\":" + jsonString(cwd.value()) + ",\"elevate\":" + elevate + "}";
        byte[] frame = (header.getBytes(StandardCharsets.UTF_8).length + "\n" + header + source.value()).getBytes(StandardCharsets.UTF_8);

        List<String> receiverArguments = new ArrayList<>(START_FLAGS);
        receiverArguments.add(scripts.text(RemoteScript.PYTHON_RECEIVER_WINDOWS));
        receiverArguments.add(Integer.toString(frame.length));
        receiverArguments.add(digester.digest(frame).hex());
        // Only the fixed receiver and the generated length and hash are in this text; the arguments, the directory and the source exist in the frame alone.
        String fixedArguments = receiverArguments.stream().map(PythonSourceReceiver::windowsQuoted).collect(Collectors.joining(" "));
        if (!FIXED_ARGUMENTS.matcher(fixedArguments).matches()) {
            throw new IllegalStateException("The fixed Python receiver for Windows has a character the command line cannot carry");
        }
        String launcher = scripts.fill(RemoteScript.WINDOWS_SOURCE_LAUNCHER, Map.of(
            "STDIN_READER", scripts.line(RemoteScript.WINDOWS_STDIN_READER),
            "INTERPRETER_BASE64", Base64.getEncoder().encodeToString(interpreter.value().getBytes(StandardCharsets.UTF_8)),
            "ARGUMENTS", fixedArguments.replace("'", "''"),
            "ERROR_REPORT", scripts.line(RemoteScript.WINDOWS_ERROR_REPORT)));
        String bootstrap = scripts.fill(RemoteScript.WINDOWS_SOURCE_BOOTSTRAP, Map.of("PACKED", scripts.gzipBase64(launcher)));
        String line = WINDOWS_COMMAND_PREFIX + bootstrap + "\"";
        if (line.length() > MAX_WINDOWS_COMMAND_LINE_CHARS) {
            // Refused before it is sent, so nothing was attempted on the target; the default of a TransferErrorCode says UNKNOWN.
            throw new RequestRefusedException(TransferErrorCode.WINDOWS_COMMAND_TOO_LARGE, false, ExecutionAttempt.NOT_ATTEMPTED);
        }
        return new PreparedCommand(line, new StdinBytes(frame), CommandKind.SOURCE);
    }

    /** The revision of the environment a POSIX receiver gives the source: the SHA-256 of the policy text (2.x PYTHON_SOURCE_ENVIRONMENT_REVISION). */
    public Digest linuxEnvironmentRevision() {
        return digester.digestUtf8(LINUX_ENVIRONMENT_POLICY);
    }

    /** The revision of the environment a Windows receiver gives the source: the SHA-256 of the policy text (2.x WINDOWS_PYTHON_SOURCE_ENVIRONMENT_REVISION). */
    public Digest windowsEnvironmentRevision() {
        return digester.digestUtf8(WINDOWS_ENVIRONMENT_POLICY);
    }

    /** The arguments after the checks {@link SourceArguments} does not make (it refuses NUL only): count, size, line breaks, and the size of their JSON form. */
    private List<String> checkedArguments(SourceArguments args) {
        Objects.requireNonNull(args, "args");
        List<String> values = args.values();
        if (values.size() > MAX_ARGUMENTS) {
            throw refused();
        }
        for (String value : values) {
            if (!Utf8Text.isWellFormed(value) || new Utf8Text(value).byteLength() > MAX_ARGUMENT_BYTES || hasLineBreakOrNul(value)) {
                throw refused();
            }
        }
        if (jsonArray(values).getBytes(StandardCharsets.UTF_8).length > MAX_ARGUMENTS_JSON_BYTES) {
            throw refused();
        }
        return values;
    }

    private void requirePosixDirectory(String cwd) {
        boolean valid = cwd.startsWith("/") && Utf8Text.isWellFormed(cwd) && new Utf8Text(cwd).byteLength() <= MAX_CWD_BYTES
            && cwd.chars().noneMatch(Character::isISOControl);
        if (!valid) {
            throw refused();
        }
    }

    private RequestRefusedException refused() {
        return new RequestRefusedException(RequestErrorCode.INVALID_OPERATION_INPUT);
    }

    private static boolean hasLineBreakOrNul(String value) {
        return value.indexOf('\r') >= 0 || value.indexOf('\n') >= 0 || value.indexOf('\0') >= 0;
    }

    /** A POSIX shell word in single quotes; a single quote inside becomes {@code '\''}. */
    private static String singleQuoted(String value) {
        return "'" + value.replace("'", "'\\''") + "'";
    }

    /** A CreateProcess argument in double quotes: a run of backslashes before a quote is doubled and the quote escaped, and a run at the end is doubled. */
    private static String windowsQuoted(String value) {
        String escaped = value.replaceAll("(\\\\*)\"", "$1$1\\\\\"").replaceAll("(\\\\+)\\z", "$1$1");
        return "\"" + escaped + "\"";
    }

    /** A JSON array of strings, as {@code JSON.stringify} writes it: no white space. */
    private static String jsonArray(List<String> values) {
        return values.stream().map(PythonSourceReceiver::jsonString).collect(Collectors.joining(",", "[", "]"));
    }

    /**
     * A JSON string, as {@code JSON.stringify} writes it: the quote and the backslash escaped, the short escapes for BS, FF, LF, CR and TAB, a backslash, a "u" and four
     * lower case hex digits for the other controls below 0x20, and everything else as it is. The text is well formed UTF-16, so no lone surrogate needs an escape.
     */
    private static String jsonString(String value) {
        StringBuilder json = new StringBuilder(value.length() + 2).append('"');
        for (int i = 0; i < value.length(); i++) {
            char c = value.charAt(i);
            switch (c) {
                case '"' -> json.append("\\\"");
                case '\\' -> json.append("\\\\");
                case '\b' -> json.append("\\b");
                case '\f' -> json.append("\\f");
                case '\n' -> json.append("\\n");
                case '\r' -> json.append("\\r");
                case '\t' -> json.append("\\t");
                default -> {
                    if (c < 0x20) {
                        json.append("\\u00").append(Character.forDigit(c >> 4, 16)).append(Character.forDigit(c & 0xf, 16));
                    } else {
                        json.append(c);
                    }
                }
            }
        }
        return json.append('"').toString();
    }
}
