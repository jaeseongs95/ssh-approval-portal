package io.github.jaeseongs95.portal.store.artifact;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import java.time.Duration;

import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

class ArtifactLimitsTest {

    @Test
    @DisplayName("RC-B-440 / RC-A-158: the default limits are 512 MiB budget, 64 MiB per file, 256 KiB chunk and 10 minutes of staging")
    void theDefaultsAreThose2xProduct() {
        ArtifactLimits defaults = ArtifactLimits.defaults();

        assertThat(defaults.budgetBytes()).isEqualTo(536_870_912L);
        assertThat(defaults.maxFileBytes()).isEqualTo(67_108_864L);
        assertThat(defaults.chunkBytes()).isEqualTo(262_144);
        assertThat(defaults.uploadTimeToLive()).isEqualTo(Duration.ofMinutes(10));
        assertThat(defaults.diskMarginBytes()).isEqualTo(ArtifactLimits.DEFAULT_DISK_MARGIN_BYTES);
    }

    @Test
    @DisplayName("RC-B-440: a limit that the table could not hold (a file over 64 MiB), a chunk over 256 KiB, a zero budget, a zero or negative time and a negative margin are refused")
    void impossibleLimitsAreRefused() {
        Duration ttl = ArtifactLimits.UPLOAD_TTL;

        assertThatThrownBy(() -> new ArtifactLimits(1, ArtifactLimits.MAX_FILE_BYTES + 1, 1, ttl, 0)).isInstanceOf(IllegalArgumentException.class);
        assertThatThrownBy(() -> new ArtifactLimits(1, 1, ArtifactLimits.CHUNK_BYTES + 1, ttl, 0)).isInstanceOf(IllegalArgumentException.class);
        assertThatThrownBy(() -> new ArtifactLimits(0, 1, 1, ttl, 0)).isInstanceOf(IllegalArgumentException.class);
        assertThatThrownBy(() -> new ArtifactLimits(1, 1, 1, Duration.ZERO, 0)).isInstanceOf(IllegalArgumentException.class);
        assertThatThrownBy(() -> new ArtifactLimits(1, 1, 1, ttl, -1)).isInstanceOf(IllegalArgumentException.class);
    }
}
