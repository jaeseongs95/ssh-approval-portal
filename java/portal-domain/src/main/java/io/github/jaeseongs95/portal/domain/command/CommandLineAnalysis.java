package io.github.jaeseongs95.portal.domain.command;

import java.util.List;
import java.util.Objects;

/**
 * What a grammar found in a command line: the program names (comparison keys, see {@link PolicyName#key()}), whether it is sure of all of them and whether the
 * line uses {@code sudo}. A complete analysis names at least one program (2.x command-line.mjs:162: {@code complete = names.size > 0}); a line the grammar cannot
 * fully read is {@link Completeness#INCOMPLETE} with whatever names it did find.
 */
public record CommandLineAnalysis(List<String> names, Completeness completeness, SudoUse sudo) {

    public CommandLineAnalysis {
        names = List.copyOf(names);
        Objects.requireNonNull(completeness, "completeness");
        Objects.requireNonNull(sudo, "sudo");
        if (completeness == Completeness.COMPLETE && names.isEmpty()) {
            throw new IllegalArgumentException("A complete analysis names at least one program");
        }
    }

    public boolean isComplete() {
        return completeness == Completeness.COMPLETE;
    }

    public boolean usesSudo() {
        return sudo == SudoUse.USES_SUDO;
    }
}
