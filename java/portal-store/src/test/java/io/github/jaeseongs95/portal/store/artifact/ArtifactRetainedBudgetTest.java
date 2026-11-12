package io.github.jaeseongs95.portal.store.artifact;

import static org.assertj.core.api.Assertions.assertThat;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.attribute.FileTime;
import java.time.Duration;
import java.util.ArrayList;
import java.util.List;

import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.boot.test.context.TestConfiguration;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Import;
import org.springframework.transaction.annotation.Propagation;
import org.springframework.transaction.annotation.Transactional;
import org.springframework.util.FileSystemUtils;

import io.github.jaeseongs95.portal.app.artifact.ArtifactPayloadStore;
import io.github.jaeseongs95.portal.app.artifact.ArtifactRecord;
import io.github.jaeseongs95.portal.app.artifact.ArtifactRegistry;
import io.github.jaeseongs95.portal.app.artifact.ArtifactReservation;
import io.github.jaeseongs95.portal.app.artifact.ReleaseReason;
import io.github.jaeseongs95.portal.domain.id.ArtifactId;
import io.github.jaeseongs95.portal.store.StorageRoots;
import io.github.jaeseongs95.portal.store.StoreTest;

/**
 * The staging budget with bytes in quarantine (design 13.6: the held bytes of recovered legacy payloads count in the shared staging budget, because they use the
 * disk of the same storage root). The budget is 32 bytes. The start-up check is not called inside a transaction, so the class runs without the slice's rollback and
 * each test removes its rows and its files.
 *
 * <p>What 2.x reported and 3.0 does not have: the recovery status object ({@code recoveryStatus.reservedBytes}, {@code liveReservedBytes}, {@code unsafeEntries}, a
 * {@code resumable} flag) and the {@code reservedBytes} the legacy metadata claimed (16 for a one byte file). The 3.0 store quarantines a payload that has no row and
 * counts the bytes it really holds; the live part is the rows' ({@link ArtifactInventory#holding()}), the held part is the files'. The inode and the change time of
 * the 2.x case are not compared: the Java file API gives neither on every file system, so the bytes and the modification time stand for "not rewritten".
 */
@StoreTest
@Transactional(propagation = Propagation.NOT_SUPPORTED)
@Import({JdbcArtifactRegistry.class, ArtifactMapper.class, FileArtifactPayloadStore.class, ArtifactStartupCheck.class, ArtifactTestStorage.class})
class ArtifactRetainedBudgetTest {

    private static final Logger LOG = LoggerFactory.getLogger(ArtifactRetainedBudgetTest.class);

    @TestConfiguration(proxyBeanMethods = false)
    static class Limits {
        @Bean
        ArtifactLimits artifactLimits() {
            return new ArtifactLimits(32L, 32L, ArtifactLimits.CHUNK_BYTES, ArtifactLimits.UPLOAD_TTL, 0L);
        }
    }

    private final ArtifactFixtures fixtures = new ArtifactFixtures();
    private final ArtifactRegistry registry;
    private final ArtifactInventory inventory;
    private final ArtifactPayloadStore payloads;
    private final ArtifactStartupCheck startup;
    private final StorageRoots roots;
    private final StagedActionRowRepository actions;
    private final ArtifactChunkRowRepository chunks;
    private final ArtifactRowRepository artifacts;

    ArtifactRetainedBudgetTest(ArtifactRegistry registry, ArtifactInventory inventory, ArtifactPayloadStore payloads, ArtifactStartupCheck startup, StorageRoots roots,
                               StagedActionRowRepository actions, ArtifactChunkRowRepository chunks, ArtifactRowRepository artifacts) {
        this.registry = registry;
        this.inventory = inventory;
        this.payloads = payloads;
        this.startup = startup;
        this.roots = roots;
        this.actions = actions;
        this.chunks = chunks;
        this.artifacts = artifacts;
    }

    @AfterEach
    void removeRowsAndFiles() {
        actions.deleteAll();
        chunks.deleteAll();
        artifacts.deleteAll();
        try {
            FileSystemUtils.deleteRecursively(roots.artifacts());
        } catch (IOException e) {
            LOG.error("The test folder {} could not be removed", roots.artifacts(), e);
            throw new IllegalStateException("The test folder could not be removed", e);
        }
    }

