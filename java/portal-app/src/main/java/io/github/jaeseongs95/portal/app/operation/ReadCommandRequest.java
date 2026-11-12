package io.github.jaeseongs95.portal.app.operation;

import java.time.Duration;
import java.util.Objects;

import io.github.jaeseongs95.portal.domain.id.OwnerId;
import io.github.jaeseongs95.portal.domain.id.RequestKey;
import io.github.jaeseongs95.portal.domain.id.TargetId;
import io.github.jaeseongs95.portal.domain.text.CommandText;
import io.github.jaeseongs95.portal.domain.text.Utf8Text;

/**
 * A read-only command a caller wants run at once.
 *
 * @param key the key that makes the request repeatable
 * @param owner who owns the operation
 * @param target the target
 * @param command the command as written
 * @param callerContext the caller's description
 * @param displayContext the text shown to the owner
 * @param waitLimit how long the caller waits for the result before it gets the running operation back
 */
public record ReadCommandRequest(RequestKey key, OwnerId owner, TargetId target, CommandText command, Utf8Text callerContext, Utf8Text displayContext, Duration waitLimit) {

    public ReadCommandRequest {
        Objects.requireNonNull(key, "key");
        Objects.requireNonNull(owner, "owner");
        Objects.requireNonNull(target, "target");
        Objects.requireNonNull(command, "command");
        Objects.requireNonNull(callerContext, "callerContext");
        Objects.requireNonNull(displayContext, "displayContext");
        Objects.requireNonNull(waitLimit, "waitLimit");
        if (waitLimit.isNegative()) {
            throw new IllegalArgumentException("The wait limit is not negative");
        }
    }
}
