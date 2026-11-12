package io.github.jaeseongs95.portal.domain.capacity;

/**
 * The capacities an installation gets when the administrator names none: a queue of ten requests per CPU and one simultaneous operation per CPU
 * (2.x adapters/config/capacity.mjs:5-8). The CPU count is given, not read here, so a test can state any machine.
 */
public record CapacityDefaults(int availableCpus) {

    private static final int QUEUE_PER_CPU = 10;

    public CapacityDefaults {
        Capacity checked = new Capacity(availableCpus);
        if (checked.value() > Integer.MAX_VALUE / QUEUE_PER_CPU) {
            throw new IllegalArgumentException("The CPU count is too large for a queue of " + QUEUE_PER_CPU + " requests per CPU");
        }
    }

    public Capacity queueCapacity() {
        return new Capacity(availableCpus * QUEUE_PER_CPU);
    }

    public Capacity maxConcurrency() {
        return new Capacity(availableCpus);
    }
}
