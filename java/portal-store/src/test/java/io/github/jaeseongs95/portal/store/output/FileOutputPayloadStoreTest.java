package io.github.jaeseongs95.portal.store.output;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import java.io.IOException;
import java.nio.ByteBuffer;
import java.nio.channels.Channels;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.attribute.PosixFilePermissions;
import java.time.Duration;
import java.util.List;

import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

import io.github.jaeseongs95.portal.app.output.FormatSpan;
import io.github.jaeseongs95.portal.app.output.OutputFormat;
import io.github.jaeseongs95.portal.app.output.OutputFormats;
import io.github.jaeseongs95.portal.app.output.OutputId;
import io.github.jaeseongs95.portal.app.output.StreamFrame;
import io.github.jaeseongs95.portal.app.output.StreamKind;
import io.github.jaeseongs95.portal.app.storage.PayloadRead;
import io.github.jaeseongs95.portal.domain.contract.ExecutionErrorCode;
import io.github.jaeseongs95.portal.domain.contract.RequestRefusedException;
import io.github.jaeseongs95.portal.domain.id.Digest;
import io.github.jaeseongs95.portal.domain.id.Sha256Digester;
import io.github.jaeseongs95.portal.store.StorageRoots;
import io.github.jaeseongs95.portal.store.TestStorage;

/** The file part of the output store on a temporary folder; no Spring and no database. */
class FileOutputPayloadStoreTest {

    private static final byte[] E2_82 = {(byte) 0xe2, (byte) 0x82};
    private static final byte[] AC_FF_00 = {(byte) 0xac, (byte) 0xff, 0};

    private FileOutputPayloadStore store(Path folder, long maxOutputBytes) {
        OutputLimits limits = new OutputLimits(Duration.ofHours(1), maxOutputBytes, maxOutputBytes * 8, 1000, 0L);
        return new FileOutputPayloadStore(new OutputFiles(new StorageRoots(TestStorage.privateFolder(folder), folder), TestStorage.rules()), new Sha256Digester(), limits);
    }

    private OutputId id(String hexDigit) {
        return new OutputId(hexDigit.repeat(48));
    }

    private byte[] utf8(String text) {
        return text.getBytes(StandardCharsets.UTF_8);
    }

    private byte[] readAll(PayloadRead read) throws IOException {
        try (read) {
            return Channels.newInputStream(read.channel()).readAllBytes();
        }
    }

    @Test
    @DisplayName("RC-A-496: partial stdout and stderr frames are on disk when append returns (kind byte, 4-byte big-endian length, data) and survive a new store; "
        + "cursor paging belongs to the output-read use case")
    void framesAreDurableBeforeFinish(@TempDir Path folder) throws IOException {
        FileOutputPayloadStore store = store(folder, 1024);
        OutputId id = id("1");

        assertThat(store.append(id, new StreamFrame(StreamKind.STDOUT, E2_82))).isEqualTo(7L);
        assertThat(store.append(id, new StreamFrame(StreamKind.STDERR, AC_FF_00))).isEqualTo(15L);

        byte[] expected = {0, 0, 0, 0, 2, (byte) 0xe2, (byte) 0x82, 1, 0, 0, 0, 3, (byte) 0xac, (byte) 0xff, 0};
        assertThat(Files.readAllBytes(folder.resolve(id.value() + ".stream"))).isEqualTo(expected);
        assertThat(store(folder, 1024).retainedBytes(id)).isEqualTo(15L);
    }

    @Test
    @DisplayName("RC-A-500: the spool never grows beyond the per-output limit, a frame is cut to what fits, and the committed bytes stay after a capture that is too large")
    void truncationBoundsTheSpool(@TempDir Path folder) throws IOException {
        FileOutputPayloadStore store = store(folder, 128);
        OutputId id = id("2");
        Path spool = folder.resolve(id.value() + ".stream");

        assertThat(store.append(id, new StreamFrame(StreamKind.STDOUT, "a".repeat(200).getBytes(StandardCharsets.US_ASCII)))).isEqualTo(128L);
        assertThat(Files.size(spool)).isEqualTo(128L);
        assertThat(ByteBuffer.wrap(Files.readAllBytes(spool)).getInt(1)).as("5 header bytes leave 123 data bytes").isEqualTo(123);

        assertThat(store.append(id, new StreamFrame(StreamKind.STDERR, utf8("lost")))).isEqualTo(128L);
        assertThat(Files.size(spool)).isEqualTo(128L);

        assertThatThrownBy(() -> store.finish(id, utf8("{}"), utf8("x".repeat(200)))).isInstanceOfSatisfying(RequestRefusedException.class,
            e -> assertThat(e.code()).isEqualTo(ExecutionErrorCode.OUTPUT_CAPACITY));
        assertThat(Files.exists(folder.resolve(id.value() + ".out"))).isFalse();
        assertThat(Files.exists(folder.resolve(id.value() + ".part"))).isFalse();
        byte[] kept = Files.readAllBytes(spool);
        assertThat(kept).hasSize(128);
        assertThat(kept[5]).isEqualTo((byte) 'a');
        assertThat(store.retainedBytes(id)).isEqualTo(128L);
    }

