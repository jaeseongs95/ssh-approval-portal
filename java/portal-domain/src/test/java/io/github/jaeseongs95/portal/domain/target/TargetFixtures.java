package io.github.jaeseongs95.portal.domain.target;

import io.github.jaeseongs95.portal.domain.capacity.Capacity;
import io.github.jaeseongs95.portal.domain.id.TargetId;

/** Builders of valid targets and profiles for the target tests; a test changes one thing and builds the rest from here. */
final class TargetFixtures {

    private TargetFixtures() {
    }

    static Target linux(String id) {
        return new Target(new TargetId(id), TargetDisplayName.of("Target " + id), new ProfileAlias("read-" + id), new ProfileAlias("write-" + id), new ProfileAlias("rev1"), Toggle.ON,
            TargetOs.LINUX, WindowsRuntime.none(), new CapacityOverride.Inherited(),
            new CapacityOverride.Inherited(), new DesktopSettings.NoDesktop());
    }

    static Target windows(String id, WindowsRuntime runtime, DesktopSettings desktop) {
        return new Target(new TargetId(id), TargetDisplayName.of("Target " + id), new ProfileAlias("read-" + id), new ProfileAlias("write-" + id), new ProfileAlias("rev1"), Toggle.ON,
            TargetOs.WINDOWS, runtime, new CapacityOverride.Inherited(), new CapacityOverride.Inherited(), desktop);
    }

    static Target withCapacities(Target base, int queue, int concurrency) {
        return new Target(base.id(), base.displayName(), base.readProfile(), base.writeProfile(), base.credentialRevision(), base.enabled(), base.os(), base.windows(),
            new CapacityOverride.Explicit(new Capacity(queue)), new CapacityOverride.Explicit(new Capacity(concurrency)), base.desktop());
    }

    static Target withEnabled(Target base, Toggle enabled) {
        return new Target(base.id(), base.displayName(), base.readProfile(), base.writeProfile(), base.credentialRevision(), enabled, base.os(), base.windows(),
            base.queueCapacity(), base.maxConcurrency(), base.desktop());
    }

    static ConnectionProfile reader() {
        return profile(AccessMode.READ_ONLY, TtyMode.NO_TTY);
    }

    static ConnectionProfile writer() {
        return profile(AccessMode.READ_WRITE, TtyMode.NO_TTY);
    }

    static ConnectionProfile profile(AccessMode access, TtyMode tty) {
        return new ConnectionProfile("host.example.test", 22, "deploy", Setting.given("ssh-ed25519 AAAAC3Nza"), Setting.unset(), AuthMethod.KEY, Setting.given("key-ref-1"),
            Setting.unset(), access, tty);
    }
}
