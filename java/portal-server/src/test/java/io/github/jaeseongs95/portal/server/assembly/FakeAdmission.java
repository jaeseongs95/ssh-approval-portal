package io.github.jaeseongs95.portal.server.assembly;

import java.util.ArrayList;
import java.util.List;

import io.github.jaeseongs95.portal.app.file.UploadAdmission;
import io.github.jaeseongs95.portal.domain.error.OperationErrorCode;
import io.github.jaeseongs95.portal.domain.error.RequestRefusedException;
import io.github.jaeseongs95.portal.domain.id.OperationId;
import io.github.jaeseongs95.portal.domain.operation.NewOperation;

/** The intake of uploads in the assembly tests: it remembers what it was given and answers a fresh id, or refuses when the test says the queue is full. */
final class FakeAdmission implements UploadAdmission {

    final List<NewOperation> admitted = new ArrayList<>();
    boolean full;
    private int counter;

    void reset() {
        admitted.clear();
        full = false;
    }

    @Override
    public OperationId admit(NewOperation operation) {
        if (full) {
            throw new RequestRefusedException(OperationErrorCode.OPERATION_QUEUE_FULL);
        }
        admitted.add(operation);
        counter++;
        return new OperationId(String.format("%048x", counter));
    }
}
