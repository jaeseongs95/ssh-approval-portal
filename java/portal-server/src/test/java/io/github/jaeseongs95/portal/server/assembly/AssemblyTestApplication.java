package io.github.jaeseongs95.portal.server.assembly;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Duration;

import org.springframework.boot.autoconfigure.EnableAutoConfiguration;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.context.annotation.Import;

import io.github.jaeseongs95.portal.app.artifact.StagingTimes;
import io.github.jaeseongs95.portal.app.target.TargetPlatformRegistry;
import io.github.jaeseongs95.portal.domain.id.Digester;
import io.github.jaeseongs95.portal.domain.target.TargetOs;
import io.github.jaeseongs95.portal.store.artifact.ArtifactLimits;

/**
 * The context of the assembly tests: the real {@link PortalAssembly} (the real storage adapters over the embedded H2 database and real files below a temporary folder, the
 * real use cases) with plain test classes standing where the other modules will stand: the SSH boundary ({@link FakeRemote}, {@link FakeInstaller}), the target platforms,
 * the targets, the registry of agent CLI releases and the intake of uploads. The limits are small numbers a test can reach: a 100,000 byte budget, files of at most 10,000 bytes.
 */
@Configuration(proxyBeanMethods = false)
@EnableAutoConfiguration
@Import({CoreAssembly.class, TargetPlatformRegistry.class})
class AssemblyTestApplication {

    @Bean
    StorageSettings storageSettings() throws IOException {
        Path base = Files.createTempDirectory("portal-assembly");
        return new StorageSettings(base.resolve("artifacts"), base.resolve("outputs"), base.resolve("audit").resolve("audit.jsonl"),
            new ArtifactLimits(100_000L, 10_000L, ArtifactLimits.CHUNK_BYTES, ArtifactLimits.UPLOAD_TTL, 0L), new StagingTimes(Duration.ofMinutes(10), Duration.ofHours(1)));
    }

    @Bean
    FakeRemote remote() {
        return new FakeRemote();
    }

    @Bean
    FakeTargets targets(Digester digester) {
        return new FakeTargets(digester);
    }

    @Bean
    FakePlatform linuxPlatform() {
        return new FakePlatform(TargetOs.LINUX);
    }

    @Bean
    FakePlatform windowsPlatform() {
        return new FakePlatform(TargetOs.WINDOWS);
    }

    @Bean
    FakeAdmission admission() {
        return new FakeAdmission();
    }

    @Bean
    FakeCatalog catalog() {
        return new FakeCatalog();
    }

    @Bean
    FakeInstaller installer(FakeCatalog catalog) {
        return new FakeInstaller(catalog.log);
    }
}
