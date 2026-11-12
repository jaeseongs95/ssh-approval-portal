package io.github.jaeseongs95.portal.app.operation;

import io.github.jaeseongs95.portal.domain.operation.Operation;

/**
 * Something that has to happen once when an operation reaches a terminal state: the file service unpins the artifact of an upload, the output store starts the clock of
 * the retention. The listeners are beans; adding one does not change a use case (open for extension). A listener is idempotent, because a restart tells it again about an
 * operation it already saw. A failure of a listener is logged and never changes the operation.
 */
public interface TerminalOperationListener {

    void onTerminal(Operation operation);
}
