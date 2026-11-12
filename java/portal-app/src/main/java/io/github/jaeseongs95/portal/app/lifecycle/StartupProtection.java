package io.github.jaeseongs95.portal.app.lifecycle;

import org.springframework.beans.factory.SmartInitializingSingleton;
import org.springframework.stereotype.Component;

import io.github.jaeseongs95.portal.app.storage.ProtectionCheck;
import io.github.jaeseongs95.portal.app.storage.StorageProtection;

/**
 * Refuses to start the application when the guard of the file stores fails (case RC-B-004). 2.x opened its output store and the maintenance state in the constructor of the
 * application and let a damaged guard fail the whole start, with the expired output bytes untouched; here the check runs once every singleton exists and before the context
 * is started, so a failure stops the start and no scheduled reaper ever runs. The reapers check the same guard before each run as well ({@code ReapGate}), so a folder whose
 * protection is lost <em>after</em> the start also keeps its bytes.
 *
 * <p>It implements {@link SmartInitializingSingleton} ({@code spring-beans}) and not Boot's {@code ApplicationRunner}: portal-app depends on Spring Framework only, and the
 * failure has to be in the refresh of the context to be a refused start.
 */
@Component
public class StartupProtection implements SmartInitializingSingleton {

    private final StorageProtection protection;

    public StartupProtection(StorageProtection protection) {
        this.protection = protection;
    }

    @Override
    public void afterSingletonsInstantiated() {
        verify();
    }

    /** Throws {@link IllegalStateException} naming the folder and carrying the cause when a folder is not protected. */
    public void verify() {
        if (protection.check() instanceof ProtectionCheck.Unprotected unprotected) {
            throw new IllegalStateException("The " + unprotected.area() + " folder is not protected; the application does not start and deletes nothing", unprotected.cause());
        }
    }
}
