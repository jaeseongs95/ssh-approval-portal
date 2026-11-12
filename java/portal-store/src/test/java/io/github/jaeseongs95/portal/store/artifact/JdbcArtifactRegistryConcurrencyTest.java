package io.github.jaeseongs95.portal.store.artifact;

import static org.assertj.core.api.Assertions.assertThat;

import java.util.List;
import java.util.Optional;
import java.util.concurrent.CyclicBarrier;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;
import java.util.concurrent.TimeUnit;

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

import io.github.jaeseongs95.portal.app.artifact.ArtifactRegistry;
import io.github.jaeseongs95.portal.app.artifact.ArtifactRecord;
import io.github.jaeseongs95.portal.app.artifact.ArtifactState;
import io.github.jaeseongs95.portal.app.artifact.ArtifactSubmission;
import io.github.jaeseongs95.portal.app.artifact.ConsumeReason;
import io.github.jaeseongs95.portal.app.artifact.ConsumeState;
import io.github.jaeseongs95.portal.domain.error.ArtifactErrorCode;
import io.github.jaeseongs95.portal.domain.error.ErrorCode;
import io.github.jaeseongs95.portal.domain.error.RequestRefusedException;
import io.github.jaeseongs95.portal.domain.id.ArtifactId;
import io.github.jaeseongs95.portal.domain.id.OperationId;
import io.github.jaeseongs95.portal.store.StoreTest;

/**
 * Two callers on two connections: the optimistic lock of {@code artifact.version} decides who wins. The slice's rollback transaction would hide the race, so the
 * class runs without it ({@code NOT_SUPPORTED}) and removes its rows itself.
 */
@StoreTest
@Transactional(propagation = Propagation.NOT_SUPPORTED)
@Import({JdbcArtifactRegistry.class, ArtifactMapper.class, FileArtifactPayloadStore.class, ArtifactTestStorage.class})
class JdbcArtifactRegistryConcurrencyTest {

    private static final Logger LOG = LoggerFactory.getLogger(JdbcArtifactRegistryConcurrencyTest.class);
    private static final long WAIT_SECONDS = 30L;

    @TestConfiguration(proxyBeanMethods = false)
    static class Limits {
        @Bean
        ArtifactLimits artifactLimits() {
            return new ArtifactLimits(ArtifactLimits.DEFAULT_BUDGET_BYTES, ArtifactLimits.MAX_FILE_BYTES, ArtifactLimits.CHUNK_BYTES, ArtifactLimits.UPLOAD_TTL, 0L);
        }
    }

    private final ArtifactFixtures fixtures = new ArtifactFixtures();
    private final ArtifactRegistry registry;
    private final StagedActionRowRepository actions;
    private final ArtifactChunkRowRepository chunks;
    private final ArtifactRowRepository artifacts;

    JdbcArtifactRegistryConcurrencyTest(ArtifactRegistry registry, StagedActionRowRepository actions, ArtifactChunkRowRepository chunks,
                                        ArtifactRowRepository artifacts) {
        this.registry = registry;
        this.actions = actions;
        this.chunks = chunks;
        this.artifacts = artifacts;
    }

    @AfterEach
    void removeRows() {
        actions.deleteAll();
        chunks.deleteAll();
        artifacts.deleteAll();
    }

    @Test
    @DisplayName("RC-B-095: two callers that complete the same consumption at once both get the tombstone, and the row charges one byte once")
    void aDuplicateRemovalChargesOnce() throws Exception {
        ArtifactId id = fixtures.readyArtifact(registry, fixtures.stagedFile(4), fixtures.bytes(4, 5));
        registry.beginConsume(id, ConsumeReason.REMOVED);

        List<Optional<ErrorCode>> outcomes = race(() -> registry.completeConsume(id, ConsumeReason.REMOVED), () -> registry.completeConsume(id, ConsumeReason.REMOVED));

        assertThat(successes(outcomes)).isEqualTo(2L);
        ArtifactRecord record = registry.find(id).orElseThrow();
        assertThat(record.state()).isEqualTo(ArtifactState.CONSUMED);
        assertThat(record.consumption()).isEqualTo(new ConsumeState.ConsumedBecause(ConsumeReason.REMOVED));
        assertThat(registry.budget().chargedBytes()).isEqualTo(1);
    }

