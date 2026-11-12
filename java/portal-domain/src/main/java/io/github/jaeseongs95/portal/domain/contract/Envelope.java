package io.github.jaeseongs95.portal.domain.contract;

import com.fasterxml.jackson.annotation.JsonInclude;
import java.util.Objects;

/**
 * The response envelope of every public tool (public-contract.mjs:73-75, 145-148, 162-168). All four fields are always on the wire: {@code ok=true} carries a
 * {@code data} object and {@code error: null}, {@code ok=false} carries {@code data: null} and an {@code error} object. The null fields are written, not left out
 * ({@link JsonInclude.Include#ALWAYS}), because the baseline lists all four as required (stage 1 spike, null inclusion).
 *
 * <p>The two variants check the rule in their constructors, so a value that breaks it cannot exist; the type parameter of a failure only says which answer the
 * caller expected.
 */
public sealed interface Envelope<T> permits Envelope.Success, Envelope.Failure {

    ContractVersion contractVersion();

    boolean ok();

    /** The envelope of an answer: {@code ok=true}, the data, no error. */
    static <T> Envelope<T> success(T data) {
        return new Success<>(ContractVersion.V2_0, true, data, null);
    }

    /** The envelope of a refusal: {@code ok=false}, no data, the error. */
    static <T> Envelope<T> failure(ErrorData error) {
        return new Failure<>(ContractVersion.V2_0, false, null, error);
    }

    @JsonInclude(JsonInclude.Include.ALWAYS)
    record Success<T>(ContractVersion contractVersion, boolean ok, T data, ErrorData error) implements Envelope<T> {
        public Success {
            Objects.requireNonNull(contractVersion, "contractVersion");
            Objects.requireNonNull(data, "data");
            if (!ok || error != null) {
                throw new IllegalArgumentException("A successful envelope has ok=true and no error");
            }
        }
    }

    @JsonInclude(JsonInclude.Include.ALWAYS)
    record Failure<T>(ContractVersion contractVersion, boolean ok, Void data, ErrorData error) implements Envelope<T> {
        public Failure {
            Objects.requireNonNull(contractVersion, "contractVersion");
            Objects.requireNonNull(error, "error");
            if (ok) {
                throw new IllegalArgumentException("A failed envelope has ok=false");
            }
        }
    }
}
