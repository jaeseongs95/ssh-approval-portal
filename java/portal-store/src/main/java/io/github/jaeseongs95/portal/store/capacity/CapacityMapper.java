package io.github.jaeseongs95.portal.store.capacity;

import java.util.ArrayList;
import java.util.List;

import org.springframework.stereotype.Component;

import io.github.jaeseongs95.portal.app.capacity.CapacityState;
import io.github.jaeseongs95.portal.domain.capacity.Capacity;
import io.github.jaeseongs95.portal.domain.id.TargetId;
import io.github.jaeseongs95.portal.domain.target.CapacityOverride;

/** Converts between {@link CapacityState} and the rows of {@code runtime_capacity} and {@code runtime_capacity_target}. An inherited override is a null column. */
@Component
class CapacityMapper {

    /** The row of the global values; {@code version} is the write counter the caller gives (1 for the first write). */
    RuntimeCapacityRow row(CapacityState state, long version) {
        return new RuntimeCapacityRow(1, state.revision(), state.queueCapacity().value(), state.maxConcurrency().value(), version);
    }

    /** One row per target override of the state. */
    List<RuntimeCapacityTargetRow> targetRows(CapacityState state) {
        List<RuntimeCapacityTargetRow> rows = new ArrayList<>();
        for (CapacityState.TargetCapacity target : state.targets()) {
            rows.add(new RuntimeCapacityTargetRow(target.targetId().value(), column(target.queueCapacity()), column(target.maxConcurrency())));
        }
        return rows;
    }

    /** The state of the stored rows. A damaged revision is refused by the {@link CapacityState} constructor, which is not caught here. */
    CapacityState state(RuntimeCapacityRow row, List<RuntimeCapacityTargetRow> targets) {
        List<CapacityState.TargetCapacity> overrides = new ArrayList<>();
        for (RuntimeCapacityTargetRow target : targets) {
            overrides.add(new CapacityState.TargetCapacity(new TargetId(target.targetId()), override(target.queueCapacity()), override(target.maxConcurrency())));
        }
        return new CapacityState(row.revision(), new Capacity(row.queueCapacity()), new Capacity(row.maxConcurrency()), overrides);
    }

    private Integer column(CapacityOverride override) {
        return switch (override) {
            case CapacityOverride.Inherited inherited -> null;
            case CapacityOverride.Explicit(Capacity capacity) -> capacity.value();
        };
    }

    private CapacityOverride override(Integer column) {
        if (column == null) {
            return new CapacityOverride.Inherited();
        }
        return new CapacityOverride.Explicit(new Capacity(column));
    }
}
