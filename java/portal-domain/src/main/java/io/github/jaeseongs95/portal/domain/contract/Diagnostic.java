package io.github.jaeseongs95.portal.domain.contract;

import com.fasterxml.jackson.annotation.JsonInclude;
import java.util.Objects;

/**
 * The real reason a request did not run, from an allow-listed set of fields (public-contract.mjs:22, {@code diagnostic}; stage 2 design 4.7). A null component is
 * the wire null (null = wire null): the field exists on the wire and its value is null.
 */
@JsonInclude(JsonInclude.Include.ALWAYS)
public record Diagnostic(DiagnosticOriginWire origin, String policyReason, String nativeStep, Long nativeError) {

    public Diagnostic {
        Objects.requireNonNull(origin, "origin");
        WireNumber.NON_NEGATIVE.requireOrNull(nativeError, "nativeError");
    }
}
