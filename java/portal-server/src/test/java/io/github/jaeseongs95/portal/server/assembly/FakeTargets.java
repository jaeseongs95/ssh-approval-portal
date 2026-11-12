package io.github.jaeseongs95.portal.server.assembly;

import java.util.List;

import io.github.jaeseongs95.portal.app.capacity.ConfiguredTargets;
import io.github.jaeseongs95.portal.app.target.TargetSource;
import io.github.jaeseongs95.portal.domain.id.Digester;
import io.github.jaeseongs95.portal.domain.id.TargetId;
import io.github.jaeseongs95.portal.domain.target.AccessMode;
import io.github.jaeseongs95.portal.domain.target.AuthMethod;
import io.github.jaeseongs95.portal.domain.target.CapacityOverride;
import io.github.jaeseongs95.portal.domain.target.ConnectionProfile;
import io.github.jaeseongs95.portal.domain.target.DesktopSettings;
import io.github.jaeseongs95.portal.domain.target.ProfileAlias;
import io.github.jaeseongs95.portal.domain.target.ResolvedTarget;
import io.github.jaeseongs95.portal.domain.target.Setting;
import io.github.jaeseongs95.portal.domain.target.Target;
import io.github.jaeseongs95.portal.domain.target.TargetDisplayName;
import io.github.jaeseongs95.portal.domain.target.TargetLookup;
import io.github.jaeseongs95.portal.domain.target.TargetOs;
import io.github.jaeseongs95.portal.domain.target.Toggle;
import io.github.jaeseongs95.portal.domain.target.TtyMode;
import io.github.jaeseongs95.portal.domain.target.WindowsRuntime;

/**
 * The targets of the assembly tests: a Linux target and a Windows target with documentation host names only, and a way to change the Linux one (another display name gives
 * another revision) or to switch it off, which is what a change of the administrator's configuration looks like to a use case. The configuration reader is stage 4's.
 */
final class FakeTargets implements TargetSource, ConfiguredTargets {

    static final TargetId LINUX_ID = new TargetId("web-1");
    static final TargetId WINDOWS_ID = new TargetId("win-1");
    static final ProfileAlias LINUX_WRITE = new ProfileAlias("web-rw");

    private final Digester digester;
    private volatile ResolvedTarget linux;
    private volatile ResolvedTarget windows;
    private volatile boolean linuxEnabled = true;

    FakeTargets(Digester digester) {
        this.digester = digester;
        reset();
    }

    @Override
    public TargetLookup lookup(TargetId id) {
        if (id.equals(LINUX_ID)) {
            return linuxEnabled ? new TargetLookup.Found(linux) : new TargetLookup.Disabled(id);
        }
        if (id.equals(WINDOWS_ID)) {
            return new TargetLookup.Found(windows);
        }
        return new TargetLookup.NotRegistered(id);
    }

    ResolvedTarget linux() {
        return linux;
    }

    ResolvedTarget windows() {
        return windows;
    }

    /** The configured targets, for the capacity defaults. */
    @Override
    public List<Target> entries() {
        return List.of(linux.target(), windows.target());
    }

    void changeLinux(String displayName) {
        linux = build(LINUX_ID, "web-ro", "web-rw", TargetOs.LINUX, displayName);
    }

    void disableLinux() {
        linuxEnabled = false;
    }

    void reset() {
        linux = build(LINUX_ID, "web-ro", "web-rw", TargetOs.LINUX, "Web one");
        windows = build(WINDOWS_ID, "win-ro", "win-rw", TargetOs.WINDOWS, "Windows one");
        linuxEnabled = true;
    }

    private ResolvedTarget build(TargetId id, String read, String write, TargetOs os, String displayName) {
        Target target = new Target(id, new TargetDisplayName(displayName), new ProfileAlias(read), new ProfileAlias(write), new ProfileAlias("cred1"), Toggle.ON, os,
            WindowsRuntime.none(), new CapacityOverride.Inherited(), new CapacityOverride.Inherited(), new DesktopSettings.NoDesktop());
        return ResolvedTarget.of(target, profile(AccessMode.READ_ONLY), profile(AccessMode.READ_WRITE), digester);
    }

    private ConnectionProfile profile(AccessMode access) {
        return new ConnectionProfile("host.example", 22, "deploy", Setting.given("SHA256:test-host-key"), Setting.unset(), AuthMethod.AGENT, Setting.unset(), Setting.unset(),
            access, TtyMode.NO_TTY);
    }
}
