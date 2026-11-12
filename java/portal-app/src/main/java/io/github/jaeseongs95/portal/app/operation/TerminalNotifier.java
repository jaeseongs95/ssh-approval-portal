package io.github.jaeseongs95.portal.app.operation;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.ObjectProvider;
import org.springframework.stereotype.Component;

import io.github.jaeseongs95.portal.domain.operation.Operation;

/** Tells every {@link TerminalOperationListener} that an operation ended, once, in the order of the listeners. A listener that fails does not stop the others. */
@Component
public class TerminalNotifier {

    private static final Logger LOG = LoggerFactory.getLogger(TerminalNotifier.class);

    private final ObjectProvider<TerminalOperationListener> listeners;

    public TerminalNotifier(ObjectProvider<TerminalOperationListener> listeners) {
        this.listeners = listeners;
    }

    public void ended(Operation operation) {
        listeners.orderedStream().forEach(listener -> {
            try {
                listener.onTerminal(operation);
            } catch (RuntimeException e) {
                LOG.error("A listener of terminal operations failed; the operation is unchanged", e);
            }
        });
    }
}
