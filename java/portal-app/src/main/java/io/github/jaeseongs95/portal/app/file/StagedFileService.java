package io.github.jaeseongs95.portal.app.file;

import java.io.ByteArrayInputStream;
import java.io.IOException;
import java.nio.ByteBuffer;
import java.nio.channels.Channels;
import java.time.Clock;
import java.util.Objects;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Service;

import io.github.jaeseongs95.portal.app.artifact.ArtifactDestination;
import io.github.jaeseongs95.portal.app.artifact.ArtifactDirection;
import io.github.jaeseongs95.portal.app.artifact.ArtifactImporter;
import io.github.jaeseongs95.portal.app.artifact.ArtifactOrigin;
import io.github.jaeseongs95.portal.app.artifact.ArtifactPayloadStore;
import io.github.jaeseongs95.portal.app.artifact.ArtifactRecord;
import io.github.jaeseongs95.portal.app.artifact.ArtifactRefusal;
import io.github.jaeseongs95.portal.app.artifact.ArtifactRegistry;
import io.github.jaeseongs95.portal.app.artifact.ArtifactReservation;
import io.github.jaeseongs95.portal.app.artifact.ArtifactRetention;
import io.github.jaeseongs95.portal.app.artifact.ArtifactSpec;
import io.github.jaeseongs95.portal.app.artifact.ArtifactState;
import io.github.jaeseongs95.portal.app.artifact.BindingKind;
import io.github.jaeseongs95.portal.app.artifact.ChunkDigest;
import io.github.jaeseongs95.portal.app.artifact.ConsumeReason;
import io.github.jaeseongs95.portal.app.artifact.ConsumeState;
import io.github.jaeseongs95.portal.app.artifact.ContentDigest;
import io.github.jaeseongs95.portal.app.artifact.ImportResult;
import io.github.jaeseongs95.portal.app.artifact.ReleaseReason;
import io.github.jaeseongs95.portal.app.artifact.StagedAction;
import io.github.jaeseongs95.portal.app.artifact.StagedActionKind;
import io.github.jaeseongs95.portal.app.artifact.StagedActionState;
import io.github.jaeseongs95.portal.app.artifact.StagingTimes;
import io.github.jaeseongs95.portal.app.maintenance.MaintenanceStore;
import io.github.jaeseongs95.portal.app.storage.PayloadRead;
import io.github.jaeseongs95.portal.app.storage.RunningDigest;
import io.github.jaeseongs95.portal.domain.error.ArtifactErrorCode;
import io.github.jaeseongs95.portal.domain.error.RequestErrorCode;
import io.github.jaeseongs95.portal.domain.error.RequestRefusedException;
import io.github.jaeseongs95.portal.domain.file.FileBinding;
import io.github.jaeseongs95.portal.domain.file.FileName;
import io.github.jaeseongs95.portal.domain.file.FileTargetBinding;
import io.github.jaeseongs95.portal.domain.id.ArtifactId;
import io.github.jaeseongs95.portal.domain.id.ArtifactUuid;
import io.github.jaeseongs95.portal.domain.id.ArtifactUuidGenerator;
import io.github.jaeseongs95.portal.domain.id.CanonicalForm;
import io.github.jaeseongs95.portal.domain.id.Digest;
import io.github.jaeseongs95.portal.domain.id.Digester;
import io.github.jaeseongs95.portal.domain.id.OperationId;
import io.github.jaeseongs95.portal.domain.id.OwnerId;
import io.github.jaeseongs95.portal.domain.id.RequestKey;
import io.github.jaeseongs95.portal.domain.operation.CompletionEvidence;
import io.github.jaeseongs95.portal.domain.operation.ConflictKey;
import io.github.jaeseongs95.portal.domain.operation.Deadline;
import io.github.jaeseongs95.portal.domain.operation.Elevation;
import io.github.jaeseongs95.portal.domain.operation.NewOperation;
import io.github.jaeseongs95.portal.domain.operation.OperationState;
import io.github.jaeseongs95.portal.domain.operation.OverwriteMode;
import io.github.jaeseongs95.portal.domain.operation.UploadInput;
import io.github.jaeseongs95.portal.domain.operation.UploadProtocol;
import io.github.jaeseongs95.portal.domain.target.ResolvedTarget;

