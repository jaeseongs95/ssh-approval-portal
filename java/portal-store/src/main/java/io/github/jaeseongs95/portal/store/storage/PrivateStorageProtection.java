package io.github.jaeseongs95.portal.store.storage;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.LinkOption;
import java.nio.file.Path;

import org.springframework.stereotype.Component;

import io.github.jaeseongs95.portal.app.storage.ProtectionCheck;
import io.github.jaeseongs95.portal.app.storage.StorageArea;
import io.github.jaeseongs95.portal.app.storage.StorageProtection;
import io.github.jaeseongs95.portal.store.StorageRoots;

/**
 * {@link StorageProtection} over {@link PrivateStorages}: the artifact folder and the output folder must be real folders that only their owner can use. A folder that does
 * not exist yet is created private to its owner (the stores do the same on first use); a folder that is a link, is not a folder, is open to others or lies on a file store that
 * offers neither permission bits nor an access control list is the answer {@link ProtectionCheck.Unprotected}, with the cause. Nothing is thrown: a guard that fails is an answer.
 */
@Component
public class PrivateStorageProtection implements StorageProtection {

    private final StorageRoots roots;
    private final PrivateStorages storages;

    public PrivateStorageProtection(StorageRoots roots, PrivateStorages storages) {
        this.roots = roots;
        this.storages = storages;
    }

    @Override
    public ProtectionCheck check() {
        for (StorageArea area : StorageArea.values()) {
            try {
                requireProtected(folderOf(area));
            } catch (IOException | RuntimeException e) {
                return new ProtectionCheck.Unprotected(area, e);
            }
        }
        return new ProtectionCheck.Protected();
    }

    private Path folderOf(StorageArea area) {
        return switch (area) {
            case ARTIFACTS -> roots.artifacts();
            case OUTPUTS -> roots.outputs();
        };
    }

    private void requireProtected(Path folder) throws IOException {
        if (!Files.exists(folder, LinkOption.NOFOLLOW_LINKS)) {
            storages.createFolder(folder);
        }
        storages.requireSafeFolder(folder);
    }
}
