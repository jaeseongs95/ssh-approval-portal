package io.github.jaeseongs95.portal.store.artifact;

import static org.assertj.core.api.Assertions.assertThat;

import java.time.Duration;
import java.util.ArrayList;
import java.util.List;

import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.springframework.boot.test.context.TestConfiguration;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Import;

import io.github.jaeseongs95.portal.app.artifact.ArtifactRecord;
import io.github.jaeseongs95.portal.app.artifact.ArtifactRegistry;
import io.github.jaeseongs95.portal.app.artifact.ArtifactReservation;
import io.github.jaeseongs95.portal.app.artifact.ReleaseReason;
import io.github.jaeseongs95.portal.app.artifact.ReservedSplit;
import io.github.jaeseongs95.portal.domain.id.ArtifactId;
import io.github.jaeseongs95.portal.domain.id.TargetId;
import io.github.jaeseongs95.portal.domain.path.PosixRemotePath;
import io.github.jaeseongs95.portal.store.StoreTest;

/**
 * The registry with a small budget (128 bytes, 64 per file, no disk margin), where the three refusals of {@code reserve} can be provoked with a few rows. The
 * disk is never short here, so a refusal is always the budget's or the per-file limit's (defect D-0012 asked for exactly that separation).
 */
@StoreTest
@Import({JdbcArtifactRegistry.class, ArtifactMapper.class, FileArtifactPayloadStore.class, ArtifactTestStorage.class})
class JdbcArtifactRegistryBudgetTest {

    @TestConfiguration(proxyBeanMethods = false)
    static class Limits {
        @Bean
        ArtifactLimits artifactLimits() {
            return new ArtifactLimits(128L, 64L, ArtifactLimits.CHUNK_BYTES, ArtifactLimits.UPLOAD_TTL, 0L);
        }
    }

    private final ArtifactFixtures fixtures = new ArtifactFixtures();
    private final ArtifactRegistry registry;

    JdbcArtifactRegistryBudgetTest(ArtifactRegistry registry) {
        this.registry = registry;
    }

    @Test
    @DisplayName("RC-A-160 / S3-AR-02 (store half): when the budget is used up even a 1 byte file is refused as BudgetExceeded, with the numbers (the live rows and nothing held), and no row is created")
    void aSmallFileIsRefusedByTheBudgetAndNothingIsStored() {
        for (int i = 0; i < 4; i++) {
            fixtures.reservedId(registry.reserve(fixtures.upload(32), fixtures.at()));
        }
        List<ArtifactRecord> before = registry.holding();

        ArtifactReservation refused = registry.reserve(fixtures.upload(1), fixtures.at());

        assertThat(refused).isEqualTo(new ArtifactReservation.BudgetExceeded(1, new ReservedSplit(128, 0), 128));
        assertThat(registry.holding()).containsExactlyInAnyOrderElementsOf(before);
        assertThat(registry.budget().chargedBytes()).isEqualTo(128);
    }

    @Test
    @DisplayName("RC-B-063 (budget half): two 64 byte files fill a 128 byte budget across targets, the third is refused, a release lets it in, releasing all returns the budget to zero")
    void theBudgetIsGlobalAcrossTargets() {
        ArtifactId alpha = fixtures.reservedId(registry.reserve(fixtures.upload(64, new PosixRemotePath("/tmp/a.bin"), new TargetId("alpha")), fixtures.at()));
        ArtifactId beta = fixtures.reservedId(registry.reserve(fixtures.upload(64, new PosixRemotePath("/tmp/b.bin"), new TargetId("beta")), fixtures.at()));

        assertThat(registry.reserve(fixtures.upload(64, new PosixRemotePath("/tmp/c.bin"), new TargetId("gamma")), fixtures.at()))
            .isEqualTo(new ArtifactReservation.BudgetExceeded(64, new ReservedSplit(128, 0), 128));
        assertThat(registry.holding()).hasSize(2);

        registry.release(alpha, ReleaseReason.REFUSED);
        ArtifactId gamma = fixtures.reservedId(registry.reserve(fixtures.upload(64, new PosixRemotePath("/tmp/c.bin"), new TargetId("gamma")), fixtures.at()));
        registry.release(beta, ReleaseReason.REFUSED);
        registry.release(gamma, ReleaseReason.REFUSED);
        assertThat(registry.budget().chargedBytes()).isZero();
        assertThat(registry.budget().remainingBytes()).isEqualTo(128);
    }

