package io.github.jaeseongs95.portal.ssh.profile;

import java.util.List;
import java.util.Objects;
import java.util.Optional;

import io.github.jaeseongs95.portal.domain.target.ProfileAlias;

/**
 * The profiles of a configuration file, in the order of the file, with its defaults. Two profiles may have the same name (2.x did not check, PF-11); the first one is the
 * profile of that name. The catalog is immutable.
 *
 * @param defaults the {@code [defaults]} table
 * @param entries the profiles, at least one
 */
public record ProfileCatalog(ProfileDefaults defaults, List<ProfileEntry> entries) {

    public ProfileCatalog {
        Objects.requireNonNull(defaults, "defaults");
        entries = List.copyOf(entries);
        if (entries.isEmpty()) {
            throw new IllegalArgumentException("A catalog has at least one profile");
        }
    }

    /** The first profile of the name, if there is one. */
    public Optional<ProfileEntry> find(ProfileAlias alias) {
        Objects.requireNonNull(alias, "alias");
        return entries.stream().filter(entry -> entry.alias().equals(alias)).findFirst();
    }

    /** Whether an OpenSSH certificate goes with the key of the profile; false for a name the catalog does not have. */
    public boolean wantsCertificate(ProfileAlias alias) {
        return find(alias).map(entry -> entry.options().cert()).orElse(false);
    }

    /**
     * The profile for a name. An empty or missing name is "not given" and falls back to {@code defaults.defaultProfile} (PF-25); without either, a single profile is the
     * answer (PF-27) and several profiles are {@link ProfileSelection.Ambiguous} (PF-26); a name that no profile has is {@link ProfileSelection.NotFound} (PF-28).
     */
    public ProfileSelection select(String name) {
        String wanted = name != null && !name.isEmpty() ? name : defaults.defaultProfile().orElse("");
        if (wanted.isEmpty()) {
            if (entries.size() == 1) {
                return new ProfileSelection.Selected(entries.get(0));
            }
            return new ProfileSelection.Ambiguous(entries.stream().map(entry -> entry.alias().value()).toList());
        }
        return entries.stream().filter(entry -> Objects.equals(wanted, entry.alias().value())).findFirst()
            .<ProfileSelection>map(ProfileSelection.Selected::new).orElseGet(() -> new ProfileSelection.NotFound(wanted));
    }
}