/**
 * The files a client has put on the server and not yet sent anywhere (2.x opaque files, design 0.3 item 5): begin, append, complete, stat, and the three things a client
 * can do with a staged file. {@code copy} publishes a copy and keeps the staged file, {@code move} publishes and consumes the staged file once the publication is
 * <em>confirmed</em>, and {@code remove} deletes the staged bytes without any SSH at all. The owner is the verified owner of the request; another owner's UUID is "not found".
 *
 * <p>A copy and a move do not publish the staged file itself: they copy its bytes into a new artifact bound to the target and admit an upload of that copy through
 * {@link UploadAdmission}, so the approval, the policy and the queue of every other request apply, and the staged file can be copied again. A request with the same
 * operation key and the same content answers the first action; the same key with other content is {@code OPERATION_KEY_CONFLICT}. A move consumes the staged file in
 * {@link #operationSettled} only when the operation completed with the evidence {@code FilePublished} of this very content (D-0035); an operation that ended otherwise keeps it,
 * and one that is {@code UNKNOWN} keeps the action open.
 *
 * <p>While a maintenance reservation holds the installation no staged file is begun, changed or sent (RC-A-776, RC-A-777).
 */
@Service
public class StagedFileService {

    private static final Logger LOG = LoggerFactory.getLogger(StagedFileService.class);

    private final ArtifactRegistry registry;
    private final ArtifactPayloadStore payloads;
    private final ArtifactImporter importer;
    private final MaintenanceStore maintenance;
    private final UploadAdmission admission;
    private final StagingTimes times;
    private final ArtifactUuidGenerator uuids;
    private final Digester digester;
    private final Clock clock;

    public StagedFileService(ArtifactRegistry registry, ArtifactPayloadStore payloads, ArtifactImporter importer, MaintenanceStore maintenance, UploadAdmission admission,
                             StagingTimes times, ArtifactUuidGenerator uuids, Digester digester, Clock clock) {
        this.registry = registry;
        this.payloads = payloads;
        this.importer = importer;
        this.maintenance = maintenance;
        this.admission = admission;
        this.times = times;
        this.uuids = uuids;
        this.digester = digester;
        this.clock = clock;
    }

    // ---- begin, append, complete, stat ----

    /** Starts a staged upload, or answers the one that the same owner and key started before (RC-B-091: the retry of a begin gets the same UUID). */
    public StagedBegin begin(OwnerId owner, String operationKey, FileName fileName, long sizeBytes) {
        requireOpen();
        Objects.requireNonNull(owner, "owner");
        Objects.requireNonNull(fileName, "fileName");
        RequestKey key = requestKey(operationKey);
        return registry.findStagedByKey(owner, key.value()).map(existing -> sameBegin(existing, fileName, sizeBytes)).orElseGet(() -> reserve(owner, key, fileName, sizeBytes));
    }

    private StagedBegin sameBegin(ArtifactRecord existing, FileName fileName, long sizeBytes) {
        if (!existing.spec().fileName().equals(fileName) || existing.spec().sizeBytes() != sizeBytes) {
            throw new RequestRefusedException(RequestErrorCode.OPERATION_KEY_CONFLICT);
        }
        return new StagedBegin.Begun(((ArtifactOrigin.Staged) existing.spec().origin()).publicUuid());
    }

    private StagedBegin reserve(OwnerId owner, RequestKey key, FileName fileName, long sizeBytes) {
        ArtifactUuid uuid = uuids.next();
        ArtifactSpec spec = new ArtifactSpec(ArtifactDirection.UPLOAD, fileName, sizeBytes, new ArtifactOrigin.Staged(uuid, owner, key.value()), new ArtifactDestination.Unassigned(),
            OverwriteMode.REPLACE, Elevation.NONE, UploadProtocol.MCP_JSON_V1, ArtifactRetention.RELEASABLE, times.upload());
        ArtifactReservation reservation = registry.reserve(spec, clock.instant());
        if (reservation instanceof ArtifactReservation.Reserved) {
            return new StagedBegin.Begun(uuid);
        }
        return new StagedBegin.Refused(ArtifactRefusal.of(reservation));
    }

