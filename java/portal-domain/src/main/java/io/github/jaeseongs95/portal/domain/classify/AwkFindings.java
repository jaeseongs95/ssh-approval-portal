package io.github.jaeseongs95.portal.domain.classify;

import java.util.List;

/**
 * What reading an awk program found (vendor {@code readAwkInvocation} result, policy/awk.js): the commands it runs itself ({@code system("...")},
 * {@code "cmd" | getline}), the commands it pipes into ({@code print | "cmd"}), whether it writes a file and whether it could not be read.
 */
record AwkFindings(List<String> commands, List<String> pipedInto, boolean writesFile, boolean unreadable) {

    AwkFindings {
        commands = List.copyOf(commands);
        pipedInto = List.copyOf(pipedInto);
    }

    /** A program the reader gave up on: it is treated as dangerous. */
    static AwkFindings notReadable() {
        return new AwkFindings(List.of(), List.of(), false, true);
    }
}
