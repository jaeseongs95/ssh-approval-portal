package io.github.jaeseongs95.portal.store.journal;

import java.security.SecureRandom;
import java.time.Clock;
import java.time.Instant;
import java.time.ZoneOffset;

import org.springframework.boot.test.context.TestConfiguration;
import org.springframework.context.annotation.Bean;

import io.github.jaeseongs95.portal.domain.id.Digester;
import io.github.jaeseongs95.portal.domain.id.OperationIdGenerator;
import io.github.jaeseongs95.portal.domain.id.Sha256Digester;
import tools.jackson.databind.json.JsonMapper;

/** The helper beans the journal adapters need, with a fixed {@link Clock} so that every time in a test is a value the test chose. */
@TestConfiguration(proxyBeanMethods = false)
class JournalTestBeans {

    static final Instant NOW = Instant.parse("2026-11-12T00:00:00Z");

    @Bean
    Clock clock() {
        return Clock.fixed(NOW, ZoneOffset.UTC);
    }

    @Bean
    Digester digester() {
        return new Sha256Digester();
    }

    @Bean
    OperationIdGenerator operationIdGenerator() {
        return new OperationIdGenerator(new SecureRandom());
    }

    @Bean
    JsonMapper jsonMapper() {
        return JsonMapper.builder().build();
    }
}
