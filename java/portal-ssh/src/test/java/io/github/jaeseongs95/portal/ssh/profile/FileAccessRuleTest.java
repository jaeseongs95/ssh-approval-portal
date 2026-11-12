package io.github.jaeseongs95.portal.ssh.profile;

import static org.assertj.core.api.Assertions.assertThat;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.attribute.AclEntry;
import java.nio.file.attribute.AclEntryPermission;
import java.nio.file.attribute.AclEntryType;
import java.nio.file.attribute.PosixFilePermission;
import java.nio.file.attribute.PosixFilePermissions;
import java.nio.file.attribute.UserPrincipal;
import java.util.List;
import java.util.Set;

import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

/**
 * Who may use the profile file (vendor PF-04, PF-05). The judgements are tested on values, so they run on every operating system: the permission sets of a file and of its
 * folder for a volume with permission bits, ACL entries of made-up principals for a volume with an access control list. The last test goes through the file system of the
 * machine the test runs on, whichever kind it is (the rule is chosen by what the file store offers).
 */
class FileAccessRuleTest {

    /** A principal that is nobody in particular: the test lists it in an access control list. */
    private record Account(String name) implements UserPrincipal {

        @Override
        public String getName() {
            return name;
        }
    }

    private final PosixFileAccessRule posix = new PosixFileAccessRule();
    private final AclFileAccessRule acl = new AclFileAccessRule();
    private final Path file = Path.of("config.toml");
    private final Path folder = Path.of("settings");

    @TempDir
    Path directory;

    private AclEntry allow(UserPrincipal principal, AclEntryPermission... permissions) {
        return AclEntry.newBuilder().setType(AclEntryType.ALLOW).setPrincipal(principal).setPermissions(permissions).build();
    }

    @Test
    @DisplayName("VR-325: a file of mode 0644 is refused, and the message names the mode and the fix")
    void aFileThatTheGroupOrOthersCanReadIsRefused() {
        AccessVerdict verdict = posix.judge(file, false, PosixFilePermissions.fromString("rw-r--r--"), Protection.NO_OTHER_ACCESS);

        assertThat(verdict).isInstanceOfSatisfying(AccessVerdict.Refused.class, refused -> assertThat(refused.reason())
            .contains("is group/world accessible (mode 644)").contains("Required: 0600").contains("chmod 600").contains(file.toString()));
    }

    @Test
    @DisplayName("VR-326: a file of mode 0600 in a folder of mode 0755 is refused on the folder: the file is judged first and the folder second")
    void aFolderThatOthersCanReadIsRefused() {
        Set<PosixFilePermission> privateFile = PosixFilePermissions.fromString("rw-------");
        Set<PosixFilePermission> openFolder = PosixFilePermissions.fromString("rwxr-xr-x");

        assertThat(posix.judge(file, false, privateFile, Protection.NO_OTHER_ACCESS)).isInstanceOf(AccessVerdict.Private.class);
        assertThat(posix.judge(folder, true, openFolder, Protection.NO_OTHER_ACCESS)).isInstanceOfSatisfying(AccessVerdict.Refused.class,
            refused -> assertThat(refused.reason()).contains("Config directory").contains("(mode 755)").contains("Required: 0700").contains("chmod 700"));
    }

    @Test
    @DisplayName("VR-327: a file of mode 0600 in a folder of mode 0700 passes")
    void aPrivateFileInAPrivateFolderPasses() {
        assertThat(posix.judge(file, false, PosixFilePermissions.fromString("rw-------"), Protection.NO_OTHER_ACCESS)).isInstanceOf(AccessVerdict.Private.class);
        assertThat(posix.judge(folder, true, PosixFilePermissions.fromString("rwx------"), Protection.NO_OTHER_ACCESS)).isInstanceOf(AccessVerdict.Private.class);
    }

    @Test
    @DisplayName("D3-10: a file that others may read but not write passes the check for known hosts, and a file they may write does not")
    void theKnownHostsCheckOnlyLooksAtWriting() {
        assertThat(posix.judge(file, false, PosixFilePermissions.fromString("rw-r--r--"), Protection.NO_OTHER_WRITE)).isInstanceOf(AccessVerdict.Private.class);
        assertThat(posix.judge(file, false, PosixFilePermissions.fromString("rw-rw-r--"), Protection.NO_OTHER_WRITE)).isInstanceOf(AccessVerdict.Refused.class);
        assertThat(posix.judge(file, false, PosixFilePermissions.fromString("rw-r--rw-"), Protection.NO_OTHER_WRITE)).isInstanceOf(AccessVerdict.Refused.class);
    }

