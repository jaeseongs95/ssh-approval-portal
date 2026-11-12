package io.github.jaeseongs95.portal.app.target;

import java.util.EnumMap;
import java.util.List;
import java.util.Map;

import org.springframework.stereotype.Component;

import io.github.jaeseongs95.portal.domain.target.TargetOs;

/**
 * Collects the {@link TargetPlatform} beans by the operating system they answer for (the strategy pattern with the beans injected as a {@code List}, design
 * patterns 8.12). A missing or doubled implementation is a start-up failure, not a failure on the first request that needs it.
 */
@Component
public class TargetPlatformRegistry {

    private final Map<TargetOs, TargetPlatform> byOs = new EnumMap<>(TargetOs.class);

    public TargetPlatformRegistry(List<TargetPlatform> platforms) {
        for (TargetPlatform platform : platforms) {
            TargetPlatform earlier = byOs.put(platform.os(), platform);
            if (earlier != null) {
                throw new IllegalStateException("Two TargetPlatform beans answer for " + platform.os() + ": " + earlier.getClass().getName() + " and "
                    + platform.getClass().getName());
            }
        }
        for (TargetOs os : TargetOs.values()) {
            if (!byOs.containsKey(os)) {
                throw new IllegalStateException("No TargetPlatform bean answers for " + os);
            }
        }
    }

    /** The platform of the given operating system; every value of {@link TargetOs} has one (checked at construction). */
    public TargetPlatform platformOf(TargetOs os) {
        return byOs.get(os);
    }
}
