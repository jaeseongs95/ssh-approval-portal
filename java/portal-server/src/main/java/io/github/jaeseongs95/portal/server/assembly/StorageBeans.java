package io.github.jaeseongs95.portal.server.assembly;

import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.util.unit.DataSize;

import io.github.jaeseongs95.portal.app.artifact.StagingTimes;
import io.github.jaeseongs95.portal.app.remote.TransferLimits;
import io.github.jaeseongs95.portal.store.StorageRoots;
import io.github.jaeseongs95.portal.store.artifact.ArtifactLimits;
import io.github.jaeseongs95.portal.store.audit.AuditFileLocation;

/**
 * The value beans that portal-store and portal-app ask for and cannot make themselves (Principles 3.1: they are records of numbers and paths, so the container cannot build
 * them by constructor injection, and this module has no setting of its own): {@link StorageRoots}, {@link ArtifactLimits}, {@link AuditFileLocation} and, derived from the same
 * numbers, {@link TransferLimits} and {@link StagingTimes}. The values come from one {@link StorageSettings}; the output limits are the store's own constants
 * ({@code OutputConfiguration}) until stage 4 binds them.
 *
 * <p>The transfer's largest file is the artifact store's, so a download that reserves the largest file a transfer carries is never refused as "too large" by the store.
 */
@Configuration(proxyBeanMethods = false)
public class StorageBeans {

    private final StorageSettings settings;

    public StorageBeans(StorageSettings settings) {
        this.settings = settings;
    }

    @Bean
    public StorageRoots storageRoots() {
        return new StorageRoots(settings.artifactsFolder(), settings.outputsFolder());
    }

    @Bean
    public ArtifactLimits artifactLimits() {
        return settings.artifactLimits();
    }

    @Bean
    public AuditFileLocation auditFileLocation() {
        return new AuditFileLocation(settings.auditFile());
    }

    @Bean
    public TransferLimits transferLimits() {
        return new TransferLimits(TransferLimits.DEFAULT_DEADLINE, DataSize.ofBytes(settings.artifactLimits().maxFileBytes()));
    }

    @Bean
    public StagingTimes stagingTimes() {
        return settings.stagingTimes();
    }
}
