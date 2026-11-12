package io.github.jaeseongs95.portal.store.artifact;

import java.io.IOException;
import java.nio.ByteBuffer;
import java.nio.channels.FileChannel;
import java.nio.channels.FileLock;
import java.nio.channels.OverlappingFileLockException;
import java.nio.file.DirectoryStream;
import java.nio.file.Files;
import java.nio.file.LinkOption;
import java.nio.file.OpenOption;
import java.nio.file.Path;
import java.nio.file.StandardCopyOption;
import java.nio.file.StandardOpenOption;
import java.util.HashSet;
import java.util.Set;
import java.util.regex.Pattern;

import org.springframework.stereotype.Component;

import io.github.jaeseongs95.portal.app.artifact.ArtifactPayloadStore;
import io.github.jaeseongs95.portal.app.artifact.ChunkDigest;
import io.github.jaeseongs95.portal.app.storage.DiskSpace;
import io.github.jaeseongs95.portal.app.storage.PayloadRead;
import io.github.jaeseongs95.portal.app.storage.PayloadWrite;
import io.github.jaeseongs95.portal.domain.contract.ArtifactErrorCode;
import io.github.jaeseongs95.portal.domain.contract.RequestRefusedException;
import io.github.jaeseongs95.portal.domain.id.ArtifactId;
import io.github.jaeseongs95.portal.store.StorageRoots;
import io.github.jaeseongs95.portal.store.storage.PrivateStorages;
import io.github.jaeseongs95.portal.store.storage.UnsafeStorageException;

/**
 * {@link ArtifactPayloadStore} over one folder, {@code StorageRoots#artifacts()}: the bytes of an artifact are the file {@code <id>.part} (2.x
 * {@code artifacts.mjs:84-149}; design 8.5, a 64 MiB body is not put in a BLOB). Every method does file I/O, so it is called outside a transaction (Principles 4.4).
 *
 * <p>Safety rules of 2.x, kept and now applied on every kind of file store: the folder and the files are private to the owner, and a symbolic link or a file that
 * is not a regular file is refused. How "private" is made and checked belongs to {@link PrivateStorages}, which picks the rule by what the file store offers (permission
 * bits, or an access control list on an NTFS volume) and refuses a file store with neither; this class holds no copy of that rule. A refusal is
 * {@code ARTIFACT_STORAGE_UNSAFE}; a link is never followed or removed.
 *
 * <p>An append writes at the current end, takes a lock on the file so that two writers of one artifact cannot interleave, and calls
 * {@code FileChannel#force(true)} before it returns: the use case commits the metadata only after that (design 8.5). Not done: the directory entry of a new file is
 * not forced separately (the JDK has no portable call for it); a crash that loses the entry loses a file whose metadata then says "more bytes than the file", which
 * the start-up check refuses to start with.
 */
@Component
public class FileArtifactPayloadStore implements ArtifactPayloadStore {

    private static final String SUFFIX = ".part";
    private static final Pattern STORED_NAME = Pattern.compile("[a-f0-9]{48}\\.part");
    private static final String QUARANTINE_FOLDER = "orphans";

    private final Path root;
    private final PrivateStorages storages;

    public FileArtifactPayloadStore(StorageRoots roots, PrivateStorages storages) {
        this.root = roots.artifacts();
        this.storages = storages;
    }

    @Override
    public PayloadWrite append(ArtifactId id, long offset, byte[] data) {
        if (data.length < 1 || data.length > ChunkDigest.MAX_CHUNK_BYTES) {
            throw new RequestRefusedException(ArtifactErrorCode.ARTIFACT_INVALID_CHUNK);
        }
        if (offset < 0) {
            throw new RequestRefusedException(ArtifactErrorCode.ARTIFACT_SEQUENCE_OR_SIZE);
        }
        Path folder = preparedRoot();
        Path file = fileOf(folder, id);
        try {
            boolean exists = Files.exists(file, LinkOption.NOFOLLOW_LINKS);
            if (exists) {
                storages.requireSafeFile(file);
            } else if (offset != 0) {
                // A file is created by its first chunk only; creating it for a later one would leave an empty file behind a refusal.
                throw new RequestRefusedException(ArtifactErrorCode.ARTIFACT_CHUNK_CONFLICT);
            }
            try (FileChannel channel = openForWrite(file, !exists); FileLock lock = channel.tryLock()) {
                if (lock == null) {
                    throw new RequestRefusedException(ArtifactErrorCode.ARTIFACT_BUSY);
                }
                if (channel.size() != offset) {
                    throw new RequestRefusedException(ArtifactErrorCode.ARTIFACT_CHUNK_CONFLICT);
                }
                ByteBuffer buffer = ByteBuffer.wrap(data);
                channel.position(offset);
                while (buffer.hasRemaining()) {
                    channel.write(buffer);
                }
                channel.force(true);
                return new PayloadWrite(channel.size());
            }
        } catch (OverlappingFileLockException e) {
            throw new RequestRefusedException(ArtifactErrorCode.ARTIFACT_BUSY, e);
        } catch (UnsafeStorageException e) {
            throw unsafe(e);
        } catch (IOException e) {
            throw ioFailure(e);
        }
    }

    @Override
    public void truncate(ArtifactId id, long length) {
        if (length < 0) {
            throw new RequestRefusedException(ArtifactErrorCode.ARTIFACT_SEQUENCE_OR_SIZE);
        }
        Path file = existingFile(id);
        try (FileChannel channel = FileChannel.open(file, StandardOpenOption.WRITE, LinkOption.NOFOLLOW_LINKS); FileLock lock = channel.tryLock()) {
            if (lock == null) {
                throw new RequestRefusedException(ArtifactErrorCode.ARTIFACT_BUSY);
            }
            if (length > channel.size()) {
                throw new RequestRefusedException(ArtifactErrorCode.ARTIFACT_SEQUENCE_OR_SIZE);
            }
            channel.truncate(length);
            channel.force(true);
        } catch (OverlappingFileLockException e) {
            throw new RequestRefusedException(ArtifactErrorCode.ARTIFACT_BUSY, e);
        } catch (IOException e) {
            throw ioFailure(e);
        }
    }

