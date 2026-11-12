package io.github.jaeseongs95.portal.store.artifact;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;

import org.springframework.beans.factory.DisposableBean;
import org.springframework.util.FileSystemUtils;

/** A private temporary folder that lives as long as the test context and is removed with it. */
final class TemporaryStorage implements DisposableBean {

    private final Path folder;

    TemporaryStorage() throws IOException {
        this.folder = Files.createTempDirectory("portal-artifacts-");
    }

    Path folder() {
        return folder;
    }

    @Override
    public void destroy() throws IOException {
        FileSystemUtils.deleteRecursively(folder);
    }
}
