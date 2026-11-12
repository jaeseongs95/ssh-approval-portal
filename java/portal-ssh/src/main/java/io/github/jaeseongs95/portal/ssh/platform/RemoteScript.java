package io.github.jaeseongs95.portal.ssh.platform;

/**
 * The name of one fixed sentence the portal sends to a target: a file of {@code ssh/remote/} on the classpath. A script of this enum is not run on this server. It is
 * data that travels to the target, where PowerShell or Python reads it (docs/external-programs: a command and its wrapper run where the user's command runs, on a
 * machine without a JVM, so Java cannot stand in for them). The {@code @@NAME@@} marks inside a file are filled in by {@link RemoteScripts#fill}.
 */
public enum RemoteScript {

    /** The C# type that reads the standard input of PowerShell by the real pipe end, compiled on the target. */
    WINDOWS_STDIN_READER("windows-stdin-reader.ps1"),
    /** The catch-block text that reports the original error and its position on the standard error. */
    WINDOWS_ERROR_REPORT("windows-error-report.ps1"),
    /** The line that stops the autoloading of modules. */
    WINDOWS_AUTOLOAD_OFF("windows-autoload-off.ps1"),
    /** The line that loads one module of the PowerShell installation by its fixed path. Mark: MODULE. */
    WINDOWS_IMPORT_MODULE("windows-import-module.ps1"),
    /** The lines that move into the working directory, given as base64 data. Marks: IMPORT_MANAGEMENT, WORKDIR_BASE64. */
    WINDOWS_WORKDIR("windows-workdir.ps1"),
    /** The frame of a fixed portal sentence run directly. Marks: PRELUDE, COMMAND, ERROR_REPORT. */
    WINDOWS_WRAPPED_COMMAND("windows-wrapped-command.ps1"),
    /** The receiver of a user command: reads the bytes through the end, checks length and hash, then compiles. Marks: STDIN_READER, BUFFER_LENGTH, BYTE_COUNT, SHA256, PRELUDE, ERROR_REPORT. */
    WINDOWS_COMMAND_RECEIVER("windows-command-receiver.ps1"),
    /** The stub that unpacks a gzip receiver and runs it. Marks: PACKED, ERROR_REPORT. */
    WINDOWS_RECEIVER_STUB("windows-receiver-stub.ps1"),
    /** The script that starts the Python of a Windows target and copies its standard input byte by byte. Marks: STDIN_READER, INTERPRETER_BASE64, ARGUMENTS, ERROR_REPORT. */
    WINDOWS_SOURCE_LAUNCHER("windows-source-launcher.ps1"),
    /** The outer expression of the launcher: unpacks a gzip text and runs it. Mark: PACKED. */
    WINDOWS_SOURCE_BOOTSTRAP("windows-source-bootstrap.ps1"),
    /** The Python receiver of a POSIX target: reads the source through the end, checks length and hash, then compiles. No marks. */
    PYTHON_RECEIVER_POSIX("python-receiver-posix.py"),
    /** The Python receiver of a Windows target: reads a frame (header and source), checks both, then compiles. No marks. */
    PYTHON_RECEIVER_WINDOWS("python-receiver-windows.py");

    private final String resourceName;

    RemoteScript(String resourceName) {
        this.resourceName = resourceName;
    }

    /** The file name under {@code ssh/remote/} on the classpath. */
    public String resourceName() {
        return resourceName;
    }
}