    @Test
    @DisplayName("RC-B-068 (store half): a refused reservation changes nothing, a released one gives its bytes back at once, and the remaining budget is what the next request sees")
    void aRefusedReservationLeavesTheBudgetAlone() {
        ArtifactId first = fixtures.reservedId(registry.reserve(fixtures.upload(64), fixtures.at()));
        ArtifactId second = fixtures.reservedId(registry.reserve(fixtures.upload(64), fixtures.at()));
        long charged = registry.budget().chargedBytes();

        assertThat(registry.reserve(fixtures.upload(1), fixtures.at())).isInstanceOf(ArtifactReservation.BudgetExceeded.class);
        assertThat(registry.budget().chargedBytes()).isEqualTo(charged);

        registry.release(first, ReleaseReason.REFUSED);
        assertThat(registry.budget().remainingBytes()).isEqualTo(64);
        assertThat(fixtures.reservedId(registry.reserve(fixtures.upload(64), fixtures.at()))).isNotEqualTo(second);
    }

    @Test
    @DisplayName("RC-A-172: items are not counted, bytes are: 101 empty files fit, the budget stops at 128 empty files and the 129th is refused")
    void emptyFilesChargeOneByteEach() {
        List<ArtifactId> ids = new ArrayList<>();
        for (int i = 0; i < 128; i++) {
            ids.add(fixtures.reservedId(registry.reserve(fixtures.upload(0), fixtures.at())));
        }

        assertThat(ids).hasSize(128);
        assertThat(registry.budget().chargedBytes()).isEqualTo(128);
        assertThat(registry.reserve(fixtures.upload(0), fixtures.at())).isEqualTo(new ArtifactReservation.BudgetExceeded(0, new ReservedSplit(128, 0), 128));
    }

    @Test
    @DisplayName("RC-A-180: a file over the per-file limit is refused as FileTooLarge with the limit, even when the budget has room")
    void aFileOverTheLimitIsRefused() {
        assertThat(registry.reserve(fixtures.upload(65), fixtures.at())).isEqualTo(new ArtifactReservation.FileTooLarge(65, 64));
        assertThat(registry.holding()).isEmpty();
        assertThat(fixtures.reservedId(registry.reserve(fixtures.upload(64), fixtures.at()))).isNotNull();
    }

    @Test
    @DisplayName("RC-A-181: with the budget full a further begin is refused; once the expired partial upload is released the capacity is free again")
    void releasingAnExpiredUploadFreesTheCapacity() {
        ArtifactId filler = fixtures.reservedId(registry.reserve(fixtures.upload(64), fixtures.at()));
        ArtifactId partial = fixtures.reservedId(registry.reserve(fixtures.upload(64), fixtures.at()));
        assertThat(registry.reserve(fixtures.upload(4), fixtures.at())).isInstanceOf(ArtifactReservation.BudgetExceeded.class);

        List<ArtifactRecord> expired = registry.expired(ArtifactFixtures.T0.plus(Duration.ofMinutes(10)));
        assertThat(expired).extracting(ArtifactRecord::id).containsExactlyInAnyOrder(filler, partial);
        expired.forEach(record -> registry.release(record.id(), ReleaseReason.EXPIRED));

        assertThat(registry.budget().chargedBytes()).isZero();
        assertThat(registry.reserve(fixtures.upload(4), fixtures.at())).isInstanceOf(ArtifactReservation.Reserved.class);
    }
}
