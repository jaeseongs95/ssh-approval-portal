package io.github.jaeseongs95.portal.app.capacity;

import java.util.List;

import io.github.jaeseongs95.portal.domain.target.Target;

/**
 * The targets the administrator has configured, as the capacity use case needs them: the limits that each one sets for itself (the defaults of the first stored capacity) and
 * the ids a new override may name. The list may be empty (an installation without targets yet); {@code Targets} of the domain may not, so it is not used here. The
 * implementation reads the configuration of stage 4; stage 3 assemblies use a plain class.
 */
public interface ConfiguredTargets {

    List<Target> entries();
}
