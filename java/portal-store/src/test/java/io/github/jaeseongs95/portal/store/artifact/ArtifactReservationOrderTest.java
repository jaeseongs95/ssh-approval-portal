package io.github.jaeseongs95.portal.store.artifact;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import java.io.IOException;
import java.io.UncheckedIOException;
import java.util.Set;

import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.ValueSource;
import org.springframework.boot.test.context.TestConfiguration;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Import;

import io.github.jaeseongs95.portal.app.artifact.ArtifactPayloadStore;
import io.github.jaeseongs95.portal.app.artifact.ArtifactRegistry;
import io.github.jaeseongs95.portal.app.artifact.ArtifactReservation;
import io.github.jaeseongs95.portal.app.artifact.ReleaseReason;
import io.github.jaeseongs95.portal.app.artifact.ReservedSplit;
import io.github.jaeseongs95.portal.app.storage.DiskSpace;
import io.github.jaeseongs95.portal.app.storage.PayloadRead;
import io.github.jaeseongs95.portal.app.storage.PayloadWrite;
import io.github.jaeseongs95.portal.domain.error.ArtifactErrorCode;
import io.github.jaeseongs95.portal.domain.error.RequestRefusedException;
import io.github.jaeseongs95.portal.domain.id.ArtifactId;
import io.github.jaeseongs95.portal.store.Savepoints;
import io.github.jaeseongs95.portal.store.StoreTest;

/**
 * The three refusals of {@code reserve} on a disk that the test controls (defect D-0012, design 5.2, cases S3-AR-01 to S3-AR-05): the budget is 10,000 bytes, one file
 * is at most 8,000 bytes and 1,000 bytes of disk must stay free after a file is set aside. The disk's usable space and the bytes in quarantine are values the test sets,
 * so each rule is shown with the one number that decides it.
 *
 * <p>"1090B" is the size of the upload that the defect report said was refused as over quota while the disk had room (2.x cause unconfirmed; the Java store is shown to
 * accept it whenever the budget has room and the disk is not short).
 */
@StoreTest
@Import({JdbcArtifactRegistry.class, ArtifactMapper.class, ArtifactTestStorage.class, ArtifactReservationOrderTest.Disk.class})
class ArtifactReservationOrderTest {

    private static final long BUDGET = 10_000L;
    private static final long FILE_LIMIT = 8_000L;
    private static final long MARGIN = 1_000L;
    private static final long THE_DEFECT_SIZE = 1_090L;

    @TestConfiguration(proxyBeanMethods = false)
    static class Disk {
        @Bean
        ArtifactLimits artifactLimits() {
            return new ArtifactLimits(BUDGET, FILE_LIMIT, ArtifactLimits.CHUNK_BYTES, ArtifactLimits.UPLOAD_TTL, MARGIN);
        }

        @Bean
        ScriptedDisk scriptedDisk() {
            return new ScriptedDisk();
        }
    }

    private final ArtifactFixtures fixtures = new ArtifactFixtures();
    private final ArtifactRegistry registry;
    private final ScriptedDisk disk;
    private final Savepoints savepoints;

    ArtifactReservationOrderTest(ArtifactRegistry registry, ScriptedDisk disk, Savepoints savepoints) {
        this.registry = registry;
        this.disk = disk;
        this.savepoints = savepoints;
        disk.reset();
    }

    @ParameterizedTest
    @ValueSource(longs = {1_000_000_000_000L, Long.MAX_VALUE, THE_DEFECT_SIZE + MARGIN})
    @DisplayName("S3-AR-01 (D-0012): a 1090 byte upload is accepted when the budget has room and the disk keeps the margin, whatever the usable space is above that")
    void theDefectSizeIsAcceptedWhenTheBudgetHasRoom(long usableBytes) {
        disk.usable(usableBytes);

        ArtifactReservation reservation = registry.reserve(fixtures.upload(THE_DEFECT_SIZE), fixtures.at());

        assertThat(reservation).isInstanceOf(ArtifactReservation.Reserved.class);
        assertThat(registry.budget().chargedBytes()).isEqualTo(THE_DEFECT_SIZE);
    }

