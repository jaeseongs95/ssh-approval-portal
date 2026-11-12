package io.github.jaeseongs95.portal.app.config;

/**
 * The number of processors the product may use, as a value the {@code CapacityDefaults} are computed from (2.x {@code availableParallelism()},
 * {@code config/capacity.mjs:5}). It is an interface so that a test answers another count without touching the JVM.
 */
@FunctionalInterface
public interface AvailableCpus {

    /** At least 1. */
    int count();
}