    /**
     * Takes the next chunk: its digest must be the one the client gave (a wrong one changes nothing, RC-B-137), its number the next one, and the file must still be
     * staging and not expired. The bytes are written and forced to disk before the registry acknowledges them.
     */
    public void append(OwnerId owner, ArtifactUuid uuid, int sequence, byte[] bytes, Digest claimed) {
        requireOpen();
        Objects.requireNonNull(bytes, "bytes");
        Objects.requireNonNull(claimed, "claimed");
        Digest actual = digester.digest(bytes);
        if (!actual.equals(claimed)) {
            throw new RequestRefusedException(ArtifactErrorCode.CHUNK_HASH_MISMATCH);
        }
        ArtifactRecord record = owned(owner, uuid);
        if (bytes.length < 1 || bytes.length > ChunkDigest.MAX_CHUNK_BYTES) {
            throw new RequestRefusedException(ArtifactErrorCode.INVALID_ARTIFACT_CHUNK);
        }
        if (record.state() != ArtifactState.STAGING) {
            throw new RequestRefusedException(ArtifactErrorCode.ARTIFACT_NOT_WRITABLE);
        }
        requireNotExpired(record, ArtifactErrorCode.ARTIFACT_EXPIRED);
        if (sequence != record.chunkCount()) {
            throw new RequestRefusedException(ArtifactErrorCode.ARTIFACT_CHUNK_CONFLICT);
        }
        if (record.receivedBytes() + bytes.length > record.spec().sizeBytes()) {
            throw new RequestRefusedException(ArtifactErrorCode.ARTIFACT_SEQUENCE_OR_SIZE);
        }
        payloads.append(record.id(), record.receivedBytes(), bytes);
        registry.append(record.id(), sequence, new ChunkDigest(bytes.length, actual));
    }

    /** Ends the upload: every byte must be there; the whole file is hashed from the stored bytes and the file is {@code READY}. Asking again answers the ready file. */
    public ArtifactRecord complete(OwnerId owner, ArtifactUuid uuid) {
        requireOpen();
        ArtifactRecord record = owned(owner, uuid);
        if (record.state() == ArtifactState.READY) {
            return record;
        }
        requireNotExpired(record, ArtifactErrorCode.ARTIFACT_EXPIRED);
        if (record.receivedBytes() != record.spec().sizeBytes()) {
            throw new RequestRefusedException(ArtifactErrorCode.ARTIFACT_INCOMPLETE);
        }
        return registry.markReady(record.id(), hashOfStoredBytes(record));
    }

    /** The staged file and the actions made on it. */
    public StagedFileView stat(OwnerId owner, ArtifactUuid uuid) {
        ArtifactRecord record = owned(owner, uuid);
        return new StagedFileView(record, registry.actions(record.id()));
    }

    // ---- remove ----

    /**
     * Removes the staged bytes (no SSH): the file is consumed with the reason {@code REMOVED}, its bytes are deleted and the row stays as a tombstone that charges one
     * byte. A second call answers the tombstone. A file that an action still depends on is {@code ARTIFACT_BUSY} (RC-B-130, RC-B-134); one that was moved is
     * {@code STAGED_FILE_CONSUMED}.
     */
    public ArtifactRecord remove(OwnerId owner, ArtifactUuid uuid) {
        requireOpen();
        ArtifactRecord record = owned(owner, uuid);
        if (record.consumption() instanceof ConsumeState.ConsumedBecause done) {
            if (done.reason() == ConsumeReason.REMOVED) {
                return record;
            }
            throw new RequestRefusedException(ArtifactErrorCode.STAGED_FILE_CONSUMED);
        }
        if (registry.actions(record.id()).stream().anyMatch(this::dependsOnTheFile)
            || record.consumption() instanceof ConsumeState.Consuming consuming && consuming.reason() == ConsumeReason.MOVED) {
            throw new RequestRefusedException(ArtifactErrorCode.ARTIFACT_BUSY);
        }
        if (record.state() == ArtifactState.READY) {
            registry.beginConsume(record.id(), ConsumeReason.REMOVED);
        }
        payloads.delete(record.id());
        return registry.completeConsume(record.id(), ConsumeReason.REMOVED);
    }

