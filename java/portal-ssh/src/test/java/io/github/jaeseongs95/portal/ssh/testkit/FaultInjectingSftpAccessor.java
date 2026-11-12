package io.github.jaeseongs95.portal.ssh.testkit;

import java.io.IOException;
import java.nio.ByteBuffer;
import java.nio.channels.SeekableByteChannel;
import java.nio.file.AccessDeniedException;
import java.nio.file.CopyOption;
import java.nio.file.OpenOption;
import java.nio.file.Path;
import java.nio.file.StandardOpenOption;
import java.nio.file.attribute.FileAttribute;
import java.util.Collection;
import java.util.List;
import java.util.Optional;
import java.util.Set;
import java.util.concurrent.CopyOnWriteArrayList;
import java.util.concurrent.atomic.AtomicInteger;
import org.apache.sshd.sftp.common.SftpConstants;
import org.apache.sshd.sftp.common.SftpException;
import org.apache.sshd.sftp.server.FileHandle;
import org.apache.sshd.sftp.server.SftpFileSystemAccessor;
import org.apache.sshd.sftp.server.SftpSubsystemProxy;

/**
 * The file system accessor of the test server's SFTP subsystem (MINA's extension point for file access, {@link SftpFileSystemAccessor}): it delegates to the default
 * behaviour and fails the operations that a {@link SftpFault} names.
 */
final class FaultInjectingSftpAccessor implements SftpFileSystemAccessor {

    private static final class ArmedFault {
        private final SftpFault fault;
        private final AtomicInteger remaining;

        ArmedFault(SftpFault fault) {
            this.fault = fault;
            this.remaining = new AtomicInteger(fault.times());
        }

        /** Takes one of the remaining matches; false when none is left. {@link Integer#MAX_VALUE} never runs out. */
        boolean consume() {
            return remaining.getAndUpdate(count -> count == Integer.MAX_VALUE ? count : Math.max(0, count - 1)) > 0;
        }
    }

    private final List<ArmedFault> faults = new CopyOnWriteArrayList<>();

    void add(SftpFault fault) {
        faults.add(new ArmedFault(fault));
    }

    void clear() {
        faults.clear();
    }

    @Override
    public SeekableByteChannel openFile(SftpSubsystemProxy sftpSubsystem, FileHandle fileHandle, Path file, String handle, Set<? extends OpenOption> options,
        FileAttribute<?>... attrs) throws IOException {
        boolean writing = options.contains(StandardOpenOption.WRITE) || options.contains(StandardOpenOption.APPEND);
        Optional<SftpFault> fault = take(writing ? SftpFault.Operation.OPEN_FOR_WRITE : SftpFault.Operation.OPEN_FOR_READ, file);
        if (fault.isPresent() && fault.get().afterBytes() == 0) {
            throw failure(fault.get(), file, sftpSubsystem);
        }
        SeekableByteChannel channel = SftpFileSystemAccessor.super.openFile(sftpSubsystem, fileHandle, file, handle, options, attrs);
        return fault.isPresent() ? new FaultyChannel(channel, fault.get(), file, sftpSubsystem) : channel;
    }

    @Override
    public void renameFile(SftpSubsystemProxy sftpSubsystem, Path oldPath, Path newPath, Collection<CopyOption> opts) throws IOException {
        Optional<SftpFault> fault = take(SftpFault.Operation.RENAME, oldPath, newPath);
        if (fault.isPresent()) {
            throw failure(fault.get(), oldPath, sftpSubsystem);
        }
        SftpFileSystemAccessor.super.renameFile(sftpSubsystem, oldPath, newPath, opts);
    }

    @Override
    public void removeFile(SftpSubsystemProxy sftpSubsystem, Path path, boolean isDirectory) throws IOException {
        Optional<SftpFault> fault = take(SftpFault.Operation.REMOVE, path);
        if (fault.isPresent()) {
            throw failure(fault.get(), path, sftpSubsystem);
        }
        SftpFileSystemAccessor.super.removeFile(sftpSubsystem, path, isDirectory);
    }

    @Override
    public void createDirectory(SftpSubsystemProxy sftpSubsystem, Path path) throws IOException {
        Optional<SftpFault> fault = take(SftpFault.Operation.MKDIR, path);
        if (fault.isPresent()) {
            throw failure(fault.get(), path, sftpSubsystem);
        }
        SftpFileSystemAccessor.super.createDirectory(sftpSubsystem, path);
    }

    private Optional<SftpFault> take(SftpFault.Operation operation, Path... paths) {
        for (ArmedFault armed : faults) {
            if (armed.fault.operation() == operation && touches(armed.fault, paths) && armed.consume()) {
                return Optional.of(armed.fault);
            }
        }
        return Optional.empty();
    }

    private boolean touches(SftpFault fault, Path... paths) {
        for (Path path : paths) {
            if (path.toString().replace('\\', '/').endsWith(fault.pathSuffix())) {
                return true;
            }
        }
        return false;
    }

    private IOException failure(SftpFault fault, Path path, SftpSubsystemProxy sftpSubsystem) {
        return switch (fault.failure()) {
            case PERMISSION_DENIED -> new AccessDeniedException(path.toString(), null, "injected: permission denied");
            case NO_SPACE -> new SftpException(SftpConstants.SSH_FX_NO_SPACE_ON_FILESYSTEM, "injected: no space left on device");
            case IO_ERROR -> new IOException("injected: I/O error");
            case CONNECTION_DROPPED -> {
                sftpSubsystem.getSession().close(true);
                yield new IOException("injected: connection dropped");
            }
        };
    }

    /** A channel that works until {@code fault.afterBytes()} bytes have moved, then fails every call. */
    private final class FaultyChannel implements SeekableByteChannel {
        private final SeekableByteChannel delegate;
        private final SftpFault fault;
        private final Path path;
        private final SftpSubsystemProxy sftpSubsystem;
        private long transferred;

        FaultyChannel(SeekableByteChannel delegate, SftpFault fault, Path path, SftpSubsystemProxy sftpSubsystem) {
            this.delegate = delegate;
            this.fault = fault;
            this.path = path;
            this.sftpSubsystem = sftpSubsystem;
        }

        private void checkBudget() throws IOException {
            if (transferred >= fault.afterBytes()) {
                throw failure(fault, path, sftpSubsystem);
            }
        }

        @Override
        public int read(ByteBuffer destination) throws IOException {
            checkBudget();
            int count = delegate.read(destination);
            if (count > 0) {
                transferred += count;
            }
            return count;
        }

        @Override
        public int write(ByteBuffer source) throws IOException {
            checkBudget();
            int count = delegate.write(source);
            transferred += count;
            return count;
        }

        @Override
        public long position() throws IOException {
            return delegate.position();
        }

        @Override
        public SeekableByteChannel position(long newPosition) throws IOException {
            delegate.position(newPosition);
            return this;
        }

        @Override
        public long size() throws IOException {
            return delegate.size();
        }

        @Override
        public SeekableByteChannel truncate(long size) throws IOException {
            delegate.truncate(size);
            return this;
        }

        @Override
        public boolean isOpen() {
            return delegate.isOpen();
        }

        @Override
        public void close() throws IOException {
            delegate.close();
        }
    }
}
