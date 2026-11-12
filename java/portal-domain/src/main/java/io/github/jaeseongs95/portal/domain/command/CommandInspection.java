package io.github.jaeseongs95.portal.domain.command;

import java.util.Objects;

/**
 * The local, conservative reading of a command before any model sees it (command-policy.mjs:74-84): the program it starts, whether it mentions secrets, and
 * whether it is risky. It is a screen, not a proof: a command that is not risky here may still be sent to the owner.
 *
 * @param executable the first word when it is a program name; {@link ExecutableName.NoExecutable} when the line does not start with one
 * @param sensitive the text holds credential material or names a place where secrets live
 * @param risky {@code sensitive}, or a shell meta character, or no program name, or a class above {@code read-only}
 */
public record CommandInspection(ExecutableName executable, boolean sensitive, boolean risky) {

    public CommandInspection {
        Objects.requireNonNull(executable, "executable");
    }

    /** The program a command line starts with, or the fact that it does not start with one. */
    public sealed interface ExecutableName permits ExecutableName.Named, ExecutableName.NoExecutable {

        record Named(String name) implements ExecutableName {
            public Named {
                Objects.requireNonNull(name, "name");
            }
        }

        record NoExecutable() implements ExecutableName {
        }
    }
}
