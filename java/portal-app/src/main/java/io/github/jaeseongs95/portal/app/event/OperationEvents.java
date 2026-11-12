package io.github.jaeseongs95.portal.app.event;

import org.springframework.context.ApplicationEventPublisher;
import org.springframework.stereotype.Component;

import io.github.jaeseongs95.portal.domain.operation.Operation;

/**
 * Publishes {@link OperationChanged}. A use case calls it after it stored a new version of an operation. Inside a transaction the listeners run after the commit
 * ({@code @TransactionalEventListener(AFTER_COMMIT)}); outside one they run at once ({@code fallbackExecution}), because the journal commits each of its own methods.
 */
@Component
public class OperationEvents {

    private final ApplicationEventPublisher publisher;

    public OperationEvents(ApplicationEventPublisher publisher) {
        this.publisher = publisher;
    }

    /** Tells every listener that the operation is now at this version. */
    public void changed(Operation operation) {
        publisher.publishEvent(OperationChanged.of(operation));
    }
}