    @Test
    @DisplayName("S3-AR-02: a refusal by the budget is BudgetExceeded and shows the live rows and the held bytes apart, with the request and the budget")
    void aBudgetRefusalShowsTheLiveAndTheHeldBytesApart() {
        disk.usable(1_000_000_000_000L);
        fixtures.reservedId(registry.reserve(fixtures.upload(6_000L), fixtures.at()));
        disk.retained(3_500L);

        ArtifactReservation refused = registry.reserve(fixtures.upload(THE_DEFECT_SIZE), fixtures.at());

        assertThat(refused).isEqualTo(new ArtifactReservation.BudgetExceeded(THE_DEFECT_SIZE, new ReservedSplit(6_000L, 3_500L), BUDGET));
        assertThat(((ArtifactReservation.BudgetExceeded) refused).reserved().totalBytes()).isEqualTo(9_500L);
        assertThat(registry.holding()).hasSize(1);
    }

    @ParameterizedTest
    @ValueSource(longs = {0L, 1_000_000_000_000L, Long.MAX_VALUE})
    @DisplayName("S3-AR-03: the budget's verdict does not depend on the disk: the same refusal for a disk with no room, a big one and an unreadable-by-size one")
    void theBudgetVerdictIgnoresTheDisk(long usableBytes) {
        fixtures.reservedId(registry.reserve(fixtures.upload(FILE_LIMIT), fixtures.at()));
        disk.usable(usableBytes);

        assertThat(registry.reserve(fixtures.upload(2_500L), fixtures.at())).isEqualTo(new ArtifactReservation.BudgetExceeded(2_500L, new ReservedSplit(FILE_LIMIT, 0L), BUDGET));
    }

    @Test
    @DisplayName("S3-AR-03: a refusal by the disk is DiskSpaceInsufficient (another variant than the budget's) with the request, the usable space and the margin, and no row is created")
    void aDiskRefusalIsAnotherVariantWithItsOwnValues() {
        disk.usable(THE_DEFECT_SIZE + MARGIN - 1);

        ArtifactReservation refused = registry.reserve(fixtures.upload(THE_DEFECT_SIZE), fixtures.at());

        assertThat(refused).isEqualTo(new ArtifactReservation.DiskSpaceInsufficient(THE_DEFECT_SIZE, THE_DEFECT_SIZE + MARGIN - 1, MARGIN));
        assertThat(refused).isNotInstanceOf(ArtifactReservation.BudgetExceeded.class);
        assertThat(registry.holding()).isEmpty();
        assertThat(registry.budget().chargedBytes()).isZero();
    }

    @Test
    @DisplayName("S3-AR-03: a disk that cannot be read is not a refusal: ARTIFACT_STORAGE_IO_ERROR with the cause kept, and no row is created")
    void anUnreadableDiskIsAnIoErrorAndNotARefusal() {
        disk.failToRead(new UncheckedIOException(new IOException("the volume is gone")));

        assertThatThrownBy(() -> savepoints.run(() -> registry.reserve(fixtures.upload(THE_DEFECT_SIZE), fixtures.at()))).isInstanceOfSatisfying(RequestRefusedException.class, e -> {
            assertThat(e.code()).isEqualTo(ArtifactErrorCode.ARTIFACT_STORAGE_IO_ERROR);
            assertThat(e.getCause()).isInstanceOf(UncheckedIOException.class);
        });
        assertThat(registry.holding()).isEmpty();
    }

