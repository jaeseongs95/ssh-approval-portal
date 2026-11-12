package io.github.jaeseongs95.portal.domain.operation;

import io.github.jaeseongs95.portal.domain.id.CanonicalForm;
import io.github.jaeseongs95.portal.domain.text.CommandText;
import io.github.jaeseongs95.portal.domain.text.Utf8Text;
import java.util.Objects;

/**
 * A shell command to run, exactly as submitted, with the caller's description of why (the context a model or the owner reads) and the text shown to the owner.
 * Both descriptions may be empty; their limits and the secrets they must not contain are checked where they enter (the caller context type).
 */
public record CommandInput(CommandText command, Utf8Text callerContext, Utf8Text displayContext) implements OperationInput {

    public CommandInput {
        Objects.requireNonNull(command, "command");
        Objects.requireNonNull(callerContext, "callerContext");
        Objects.requireNonNull(displayContext, "displayContext");
    }

    @Override
    public OperationKind kind() {
        return OperationKind.COMMAND;
    }

    @Override
    public CanonicalForm describeTo(CanonicalForm form) {
        return form.field("input.kind", "command").field("command.text", command.value()).field("command.callerContext", callerContext.value())
            .field("command.displayContext", displayContext.value());
    }
}
