package io.github.jaeseongs95.portal.domain.path;

import static org.assertj.core.api.Assertions.assertThat;

import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

/** The containment, directory and sibling of a remote path (the allowed-root rule of a file transfer, stage 3 design 4.4 line 16). */
class RemotePathWithinTest {

    @Test
    @DisplayName("S3-SF-15 a Windows path is within its allowed root without regard to case, drive letter case or separator")
    void windowsContainmentIgnoresCaseAndSeparator() {
        RemotePath root = new WindowsRemotePath("C:\\Work\\Files");
        assertThat(new WindowsRemotePath("c:/work/files/a.bin").isWithin(root)).isTrue();
        assertThat(new WindowsRemotePath("C:\\WORK\\FILES\\sub\\deep\\a.bin").isWithin(root)).isTrue();
        assertThat(new WindowsRemotePath("C:\\Work\\Files").isWithin(root)).as("the root itself").isTrue();
    }

    @Test
    @DisplayName("S3-SF-15 a Windows path outside the allowed root: a sibling that starts with the same letters, another folder, another drive")
    void windowsContainmentRefusesOutsidePaths() {
        RemotePath root = new WindowsRemotePath("C:\\Work\\Files");
        assertThat(new WindowsRemotePath("C:\\Work\\Files2\\a.bin").isWithin(root)).isFalse();
        assertThat(new WindowsRemotePath("C:\\Work\\a.bin").isWithin(root)).isFalse();
        assertThat(new WindowsRemotePath("D:\\Work\\Files\\a.bin").isWithin(root)).isFalse();
        assertThat(new WindowsRemotePath("C:\\Other\\Files\\a.bin").isWithin(root)).isFalse();
    }

    @Test
    @DisplayName("S3-SF-15 a POSIX path is within its root part by part, case matters, empty parts name the same directory")
    void posixContainmentIsExactPartByPart() {
        RemotePath root = new PosixRemotePath("/srv/data");
        assertThat(new PosixRemotePath("/srv/data/a.bin").isWithin(root)).isTrue();
        assertThat(new PosixRemotePath("/srv//data///a/b.bin").isWithin(root)).isTrue();
        assertThat(new PosixRemotePath("/srv/database/a.bin").isWithin(root)).isFalse();
        assertThat(new PosixRemotePath("/srv/Data/a.bin").isWithin(root)).isFalse();
        assertThat(new PosixRemotePath("/srv/a.bin").isWithin(root)).isFalse();
    }

    @Test
    @DisplayName("S3-SF-15 a root of the other syntax contains nothing")
    void rootsOfOtherSyntaxContainNothing() {
        assertThat(new PosixRemotePath("/c:/work/a.bin").isWithin(new WindowsRemotePath("C:\\work"))).isFalse();
        assertThat(new WindowsRemotePath("C:\\work\\a.bin").isWithin(new PosixRemotePath("/work"))).isFalse();
    }

    @Test
    @DisplayName("S3-SF-01 the directory of a path is the text before its last part, the root for a file at the top")
    void directoryOfAPath() {
        assertThat(new PosixRemotePath("/srv/data/a.bin").directory()).isEqualTo("/srv/data");
        assertThat(new PosixRemotePath("/a.bin").directory()).isEqualTo("/");
        assertThat(new PosixRemotePath("/srv//data///a.bin").directory()).isEqualTo("/srv//data");
        assertThat(new WindowsRemotePath("C:\\work\\a.bin").directory()).isEqualTo("C:\\work");
        assertThat(new WindowsRemotePath("C:/work/sub/a.bin").directory()).isEqualTo("C:/work/sub");
        assertThat(new WindowsRemotePath("C:\\a.bin").directory()).isEqualTo("C:\\");
    }

    @Test
    @DisplayName("S3-SF-01 a sibling is a file of the same directory in the same syntax and separator")
    void siblingOfAPath() {
        assertThat(new PosixRemotePath("/srv/data/a.bin").sibling(".ssh-approval-0f.part").value()).isEqualTo("/srv/data/.ssh-approval-0f.part");
        assertThat(new PosixRemotePath("/a.bin").sibling("b.bin").value()).isEqualTo("/b.bin");
        assertThat(new WindowsRemotePath("C:\\work\\a.bin").sibling("b.bin").value()).isEqualTo("C:\\work\\b.bin");
        assertThat(new WindowsRemotePath("C:/work/a.bin").sibling("b.bin").value()).isEqualTo("C:/work/b.bin");
        assertThat(new WindowsRemotePath("C:\\a.bin").sibling("b.bin").value()).isEqualTo("C:\\b.bin");
    }
}
