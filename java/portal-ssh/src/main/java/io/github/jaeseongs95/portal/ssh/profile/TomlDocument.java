package io.github.jaeseongs95.portal.ssh.profile;

import java.util.List;

import jakarta.validation.Valid;
import jakarta.validation.constraints.NotEmpty;

/**
 * The profile file as it is written (2.x vendor config/schema.js:211-217): an optional {@code [defaults]} table, one or more {@code [[profiles]]} tables and an optional
 * {@code [policy]} table, and no other key (PF-08, PF-09).
 */
record TomlDocument(
    @Valid TomlDefaults defaults,
    @NotEmpty(message = "must define at least one profile") @Valid List<TomlProfile> profiles,
    TomlPolicy policy) {
}