    private boolean dependsOnTheFile(StagedAction action) {
        return action.state() == StagedActionState.RESERVED || action.state() == StagedActionState.SUBMITTED;
    }

    // ---- copy and move ----

    /**
     * Copies or moves a staged file to a path on a target. The checks come first and change nothing: maintenance, the key, the owner, the revision the client saw, the
     * state and the expiry of the file, and an earlier action with the same key. Then the bytes are copied into a new artifact bound to the target (a refusal of the budget
     * or the disk is the answer, with its numbers), the upload of that copy is admitted, and the action is recorded as {@code SUBMITTED}. If the admission fails, the copy is
     * removed and nothing is left.
     */
    public StagedPlacement place(StagedPlacementRequest request) {
        Objects.requireNonNull(request, "request");
        requireOpen();
        RequestKey key = requestKey(request.operationKey());
        ArtifactRecord source = owned(request.owner(), request.uuid());
        if (!request.expectedRevision().equals(request.target().revision())) {
            throw new RequestRefusedException(RequestErrorCode.TARGET_REVISION_CONFLICT);
        }
        Digest inputDigest = inputDigestOf(request);
        return registry.actions(source.id()).stream().filter(action -> action.operationKey().equals(key.value())).findFirst()
            .map(earlier -> answerEarlier(earlier, inputDigest)).orElseGet(() -> publishCopy(request, key, source, inputDigest));
    }

    /** The same key with the same content is the first action, not a second one; with other content it is a conflict. */
    private StagedPlacement answerEarlier(StagedAction earlier, Digest inputDigest) {
        if (!earlier.inputDigest().equals(inputDigest)) {
            throw new RequestRefusedException(RequestErrorCode.OPERATION_KEY_CONFLICT);
        }
        return new StagedPlacement.Placed(earlier.requestId(), earlier.state());
    }

    private StagedPlacement publishCopy(StagedPlacementRequest request, RequestKey key, ArtifactRecord source, Digest inputDigest) {
        requireUsable(source);
        ArtifactSpec copySpec = new ArtifactSpec(ArtifactDirection.UPLOAD, source.spec().fileName(), source.spec().sizeBytes(), new ArtifactOrigin.Transfer(),
            new ArtifactDestination.Assigned(request.remotePath(), request.target().target().id(), request.target().revision(), BindingKind.BOUND), request.overwrite(),
            request.elevation(), UploadProtocol.MCP_JSON_V1, ArtifactRetention.RELEASABLE, times.upload());
        Digest sourceDigest = ((ContentDigest.Sealed) source.content()).sha256();
        ImportResult imported = importer.importStream(copySpec, () -> bytesOf(source), sourceDigest);
        if (imported instanceof ImportResult.Refused refused) {
            return new StagedPlacement.Refused(refused.refusal());
        }
        if (!(imported instanceof ImportResult.Imported done)) {
            // The staged bytes could not be read back as they were stored: the file is no longer what the owner staged.
            throw new RequestRefusedException(ArtifactErrorCode.STAGED_FILE_CHANGED);
        }
        ArtifactRecord copy = done.artifact();
        OperationId operation;
        try {
            operation = admission.admit(newOperation(request, key, copy, sourceDigest));
        } catch (RuntimeException e) {
            discard(copy.id());
            throw e;
        }
        registry.submit(copy.id(), operation);
        registry.addAction(new StagedAction(source.id(), key.value(), requestKeyOf(request.owner(), key), inputDigest, operation, request.kind(), StagedActionState.SUBMITTED,
            request.target().target().id(), request.target().revision(), request.remotePath(), request.overwrite(), request.elevation()));
        return new StagedPlacement.Placed(operation, StagedActionState.SUBMITTED);
    }

