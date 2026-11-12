package io.github.jaeseongs95.portal.ssh.profile;

import java.util.Objects;

import org.springframework.stereotype.Component;

import io.github.jaeseongs95.portal.app.remote.ProfileLookup;
import io.github.jaeseongs95.portal.app.remote.ProfileSource;
import io.github.jaeseongs95.portal.domain.target.ProfileAlias;

/**
 * The {@link ProfileSource} of the SSH adapter: it answers from the {@link ProfileCatalog} that {@link TomlProfileLoader} made. The catalog is a bean that the assembly of the
 * product builds from the configured path of the profile file (stage 4); this class holds no state besides it. Two lookups of one name give equal values, so the guard that
 * compares the profile of a request with the profile at dispatch time (2.x {@code target_changed}) compares values.
 */
@Component
public final class ProfileRegistry implements ProfileSource {

    private final ProfileCatalog catalog;

    public ProfileRegistry(ProfileCatalog catalog) {
        this.catalog = Objects.requireNonNull(catalog, "catalog");
    }

    @Override
    public ProfileLookup lookup(ProfileAlias alias) {
        return catalog.find(alias)
            .<ProfileLookup>map(entry -> new ProfileLookup.Found(entry.connection()))
            .orElseGet(() -> new ProfileLookup.NotConfigured(alias));
    }
}