    @Test
    @DisplayName("RC-A-507: both renderings are stored one after the other byte for byte (text blocks, UTF-8, empty), with the digest of each 16 KiB page, and read back after a restart; "
        + "page assembly at UTF-8 boundaries belongs to the output-read use case")
    void renderingsAreStoredExactly(@TempDir Path folder) throws IOException {
        Sha256Digester digester = new Sha256Digester();
        FileOutputPayloadStore store = store(folder, 4 * 1024 * 1024);
        OutputId id = id("3");
        String unit = "한글🙂\r\n";
        byte[] json = utf8("{\"failed\":true,\"texts\":[\"\",\"" + unit.repeat(11000).replace("\r\n", "\\r\\n") + "\",\"\"],\"data\":{\"nested\":[\"SENTINEL\",17]}}");
        byte[] text = utf8("\n" + unit.repeat(11000) + "\n\n{\n  \"nested\": [\n    \"SENTINEL\",\n    17\n  ]\n}");

        OutputFormats formats = store.finish(id, json, text);

        FormatSpan jsonSpan = formats.spans().get(OutputFormat.JSON);
        FormatSpan textSpan = formats.spans().get(OutputFormat.TEXT);
        assertThat(jsonSpan.offsetBytes()).isZero();
        assertThat(jsonSpan.sizeBytes()).isEqualTo(json.length);
        assertThat(textSpan.offsetBytes()).isEqualTo(json.length);
        assertThat(textSpan.sizeBytes()).isEqualTo(text.length);
        assertThat(jsonSpan.pageDigests()).hasSize((json.length + 16383) / 16384);
        assertThat(textSpan.pageDigests()).hasSize((text.length + 16383) / 16384).hasSizeGreaterThan(1);
        assertThat(textSpan.sha256()).isEqualTo(digester.digest(text));
        assertThat(Files.size(folder.resolve(id.value() + ".out"))).isEqualTo((long) json.length + text.length);
        assertThat(Files.exists(folder.resolve(id.value() + ".part"))).isFalse();

        FileOutputPayloadStore restarted = store(folder, 4 * 1024 * 1024);
        assertThat(readAll(restarted.openFormat(id, OutputFormat.JSON, jsonSpan))).isEqualTo(json);
        assertThat(readAll(restarted.openFormat(id, OutputFormat.TEXT, textSpan))).isEqualTo(text);

        OutputId emptyId = id("4");
        OutputFormats empty = store.finish(emptyId, utf8("{\"failed\":false,\"texts\":[]}"), new byte[0]);
        assertThat(empty.spans().get(OutputFormat.TEXT).sizeBytes()).isZero();
        assertThat(empty.spans().get(OutputFormat.TEXT).pageDigests()).isEmpty();
        assertThat(readAll(store.openFormat(emptyId, OutputFormat.TEXT, empty.spans().get(OutputFormat.TEXT)))).isEmpty();

        OutputId smallId = id("5");
        OutputFormats small = store.finish(smallId, utf8("{}"), utf8("a한🙂z"));
        assertThat(new String(readAll(store.openFormat(smallId, OutputFormat.TEXT, small.spans().get(OutputFormat.TEXT))), StandardCharsets.UTF_8)).isEqualTo("a한🙂z");

        assertThatThrownBy(() -> new FormatSpan(-1L, 0L, new Digest("a".repeat(64)), List.of())).isInstanceOf(IllegalArgumentException.class);
        store.delete(id);
        assertThat(store.retainedBytes(id)).isZero();
        assertThat(Files.exists(folder.resolve(id.value() + ".out"))).isFalse();
    }

