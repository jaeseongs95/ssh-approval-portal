package io.github.jaeseongs95.portal.server.usecase;

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
 * The targets of the use case tests: one Linux target that a test can replace by a changed one (a new revision) or switch off, which is what a change of the
 * administrator's configuration looks like to a use case. The configuration reader of stage 4 is not in this module.
 */
final class FixedTargets implements TargetSource {

    static final TargetId ID = new TargetId("web-1");
    static final ProfileAlias READ_PROFILE = new ProfileAlias("web-ro");
    static final ProfileAlias WRITE_PROFILE = new ProfileAlias("web-rw");

    private final Digester digester;
    private volatile ResolvedTarget current;
    private volatile boolean enabled = true;

    FixedTargets(Digester digester) {
        this.digester = digester;
        this.current = build("Web one", Toggle.ON);
    }

    @Override
    public TargetLookup lookup(TargetId id) {
        ResolvedTarget target = current;
        if (!target.target().id().equals(id)) {
            return new TargetLookup.NotRegistered(id);
        }
        return enabled ? new TargetLookup.Found(target) : new TargetLookup.Disabled(id);
    }

    /** The target as it is now. */
    ResolvedTarget current() {
        return current;
    }

    /** The administrator changed the target: another display name gives another revision. */
    void change(String displayName) {
        current = build(displayName, Toggle.ON);
    }

    /** Back to the first revision, so the next test starts from the same target. */
    void reset() {
        current = build("Web one", Toggle.ON);
        enabled = true;
    }

    void disable() {
        enabled = false;
    }

    private ResolvedTarget build(String displayName, Toggle toggle) {
        Target target = new Target(ID, new TargetDisplayName(displayName), READ_PROFILE, WRITE_PROFILE, new ProfileAlias("cred1"), toggle, TargetOs.LINUX,
            WindowsRuntime.none(), new CapacityOverride.Inherited(), new CapacityOverride.Inherited(), new DesktopSettings.NoDesktop());
        ConnectionProfile reader = profile(AccessMode.READ_ONLY);
        ConnectionProfile writer = profile(AccessMode.READ_WRITE);
        return ResolvedTarget.of(target, reader, writer, digester);
    }

    private static ConnectionProfile profile(AccessMode access) {
        return new ConnectionProfile("host.example", 22, "deploy", Setting.given("SHA256:test-host-key"), Setting.unset(), AuthMethod.AGENT, Setting.unset(), Setting.unset(),
            access, TtyMode.NO_TTY);
    }
}
