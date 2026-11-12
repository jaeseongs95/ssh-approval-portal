package io.github.jaeseongs95.portal.app.admission;

/** The place a request holds at the entrance. Both methods are idempotent and neither waits. */
public interface AdmissionTicket {

    /** Gives the place back, and a detached request gives back its detached count. A second call changes nothing. */
    void release();

    /**
     * Frees the active place while the request keeps running outside the entrance. Another detach of the same ticket changes nothing.
     *
     * @throws io.github.jaeseongs95.portal.domain.error.RequestRefusedException {@code REQUEST_WAIT_LIMIT} when as many requests are detached as allowed,
     *     {@code REQUEST_QUEUE_CLOSED} when the entrance is closed
     */
    void detach();
}
