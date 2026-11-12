package io.github.jaeseongs95.portal.store.artifact;

import static org.assertj.core.api.Assertions.assertThat;

import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.springframework.boot.test.context.TestConfiguration;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Import;

import io.github.jaeseongs95.portal.app.artifact.ArtifactPayloadStore;
import io.github.jaeseongs95.portal.app.artifact.ArtifactRegistry;
import io.github.jaeseongs95.portal.app.artifact.ArtifactReservation;

import io.github.jaeseongs95.portal.store.StoreTest;

/**
 * The registry on a disk that is "short" by construction: the margin that must stay free is larger than any real disk, while the budget is the 2.x default and has
 * plenty of room. A refusal can then only be the disk's, which is the separation that defect D-0012 asked for (2.x refused a small file as over quota because the
 * disk was short).
 */
@StoreTest
@Import({JdbcArtifactRegistry.class, ArtifactMapper.class, FileArtifactPayloadStore.class, ArtifactTestStorage.class})
class JdbcArtifactRegistryDiskTest {

    @TestConfiguration(proxyBeanMethods = false)
    static class Limits {
        @Bean
        ArtifactLimits artifactLimits() {
            return new ArtifactLimits(ArtifactLimits.DEFAULT_BUDGET_BYTES, ArtifactLimits.MAX_FILE_BYTES, ArtifactLimits.CHUNK_BYTES, ArtifactLimits.UPLOAD_TTL,
                Long.MAX_VALUE);
        }
    }

    private final ArtifactFixtures fixtures = new ArtifactFixtures();
    private final ArtifactRegistry registry;
    private final ArtifactInventory inventory;
    private final ArtifactPayloadStore payloads;

    JdbcArtifactRegistryDiskTest(ArtifactRegistry registry, ArtifactInventory inventory, ArtifactPayloadStore payloads) {
        this.registry = registry;
        this.inventory = inventory;
        this.payloads = payloads;
    }

    @Test
    @DisplayName("RC-A-160 / RC-B-094 (D-0012): a 1 byte file on a disk without room is refused as DiskSpaceInsufficient, not as a budget refusal, and no row is created")
    void aSmallFileIsRefusedByTheDiskNotByTheBudget() {
        ArtifactReservation refused = registry.reserve(fixtures.upload(1), fixtures.at());

        assertThat(refused).isInstanceOf(ArtifactReservation.DiskSpaceInsufficient.class);
        ArtifactReservation.DiskSpaceInsufficient disk = (ArtifactReservation.DiskSpaceInsufficient) refused;
        assertThat(disk.requestedBytes()).isEqualTo(1);
        assertThat(disk.usableBytes()).isPositive();
        assertThat(inventory.holding()).isEmpty();
        assertThat(registry.budget().chargedBytes()).isZero();
        assertThat(registry.budget().remainingBytes()).isEqualTo(ArtifactLimits.DEFAULT_BUDGET_BYTES);
        assertThat(payloads.usable().usableBytes()).isPositive();
    }

    @Test
    @DisplayName("RC-A-160: the per-file limit is answered before the disk is asked")
    void thePerFileLimitComesBeforeTheDisk() {
        assertThat(registry.reserve(fixtures.upload(ArtifactLimits.MAX_FILE_BYTES + 1), fixtures.at())).isEqualTo(
            new ArtifactReservation.FileTooLarge(ArtifactLimits.MAX_FILE_BYTES));
    }
}
