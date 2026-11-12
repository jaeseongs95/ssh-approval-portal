package io.github.jaeseongs95.portal.domain.path;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import java.util.List;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

class RemotePathTest {

    @Test
    @DisplayName("RC-B-580 a Windows path: three accepted forms come back as written and the basename is the last part")
    void windowsPathAccepted() {
        for (String path : List.of("C:\\\uc2b9\uc778 \ud30c\uc77c\\\ud55c\uae00.bin", "d:/\uc2b9\uc778 \ud30c\uc77c/\ud55c\uae00.bin", "C:/files/single'quote.bin")) {
            assertThat(new WindowsRemotePath(path).value()).isEqualTo(path);
            assertThat(RemotePath.parse(path)).isInstanceOf(WindowsRemotePath.class);
            assertThat(PathSyntax.WINDOWS.path(path).value()).isEqualTo(path);
        }
        assertThat(new WindowsRemotePath("C:\\\uc2b9\uc778 \ud30c\uc77c\\\ud55c\uae00.bin").basename()).isEqualTo("\ud55c\uae00.bin");
        assertThat(new WindowsRemotePath("C:/files/file.bin").basename()).isEqualTo("file.bin");
    }

    @Test
    @DisplayName("RC-B-580 S2-VA-04 a Windows path: the drive root, dot parts, doubled separators, stream names, reserved device names and unsafe endings are refused")
    void windowsPathRefused() {
        String longPath = "C:\\" + "a".repeat(4094);
        List<String> refused = List.of("", "C:", "C:relative.bin", "C:/", "C:\\", "/tmp/file", "\\\\server\\share\\file", "\\\\?\\C:\\file", "\\\\.\\NUL", "C:/file:stream",
            "C:\\..\\file", "C:\\.\\file", "C:\\a\\.", "C:\\a\\..\\b", "C:\\a\\\\b", "C:/a//b", "C:/file/", "C:\\a.", "C:\\a ", "C:\\a\nb", "C:\\a\u200bb", "C:\\a?b",
            "C:\\a*b", "C:\\a\"b", "C:\\a<b", "C:\\a|b", "C:\\CON", "C:\\nul.txt", "C:\\AUX\\file", "C:\\prn", "C:\\COM1.log", "C:\\lpt9", "C:\\COM\u00b9", "C:\\LPT\u00b2",
            " C:\\file", "C:\\file ", longPath);
        for (String path : refused) {
            assertThatThrownBy(() -> new WindowsRemotePath(path)).as("path %s", path).isInstanceOf(IllegalArgumentException.class);
        }
        assertThat(new WindowsRemotePath("C:\\" + "a".repeat(4093)).value()).hasSize(4096);
        assertThat(new WindowsRemotePath("C:\\CONSOLE").value()).as("CON is reserved only as a whole name or before a dot").isEqualTo("C:\\CONSOLE");
        assertThat(new WindowsRemotePath("C:\\COM10").value()).isEqualTo("C:\\COM10");
    }

    @Test
    @DisplayName("RC-B-581 S2-VA-03 a POSIX path: spaces, backslashes and empty parts are fine, the basename drops trailing slashes")
    void posixPathAccepted() {
        for (String path : List.of("/tmp/\ud55c\uae00.bin", "/tmp/back\\slash.bin", "//a", "/a//b", "///")) {
            assertThat(new PosixRemotePath(path).value()).isEqualTo(path);
            assertThat(RemotePath.parse(path)).isInstanceOf(PosixRemotePath.class);
        }
        assertThat(new PosixRemotePath("/tmp/back\\slash.bin").basename()).isEqualTo("back\\slash.bin");
        assertThat(new PosixRemotePath("/tmp/directory///").basename()).isEqualTo("directory");
        assertThat(new PosixRemotePath("///").basename()).isEmpty();
        assertThat(new PosixRemotePath("/a").basename()).isEqualTo("a");
        assertThat(new PosixRemotePath("/" + "a".repeat(4095)).value()).hasSize(4096);
    }

    @Test
    @DisplayName("S2-VA-03 a POSIX path: the root, relative paths, dot parts, outer white space, hidden characters and 4097 characters are refused")
    void posixPathRefused() {
        List<String> refused = List.of("/", "", "tmp/file", "./file", "/a/../b", "/a/./b", "/a/..", " /a", "/a ", "\u00a0/a", "/a\u202eb", "/a\nb", "/a\0b", "/" + "a".repeat(4096));
        for (String path : refused) {
            assertThatThrownBy(() -> new PosixRemotePath(path)).as("path %s", path).isInstanceOf(IllegalArgumentException.class);
        }
    }

    @Test
    @DisplayName("RC-B-581 a Windows path is no POSIX path and C:/NUL.txt is no path at all")
    void syntaxesDoNotMix() {
        assertThatThrownBy(() -> new PosixRemotePath("C:/files/file.bin")).isInstanceOf(IllegalArgumentException.class);
        assertThatThrownBy(() -> RemotePath.parse("C:/NUL.txt")).isInstanceOf(IllegalArgumentException.class);
        assertThatThrownBy(() -> PathSyntax.POSIX.path("C:\\file")).isInstanceOf(IllegalArgumentException.class);
        assertThatThrownBy(() -> PathSyntax.WINDOWS.path("/tmp/file")).isInstanceOf(IllegalArgumentException.class);
    }
}
