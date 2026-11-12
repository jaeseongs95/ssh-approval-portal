package io.github.jaeseongs95.portal.domain.operation;

import java.util.Objects;

/**
 * Who is allowed to start an operation: the owner, who may start any kind, or the server's policy for one kind of operation. 2.x told these apart with five
 * module-private symbols; a value is the same idea without a hidden global (2.x approval-queue.mjs:8-11). The authority decides the {@link ApprovalMode}.
 */
public sealed interface StartAuthority permits StartAuthority.Owner, StartAuthority.Policy {

    /** The mode the operation gets when it is started with this authority. */
    ApprovalMode mode();

    /** True when this authority may start an operation of the kind. Whether a read authority is used for a read-only command is the use case's judgement. */
    boolean covers(OperationKind kind);

    /** The owner approved the operation. */
    record Owner() implements StartAuthority {

        @Override
        public ApprovalMode mode() {
            return ApprovalMode.OWNER;
        }

        @Override
        public boolean covers(OperationKind kind) {
            return true;
        }
    }

    /** The server's policy decided: for a command, for a read-only command, for an upload or for a download. */
    record Policy(PolicyScope scope) implements StartAuthority {

        public Policy {
            Objects.requireNonNull(scope, "scope");
        }

        @Override
        public ApprovalMode mode() {
            return ApprovalMode.AUTOMATIC;
        }

        @Override
        public boolean covers(OperationKind kind) {
            return switch (scope) {
                case COMMAND -> kind == OperationKind.COMMAND || kind == OperationKind.SOURCE || kind == OperationKind.AGENT_CLI;
                case READ -> kind == OperationKind.COMMAND;
                case UPLOAD -> kind == OperationKind.UPLOAD;
                case DOWNLOAD -> kind == OperationKind.DOWNLOAD;
            };
        }
    }

    /** The kind of operation a server policy may start (2.x COMMAND, READ, UPLOAD and DOWNLOAD authority). */
    enum PolicyScope {
        COMMAND, READ, UPLOAD, DOWNLOAD
    }
}
