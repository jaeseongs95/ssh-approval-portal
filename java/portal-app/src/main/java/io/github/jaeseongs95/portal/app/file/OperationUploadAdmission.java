package io.github.jaeseongs95.portal.app.file;

import java.util.Objects;
import java.util.concurrent.CompletionException;

import org.springframework.stereotype.Service;

import io.github.jaeseongs95.portal.app.admission.AdmissionTicket;
import io.github.jaeseongs95.portal.app.admission.RequestAdmission;
import io.github.jaeseongs95.portal.app.operation.OperationIntake;
import io.github.jaeseongs95.portal.app.remote.CancelSource;
import io.github.jaeseongs95.portal.domain.id.OperationId;
import io.github.jaeseongs95.portal.domain.operation.NewOperation;
import io.github.jaeseongs95.portal.domain.operation.OperationKind;

/**
 * {@link UploadAdmission} over the request entrance and the operation intake that every other request goes through (stage 3 design 8.2 groups G4 and G6): a place at the
 * {@link RequestAdmission} first (a full line, a closed entrance and a wait that ran out are the entrance's own refusals), then {@link OperationIntake#submit}, which judges
 * maintenance and the request store, writes the journal once per request key and contract, audits and announces the operation. The upload waits for the owner like any
 * operation; the place at the entrance is given back as soon as the operation is accepted, so the owner's decision never holds it.
 *
 * <p>The method blocks the calling thread while it waits for a place, for at most the entrance's maximum wait.
 */
@Service
public class OperationUploadAdmission implements UploadAdmission {

    private final RequestAdmission entrance;
    private final OperationIntake intake;

    public OperationUploadAdmission(RequestAdmission entrance, OperationIntake intake) {
        this.entrance = entrance;
        this.intake = intake;
    }

    /**
     * Accepts the upload operation, or answers the operation that the same key and contract was accepted as before.
     *
     * @throws IllegalArgumentException when the operation is not an upload
     * @throws io.github.jaeseongs95.portal.domain.error.RequestRefusedException the entrance or the intake refused, with the code of the limit or the conflict
     */
    @Override
    public OperationId admit(NewOperation operation) {
        Objects.requireNonNull(operation, "operation");
        if (operation.kind() != OperationKind.UPLOAD) {
            throw new IllegalArgumentException("Only an upload is admitted here: " + operation.kind());
        }
        AdmissionTicket ticket = place();
        try {
            return intake.submit(operation).id();
        } finally {
            ticket.release();
        }
    }

    private AdmissionTicket place() {
        try {
            return entrance.acquire(new CancelSource()).toCompletableFuture().join();
        } catch (CompletionException e) {
            if (e.getCause() instanceof RuntimeException refusal) {
                throw refusal;
            }
            throw e;
        }
    }
}
