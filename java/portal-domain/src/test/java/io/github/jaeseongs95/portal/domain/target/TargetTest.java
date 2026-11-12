package io.github.jaeseongs95.portal.domain.target;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import io.github.jaeseongs95.portal.domain.capacity.Capacity;
import io.github.jaeseongs95.portal.domain.id.Sha256Digester;
import io.github.jaeseongs95.portal.domain.id.TargetId;
import java.util.List;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import tools.jackson.databind.json.JsonMapper;

class TargetTest {

    @Test
    @DisplayName("S2-VA-06 a Target takes all twelve settings of 2.x: id, name, two profiles, credential revision, switch, platform, Windows runtime, two capacities, desktop")
    void allSettings() {
        WindowsRuntime runtime = new WindowsRuntime(Setting.given(new WindowsDirectory("C:\\")), Setting.given(new WindowsPythonExecutable("C:\\Python312\\python.exe")));
        Target windows = TargetFixtures.windows("win", runtime, new DesktopSettings.Rdp(Toggle.ON, SecretReference.parse("secret://vault/rdp-win"), new DesktopGeometry(1920, 1080)));
        assertThat(windows.os()).isEqualTo(TargetOs.WINDOWS);
        assertThat(windows.capabilities().commandShell()).isEqualTo(CommandShell.WINDOWS_POWERSHELL_5_1);
        assertThat(windows.capabilities().pythonSource()).isTrue();
        Target linux = TargetFixtures.withCapacities(TargetFixtures.linux("alpha"), 7, 3);
        assertThat(linux.queueCapacity()).isEqualTo(new CapacityOverride.Explicit(new Capacity(7)));
        assertThat(linux.queueCapacity().orElse(new Capacity(1))).isEqualTo(new Capacity(7));
        assertThat(linux.maxConcurrency().orElse(new Capacity(1))).isEqualTo(new Capacity(3));
        assertThat(linux.capabilities().commandShell()).isEqualTo(CommandShell.POSIX);
        assertThat(TargetFixtures.linux("beta").queueCapacity().orElse(new Capacity(9))).as("an unset capacity inherits the default").isEqualTo(new Capacity(9));
    }

    @Test
    @DisplayName("S2-VA-06 the read and the write profile must differ, and the aliases are short lowercase names")
    void profileRules() {
        Target base = TargetFixtures.linux("alpha");
        assertThatThrownBy(() -> new Target(base.id(), base.displayName(), base.readProfile(), base.readProfile(), base.credentialRevision(), base.enabled(), base.os(),
            base.windows(), base.queueCapacity(), base.maxConcurrency(), base.desktop())).isInstanceOf(IllegalArgumentException.class);
        for (String bad : new String[] {"Read", "1read", "_read", "read.profile", "a".repeat(33)}) {
            assertThatThrownBy(() -> new Target(base.id(), base.displayName(), new ProfileAlias(bad), base.writeProfile(), base.credentialRevision(), base.enabled(), base.os(),
                base.windows(), base.queueCapacity(), base.maxConcurrency(), base.desktop())).as("read profile %s", bad).isInstanceOf(IllegalArgumentException.class);
        }
        assertThatThrownBy(() -> new Target(base.id(), base.displayName(), base.readProfile(), base.writeProfile(), new ProfileAlias("Rev1"), base.enabled(), base.os(),
            base.windows(), base.queueCapacity(), base.maxConcurrency(), base.desktop())).isInstanceOf(IllegalArgumentException.class);
        assertThat(new ProfileAlias("Mixed_Case.profile+1-x").value()).as("the broader profile name of a policy rule").isEqualTo("Mixed_Case.profile+1-x");
        assertThatThrownBy(() -> new ProfileAlias("-x")).isInstanceOf(IllegalArgumentException.class);
        assertThatThrownBy(() -> new ProfileAlias("a".repeat(81))).isInstanceOf(IllegalArgumentException.class);
    }

    @Test
    @DisplayName("S2-VA-06 Windows runtime settings are only for a Windows target; a Python executable has a python name")
    void windowsSettingsOnLinux() {
        Target base = TargetFixtures.linux("alpha");
        WindowsRuntime runtime = new WindowsRuntime(Setting.given(new WindowsDirectory("C:\\work")), Setting.unset());
        assertThatThrownBy(() -> new Target(base.id(), base.displayName(), base.readProfile(), base.writeProfile(), base.credentialRevision(), base.enabled(), base.os(), runtime,
            base.queueCapacity(), base.maxConcurrency(), base.desktop())).isInstanceOf(IllegalArgumentException.class).hasMessageContaining("Windows");
        assertThat(new WindowsPythonExecutable("C:\\python3.exe").value()).isEqualTo("C:\\python3.exe");
        assertThat(new WindowsPythonExecutable("C:/Tools/Python3.12.2.EXE").value()).isEqualTo("C:/Tools/Python3.12.2.EXE");
        for (String bad : new String[] {"C:\\", "C:\\tools\\perl.exe", "C:\\python.bat", "python.exe", "C:\\a\\..\\python.exe"}) {
            assertThatThrownBy(() -> new WindowsPythonExecutable(bad)).as("executable %s", bad).isInstanceOf(IllegalArgumentException.class);
        }
        assertThat(new WindowsDirectory("C:/").value()).isEqualTo("C:/");
        assertThatThrownBy(() -> new WindowsDirectory("C:\\" + "a".repeat(600))).isInstanceOf(IllegalArgumentException.class);
        Target withoutPython = TargetFixtures.windows("win", WindowsRuntime.none(), new DesktopSettings.NoDesktop());
        assertThat(withoutPython.capabilities().pythonSource()).as("a Windows target needs a configured Python for source requests").isFalse();
    }

