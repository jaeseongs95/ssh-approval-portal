package io.github.jaeseongs95.portal.store.audit;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.nio.ByteBuffer;
import java.nio.channels.WritableByteChannel;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Clock;
import java.time.Instant;
import java.time.ZoneOffset;
import java.util.List;

import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

import io.github.jaeseongs95.portal.app.audit.AuditAction;
import io.github.jaeseongs95.portal.app.audit.AuditEvent;
import io.github.jaeseongs95.portal.app.audit.AuditFailedException;
import io.github.jaeseongs95.portal.domain.id.OperationId;
import io.github.jaeseongs95.portal.store.TestStorage;
import tools.jackson.databind.json.JsonMapper;

/**
 * RC-A-623 (2.x {@code test/core.test.mjs:48}: the write callback of the audit log) on the {@link AuditFile} seam, plus the file behaviour: the file is created, one JSON
 * line per append. File permissions (2.x created the file with mode 0600) and the startup normalization of the journal are not part of this test; the lead owns them.
 */
class JsonlAuditLogTest {

    private static final Clock CLOCK = Clock.fixed(Instant.parse("2026-11-12T00:00:00Z"), ZoneOffset.UTC);
    private static final OperationId ID = new OperationId("a".repeat(48));

    private final JsonMapper mapper = JsonMapper.builder().build();

    /** The fields of a line as the reader sees them. */
    record Parsed(String at, String action, String id, String note) {
    }

    @Test
    @DisplayName("RC-A-623: a channel that takes 2 bytes at a time still gets the whole line, and the file is forced once")
    void partialWritesAreCompleted() throws IOException {
        ChunkChannel channel = new ChunkChannel(2);
        FakeFile file = new FakeFile(channel);
        JsonlAuditLog log = new JsonlAuditLog(file, CLOCK, mapper);

        log.append(new AuditEvent(AuditAction.SUBMITTED, ID, "audit"));

        String written = channel.text();
        assertThat(written).endsWith("\n");
        assertThat(written.indexOf('\n')).isEqualTo(written.length() - 1);
        assertThat(mapper.readValue(written.strip(), Parsed.class)).isEqualTo(new Parsed("2026-11-12T00:00:00Z", "submitted", ID.value(), "audit"));
        assertThat(file.forced).isEqualTo(1);
    }

    @Test
    @DisplayName("RC-A-623: a channel that takes no byte makes the append fail and the file is not forced")
    void aZeroByteWriteFails() {
        FakeFile file = new FakeFile(new ChunkChannel(0));
        JsonlAuditLog log = new JsonlAuditLog(file, CLOCK, mapper);

        assertThatThrownBy(() -> log.append(new AuditEvent(AuditAction.DENIED, ID, "audit"))).isInstanceOf(AuditFailedException.class);
        assertThat(file.forced).isZero();
    }

    @Test
    @DisplayName("RC-A-623: a write or flush that fails with an I/O error is an AuditFailedException that carries the cause")
    void anIoFailureIsAnAuditFailure() {
        IOException diskFull = new IOException("disk full");
        JsonlAuditLog failingWrite = new JsonlAuditLog(new FakeFile(new FailingChannel(diskFull)), CLOCK, mapper);
        FakeFile failingForce = new FakeFile(new ChunkChannel(64));
        failingForce.forceFailure = diskFull;
        JsonlAuditLog failingFlush = new JsonlAuditLog(failingForce, CLOCK, mapper);

        assertThatThrownBy(() -> failingWrite.append(new AuditEvent(AuditAction.DENIED, ID, "n"))).isInstanceOf(AuditFailedException.class).hasCause(diskFull);
        assertThatThrownBy(() -> failingFlush.append(new AuditEvent(AuditAction.DENIED, ID, "n"))).isInstanceOf(AuditFailedException.class).hasCause(diskFull);
    }

