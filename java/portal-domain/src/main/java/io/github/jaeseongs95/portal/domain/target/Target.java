package io.github.jaeseongs95.portal.domain.target;

import io.github.jaeseongs95.portal.domain.id.CanonicalForm;
import io.github.jaeseongs95.portal.domain.id.TargetId;
import java.util.Objects;
import java.util.regex.Pattern;

/**
 * A target the administrator configured: the machine requests are sent to. A request chooses a target by id and never names an address, so what a request can reach
 * is fixed by this configuration. The record holds one line of that configuration, checked as 2.x checked it (targets.mjs:13-60): the profile names and the
 * credential revision are short lowercase aliases, the read and write profiles are two different profiles, the Windows settings exist only on a Windows target, and the
 * desktop backend fits the operating system.
 *
 * @param id the target's id
 * @param displayName the name shown to people
 * @param readProfile the profile read-only commands use
 * @param writeProfile the profile every other operation uses; not the same as the read profile
 * @param credentialRevision the administrator's revision label of the credentials; a rotation changes it and so changes the target's revision
 * @param enabled whether the target takes requests
 * @param os the operating system family
 * @param windows the settings only a Windows target has
 * @param queueCapacity a queue capacity of this target's own, or the default
 * @param maxConcurrency a concurrency of this target's own, or the default
 * @param desktop how the remote desktop is reached
 */
public record Target(TargetId id, TargetDisplayName displayName, ProfileAlias readProfile, ProfileAlias writeProfile, ProfileAlias credentialRevision, Toggle enabled,
                     TargetOs os, WindowsRuntime windows, CapacityOverride queueCapacity, CapacityOverride maxConcurrency, DesktopSettings desktop) {

    private static final Pattern ALIAS = Pattern.compile("[a-z][a-z0-9_-]{0,31}");

    public Target {
        Objects.requireNonNull(id, "id");
        Objects.requireNonNull(displayName, "displayName");
        Objects.requireNonNull(readProfile, "readProfile");
        Objects.requireNonNull(writeProfile, "writeProfile");
        Objects.requireNonNull(credentialRevision, "credentialRevision");
        Objects.requireNonNull(enabled, "enabled");
        Objects.requireNonNull(os, "os");
        Objects.requireNonNull(windows, "windows");
        Objects.requireNonNull(queueCapacity, "queueCapacity");
        Objects.requireNonNull(maxConcurrency, "maxConcurrency");
        Objects.requireNonNull(desktop, "desktop");
        if (!ALIAS.matcher(readProfile.value()).matches() || !ALIAS.matcher(writeProfile.value()).matches() || !ALIAS.matcher(credentialRevision.value()).matches()
            || readProfile.equals(writeProfile)) {
            throw new IllegalArgumentException("Invalid or duplicate target configuration");
        }
        if (os != TargetOs.WINDOWS && !windows.isEmpty()) {
            throw new IllegalArgumentException("Windows runtime settings require a Windows target");
        }
        if (!desktop.fits(os)) {
            throw new IllegalArgumentException("Invalid desktop backend for target platform");
        }
    }

    public boolean isEnabled() {
        return enabled.isOn();
    }

    /** What the target supports: the shell by operating system, and source requests on a Windows target only when a Python is configured. */
    public TargetCapabilities capabilities() {
        boolean onWindows = os == TargetOs.WINDOWS;
        return new TargetCapabilities(onWindows ? CommandShell.WINDOWS_POWERSHELL_5_1 : CommandShell.POSIX, true, true, !onWindows || windows.python().isGiven(), true, true);
    }

    /** Writes every field into a canonical form, for the revision of the target. */
    CanonicalForm describeTo(CanonicalForm form) {
        form.field("target.id", id.value()).field("target.displayName", displayName.value()).field("target.readProfile", readProfile.value())
            .field("target.writeProfile", writeProfile.value()).field("target.credentialRevision", credentialRevision.value()).field("target.enabled", enabled.name())
            .field("target.os", os.name());
        windows.describeTo(form);
        queueCapacity.describeTo(form, "target.queueCapacity");
        maxConcurrency.describeTo(form, "target.maxConcurrency");
        return desktop.describeTo(form);
    }
}