    @Test
    @DisplayName("S2-VA-06 the desktop backend must fit the platform: Xvnc on Linux, RDP on Windows, a port from 1 to 65535, a geometry within limits")
    void desktopRules() {
        DesktopGeometry standard = DesktopGeometry.standard();
        assertThat(standard).isEqualTo(new DesktopGeometry(1280, 720));
        assertThat(TargetFixtures.linux("a").desktop()).isEqualTo(new DesktopSettings.NoDesktop());
        Target base = TargetFixtures.linux("alpha");
        assertThat(new Target(base.id(), base.displayName(), base.readProfile(), base.writeProfile(), base.credentialRevision(), base.enabled(), base.os(), base.windows(),
            base.queueCapacity(), base.maxConcurrency(), new DesktopSettings.ManagedXvnc(Toggle.ON, standard)).desktop()).isInstanceOf(DesktopSettings.ManagedXvnc.class);
        assertThatThrownBy(() -> new Target(base.id(), base.displayName(), base.readProfile(), base.writeProfile(), base.credentialRevision(), base.enabled(), base.os(),
            base.windows(), base.queueCapacity(), base.maxConcurrency(), new DesktopSettings.Rdp(Toggle.ON, SecretReference.parse("secret://vault/a"), standard)))
            .isInstanceOf(IllegalArgumentException.class);
        assertThatThrownBy(() -> TargetFixtures.windows("win", WindowsRuntime.none(), new DesktopSettings.ManagedXvnc(Toggle.ON, standard))).isInstanceOf(IllegalArgumentException.class);
        assertThat(TargetFixtures.windows("win", WindowsRuntime.none(), new DesktopSettings.AttachedRfb(Toggle.OFF, 5900, standard)).desktop()).isNotNull();
        assertThatThrownBy(() -> new DesktopSettings.AttachedRfb(Toggle.ON, 0, standard)).isInstanceOf(IllegalArgumentException.class);
        assertThatThrownBy(() -> new DesktopSettings.AttachedRfb(Toggle.ON, 65536, standard)).isInstanceOf(IllegalArgumentException.class);
        assertThat(new DesktopGeometry(320, 320).width()).isEqualTo(320);
        assertThat(new DesktopGeometry(4096, 1024).height()).isEqualTo(1024);
        for (int[] bad : new int[][] {{319, 720}, {1280, 4097}, {4096, 4096}, {2049, 2049}}) {
            assertThatThrownBy(() -> new DesktopGeometry(bad[0], bad[1])).isInstanceOf(IllegalArgumentException.class);
        }
    }

    @Test
    @DisplayName("S2-VA-06 a secret reference is secret://provider/name and never a secret")
    void secretReferences() {
        SecretReference reference = SecretReference.parse("secret://vault/rdp-win.1");
        assertThat(reference.provider()).isEqualTo("vault");
        assertThat(reference.name()).isEqualTo("rdp-win.1");
        assertThat(reference.text()).isEqualTo("secret://vault/rdp-win.1");
        for (String bad : new String[] {"secret://Vault/a", "secret://vault/", "secret://vault/_a", "secret:/vault/a", "vault/a", "secret://vault/a b", "secret://vault/a\n"}) {
            assertThatThrownBy(() -> SecretReference.parse(bad)).as("reference %s", bad).isInstanceOf(IllegalArgumentException.class);
        }
    }

    @Test
    @DisplayName("S2-VA-06 a display name is at most 80 characters as written, trimmed, without control, format or separator characters")
    void displayNames() {
        assertThat(TargetDisplayName.of("  Production  ").value()).isEqualTo("Production");
        assertThat(TargetDisplayName.of("x".repeat(80)).value()).hasSize(80);
        for (String bad : new String[] {"", "   ", "x".repeat(81), "a\nb", "a\u200bb", "a\u2028b", "a" + (char) 0x7f}) {
            assertThatThrownBy(() -> TargetDisplayName.of(bad)).as("name '%s'", bad).isInstanceOf(IllegalArgumentException.class);
        }
        assertThatThrownBy(() -> new TargetDisplayName(" padded")).isInstanceOf(IllegalArgumentException.class);
    }

