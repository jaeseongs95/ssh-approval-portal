package io.github.jaeseongs95.portal.store.output;

import java.io.IOException;
import java.io.UncheckedIOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.security.SecureRandom;
import java.util.Comparator;
import java.util.stream.Stream;

import org.springframework.beans.factory.DisposableBean;
import org.springframework.boot.test.context.TestConfiguration;
import org.springframework.context.annotation.Bean;

import io.github.jaeseongs95.portal.domain.id.Digester;
import io.github.jaeseongs95.portal.domain.id.OperationIdGenerator;
import io.github.jaeseongs95.portal.domain.id.Sha256Digester;
import io.github.jaeseongs95.portal.store.StorageRoots;
import io.github.jaeseongs95.portal.store.TestStorage;
import io.github.jaeseongs95.portal.store.storage.PrivateStorages;

/**
 * The beans that the portal-app configuration ({@link Digester}, the id generator) and the server ({@link StorageRoots}) provide in the product, supplied for a test
 * that wires the output adapters by Spring. The output folder is created for the context and removed when the context closes.
 */
@TestConfiguration(proxyBeanMethods = false)
class OutputWiringBeans {

    @Bean
    StorageRoots storageRoots() throws IOException {
        Path folder = TestStorage.privateFolder(Files.createTempDirectory("portal-output-wiring"));
        return new StorageRoots(folder, folder);
    }

    @Bean
    PrivateStorages privateStorages() {
        return TestStorage.rules();
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
    DisposableBean outputFolderCleanup(StorageRoots roots) {
        return () -> {
            try (Stream<Path> tree = Files.walk(roots.outputs())) {
                tree.sorted(Comparator.reverseOrder()).forEach(path -> {
                    try {
                        Files.delete(path);
                    } catch (IOException e) {
                        throw new UncheckedIOException(e);
                    }
                });
            }
        };
    }
}
