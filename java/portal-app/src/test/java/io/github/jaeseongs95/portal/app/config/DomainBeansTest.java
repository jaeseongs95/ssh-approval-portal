package io.github.jaeseongs95.portal.app.config;

import static org.assertj.core.api.Assertions.assertThat;

import java.security.SecureRandom;
import java.time.Clock;
import java.time.Instant;
import java.time.ZoneOffset;

import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.springframework.boot.test.context.runner.ApplicationContextRunner;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;

import io.github.jaeseongs95.portal.domain.approval.MaintenancePolicy;
import io.github.jaeseongs95.portal.domain.classify.CommandClass;
import io.github.jaeseongs95.portal.domain.classify.CommandClassifier;
import io.github.jaeseongs95.portal.domain.id.ArtifactIdGenerator;
import io.github.jaeseongs95.portal.domain.id.ArtifactUuidGenerator;
import io.github.jaeseongs95.portal.domain.id.Digester;
import io.github.jaeseongs95.portal.domain.id.OperationIdGenerator;
import io.github.jaeseongs95.portal.domain.redact.OutputRedactor;
import io.github.jaeseongs95.portal.domain.schedule.OperationScheduler;
import io.github.jaeseongs95.portal.domain.text.CommandText;

class DomainBeansTest {

    private final ApplicationContextRunner runner = new ApplicationContextRunner().withUserConfiguration(DomainBeans.class);

    @Test
    @DisplayName("S2-AP-01: DomainBeans gives exactly one Clock, one SecureRandom and one Digester, and the Clock is UTC")
    void oneOfEachAndTheClockIsUtc() {
        runner.run(context -> {
            assertThat(context).hasNotFailed();
            assertThat(context).hasSingleBean(Clock.class);
            assertThat(context).hasSingleBean(SecureRandom.class);
            assertThat(context).hasSingleBean(Digester.class);
            assertThat(context).hasSingleBean(OperationIdGenerator.class);
            assertThat(context).hasSingleBean(ArtifactIdGenerator.class);
            assertThat(context).hasSingleBean(ArtifactUuidGenerator.class);
            assertThat(context).hasSingleBean(AvailableCpus.class);
            assertThat(context.getBean(Clock.class).getZone()).isEqualTo(ZoneOffset.UTC);
        });
    }

    @Test
    @DisplayName("S2-AP-01: the AvailableCpus bean answers at least one processor")
    void availableCpusIsPositive() {
        runner.run(context -> assertThat(context.getBean(AvailableCpus.class).count()).isGreaterThanOrEqualTo(1));
    }

    @Test
    @DisplayName("S2-AP-01: a test configuration replaces the Clock by a fixed one and the context still has a single Clock")
    void aTestConfigurationCanReplaceTheClock() {
        Instant fixed = Instant.parse("2026-11-12T00:00:00Z");
        runner.withUserConfiguration(FixedClock.class).withAllowBeanDefinitionOverriding(true).run(context -> {
            assertThat(context).hasSingleBean(Clock.class);
            assertThat(context.getBean(Clock.class).instant()).isEqualTo(fixed);
        });
    }

    @Test
    @DisplayName("S3-UC-03: DomainBeans gives one CommandClassifier, one OutputRedactor, one OperationScheduler and one MaintenancePolicy, and they work")
    void theClassifierTheRedactorAndThePoliciesAreBeans() {
        runner.run(context -> {
            assertThat(context).hasNotFailed();
            assertThat(context).hasSingleBean(CommandClassifier.class);
            assertThat(context).hasSingleBean(OutputRedactor.class);
            assertThat(context).hasSingleBean(OperationScheduler.class);
            assertThat(context).hasSingleBean(MaintenancePolicy.class);
            assertThat(context.getBean(CommandClassifier.class).classify(new CommandText("cat /tmp/a")).commandClass()).isEqualTo(CommandClass.READ_ONLY);
            assertThat(context.getBean(OutputRedactor.class).redact("key AKIAABCDEFGHIJKLMNOP end").value()).doesNotContain("AKIAABCDEFGHIJKLMNOP");
        });
    }

    @Configuration(proxyBeanMethods = false)
    static class FixedClock {

        @Bean
        Clock clock() {
            return Clock.fixed(Instant.parse("2026-11-12T00:00:00Z"), ZoneOffset.UTC);
        }
    }
}
