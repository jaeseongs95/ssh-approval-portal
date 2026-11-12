package io.github.jaeseongs95.portal.app.capacity;

import java.security.SecureRandom;
import java.util.HashSet;
import java.util.HexFormat;
import java.util.List;
import java.util.Objects;
import java.util.Set;

import org.springframework.stereotype.Service;

import io.github.jaeseongs95.portal.app.config.AvailableCpus;
import io.github.jaeseongs95.portal.app.maintenance.MaintenanceStore;
import io.github.jaeseongs95.portal.domain.capacity.CapacityDefaults;
import io.github.jaeseongs95.portal.domain.error.CapacityErrorCode;
import io.github.jaeseongs95.portal.domain.error.RequestErrorCode;
import io.github.jaeseongs95.portal.domain.error.RequestRefusedException;
import io.github.jaeseongs95.portal.domain.id.TargetId;
import io.github.jaeseongs95.portal.domain.target.Target;

/**
 * The administrator's override of the queue and concurrency limits (2.x {@code runtime-capacity.mjs}, cases RC-B-410 and its neighbours). The installation's own values are
 * the defaults of a first start (one simultaneous operation and ten queued requests per CPU, and the limits that each target configures for itself); the override is stored
 * and survives a restart. The dispatcher reads the stored limits when it claims an operation, so a change never touches an operation that exists: lowering the limits below the
 * number of running or queued operations leaves them as they are, and the new limits apply to the next claim.
 *
 * <p>A change is one compare-and-set on the revision the administrator saw. It is refused while a maintenance reservation holds the installation ({@code MAINTENANCE_ACTIVE}),
 * for a stale revision ({@code CAPACITY_REVISION_CONFLICT}), for a target that appears twice or is neither stored nor configured, and the stored value is not changed by any of
 * these refusals. An override of a target that was removed from the configuration is kept (2.x did), so it is only new overrides that must name a configured target.
 */
@Service
public class CapacityService {

    /** 16 random bytes as 32 lower-case hex characters: the form of a capacity revision. */
    private static final int REVISION_BYTES = 16;

    private final RuntimeCapacityStore store;
    private final MaintenanceStore maintenance;
    private final ConfiguredTargets targets;
    private final AvailableCpus cpus;
    private final SecureRandom random;

    public CapacityService(RuntimeCapacityStore store, MaintenanceStore maintenance, ConfiguredTargets targets, AvailableCpus cpus, SecureRandom random) {
        this.store = store;
        this.maintenance = maintenance;
        this.targets = targets;
        this.cpus = cpus;
        this.random = random;
    }

    /** The stored limits; the first call of a new installation stores the defaults (two first writers: one wins, the other reads). */
    public CapacityState current() {
        return store.read().orElseGet(() -> store.initialize(defaults()));
    }

    /**
     * Replaces the limits with {@code proposed}, under the revision the administrator saw. The revision of {@code proposed} is ignored: the stored one is a new revision. A
     * refusal changes nothing.
     */
    public CapacityState update(String expectedRevision, CapacityState proposed) {
        Objects.requireNonNull(expectedRevision, "expectedRevision");
        Objects.requireNonNull(proposed, "proposed");
        if (maintenance.occupied()) {
            throw new RequestRefusedException(RequestErrorCode.MAINTENANCE_ACTIVE);
        }
        CapacityState stored = current();
        if (!stored.revision().equals(expectedRevision)) {
            throw new RequestRefusedException(CapacityErrorCode.CAPACITY_REVISION_CONFLICT);
        }
        requireKnownTargets(stored, proposed.targets());
        CapacityState next = new CapacityState(newRevision(), proposed.queueCapacity(), proposed.maxConcurrency(), proposed.targets());
        store.compareAndSet(expectedRevision, next);
        return next;
    }

    private void requireKnownTargets(CapacityState stored, List<CapacityState.TargetCapacity> proposed) {
        Set<TargetId> seen = new HashSet<>();
        Set<TargetId> known = new HashSet<>();
        stored.targets().forEach(target -> known.add(target.targetId()));
        targets.entries().forEach(target -> known.add(target.id()));
        for (CapacityState.TargetCapacity override : proposed) {
            if (!seen.add(override.targetId())) {
                throw new RequestRefusedException(CapacityErrorCode.INVALID_CAPACITY_TARGETS);
            }
            if (!known.contains(override.targetId())) {
                throw new RequestRefusedException(CapacityErrorCode.UNKNOWN_CAPACITY_TARGET);
            }
        }
    }

    private CapacityState defaults() {
        CapacityDefaults installation = new CapacityDefaults(cpus.count());
        List<CapacityState.TargetCapacity> own = targets.entries().stream().map(this::overrideOf).toList();
        return new CapacityState(newRevision(), installation.queueCapacity(), installation.maxConcurrency(), own);
    }

    private CapacityState.TargetCapacity overrideOf(Target target) {
        return new CapacityState.TargetCapacity(target.id(), target.queueCapacity(), target.maxConcurrency());
    }

    private String newRevision() {
        byte[] bytes = new byte[REVISION_BYTES];
        random.nextBytes(bytes);
        return HexFormat.of().formatHex(bytes);
    }
}
