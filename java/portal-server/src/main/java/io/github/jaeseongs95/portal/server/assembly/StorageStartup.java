package io.github.jaeseongs95.portal.server.assembly;

import java.time.Clock;

import org.springframework.beans.factory.SmartInitializingSingleton;
import org.springframework.stereotype.Component;

import io.github.jaeseongs95.portal.app.lifecycle.StartupProtection;
import io.github.jaeseongs95.portal.app.maintenance.MaintenanceStore;
import io.github.jaeseongs95.portal.store.artifact.ArtifactStartupCheck;
import io.github.jaeseongs95.portal.store.output.OutputStartupCheck;

/**
 * Reconciles the file stores with their metadata once, at the start (design 8.5): payload files without a row go to quarantine, a byte tail that was never acknowledged is cut
 * off, a deletion that was begun is finished, an output that was pending is given up. It lives in the server because the checks belong to portal-store and the guard to
 * portal-app; only the assembly holds both.
 *
 * <p>The guard comes first: when the protection of a store fails, {@link StartupProtection#verify()} stops the start before a file is read (RC-B-004). While a maintenance
 * reservation holds the installation (it is stored, so it survives a restart) the expired outputs are not deleted either: only the recovery that deletes nothing runs
 * (RC-A-173).
 */
@Component
public class StorageStartup implements SmartInitializingSingleton {

    private final StartupProtection protection;
    private final MaintenanceStore maintenance;
    private final ArtifactStartupCheck artifacts;
    private final OutputStartupCheck outputs;
    private final Clock clock;

    public StorageStartup(StartupProtection protection, MaintenanceStore maintenance, ArtifactStartupCheck artifacts, OutputStartupCheck outputs, Clock clock) {
        this.protection = protection;
        this.maintenance = maintenance;
        this.artifacts = artifacts;
        this.outputs = outputs;
        this.clock = clock;
    }

    @Override
    public void afterSingletonsInstantiated() {
        protection.verify();
        artifacts.reconcile();
        if (maintenance.occupied()) {
            outputs.recover(clock.instant());
        } else {
            outputs.reconcile(clock.instant());
        }
    }
}