    @Test
    @DisplayName("VR-328: an access control list that lets another account write is refused, and the account is named")
    void anAccountThatMayWriteIsRefused() {
        Account owner = new Account("owner");
        Account everyone = new Account("Everyone");
        List<AclEntry> entries = List.of(allow(owner, AclEntryPermission.READ_DATA, AclEntryPermission.WRITE_DATA),
            allow(everyone, AclEntryPermission.READ_DATA, AclEntryPermission.WRITE_DATA));

        AccessVerdict verdict = acl.judge(file, Set.of(owner), entries, Protection.NO_OTHER_ACCESS);

        assertThat(verdict).isInstanceOfSatisfying(AccessVerdict.Refused.class, refused -> assertThat(refused.reason()).contains("Everyone").contains(file.toString()));
    }

    @Test
    @DisplayName("VR-329: an access control list that lets another account only read is a warning, not a refusal")
    void anAccountThatMayOnlyReadIsAWarning() {
        Account owner = new Account("owner");
        Account users = new Account("Users");
        List<AclEntry> entries = List.of(allow(owner, AclEntryPermission.READ_DATA, AclEntryPermission.WRITE_DATA), allow(users, AclEntryPermission.READ_DATA));

        assertThat(acl.judge(file, Set.of(owner), entries, Protection.NO_OTHER_ACCESS)).isInstanceOfSatisfying(AccessVerdict.Exposed.class,
            exposed -> assertThat(exposed.reason()).contains("Users"));
        assertThat(acl.judge(file, Set.of(owner), entries, Protection.NO_OTHER_WRITE)).as("reading by others is no problem for the known hosts").isInstanceOf(AccessVerdict.Private.class);
    }

    @Test
    @DisplayName("VR-328: the owner, the system account and a DENY entry are not an exposure")
    void trustedAccountsAndDenyEntriesAreNotAnExposure() {
        Account owner = new Account("owner");
        Account system = new Account("SYSTEM");
        Account everyone = new Account("Everyone");
        List<AclEntry> entries = List.of(
            AclEntry.newBuilder().setType(AclEntryType.DENY).setPrincipal(everyone).setPermissions(AclEntryPermission.WRITE_DATA).build(),
            allow(owner, AclEntryPermission.READ_DATA, AclEntryPermission.WRITE_DATA, AclEntryPermission.WRITE_ACL),
            allow(system, AclEntryPermission.READ_DATA, AclEntryPermission.WRITE_DATA, AclEntryPermission.WRITE_OWNER));

        assertThat(acl.judge(file, Set.of(owner, system), entries, Protection.NO_OTHER_ACCESS)).isInstanceOf(AccessVerdict.Private.class);
    }

    @Test
    @DisplayName("VR-325, VR-328, VR-329: on the file system of this machine a private file in a private folder passes, and opening it to others is a refusal (permission bits) or a warning (read, ACL)")
    void theGuardJudgesTheRealFileSystem() throws IOException {
        Path folderOnDisk = TestFiles.privateFolder(Files.createDirectory(directory.resolve("settings")));
        Path fileOnDisk = TestFiles.privateFile(Files.writeString(folderOnDisk.resolve("config.toml"), "# profiles\n"));
        FileAccessGuard guard = TestFiles.guard();
        assertThat(guard.inspect(fileOnDisk, Protection.NO_OTHER_ACCESS)).isInstanceOf(AccessVerdict.Private.class);

        TestFiles.openToRead(fileOnDisk);
        if (TestFiles.hasPermissionBits(fileOnDisk)) {
            assertThat(guard.inspect(fileOnDisk, Protection.NO_OTHER_ACCESS)).isInstanceOf(AccessVerdict.Refused.class);
        } else {
            assertThat(guard.inspect(fileOnDisk, Protection.NO_OTHER_ACCESS)).isInstanceOf(AccessVerdict.Exposed.class);
        }

        TestFiles.privateFile(fileOnDisk);
        TestFiles.openToWrite(fileOnDisk);
        assertThat(guard.inspect(fileOnDisk, Protection.NO_OTHER_ACCESS)).isInstanceOf(AccessVerdict.Refused.class);
        assertThat(guard.inspect(fileOnDisk, Protection.NO_OTHER_WRITE)).isInstanceOf(AccessVerdict.Refused.class);
    }

    @Test
    @DisplayName("VR-326: the folder is judged after the file, and a folder that others can use is refused through the guard")
    void theGuardJudgesTheFolderToo() throws IOException {
        Path folderOnDisk = TestFiles.privateFolder(Files.createDirectory(directory.resolve("open-settings")));
        Path fileOnDisk = TestFiles.privateFile(Files.writeString(folderOnDisk.resolve("config.toml"), "# profiles\n"));
        TestFiles.openToWrite(folderOnDisk);

        assertThat(TestFiles.guard().inspect(fileOnDisk, Protection.NO_OTHER_ACCESS)).isInstanceOf(AccessVerdict.Refused.class);
    }
}