    @Test
    @DisplayName("RC-A-161 / RC-A-164: two callers that acknowledge the same chunk number at once: exactly one wins, the other gets ARTIFACT_CHUNK_CONFLICT, one chunk row exists")
    void theSameChunkNumberIsAcknowledgedOnce() throws Exception {
        ArtifactId id = fixtures.reservedId(registry.reserve(fixtures.upload(8), fixtures.at()));

        List<Optional<ErrorCode>> outcomes = race(() -> registry.append(id, 0, fixtures.chunk(fixtures.bytes(4, 1))),
            () -> registry.append(id, 0, fixtures.chunk(fixtures.bytes(4, 1))));

        assertThat(successes(outcomes)).isEqualTo(1L);
        assertThat(refusals(outcomes)).containsExactly(ArtifactErrorCode.ARTIFACT_CHUNK_CONFLICT);
        ArtifactRecord record = registry.find(id).orElseThrow();
        assertThat(record.receivedBytes()).isEqualTo(4);
        assertThat(record.chunkCount()).isEqualTo(1);
        assertThat(registry.chunks(id)).hasSize(1);
    }

    @Test
    @DisplayName("RC-A-164: two operations submitted from one upload at once: exactly one is bound, the other gets ARTIFACT_ALREADY_SUBMITTED")
    void onlyOneOperationIsBoundToAnUpload() throws Exception {
        ArtifactId id = fixtures.readyArtifact(registry, fixtures.upload(4), fixtures.bytes(4, 2));
        OperationId first = new OperationId("a".repeat(48));
        OperationId second = new OperationId("b".repeat(48));

        List<Optional<ErrorCode>> outcomes = race(() -> registry.submit(id, first), () -> registry.submit(id, second));

        assertThat(successes(outcomes)).isEqualTo(1L);
        assertThat(refusals(outcomes)).containsExactly(ArtifactErrorCode.ARTIFACT_ALREADY_SUBMITTED);
        ArtifactSubmission submission = registry.find(id).orElseThrow().submission();
        assertThat(submission).isIn(new ArtifactSubmission.SubmittedAs(first), new ArtifactSubmission.SubmittedAs(second));
    }

    /** Runs both calls at the same moment (a barrier) on two threads and returns, per call, no code for a success or the code of its refusal. */
    private List<Optional<ErrorCode>> race(Runnable first, Runnable second) throws Exception {
        CyclicBarrier barrier = new CyclicBarrier(2);
        try (ExecutorService pool = Executors.newFixedThreadPool(2)) {
            Future<Optional<ErrorCode>> one = pool.submit(() -> {
                barrier.await();
                return attempt(first);
            });
            Future<Optional<ErrorCode>> two = pool.submit(() -> {
                barrier.await();
                return attempt(second);
            });
            return List.of(one.get(WAIT_SECONDS, TimeUnit.SECONDS), two.get(WAIT_SECONDS, TimeUnit.SECONDS));
        }
    }

    private long successes(List<Optional<ErrorCode>> outcomes) {
        return outcomes.stream().filter(Optional::isEmpty).count();
    }

    private List<ErrorCode> refusals(List<Optional<ErrorCode>> outcomes) {
        return outcomes.stream().flatMap(Optional::stream).toList();
    }

    private Optional<ErrorCode> attempt(Runnable call) {
        try {
            call.run();
            return Optional.empty();
        } catch (RequestRefusedException e) {
            LOG.debug("The call was refused", e);
            return Optional.of(e.code());
        }
    }
}
