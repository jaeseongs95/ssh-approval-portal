package io.github.jaeseongs95.portal.ssh.profile;

import java.util.Objects;

/** What a {@link FileAccessRule} found out about a path: it is as private as asked, it is readable by others where that is only a warning, or it is refused. */
public sealed interface AccessVerdict permits AccessVerdict.Private, AccessVerdict.Exposed, AccessVerdict.Refused {

    /** The path is as private as the {@link Protection} asked. */
    record Private() implements AccessVerdict {
    }

    /** Others may read the path and nothing worse: the load continues and the reason is a warning (2.x PF-05, an ACL that gives others read access only). */
    record Exposed(String reason) implements AccessVerdict {

        public Exposed {
            Objects.requireNonNull(reason, "reason");
        }
    }

    /** The path is not private enough: the load stops with the reason, which names the path and how to fix it. */
    record Refused(String reason) implements AccessVerdict {

        public Refused {
            Objects.requireNonNull(reason, "reason");
        }
    }
}
