package io.github.jaeseongs95.portal.app.operation;

import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;

import org.springframework.stereotype.Component;

import io.github.jaeseongs95.portal.app.remote.CancelSource;
import io.github.jaeseongs95.portal.domain.id.OperationId;

/**
 * The cancel of every execution that runs in this process. The dispatcher registers one when it claims an operation and releases it when the operation is settled; the
 * cancel of a request finds it here and asks the adapter to stop. The state is this bean's alone and is not written anywhere: after a restart nothing runs, and
 * recovery settles what was in flight.
 */
@Component
public class RunningExecutions {

    private final Map<OperationId, CancelSource> running = new ConcurrentHashMap<>();

    /** The cancel for the execution of the operation; the same one while the execution is registered. */
    public CancelSource register(OperationId id) {
        return running.computeIfAbsent(id, key -> new CancelSource());
    }

    /** Asks the execution to stop; true when one was registered. */
    public boolean cancel(OperationId id) {
        CancelSource source = running.get(id);
        if (source == null) {
            return false;
        }
        source.cancel();
        return true;
    }

    public void release(OperationId id) {
        running.remove(id);
    }

    /** The number of executions that run now. */
    public int count() {
        return running.size();
    }
}
