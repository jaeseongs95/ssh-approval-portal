package io.github.jaeseongs95.portal.ssh.sftp;

import static org.assertj.core.api.Assertions.assertThat;

import io.github.jaeseongs95.portal.domain.path.PosixRemotePath;
import io.github.jaeseongs95.portal.domain.path.WindowsRemotePath;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

/** The SFTP form of a request path: POSIX as written, Windows as {@code /C:/dir/file}; the directories on the way; the names next to the file. */
class SftpLocationTest {

    @Test
    @DisplayName("S3-SF-13 a POSIX path is sent as written and its directories are listed from the one below the root down to the one that holds the file")
    void posixLocation() {
        SftpLocation location = new SftpLocation(new PosixRemotePath("/srv//data/in/a.bin"));

        assertThat(location.file()).isEqualTo("/srv//data/in/a.bin");
        assertThat(location.directory()).isEqualTo("/srv//data/in");
        assertThat(location.ancestors()).containsExactly("/srv", "/srv/data", "/srv/data/in");
        assertThat(location.sibling(".ssh-approval-0f.part")).isEqualTo("/srv//data/in/.ssh-approval-0f.part");
    }

    @Test
    @DisplayName("S3-SF-13 a file at the top has no directory to inspect")
    void topLevelFile() {
        SftpLocation location = new SftpLocation(new PosixRemotePath("/a.bin"));

        assertThat(location.ancestors()).isEmpty();
        assertThat(location.directory()).isEqualTo("/");
        assertThat(location.sibling("b.bin")).isEqualTo("/b.bin");
    }

    @Test
    @DisplayName("S3-RW-02 a Windows path is sent as /C:/dir/file with forward slashes; the drive is the root and is not inspected")
    void windowsLocation() {
        SftpLocation backslashes = new SftpLocation(new WindowsRemotePath("C:\\work\\in\\a.bin"));
        SftpLocation mixed = new SftpLocation(new WindowsRemotePath("D:/work/a.bin"));

        assertThat(backslashes.file()).isEqualTo("/C:/work/in/a.bin");
        assertThat(backslashes.directory()).isEqualTo("/C:/work/in");
        assertThat(backslashes.ancestors()).containsExactly("/C:/work", "/C:/work/in");
        assertThat(backslashes.sibling("b.bin")).isEqualTo("/C:/work/in/b.bin");
        assertThat(mixed.file()).isEqualTo("/D:/work/a.bin");
        assertThat(new SftpLocation(new WindowsRemotePath("C:\\a.bin")).ancestors()).isEmpty();
        assertThat(new SftpLocation(new WindowsRemotePath("C:\\a.bin")).sibling("b.bin")).isEqualTo("/C:/b.bin");
    }
}