    @Override
    public long length(ArtifactId id) {
        Path file = existingFile(id);
        try {
            return Files.size(file);
        } catch (IOException e) {
            throw ioFailure(e);
        }
    }

    @Override
    public PayloadRead open(ArtifactId id) {
        Path file = existingFile(id);
        try {
            FileChannel channel = FileChannel.open(file, StandardOpenOption.READ, LinkOption.NOFOLLOW_LINKS);
            try {
                return new PayloadRead(channel, channel.size());
            } catch (IOException | RuntimeException e) {
                try {
                    channel.close();
                } catch (IOException closing) {
                    e.addSuppressed(closing);
                }
                throw e;
            }
        } catch (IOException e) {
            throw ioFailure(e);
        }
    }

    /** Deletes the file; a file that is not there is already deleted. A symbolic link is removed as a link, its target is not touched. */
    @Override
    public void delete(ArtifactId id) {
        Path file = fileOf(preparedRoot(), id);
        try {
            Files.deleteIfExists(file);
        } catch (IOException e) {
            throw ioFailure(e);
        }
    }

    /** Moves the file to {@code orphans/} next to the payloads and keeps every byte; nothing in the store deletes that folder's files. */
    @Override
    public void quarantine(ArtifactId id) {
        Path folder = preparedRoot();
        Path file = fileOf(folder, id);
        try {
            if (!Files.exists(file, LinkOption.NOFOLLOW_LINKS)) {
                throw new RequestRefusedException(ArtifactErrorCode.ARTIFACT_NOT_FOUND);
            }
            Path quarantine = folder.resolve(QUARANTINE_FOLDER);
            storages.createFolder(quarantine);
            Files.move(file, freeName(quarantine, id), StandardCopyOption.ATOMIC_MOVE);
        } catch (UnsafeStorageException e) {
            throw unsafe(e);
        } catch (IOException e) {
            throw ioFailure(e);
        }
    }

    @Override
    public Set<ArtifactId> stored() {
        Path folder = preparedRoot();
        Set<ArtifactId> found = new HashSet<>();
        try (DirectoryStream<Path> entries = Files.newDirectoryStream(folder, "*" + SUFFIX)) {
            for (Path entry : entries) {
                String name = entry.getFileName().toString();
                if (STORED_NAME.matcher(name).matches()) {
                    storages.requireSafeFile(entry);
                    found.add(new ArtifactId(name.substring(0, name.length() - SUFFIX.length())));
                }
            }
        } catch (UnsafeStorageException e) {
            throw unsafe(e);
        } catch (IOException e) {
            throw ioFailure(e);
        }
        return Set.copyOf(found);
    }

    @Override
    public DiskSpace usable() {
        Path folder = preparedRoot();
        try {
            return new DiskSpace(Files.getFileStore(folder).getUsableSpace());
        } catch (IOException e) {
            throw ioFailure(e);
        }
    }

    /** The root folder, created private when it is not there; a link, a plain file or a folder that others can use is refused, on every kind of file store. */
    private Path preparedRoot() {
        try {
            if (!Files.exists(root, LinkOption.NOFOLLOW_LINKS)) {
                storages.createFolder(root);
            }
            storages.requireSafeFolder(root);
            return root;
        } catch (UnsafeStorageException e) {
            throw unsafe(e);
        } catch (IOException e) {
            throw ioFailure(e);
        }
    }

    private Path existingFile(ArtifactId id) {
        Path file = fileOf(preparedRoot(), id);
        if (!Files.exists(file, LinkOption.NOFOLLOW_LINKS)) {
            throw new RequestRefusedException(ArtifactErrorCode.ARTIFACT_NOT_FOUND);
        }
        try {
            storages.requireSafeFile(file);
        } catch (UnsafeStorageException e) {
            throw unsafe(e);
        } catch (IOException e) {
            throw ioFailure(e);
        }
        return file;
    }

    private Path fileOf(Path folder, ArtifactId id) {
        // An ArtifactId is 48 lowercase hex characters, so the name cannot leave the folder.
        return folder.resolve(id.value() + SUFFIX);
    }

    private Path freeName(Path folder, ArtifactId id) {
        Path candidate = folder.resolve(id.value() + SUFFIX);
        for (int attempt = 1; Files.exists(candidate, LinkOption.NOFOLLOW_LINKS); attempt++) {
            candidate = folder.resolve(id.value() + "." + attempt + SUFFIX);
        }
        return candidate;
    }

    private FileChannel openForWrite(Path file, boolean create) throws IOException {
        Set<OpenOption> options = create ? Set.of(StandardOpenOption.CREATE_NEW, StandardOpenOption.WRITE, LinkOption.NOFOLLOW_LINKS)
            : Set.of(StandardOpenOption.WRITE, LinkOption.NOFOLLOW_LINKS);
        return storages.open(file, options);
    }

    private RequestRefusedException unsafe(UnsafeStorageException cause) {
        return new RequestRefusedException(ArtifactErrorCode.ARTIFACT_STORAGE_UNSAFE, cause);
    }

    private RequestRefusedException ioFailure(IOException cause) {
        return new RequestRefusedException(ArtifactErrorCode.ARTIFACT_STORAGE_IO_ERROR, cause);
    }
}