    /** The stored bytes of a staged file; an empty file has no payload file, so it reads as no bytes. */
    private PayloadRead bytesOf(ArtifactRecord source) {
        if (source.spec().sizeBytes() == 0) {
            return new PayloadRead(Channels.newChannel(new ByteArrayInputStream(new byte[0])), 0L);
        }
        return payloads.open(source.id());
    }

    /**
     * The operation of a staged file ended. A move consumes the staged file only when the operation completed with {@code FilePublished} of this very content
     * (RC-B-130 to RC-B-132: a completion without the publication evidence consumes nothing); every final state settles the action; an {@code UNKNOWN} operation leaves it open.
     */
    public void operationSettled(OwnerId owner, ArtifactUuid uuid, String operationKey, OperationState state, CompletionEvidence evidence) {
        Objects.requireNonNull(state, "state");
        Objects.requireNonNull(evidence, "evidence");
        ArtifactRecord record = owned(owner, uuid);
        StagedAction action = registry.actions(record.id()).stream().filter(candidate -> candidate.operationKey().equals(operationKey)).findFirst()
            .orElseThrow(() -> new RequestRefusedException(ArtifactErrorCode.ARTIFACT_NOT_FOUND));
        settle(record, action, state, evidence);
    }

    /**
     * The operation ended, told by what the operation is and not by who asked: finds the use of a staged file that the operation was submitted for and settles it as
     * {@link #operationSettled(OwnerId, ArtifactUuid, String, OperationState, CompletionEvidence)} does. An operation that is not the operation of a staged file, or whose
     * staged file is gone, is none of this service's business and changes nothing. Telling it twice is harmless (a restart tells every terminal operation again).
     */
    public void operationSettled(OperationId operation, OperationState state, CompletionEvidence evidence) {
        Objects.requireNonNull(operation, "operation");
        Objects.requireNonNull(state, "state");
        Objects.requireNonNull(evidence, "evidence");
        registry.actionOf(operation).ifPresent(action -> registry.find(action.artifactId()).ifPresent(record -> settle(record, action, state, evidence)));
    }

    private void settle(ArtifactRecord record, StagedAction action, OperationState state, CompletionEvidence evidence) {
        if (!state.isFinal() || action.state() == StagedActionState.SETTLED || action.state() == StagedActionState.REFUSED) {
            return;
        }
        if (action.kind() == StagedActionKind.MOVE && state == OperationState.COMPLETED && publishedThisFile(record, evidence)) {
            consume(record);
        }
        registry.updateAction(record.id(), action.operationKey(), StagedActionState.SETTLED);
    }

    private boolean publishedThisFile(ArtifactRecord record, CompletionEvidence evidence) {
        return evidence instanceof CompletionEvidence.FilePublished published && record.content() instanceof ContentDigest.Sealed sealed
            && sealed.sha256().equals(published.sha256());
    }

    /** Moved: the reason is recorded when the use starts, the bytes are deleted, and the row ends as a tombstone. A crash in between is resumed with the same reason. */
    private void consume(ArtifactRecord record) {
        if (record.state() == ArtifactState.READY) {
            registry.beginConsume(record.id(), ConsumeReason.MOVED);
        }
        payloads.delete(record.id());
        registry.completeConsume(record.id(), ConsumeReason.MOVED);
    }

    // ---- helpers ----

    private void requireOpen() {
        if (maintenance.occupied()) {
            throw new RequestRefusedException(ArtifactErrorCode.ARTIFACT_MAINTENANCE);
        }
    }

    private RequestKey requestKey(String operationKey) {
        try {
            return new RequestKey(Objects.requireNonNull(operationKey, "operationKey"));
        } catch (IllegalArgumentException e) {
            throw new RequestRefusedException(ArtifactErrorCode.INVALID_OPERATION_KEY, e);
        }
    }

    /** The request key of the upload: the owner and the operation key, so two owners with the same operation key never meet in the journal. */
    private RequestKey requestKeyOf(OwnerId owner, RequestKey operationKey) {
        return new RequestKey("opaque:" + digester.digestUtf8(owner.value() + "\0" + operationKey.value()).hex());
    }

