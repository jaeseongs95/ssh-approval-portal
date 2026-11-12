package io.github.jaeseongs95.portal.ssh.profile;

import java.util.Arrays;
import java.util.Map;
import java.util.function.Function;
import java.util.stream.Collectors;

/** The approval setting of a profile as the file spells it: {@code auto}, {@code ask-destructive}, {@code ask-all} or {@code deny} (2.x vendor config/schema.js:3). */
public enum ProfileApproval {
    AUTO("auto"), ASK_DESTRUCTIVE("ask-destructive"), ASK_ALL("ask-all"), DENY("deny");

    private static final Map<String, ProfileApproval> BY_WIRE = Arrays.stream(values()).collect(Collectors.toUnmodifiableMap(ProfileApproval::wire, Function.identity()));

    private final String wire;

    ProfileApproval(String wire) {
        this.wire = wire;
    }

    /** The spelling in the file. */
    public String wire() {
        return wire;
    }

    /** The setting for a spelling the schema has already checked. */
    static ProfileApproval fromWire(String wire) {
        ProfileApproval found = BY_WIRE.get(wire);
        if (found == null) {
            throw new IllegalArgumentException("Unknown approval mode: " + wire);
        }
        return found;
    }
}
