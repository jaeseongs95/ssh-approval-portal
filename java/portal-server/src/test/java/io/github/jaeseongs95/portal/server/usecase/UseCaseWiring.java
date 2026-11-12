package io.github.jaeseongs95.portal.server.usecase;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;

import org.springframework.boot.test.context.TestConfiguration;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.ComponentScan;
import org.springframework.context.annotation.FilterType;
import org.springframework.context.annotation.Import;
import org.springframework.data.jdbc.repository.config.EnableJdbcRepositories;
import org.springframework.scheduling.concurrent.ThreadPoolTaskScheduler;

import tools.jackson.databind.json.JsonMapper;

import io.github.jaeseongs95.portal.app.artifact.ArtifactImporter;
import io.github.jaeseongs95.portal.app.artifact.StagingTimes;
import io.github.jaeseongs95.portal.app.config.DomainBeans;
import io.github.jaeseongs95.portal.app.file.DownloadService;
import io.github.jaeseongs95.portal.app.file.OperationUploadAdmission;
import io.github.jaeseongs95.portal.app.file.StagedFileService;
import io.github.jaeseongs95.portal.app.file.TransferOutcomes;
import io.github.jaeseongs95.portal.app.file.TransferSupport;
import io.github.jaeseongs95.portal.app.file.UploadService;
import io.github.jaeseongs95.portal.app.remote.TransferLimits;
import io.github.jaeseongs95.portal.app.event.ChangeWaiters;
import io.github.jaeseongs95.portal.app.journal.OperationJournal;
import io.github.jaeseongs95.portal.app.remote.ExecutionLimits;
import io.github.jaeseongs95.portal.app.target.TargetPlatformRegistry;
import io.github.jaeseongs95.portal.domain.approval.ApprovalPolicy;
import io.github.jaeseongs95.portal.domain.capacity.Capacity;
import io.github.jaeseongs95.portal.domain.classify.CommandClassifier;
import io.github.jaeseongs95.portal.domain.id.Digester;
import io.github.jaeseongs95.portal.domain.schedule.AdmissionLimits;
import io.github.jaeseongs95.portal.domain.schedule.ConcurrencyLimits;
import io.github.jaeseongs95.portal.domain.target.TargetOs;
import io.github.jaeseongs95.portal.store.StorageRoots;
import io.github.jaeseongs95.portal.store.artifact.ArtifactLimits;
import io.github.jaeseongs95.portal.store.output.OutputConfiguration;

/**
 * The wiring of the use case slice. Real: every use case bean of portal-app (found by scanning its packages), every storage adapter that the use cases need (found by
 * scanning the store packages, without the artifact, audit, capacity and agent CLI adapters, which no use case of this slice touches), the helper beans of
 * {@link DomainBeans}. Plain test classes: the SSH executor ({@link ScriptedExecutor}), the audit port ({@link RecordingAudit}), the two target platforms
 * ({@link TestPlatform}), the targets ({@link FixedTargets}) and a listener of terminal operations. The limits are small numbers a test can reach: four operations at
 * once, two on one target.
 */
@TestConfiguration(proxyBeanMethods = false)
@Import({DomainBeans.class, OutputConfiguration.class, TargetPlatformRegistry.class, StagedFileService.class, UploadService.class, DownloadService.class,
    TransferSupport.class, TransferOutcomes.class, OperationUploadAdmission.class, ArtifactImporter.class})
@ComponentScan(basePackages = {"io.github.jaeseongs95.portal.app.event", "io.github.jaeseongs95.portal.app.admission", "io.github.jaeseongs95.portal.app.operation",
    "io.github.jaeseongs95.portal.app.execution", "io.github.jaeseongs95.portal.app.recovery"}, excludeFilters = @ComponentScan.Filter(type = FilterType.REGEX,
    pattern = "io\\.github\\.jaeseongs95\\.portal\\.app\\.execution\\.AgentCliOperationRunner"))
@ComponentScan(basePackages = "io.github.jaeseongs95.portal.store", excludeFilters = @ComponentScan.Filter(type = FilterType.REGEX,
    pattern = "io\\.github\\.jaeseongs95\\.portal\\.store\\.(audit|capacity|cli)\\..*|io\\.github\\.jaeseongs95\\.portal\\.store\\.StoreConfiguration"))
@EnableJdbcRepositories(basePackages = "io.github.jaeseongs95.portal.store")
class UseCaseWiring {

    @Bean
    ConcurrencyLimits concurrencyLimits() {
        return ConcurrencyLimits.defaults().withGlobalConcurrency(new Capacity(4)).withTargetConcurrency(new Capacity(2));
    }

    @Bean
    AdmissionLimits admissionLimits() {
        return AdmissionLimits.defaults();
    }

    @Bean
    ApprovalPolicy approvalPolicy() {
        return new ApprovalPolicy(new Capacity(100));
    }

    @Bean
    ExecutionLimits executionLimits() {
        return ExecutionLimits.defaults();
    }

    @Bean
    TransferLimits transferLimits() {
        return TransferLimits.defaults();
    }

    @Bean
    StagingTimes stagingTimes() {
        return StagingTimes.defaults();
    }

    /** No disk margin: a test must not fail because the disk of the machine is nearly full; the rule of the margin has its own tests in portal-store. */
    @Bean
    ArtifactLimits artifactLimits() {
        return new ArtifactLimits(ArtifactLimits.DEFAULT_BUDGET_BYTES, ArtifactLimits.MAX_FILE_BYTES, ArtifactLimits.CHUNK_BYTES, ArtifactLimits.UPLOAD_TTL, 0);
    }

    /** The SFTP boundary, the other thing that is not real: it follows the contract of the adapter and answers what a test says. */
    @Bean
    ScriptedTransfer transfer() {
        return new ScriptedTransfer();
    }

    /** One pool serves as the {@code TaskScheduler} (timers) and the {@code TaskExecutor} (the dispatcher and the executions). */
    @Bean
    ThreadPoolTaskScheduler taskScheduler() {
        ThreadPoolTaskScheduler scheduler = new ThreadPoolTaskScheduler();
        scheduler.setPoolSize(8);
        scheduler.setThreadNamePrefix("usecase-");
        return scheduler;
    }

    @Bean
    JsonMapper jsonMapper() {
        return JsonMapper.builder().build();
    }

    /** The output folder is made by the store (private to its owner) below a temporary folder of this context. */
    @Bean
    StorageRoots storageRoots() throws IOException {
        Path base = Files.createTempDirectory("portal-usecase");
        return new StorageRoots(base.resolve("artifacts"), base.resolve("outputs"));
    }

    @Bean
    RecordingAudit audit() {
        return new RecordingAudit();
    }

    @Bean
    FixedTargets targets(Digester digester) {
        return new FixedTargets(digester);
    }

    @Bean
    TestPlatform linuxPlatform(CommandClassifier classifier) {
        return new TestPlatform(TargetOs.LINUX, classifier);
    }

    @Bean
    TestPlatform windowsPlatform(CommandClassifier classifier) {
        return new TestPlatform(TargetOs.WINDOWS, classifier);
    }

    @Bean
    ScriptedExecutor executor() {
        return new ScriptedExecutor();
    }

    @Bean
    RecordingTerminalListener terminalListener() {
        return new RecordingTerminalListener();
    }

    @Bean
    UseCaseKit kit(Digester digester, FixedTargets targets, ChangeWaiters waiters, OperationJournal journal) {
        return new UseCaseKit(digester, targets, waiters, journal);
    }
}