    @Test
    @DisplayName("S3-AR-04: the order is the file limit, then the budget, then the disk, and one answer at a time, also when the disk cannot be read")
    void theOrderIsLimitBudgetDisk() {
        disk.usable(1_000_000_000_000L);
        ArtifactId filler = fixtures.reservedId(registry.reserve(fixtures.upload(FILE_LIMIT), fixtures.at()));
        disk.failToRead(new UncheckedIOException(new IOException("the volume is gone")));

        // 9,000 is over the file limit, over the budget with the filler, and the disk is unreadable: the limit speaks first.
        assertThat(registry.reserve(fixtures.upload(9_000L), fixtures.at())).isEqualTo(new ArtifactReservation.FileTooLarge(9_000L, FILE_LIMIT));
        // 2,500 is within the limit, over the budget with the filler, and the disk is unreadable: the budget speaks before the disk is asked.
        assertThat(registry.reserve(fixtures.upload(2_500L), fixtures.at())).isEqualTo(new ArtifactReservation.BudgetExceeded(2_500L, new ReservedSplit(FILE_LIMIT, 0L), BUDGET));

        registry.release(filler, ReleaseReason.REFUSED);
        disk.usable(0L);
        // the budget has room again and the disk is short: only now the disk speaks.
        assertThat(registry.reserve(fixtures.upload(2_500L), fixtures.at())).isEqualTo(new ArtifactReservation.DiskSpaceInsufficient(2_500L, 0L, MARGIN));
    }

    @Test
    @DisplayName("S3-AR-05: bytes held in quarantine use the budget and show as holdingBytes in the refusal; once they are gone the same file is accepted")
    void heldBytesAreRefusedWithTheirOwnNumberAndFreedBytesLetTheFileIn() {
        disk.usable(1_000_000_000_000L);
        disk.retained(9_500L);

        ArtifactReservation refused = registry.reserve(fixtures.upload(THE_DEFECT_SIZE), fixtures.at());

        assertThat(refused).isEqualTo(new ArtifactReservation.BudgetExceeded(THE_DEFECT_SIZE, new ReservedSplit(0L, 9_500L), BUDGET));
        assertThat(registry.budget().chargedBytes()).as("the budget view counts the held bytes too").isEqualTo(9_500L);

        disk.retained(0L);

        assertThat(registry.reserve(fixtures.upload(THE_DEFECT_SIZE), fixtures.at())).isInstanceOf(ArtifactReservation.Reserved.class);
    }

    /** A payload store that is only a disk: it answers the usable space and the retained bytes the test sets, or fails to read them. */
    static final class ScriptedDisk implements ArtifactPayloadStore, RetainedPayloads {

        private long usableBytes = Long.MAX_VALUE;
        private long retainedBytes;
        private RuntimeException failure;

        void reset() {
            usableBytes = Long.MAX_VALUE;
            retainedBytes = 0L;
            failure = null;
        }

        void usable(long bytes) {
            this.usableBytes = bytes;
            this.failure = null;
        }

        void retained(long bytes) {
            this.retainedBytes = bytes;
        }

        void failToRead(RuntimeException cause) {
            this.failure = cause;
        }

        @Override
        public DiskSpace usable() {
            if (failure != null) {
                throw failure;
            }
            return new DiskSpace(usableBytes);
        }

        @Override
        public long retainedBytes() {
            return retainedBytes;
        }

        @Override
        public PayloadWrite append(ArtifactId id, long offset, byte[] data) {
            throw new IllegalStateException("The scripted disk stores no payload");
        }

        @Override
        public void truncate(ArtifactId id, long length) {
            throw new IllegalStateException("The scripted disk stores no payload");
        }

        @Override
        public long length(ArtifactId id) {
            throw new IllegalStateException("The scripted disk stores no payload");
        }

        @Override
        public PayloadRead open(ArtifactId id) {
            throw new IllegalStateException("The scripted disk stores no payload");
        }

        @Override
        public void delete(ArtifactId id) {
            throw new IllegalStateException("The scripted disk stores no payload");
        }

        @Override
        public void quarantine(ArtifactId id) {
            throw new IllegalStateException("The scripted disk stores no payload");
        }

        @Override
        public Set<ArtifactId> stored() {
            return Set.of();
        }
    }
}
