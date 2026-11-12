package io.github.jaeseongs95.portal.domain.target;

import io.github.jaeseongs95.portal.domain.id.Digester;
import java.util.Objects;

/**
 * A target together with the two connection profiles it uses and the revision those make. It exists only when the profiles fit the target (2.x targets.mjs:62-82):
 * the read profile is read only and the write profile can write, both reach the same machine in the same way (address, user, host key, jump host, authentication,
 * key reference), the write profile pins the host key, and a Windows target's profiles have no POSIX working directory and no terminal.
 *
 * @param target the administrator's entry
 * @param reader the profile read-only commands use
 * @param writer the profile every other operation uses
 * @param revision the revision of all three
 */
public record ResolvedTarget(Target target, ConnectionProfile reader, ConnectionProfile writer, TargetRevision revision) {

    public ResolvedTarget {
        Objects.requireNonNull(target, "target");
        Objects.requireNonNull(reader, "reader");
        Objects.requireNonNull(writer, "writer");
        Objects.requireNonNull(revision, "revision");
        if (reader.access() != AccessMode.READ_ONLY || writer.access() != AccessMode.READ_WRITE || !reader.sharesConnectionWith(writer)) {
            throw new IllegalArgumentException("Expected matching writable and read-only SSH targets");
        }
        if (!writer.pinnedHostKey().isGiven()) {
            throw new IllegalArgumentException("Targets require pinned host keys");
        }
        if (target.os() == TargetOs.WINDOWS) {
            if (reader.workdir().isGiven() || writer.workdir().isGiven()) {
                throw new IllegalArgumentException("Windows targets cannot use a POSIX profile workdir");
            }
            if (reader.tty() == TtyMode.TTY || writer.tty() == TtyMode.TTY) {
                throw new IllegalArgumentException("Windows targets require non-TTY profiles");
            }
        }
    }

    /** The resolved target with the revision the digester computes from the three parts. */
    public static ResolvedTarget of(Target target, ConnectionProfile reader, ConnectionProfile writer, Digester digester) {
        return new ResolvedTarget(target, reader, writer, TargetRevision.of(target, reader, writer, digester));
    }
}
