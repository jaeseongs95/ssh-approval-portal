package io.github.jaeseongs95.portal.store.artifact;

import java.io.IOException;
import java.security.SecureRandom;

import org.springframework.boot.test.context.TestConfiguration;
import org.springframework.context.annotation.Bean;

import io.github.jaeseongs95.portal.domain.id.ArtifactIdGenerator;
import io.github.jaeseongs95.portal.domain.id.Digester;
import io.github.jaeseongs95.portal.domain.id.Sha256Digester;
import io.github.jaeseongs95.portal.store.StorageRoots;
import io.github.jaeseongs95.portal.store.TestStorage;
import io.github.jaeseongs95.portal.store.storage.PrivateStorages;

/**
 * The beans an artifact test slice needs besides the adapters under test: a private temporary storage root (removed with the context), the id generator and the
 * digest. In the product these come from portal-app's {@code DomainBeans} and from the server's settings; this module does not depend on them.
 */
@TestConfiguration(proxyBeanMethods = false)
class ArtifactTestStorage {

    @Bean
    TemporaryStorage temporaryStorage() throws IOException {
        return new TemporaryStorage();
    }

    @Bean
    StorageRoots storageRoots(TemporaryStorage storage) {
        return new StorageRoots(storage.folder().resolve("artifacts"), storage.folder().resolve("outputs"));
    }

    @Bean
    PrivateStorages privateStorages() {
        return TestStorage.rules();
    }

    @Bean
    ArtifactIdGenerator artifactIdGenerator() {
        return new ArtifactIdGenerator(new SecureRandom());
    }

    @Bean
    Digester digester() {
        return new Sha256Digester();
    }
}
