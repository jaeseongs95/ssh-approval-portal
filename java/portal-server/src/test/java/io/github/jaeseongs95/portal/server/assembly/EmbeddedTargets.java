package io.github.jaeseongs95.portal.server.assembly;

import java.util.List;

import io.github.jaeseongs95.portal.app.capacity.ConfiguredTargets;
import io.github.jaeseongs95.portal.app.target.TargetSource;
import io.github.jaeseongs95.portal.domain.id.Digester;
import io.github.jaeseongs95.portal.domain.id.TargetId;
import io.github.jaeseongs95.portal.domain.target.CapacityOverride;
import io.github.jaeseongs95.portal.domain.target.DesktopSettings;
import io.github.jaeseongs95.portal.domain.target.ProfileAlias;
import io.github.jaeseongs95.portal.domain.target.ResolvedTarget;
import io.github.jaeseongs95.portal.domain.target.Target;
import io.github.jaeseongs95.portal.domain.target.TargetDisplayName;
import io.github.jaeseongs95.portal.domain.target.TargetLookup;
import io.github.jaeseongs95.portal.domain.target.TargetOs;
import io.github.jaeseongs95.portal.domain.target.Toggle;
import io.github.jaeseongs95.portal.domain.target.WindowsRuntime;
import io.github.jaeseongs95.portal.ssh.profile.ProfileCatalog;

/**
 * The one target of the full assembly test: a Linux target whose two profiles are the ones of the profile file of the test (so what the guard compares at dispatch time is what
 * the SSH adapter reads), standing where the configuration reader of stage 4 will stand.
 */
final class EmbeddedTargets implements TargetSource, ConfiguredTargets {

    static final TargetId ID = new TargetId("emb-1");
    static final ProfileAlias READ_PROFILE = new ProfileAlias("emb-ro");
    static final ProfileAlias WRITE_PROFILE = new ProfileAlias("emb-rw");

    private final ResolvedTarget resolved;

    EmbeddedTargets(ProfileCatalog catalog, Digester digester) {
        Target target = new Target(ID, new TargetDisplayName("Embedded server"), READ_PROFILE, WRITE_PROFILE, new ProfileAlias("cred1"), Toggle.ON, TargetOs.LINUX,
            WindowsRuntime.none(), new CapacityOverride.Inherited(), new CapacityOverride.Inherited(), new DesktopSettings.NoDesktop());
        this.resolved = ResolvedTarget.of(target, catalog.find(READ_PROFILE).orElseThrow().connection(), catalog.find(WRITE_PROFILE).orElseThrow().connection(), digester);
    }

    @Override
    public TargetLookup lookup(TargetId id) {
        return ID.equals(id) ? new TargetLookup.Found(resolved) : new TargetLookup.NotRegistered(id);
    }

    @Override
    public List<Target> entries() {
        return List.of(resolved.target());
    }

    ResolvedTarget target() {
        return resolved;
    }
}
