package io.github.jaeseongs95.portal.store.output;

import java.io.IOException;
import java.nio.ByteBuffer;
import java.nio.channels.FileChannel;
import java.nio.charset.StandardCharsets;
import java.nio.file.Path;
import java.time.Instant;
import java.security.SecureRandom;

import org.springframework.data.jdbc.core.JdbcAggregateOperations;
import org.springframework.transaction.PlatformTransactionManager;

import io.github.jaeseongs95.portal.app.output.OutputBinding;
import io.github.jaeseongs95.portal.app.output.OutputId;
import io.github.jaeseongs95.portal.app.output.OutputReservation;
import io.github.jaeseongs95.portal.app.output.StreamFrame;
import io.github.jaeseongs95.portal.app.output.StreamKind;
import io.github.jaeseongs95.portal.domain.id.OperationIdGenerator;
import io.github.jaeseongs95.portal.domain.id.Sha256Digester;
import io.github.jaeseongs95.portal.store.StorageRoots;
import io.github.jaeseongs95.portal.store.TestStorage;
import io.github.jaeseongs95.portal.store.output.OutputFiles.PayloadKind;

/**
 * The output store as a test builds it: the manifest store over the test's database, the payload store over a temporary folder, and the start-up check over both.
 * A second world over the same folder and the same database is a restart of the portal (fresh objects, same bytes and rows).
 */
final class OutputWorld {

    final OutputFiles files;
    final FileOutputPayloadStore payloads;
    final JdbcOutputManifestStore manifests;
    final OutputStartupCheck startup;
    final CommandOutputRowRepository rows;
    final CommandOutputFormatRowRepository formats;
    final CommandOutputPageRowRepository pages;
    private final JdbcAggregateOperations aggregates;

    OutputWorld(Path folder, OutputLimits limits, CommandOutputRowRepository rows, CommandOutputFormatRowRepository formats, CommandOutputPageRowRepository pages,
                JdbcAggregateOperations aggregates, OutputMapper mapper, PlatformTransactionManager transactionManager) {
        this.rows = rows;
        this.formats = formats;
        this.pages = pages;
        this.aggregates = aggregates;
        this.files = new OutputFiles(new StorageRoots(TestStorage.privateFolder(folder), folder), TestStorage.rules());
        this.payloads = new FileOutputPayloadStore(files, new Sha256Digester(), limits);
        this.manifests = new JdbcOutputManifestStore(rows, formats, pages, aggregates, mapper, new OperationIdGenerator(new SecureRandom()), payloads, transactionManager,
            limits);
        this.startup = new OutputStartupCheck(manifests, payloads);
    }

    Path file(OutputId id, PayloadKind kind) {
        return files.path(id, kind);
    }

    /** Reserves and insists that the reservation was accepted. */
    OutputId reserve(OutputBinding binding, long expectedBytes, Instant at) {
        OutputReservation reservation = manifests.reserve(binding, expectedBytes, at);
        if (reservation instanceof OutputReservation.Reserved reserved) {
            return reserved.id();
        }
        throw new AssertionError("The reservation was refused: " + reservation);
    }

    CommandOutputRow row(OutputId id) {
        return rows.findById(id.value()).orElseThrow();
    }

    long charge(OutputId id) {
        return row(id).chargeBytes();
    }

    /** Appends a frame of the text and returns the size of the spool. */
    long append(OutputId id, StreamKind kind, String text) {
        return payloads.append(id, new StreamFrame(kind, text.getBytes(StandardCharsets.UTF_8)));
    }

    /** Puts bytes in a payload file the way the store would (owner only, no links), replacing what the file held. */
    void plant(Path file, byte[] content) throws IOException {
        try (FileChannel channel = files.openFresh(file)) {
            channel.write(ByteBuffer.wrap(content));
        }
    }

    /** Sets a charge directly, as an older version of the store would have left it. */
    void forceCharge(OutputId id, long chargeBytes) {
        aggregates.update(row(id).withChargeBytes(chargeBytes));
    }
}