    private Path orphans() {
        return roots.artifacts().resolve("orphans");
    }

    @Test
    @DisplayName("RC-A-170: a recovered legacy payload over the budget is counted in full: reserved 33, nothing live, a 1 byte begin is refused as a budget refusal, a reap and a second start keep the bytes and the 33")
    void quarantinedBytesOverTheBudgetAreEnforced() throws IOException {
        ArtifactId legacy = new ArtifactId("1".repeat(48));
        byte[] bytes = fixtures.bytes(33, 'L');
        payloads.append(legacy, 0, bytes);

        assertThat(startup.reconcile().quarantined()).containsExactly(legacy);

        assertThat(registry.budget().chargedBytes()).as("reserved").isEqualTo(33);
        assertThat(inventory.holding()).as("nothing live is reserved").isEmpty();
        assertThat(registry.reserve(fixtures.upload(1), fixtures.at())).isEqualTo(new ArtifactReservation.BudgetExceeded(1, 33, 32));
        assertThat(registry.expired(ArtifactFixtures.T0.plus(Duration.ofHours(2)))).isEmpty();
        assertThat(Files.readAllBytes(orphans().resolve(legacy.value() + ".part"))).as("the reap does not touch the bytes").isEqualTo(bytes);
        assertThat(startup.reconcile().quarantined()).as("a second start finds nothing new").isEmpty();
        assertThat(registry.budget().chargedBytes()).as("and still reserves 33").isEqualTo(33);
        assertThat(registry.reserve(fixtures.upload(1), fixtures.at())).isInstanceOf(ArtifactReservation.BudgetExceeded.class);
    }

    @Test
    @DisplayName("RC-A-169: eight one byte legacy payloads reserve 8, a live begin of 16 makes 24 of 32, a begin over the budget is refused, and a second start, a release and a reap leave the 8 and the files as they were")
    void quarantinedBytesAreChargedWithTheLiveReservationAndNotRewritten() throws IOException {
        List<ArtifactId> legacy = new ArrayList<>();
        for (int i = 1; i <= 8; i++) {
            ArtifactId id = new ArtifactId(String.format("%048x", i));
            legacy.add(id);
            payloads.append(id, 0, new byte[] {(byte) i});
        }
        assertThat(startup.reconcile().quarantined()).containsExactlyInAnyOrderElementsOf(legacy);
        List<FileTime> modified = new ArrayList<>();
        for (ArtifactId id : legacy) {
            modified.add(Files.getLastModifiedTime(orphans().resolve(id.value() + ".part")));
        }

        assertThat(registry.budget().chargedBytes()).as("reserved").isEqualTo(8);
        assertThat(inventory.holding()).as("live reserved 0").isEmpty();
        ArtifactId live = fixtures.reservedId(registry.reserve(fixtures.upload(16), fixtures.at()));
        assertThat(registry.budget().chargedBytes()).as("8 held and 16 live").isEqualTo(24);
        assertThat(registry.budget().remainingBytes()).isEqualTo(8);
        assertThat(registry.reserve(fixtures.upload(9), fixtures.at())).isEqualTo(new ArtifactReservation.BudgetExceeded(9, 24, 32));
        assertThat(startup.reconcile().quarantined()).as("the second start").isEmpty();
        assertThat(registry.budget().chargedBytes()).isEqualTo(24);
        assertThat(registry.reserve(fixtures.upload(16), fixtures.at())).as("a begin that was refused is not accepted by asking again").isInstanceOf(ArtifactReservation.BudgetExceeded.class);

        registry.release(live, ReleaseReason.REFUSED);
        assertThat(registry.budget().chargedBytes()).as("after the live one is removed").isEqualTo(8);
        List<ArtifactRecord> expired = registry.expired(ArtifactFixtures.T0.plus(Duration.ofHours(2)));
        assertThat(expired).isEmpty();
        assertThat(registry.budget().chargedBytes()).as("a reap keeps the held bytes").isEqualTo(8);
        for (int i = 0; i < legacy.size(); i++) {
            Path file = orphans().resolve(legacy.get(i).value() + ".part");
            assertThat(Files.readAllBytes(file)).isEqualTo(new byte[] {(byte) (i + 1)});
            assertThat(Files.getLastModifiedTime(file)).as("modification time of " + file.getFileName()).isEqualTo(modified.get(i));
        }
    }
}
