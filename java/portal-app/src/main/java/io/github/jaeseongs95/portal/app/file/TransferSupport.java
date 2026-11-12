package io.github.jaeseongs95.portal.app.file;

import java.util.Objects;

import org.springframework.stereotype.Component;

import io.github.jaeseongs95.portal.app.remote.ElevationPlan;
import io.github.jaeseongs95.portal.app.remote.FileAccess;
import io.github.jaeseongs95.portal.app.target.TargetPlatform;
import io.github.jaeseongs95.portal.app.target.TargetPlatformRegistry;
import io.github.jaeseongs95.portal.domain.error.RequestErrorCode;
import io.github.jaeseongs95.portal.domain.error.RequestRefusedException;
import io.github.jaeseongs95.portal.domain.operation.Elevation;
import io.github.jaeseongs95.portal.domain.target.ResolvedTarget;

/**
 * What both transfer services ask of the target's platform: the platform itself and the rights a file operation runs with. The choice of the platform is a lookup in
 * the registry, never a branch on the operating system here (design patterns 8.12).
 */
@Component
public class TransferSupport {

    private final TargetPlatformRegistry platforms;

    public TransferSupport(TargetPlatformRegistry platforms) {
        this.platforms = platforms;
    }

    public TargetPlatform platformOf(ResolvedTarget target) {
        Objects.requireNonNull(target, "target");
        return platforms.platformOf(target.target().os());
    }

    /**
     * The rights of the file operation. An elevated one needs a plan the target supports; a target that has none is refused here with
     * {@code TARGET_CAPABILITY_UNSUPPORTED}, because an elevated {@link FileAccess} cannot be built from {@link ElevationPlan.NotSupported} and the adapter is not the place
     * to find that out (the {@code FileAccess} Javadoc).
     */
    public FileAccess accessOf(TargetPlatform platform, Elevation elevation) {
        return switch (elevation) {
            case NONE -> new FileAccess.Direct();
            case SUDO -> {
                ElevationPlan plan = platform.elevationPlan();
                if (plan instanceof ElevationPlan.NotSupported) {
                    throw new RequestRefusedException(RequestErrorCode.TARGET_CAPABILITY_UNSUPPORTED);
                }
                yield new FileAccess.Elevated(plan);
            }
        };
    }
}
