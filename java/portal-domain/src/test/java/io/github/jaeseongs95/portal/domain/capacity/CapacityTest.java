package io.github.jaeseongs95.portal.domain.capacity;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

class CapacityTest {

    @Test
    @DisplayName("S2-VA-05 RC-A-745 a capacity is a whole number of at least 1: zero, negatives, signs, leading zeros, blanks and larger than an int are refused")
    void capacityRules() {
        assertThat(new Capacity(1).value()).isEqualTo(1);
        assertThat(Capacity.parse("1").value()).isEqualTo(1);
        assertThat(Capacity.parse("2147483647").value()).isEqualTo(Integer.MAX_VALUE);
        for (String bad : new String[] {"0", "01", "-1", "+1", "1.5", "1e3", " 2", "2 ", "", "NaN", "Infinity", "9007199254740993", "2147483648"}) {
            assertThatThrownBy(() -> Capacity.parse(bad)).as("text '%s'", bad).isInstanceOf(IllegalArgumentException.class);
        }
        assertThatThrownBy(() -> new Capacity(0)).isInstanceOf(IllegalArgumentException.class);
        assertThatThrownBy(() -> new Capacity(-1)).isInstanceOf(IllegalArgumentException.class);
        assertThatThrownBy(() -> Capacity.parse(null)).isInstanceOf(NullPointerException.class);
    }

    @Test
    @DisplayName("S2-VA-05 the defaults are one operation per CPU and a queue of ten per CPU, for 1 and 8 CPUs")
    void defaultsFollowTheCpuCount() {
        assertThat(new CapacityDefaults(1).queueCapacity()).isEqualTo(new Capacity(10));
        assertThat(new CapacityDefaults(1).maxConcurrency()).isEqualTo(new Capacity(1));
        assertThat(new CapacityDefaults(8).queueCapacity()).isEqualTo(new Capacity(80));
        assertThat(new CapacityDefaults(8).maxConcurrency()).isEqualTo(new Capacity(8));
        assertThatThrownBy(() -> new CapacityDefaults(0)).isInstanceOf(IllegalArgumentException.class);
        assertThatThrownBy(() -> new CapacityDefaults(Integer.MAX_VALUE)).isInstanceOf(IllegalArgumentException.class);
    }
}