    private ArtifactRecord owned(OwnerId owner, ArtifactUuid uuid) {
        Objects.requireNonNull(owner, "owner");
        Objects.requireNonNull(uuid, "uuid");
        ArtifactRecord record = registry.findStaged(uuid).orElseThrow(() -> new RequestRefusedException(ArtifactErrorCode.ARTIFACT_NOT_FOUND));
        if (!(record.spec().origin() instanceof ArtifactOrigin.Staged staged) || !staged.owner().equals(owner)) {
            throw new RequestRefusedException(ArtifactErrorCode.ARTIFACT_NOT_FOUND);
        }
        return record;
    }

    private void requireNotExpired(ArtifactRecord record, ArtifactErrorCode code) {
        if (record.spec().retention() == ArtifactRetention.RELEASABLE && !clock.instant().isBefore(record.expiresAt())) {
            throw new RequestRefusedException(code);
        }
    }

    /** A file that can be sent: ready, not in use, not expired, and its digest known. */
    private void requireUsable(ArtifactRecord source) {
        if (source.consumption() instanceof ConsumeState.Consuming || source.consumption() instanceof ConsumeState.ConsumedBecause) {
            throw new RequestRefusedException(ArtifactErrorCode.STAGED_FILE_CONSUMED);
        }
        if (source.state() != ArtifactState.READY || !(source.content() instanceof ContentDigest.Sealed)) {
            throw new RequestRefusedException(ArtifactErrorCode.ARTIFACT_NOT_READY);
        }
        requireNotExpired(source, ArtifactErrorCode.STAGED_FILE_EXPIRED);
    }

    private Digest inputDigestOf(StagedPlacementRequest request) {
        return new CanonicalForm().field("uuid", request.uuid().text()).field("action", request.kind().name()).field("targetId", request.target().target().id().value())
            .field("targetRevision", request.target().revision().hex()).field("remotePath", request.remotePath().value()).field("overwrite", request.overwrite().name())
            .field("elevation", request.elevation().name()).digest(digester);
    }

    private NewOperation newOperation(StagedPlacementRequest request, RequestKey key, ArtifactRecord copy, Digest sha256) {
        ResolvedTarget target = request.target();
        UploadInput input = new UploadInput(copy.id(), request.remotePath(), copy.spec().fileName(), copy.spec().sizeBytes(), sha256, request.overwrite(), request.elevation(),
            new FileBinding.Bound(new FileTargetBinding(target.target().id(), target.revision())), UploadProtocol.MCP_JSON_V1);
        return NewOperation.of(digester, requestKeyOf(request.owner(), key), request.owner(), target.target().id(), target.revision(), target.target().writeProfile(), input,
            new ConflictKey.Of("upload:" + digester.digestUtf8(request.remotePath().value()).hex()), new Deadline.None());
    }

    private Digest hashOfStoredBytes(ArtifactRecord record) {
        RunningDigest whole = new RunningDigest();
        if (record.spec().sizeBytes() == 0) {
            return whole.finish();
        }
        try (PayloadRead read = payloads.open(record.id())) {
            ByteBuffer buffer = ByteBuffer.allocate(ChunkDigest.MAX_CHUNK_BYTES);
            long remaining = record.spec().sizeBytes();
            while (remaining > 0 && read.channel().read(buffer) >= 0) {
                buffer.flip();
                int take = (int) Math.min(buffer.remaining(), remaining);
                whole.update(buffer.array(), 0, take);
                remaining -= take;
                buffer.clear();
            }
        } catch (IOException e) {
            throw new RequestRefusedException(ArtifactErrorCode.ARTIFACT_STORAGE_IO_ERROR, e);
        }
        return whole.finish();
    }

    /** Removes a copy that no operation will ever use. A failure is logged: the row is {@code DELETING} and the start-up check finishes the removal. */
    private void discard(ArtifactId id) {
        try {
            registry.beginDelete(id);
            payloads.delete(id);
            registry.release(id, ReleaseReason.REFUSED);
        } catch (RuntimeException e) {
            LOG.warn("The copy " + id.value() + " of a staged file could not be discarded; the start-up check removes it", e);
        }
    }
}