    @Test
    @DisplayName("S2-VA-06 the targets are at least one and each id is there once; a default target is an enabled one")
    void targetsList() {
        Target alpha = TargetFixtures.linux("alpha");
        Target beta = TargetFixtures.withEnabled(TargetFixtures.linux("beta"), Toggle.OFF);
        Targets targets = new Targets(List.of(alpha, beta));
        assertThatThrownBy(() -> new Targets(List.of())).isInstanceOf(IllegalArgumentException.class);
        assertThatThrownBy(() -> new Targets(List.of(alpha, alpha))).isInstanceOf(IllegalArgumentException.class);
        assertThat(targets.requireEnabledDefault(new TargetId("alpha"))).isEqualTo(new TargetId("alpha"));
        assertThatThrownBy(() -> targets.requireEnabledDefault(new TargetId("beta"))).isInstanceOf(IllegalArgumentException.class);
        assertThatThrownBy(() -> targets.requireEnabledDefault(new TargetId("gamma"))).isInstanceOf(IllegalArgumentException.class);
    }

    @Test
    @DisplayName("S2-VA-06 a resolved target needs a read only reader, a writer, the same connection, a pinned host key, and on Windows no workdir and no terminal")
    void resolvedTargets() {
        Sha256Digester digester = new Sha256Digester();
        Target alpha = TargetFixtures.linux("alpha");
        ResolvedTarget resolved = ResolvedTarget.of(alpha, TargetFixtures.reader(), TargetFixtures.writer(), digester);
        assertThat(resolved.revision().hex()).hasSize(64);
        assertThatThrownBy(() -> ResolvedTarget.of(alpha, TargetFixtures.writer(), TargetFixtures.reader(), digester)).isInstanceOf(IllegalArgumentException.class);
        ConnectionProfile otherHost = new ConnectionProfile("other.example.test", 22, "deploy", Setting.given("ssh-ed25519 AAAAC3Nza"), Setting.unset(), AuthMethod.KEY,
            Setting.given("key-ref-1"), Setting.unset(), AccessMode.READ_ONLY, TtyMode.NO_TTY);
        assertThatThrownBy(() -> ResolvedTarget.of(alpha, otherHost, TargetFixtures.writer(), digester)).isInstanceOf(IllegalArgumentException.class);
        ConnectionProfile unpinned = new ConnectionProfile("host.example.test", 22, "deploy", Setting.unset(), Setting.unset(), AuthMethod.KEY, Setting.given("key-ref-1"),
            Setting.unset(), AccessMode.READ_WRITE, TtyMode.NO_TTY);
        ConnectionProfile unpinnedReader = new ConnectionProfile("host.example.test", 22, "deploy", Setting.unset(), Setting.unset(), AuthMethod.KEY, Setting.given("key-ref-1"),
            Setting.unset(), AccessMode.READ_ONLY, TtyMode.NO_TTY);
        assertThatThrownBy(() -> ResolvedTarget.of(alpha, unpinnedReader, unpinned, digester)).hasMessageContaining("pinned");
        Target windows = TargetFixtures.windows("win", WindowsRuntime.none(), new DesktopSettings.NoDesktop());
        assertThatThrownBy(() -> ResolvedTarget.of(windows, TargetFixtures.profile(AccessMode.READ_ONLY, TtyMode.TTY), TargetFixtures.writer(), digester))
            .isInstanceOf(IllegalArgumentException.class);
        ResolvedTargets registry = new ResolvedTargets(List.of(resolved, ResolvedTarget.of(TargetFixtures.withEnabled(TargetFixtures.linux("off"), Toggle.OFF), TargetFixtures.reader(),
            TargetFixtures.writer(), digester)));
        assertThat(registry.lookup(new TargetId("alpha"))).isEqualTo(new TargetLookup.Found(resolved));
        assertThat(registry.lookup(new TargetId("off"))).isEqualTo(new TargetLookup.Disabled(new TargetId("off")));
        assertThat(registry.lookup(new TargetId("none"))).isEqualTo(new TargetLookup.NotRegistered(new TargetId("none")));
    }

    @Test
    @DisplayName("S2-CO-04 the wire values of the target enums and of the switch are those of 2.x")
    void wireValues() throws Exception {
        JsonMapper mapper = new JsonMapper();
        assertThat(mapper.writeValueAsString(TargetOs.LINUX)).isEqualTo("\"linux\"");
        assertThat(mapper.writeValueAsString(TargetOs.WINDOWS)).isEqualTo("\"windows\"");
        assertThat(mapper.writeValueAsString(Toggle.ON)).isEqualTo("true");
        assertThat(mapper.writeValueAsString(Toggle.OFF)).isEqualTo("false");
        assertThat(mapper.writeValueAsString(CommandShell.POSIX)).isEqualTo("\"posix\"");
        assertThat(mapper.writeValueAsString(CommandShell.WINDOWS_POWERSHELL_5_1)).isEqualTo("\"windows-powershell-5.1\"");
    }
}
