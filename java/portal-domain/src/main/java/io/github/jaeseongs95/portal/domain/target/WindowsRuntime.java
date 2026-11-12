package io.github.jaeseongs95.portal.domain.target;

import io.github.jaeseongs95.portal.domain.id.CanonicalForm;
import java.util.Objects;

/**
 * The settings only a Windows target has: where commands start and which Python runs source requests. Neither is required. A Linux target has neither, which
 * {@link Target} enforces (2.x targets.mjs:28-30).
 *
 * @param workdir the working directory on the target
 * @param python the Python executable on the target; without it the target does not support source requests
 */
public record WindowsRuntime(Setting<WindowsDirectory> workdir, Setting<WindowsPythonExecutable> python) {

    public WindowsRuntime {
        Objects.requireNonNull(workdir, "workdir");
        Objects.requireNonNull(python, "python");
    }

    /** No Windows settings at all. */
    public static WindowsRuntime none() {
        return new WindowsRuntime(Setting.unset(), Setting.unset());
    }

    /** True when neither setting is given. */
    public boolean isEmpty() {
        return !workdir.isGiven() && !python.isGiven();
    }

    CanonicalForm describeTo(CanonicalForm form) {
        workdir.describeTo(form, "windows.workdir", WindowsDirectory::value);
        return python.describeTo(form, "windows.python", WindowsPythonExecutable::value);
    }
}
