package io.github.jaeseongs95.portal.app.lifecycle;

import static org.assertj.core.api.Assertions.assertThat;

import java.io.IOException;

import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.springframework.boot.test.context.runner.ApplicationContextRunner;

import io.github.jaeseongs95.portal.app.storage.ProtectionCheck;
import io.github.jaeseongs95.portal.app.storage.ReapFixtures;
import io.github.jaeseongs95.portal.app.storage.StorageArea;
import io.github.jaeseongs95.portal.app.storage.StorageProtection;

/** RC-B-004 / S3-UC-06: the application does not start when the protection of a file store fails, and starts when it holds. */
class StartupProtectionTest {

    @Test
    @DisplayName("S3-UC-06 / RC-B-004: a protection that fails refuses the start, names the folder and keeps the cause")
    void aFailingProtectionRefusesTheStart() {
        ReapFixtures.Protection protection = new ReapFixtures.Protection();
        protection.answer(new ProtectionCheck.Unprotected(StorageArea.OUTPUTS, new IOException("the folder is open to others")));

        new ApplicationContextRunner().withBean(StorageProtection.class, () -> protection).withBean(StartupProtection.class).run(context -> {
            assertThat(context).hasFailed();
            assertThat(context.getStartupFailure()).rootCause().isInstanceOf(IOException.class);
            assertThat(context.getStartupFailure()).hasStackTraceContaining("OUTPUTS");
        });
    }

    @Test
    @DisplayName("S3-UC-06: a protection that holds lets the application start")
    void aHoldingProtectionStarts() {
        new ApplicationContextRunner().withBean(StorageProtection.class, ReapFixtures.Protection::new).withBean(StartupProtection.class)
            .run(context -> assertThat(context).hasNotFailed());
    }
}