    @Test
    @DisplayName("RC-A-511: only verified bytes are returned: a damaged byte, a second hard link and a mode that others can read are refused where the file store can tell, "
        + "and an output id cannot leave the folder; the authorization check per read belongs to the output-read use case")
    void onlyVerifiedBytesAreReturned(@TempDir Path folder) throws IOException {
        FileOutputPayloadStore store = store(folder, 1024 * 1024);
        OutputId id = id("6");
        byte[] json = utf8("{\"failed\":false,\"texts\":[\"" + "SAFE ".repeat(20000) + "\"]}");
        FormatSpan span = store.finish(id, json, utf8("SAFE ".repeat(20000))).spans().get(OutputFormat.JSON);
        Path out = folder.resolve(id.value() + ".out");
        assertThat(readAll(store.openFormat(id, OutputFormat.JSON, span))).isEqualTo(json);

        byte[] original = Files.readAllBytes(out);
        byte[] damaged = original.clone();
        damaged[10] ^= 1;
        Files.write(out, damaged);
        assertThatThrownBy(() -> store.openFormat(id, OutputFormat.JSON, span)).isInstanceOfSatisfying(RequestRefusedException.class,
            e -> assertThat(e.code()).isEqualTo(ExecutionErrorCode.OUTPUT_CAPTURE_FAILED));
        Files.write(out, original);
        assertThat(readAll(store.openFormat(id, OutputFormat.JSON, span))).isEqualTo(json);

        boolean linkCountVisible = Files.getFileStore(out).supportsFileAttributeView("unix");
        Path extra = folder.resolve("extra-link");
        Files.createLink(extra, out);
        if (linkCountVisible) {
            assertThatThrownBy(() -> store.openFormat(id, OutputFormat.JSON, span)).isInstanceOf(RequestRefusedException.class);
        } else {
            assertThat(readAll(store.openFormat(id, OutputFormat.JSON, span))).as("this file store does not report link counts, so the rule cannot apply").isEqualTo(json);
        }
        Files.delete(extra);

        boolean posix = Files.getFileStore(out).supportsFileAttributeView("posix");
        if (posix) {
            assertThat(Files.getPosixFilePermissions(out)).as("created owner only").isEqualTo(PosixFilePermissions.fromString("rw-------"));
            Files.setPosixFilePermissions(out, PosixFilePermissions.fromString("rw-r--r--"));
            assertThatThrownBy(() -> store.openFormat(id, OutputFormat.JSON, span)).isInstanceOf(RequestRefusedException.class);
            Files.setPosixFilePermissions(out, PosixFilePermissions.fromString("rw-------"));
        }
        assertThat(readAll(store.openFormat(id, OutputFormat.JSON, span))).isEqualTo(json);

        assertThatThrownBy(() -> new OutputId("../unsafe")).isInstanceOf(IllegalArgumentException.class);
    }

    @Test
    @DisplayName("RC-A-510: payload files without a manifest are listed by id (foreign names are not) and moved to the quarantine folder, never deleted; a second file of the same name is kept too")
    void orphansAreListedAndQuarantined(@TempDir Path folder) throws IOException {
        FileOutputPayloadStore store = store(folder, 1024);
        OutputId orphan = id("f");
        Files.write(folder.resolve(orphan.value() + ".part"), new byte[0]);
        store.append(orphan, new StreamFrame(StreamKind.STDOUT, utf8("x")));
        Files.write(folder.resolve("manifest.sqlite"), utf8("not a payload"));
        Files.write(folder.resolve("e".repeat(47) + ".out"), utf8("short name"));
        Files.write(folder.resolve(orphan.value() + ".txt"), utf8("other suffix"));

        assertThat(store.stored()).containsExactly(orphan);
        assertThat(store.usable().usableBytes()).isPositive();

        store.quarantine(orphan);

        assertThat(store.stored()).isEmpty();
        Path quarantine = folder.resolve("quarantine");
        assertThat(Files.exists(quarantine.resolve(orphan.value() + ".part"))).isTrue();
        assertThat(Files.exists(quarantine.resolve(orphan.value() + ".stream"))).isTrue();

        Files.write(folder.resolve(orphan.value() + ".part"), utf8("again"));
        store.quarantine(orphan);
        assertThat(Files.exists(quarantine.resolve(orphan.value() + ".part.1"))).isTrue();
        store.delete(orphan);
    }
}
