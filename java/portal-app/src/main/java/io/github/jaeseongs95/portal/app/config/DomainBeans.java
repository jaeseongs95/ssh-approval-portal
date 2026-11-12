package io.github.jaeseongs95.portal.app.config;

import java.security.SecureRandom;
import java.time.Clock;

import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;

import io.github.jaeseongs95.portal.domain.approval.MaintenancePolicy;
import io.github.jaeseongs95.portal.domain.classify.CommandClassifier;
import io.github.jaeseongs95.portal.domain.classify.VendorCommandClassifier;
import io.github.jaeseongs95.portal.domain.id.ArtifactIdGenerator;
import io.github.jaeseongs95.portal.domain.id.ArtifactUuidGenerator;
import io.github.jaeseongs95.portal.domain.id.Digester;
import io.github.jaeseongs95.portal.domain.id.OperationIdGenerator;
import io.github.jaeseongs95.portal.domain.id.Sha256Digester;
import io.github.jaeseongs95.portal.domain.redact.OutputRedactor;
import io.github.jaeseongs95.portal.domain.redact.VendorOutputRedactor;
import io.github.jaeseongs95.portal.domain.schedule.OperationScheduler;

/**
 * The helper beans every other bean shares: one {@link Clock}, one {@link SecureRandom}, one {@link Digester} (Principles 3.7, 4.5).
 *
 * <p>Why {@code @Bean} methods and not {@code @Component} (Principles 3.1): {@link Clock} and {@link SecureRandom} are JDK classes that take no annotation, and the
 * classes of portal-domain ({@link Sha256Digester}, the id generators) may not carry a Spring annotation because rule A-DOMAIN lets the domain depend on the JDK and
 * the Jackson annotations only. This configuration is therefore the one place that turns those plain objects into beans. A test replaces {@link Clock} by
 * {@code Clock.fixed} or {@code Clock.offset} (no {@code @Primary} here, so a test configuration can override the bean by name).
 */
@Configuration(proxyBeanMethods = false)
public class DomainBeans {

    /** The one clock; UTC, never the system default zone (rule A-TIME). */
    @Bean
    public Clock clock() {
        return Clock.systemUTC();
    }

    /** One instance for the whole application; it is created once, not per call. */
    @Bean
    public SecureRandom secureRandom() {
        return new SecureRandom();
    }

    /** SHA-256 over bytes; the implementation creates a new {@code MessageDigest} per call, so the bean is thread safe. */
    @Bean
    public Digester digester() {
        return new Sha256Digester();
    }

    @Bean
    public OperationIdGenerator operationIdGenerator(SecureRandom random) {
        return new OperationIdGenerator(random);
    }

    @Bean
    public ArtifactIdGenerator artifactIdGenerator(SecureRandom random) {
        return new ArtifactIdGenerator(random);
    }

    @Bean
    public ArtifactUuidGenerator artifactUuidGenerator(SecureRandom random) {
        return new ArtifactUuidGenerator(random);
    }

    /**
     * The command classifier of the vendor rules (stage 3 design 1.3, S2 carry-over). {@code VendorCommandClassifier} is a plain class of portal-domain without a Spring
     * annotation (rule A-DOMAIN), so it is made a bean here, under the interface the consumers depend on. It holds no state and is safe to share.
     */
    @Bean
    public CommandClassifier commandClassifier() {
        return new VendorCommandClassifier();
    }

    /**
     * The output redactor with the vendor secret patterns and the entropy scan of 2.x (threshold 4.5). A plain class of portal-domain, so a bean here for the reason of
     * {@link #commandClassifier()}. It holds no state and is safe to share.
     */
    @Bean
    public OutputRedactor outputRedactor() {
        return new VendorOutputRedactor();
    }

    /** The scheduler's judgements are pure functions of a view; one instance serves every use case. A plain class of portal-domain, so a bean here. */
    @Bean
    public OperationScheduler operationScheduler() {
        return new OperationScheduler();
    }

    /** The maintenance rules, pure judgements. A plain class of portal-domain, so a bean here. */
    @Bean
    public MaintenancePolicy maintenancePolicy() {
        return new MaintenancePolicy();
    }

    /** The JVM's processor count; the interface lets a test answer another one. */
    @Bean
    public AvailableCpus availableCpus() {
        return () -> Runtime.getRuntime().availableProcessors();
    }
}