    @Test
    @DisplayName("RC-A-623: the file and its folder are created on the first use, and two appends give two lines in order")
    void twoAppendsGiveTwoLines(@TempDir Path directory) throws IOException {
        Path path = directory.resolve("logs").resolve("audit.jsonl");
        try (JsonlAuditLog log = new JsonlAuditLog(new AuditFileLocation(path), CLOCK, mapper, TestStorage.rules())) {
            assertThat(path).exists();
            log.append(new AuditEvent(AuditAction.SUBMITTED, ID, "first"));
            log.append(new AuditEvent(AuditAction.COMMAND_DECISION, ID, "second"));
        }

        List<String> lines = Files.readAllLines(path, StandardCharsets.UTF_8);

        assertThat(lines).hasSize(2);
        assertThat(mapper.readValue(lines.get(0), Parsed.class)).isEqualTo(new Parsed("2026-11-12T00:00:00Z", "submitted", ID.value(), "first"));
        assertThat(mapper.readValue(lines.get(1), Parsed.class)).isEqualTo(new Parsed("2026-11-12T00:00:00Z", "command-decision", ID.value(), "second"));
    }

    @Test
    @DisplayName("RC-A-623: an existing file is appended to, and a note with a line break, a quote and Korean text stays on one line and reads back unchanged")
    void anExistingFileIsAppendedAndANoteStaysOnOneLine(@TempDir Path directory) throws IOException {
        // The audit file must be private to its owner, so the folder that the earlier file is written in is made private first (the product's own folders are).
        Path path = TestStorage.privateFolder(directory).resolve("audit.jsonl");
        Files.writeString(path, "{\"kept\":true}\n", StandardCharsets.UTF_8);
        String note = "line one\nline \"two\" 승인";
        try (JsonlAuditLog log = new JsonlAuditLog(new AuditFileLocation(path), CLOCK, mapper, TestStorage.rules())) {
            log.append(new AuditEvent(AuditAction.MAINTENANCE_RELEASED, ID, note));
        }

        List<String> lines = Files.readAllLines(path, StandardCharsets.UTF_8);

        assertThat(lines).hasSize(2);
        assertThat(lines.get(0)).isEqualTo("{\"kept\":true}");
        assertThat(mapper.readValue(lines.get(1), Parsed.class)).isEqualTo(new Parsed("2026-11-12T00:00:00Z", "maintenance-released", ID.value(), note));
    }

    /** Takes at most {@code chunk} bytes per write (0 takes none) and keeps what it took. */
    private static final class ChunkChannel implements WritableByteChannel {

        private final ByteArrayOutputStream sink = new ByteArrayOutputStream();
        private final int chunk;

        ChunkChannel(int chunk) {
            this.chunk = chunk;
        }

        @Override
        public int write(ByteBuffer source) {
            int taken = Math.min(chunk, source.remaining());
            byte[] part = new byte[taken];
            source.get(part);
            sink.write(part, 0, taken);
            return taken;
        }

        String text() {
            return sink.toString(StandardCharsets.UTF_8);
        }

        @Override
        public boolean isOpen() {
            return true;
        }

        @Override
        public void close() {
            // Nothing to release: the sink is in memory.
        }
    }

    /** A channel whose write fails. */
    private static final class FailingChannel implements WritableByteChannel {

        private final IOException failure;

        FailingChannel(IOException failure) {
            this.failure = failure;
        }

        @Override
        public int write(ByteBuffer source) throws IOException {
            throw failure;
        }

        @Override
        public boolean isOpen() {
            return true;
        }

        @Override
        public void close() {
            // Nothing to release.
        }
    }

    /** An {@link AuditFile} over a given channel that counts the flushes. */
    private static final class FakeFile implements AuditFile {

        private final WritableByteChannel channel;
        private int forced;
        private IOException forceFailure;

        FakeFile(WritableByteChannel channel) {
            this.channel = channel;
        }

        @Override
        public WritableByteChannel channel() {
            return channel;
        }

        @Override
        public void force() throws IOException {
            if (forceFailure != null) {
                throw forceFailure;
            }
            forced++;
        }

        @Override
        public void close() {
            // Nothing to release.
        }
    }
}
