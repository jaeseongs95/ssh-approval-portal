package io.github.jaeseongs95.portal.domain.target;

import io.github.jaeseongs95.portal.domain.id.CanonicalForm;
import java.util.Objects;

/**
 * How a target's remote desktop is reached: not configured, an already running RFB server (VNC) on a port, a virtual display the server starts (Xvnc, Linux
 * targets only), or RDP with a credential reference (Windows targets only). Each configured variant can be switched off without losing the rest of its settings.
 * {@link Target} checks that the variant fits the target's operating system (2.x targets.mjs:37-54).
 */
public sealed interface DesktopSettings permits DesktopSettings.NoDesktop, DesktopSettings.AttachedRfb, DesktopSettings.ManagedXvnc, DesktopSettings.Rdp {

    /** True when the variant can be used on a target of the operating system. */
    boolean fits(TargetOs os);

    CanonicalForm describeTo(CanonicalForm form);

    /** No desktop is configured. */
    record NoDesktop() implements DesktopSettings {

        @Override
        public boolean fits(TargetOs os) {
            return true;
        }

        @Override
        public CanonicalForm describeTo(CanonicalForm form) {
            return form.absent("desktop");
        }
    }

    /** An RFB server that already runs on the target, on a TCP port from 1 to 65535. */
    record AttachedRfb(Toggle enabled, int port, DesktopGeometry geometry) implements DesktopSettings {

        public AttachedRfb {
            Objects.requireNonNull(enabled, "enabled");
            Objects.requireNonNull(geometry, "geometry");
            if (port < 1 || port > 65535) {
                throw new IllegalArgumentException("Invalid attached desktop configuration");
            }
        }

        @Override
        public boolean fits(TargetOs os) {
            return true;
        }

        @Override
        public CanonicalForm describeTo(CanonicalForm form) {
            return form.field("desktop.backend", "rfb").field("desktop.enabled", enabled.name()).field("desktop.port", port).field("desktop.width", geometry.width())
                .field("desktop.height", geometry.height());
        }
    }

    /** A virtual display (Xvnc) the server starts on the target. The endpoint is the backend's choice, so there is no port. */
    record ManagedXvnc(Toggle enabled, DesktopGeometry geometry) implements DesktopSettings {

        public ManagedXvnc {
            Objects.requireNonNull(enabled, "enabled");
            Objects.requireNonNull(geometry, "geometry");
        }

        @Override
        public boolean fits(TargetOs os) {
            return os == TargetOs.LINUX;
        }

        @Override
        public CanonicalForm describeTo(CanonicalForm form) {
            return form.field("desktop.backend", "xvnc").field("desktop.enabled", enabled.name()).field("desktop.width", geometry.width())
                .field("desktop.height", geometry.height());
        }
    }

    /** RDP to a Windows target with the credential kept in a secret store. */
    record Rdp(Toggle enabled, SecretReference credentialRef, DesktopGeometry geometry) implements DesktopSettings {

        public Rdp {
            Objects.requireNonNull(enabled, "enabled");
            Objects.requireNonNull(credentialRef, "credentialRef");
            Objects.requireNonNull(geometry, "geometry");
        }

        @Override
        public boolean fits(TargetOs os) {
            return os == TargetOs.WINDOWS;
        }

        @Override
        public CanonicalForm describeTo(CanonicalForm form) {
            return form.field("desktop.backend", "rdp").field("desktop.enabled", enabled.name()).field("desktop.credentialRef", credentialRef.text())
                .field("desktop.width", geometry.width()).field("desktop.height", geometry.height());
        }
    }
}
