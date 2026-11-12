package io.github.jaeseongs95.portal.domain.contract;

import com.fasterxml.jackson.annotation.JsonInclude;
import java.util.Objects;

/**
 * One page of the captured output an {@code observe} call with {@code includeOutput} returns (public-contract.mjs:19-20, {@code outputPage}). The text is untrusted
 * output of the target; {@code nextCursor} is where the next page starts and {@code eof} says no page follows.
 */
@JsonInclude(JsonInclude.Include.ALWAYS)
public record OutputPage(String text, long cursor, long nextCursor, long bytes, long totalBytes, String sha256, boolean eof, long expiresAt) {

    public OutputPage {
        Objects.requireNonNull(text, "text");
        WireNumber.NON_NEGATIVE.require(cursor, "cursor");
        WireNumber.NON_NEGATIVE.require(nextCursor, "nextCursor");
        WireNumber.NON_NEGATIVE.require(bytes, "bytes");
        WireNumber.NON_NEGATIVE.require(totalBytes, "totalBytes");
        WireFormat.DIGEST.require(sha256, "sha256");
        WireNumber.NON_NEGATIVE.require(expiresAt, "expiresAt");
    }
}
