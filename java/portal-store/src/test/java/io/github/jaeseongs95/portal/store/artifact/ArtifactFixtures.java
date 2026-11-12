package io.github.jaeseongs95.portal.store.artifact;

import java.security.SecureRandom;
import java.time.Clock;
import java.time.Duration;
import java.time.Instant;
import java.time.ZoneOffset;
import java.util.Arrays;

import io.github.jaeseongs95.portal.app.artifact.ArtifactDestination;
import io.github.jaeseongs95.portal.app.artifact.ArtifactDirection;
import io.github.jaeseongs95.portal.app.artifact.ArtifactOrigin;
import io.github.jaeseongs95.portal.app.artifact.ArtifactRegistry;
import io.github.jaeseongs95.portal.app.artifact.ArtifactReservation;
import io.github.jaeseongs95.portal.app.artifact.ArtifactRetention;
import io.github.jaeseongs95.portal.app.artifact.ArtifactSpec;
import io.github.jaeseongs95.portal.app.artifact.BindingKind;
import io.github.jaeseongs95.portal.app.artifact.ChunkDigest;
import io.github.jaeseongs95.portal.domain.file.FileName;
import io.github.jaeseongs95.portal.domain.id.ArtifactId;
import io.github.jaeseongs95.portal.domain.id.ArtifactUuid;
import io.github.jaeseongs95.portal.domain.id.ArtifactUuidGenerator;
import io.github.jaeseongs95.portal.domain.id.Digest;
import io.github.jaeseongs95.portal.domain.id.Sha256Digester;
import io.github.jaeseongs95.portal.domain.id.OwnerId;
import io.github.jaeseongs95.portal.domain.id.TargetId;
import io.github.jaeseongs95.portal.domain.operation.Elevation;
import io.github.jaeseongs95.portal.domain.operation.OverwriteMode;
import io.github.jaeseongs95.portal.domain.operation.UploadProtocol;
import io.github.jaeseongs95.portal.domain.path.PosixRemotePath;
import io.github.jaeseongs95.portal.domain.path.RemotePath;
import io.github.jaeseongs95.portal.domain.target.TargetRevision;

/** Builds the values the artifact tests reserve and append; the time is a fixed {@link Clock}, so every test sees the same instants. */
final class ArtifactFixtures {

    static final Instant T0 = Instant.parse("2026-11-12T00:00:00Z");
    static final Duration ONE_HOUR = Duration.ofHours(1);

    private final Clock clock = Clock.fixed(T0, ZoneOffset.UTC);
    private final Sha256Digester digester = new Sha256Digester();
    private final ArtifactUuidGenerator uuids = new ArtifactUuidGenerator(new SecureRandom());
    private final TargetRevision revision = TargetRevision.of("a".repeat(64));

    Instant at() {
        return clock.instant();
    }

    ArtifactSpec upload(long size) {
        return upload(size, new PosixRemotePath("/tmp/upload.bin"), new TargetId("alpha"));
    }

    /** An upload bound to {@code path} on {@code target}, expiring after the 10 minute staging time. */
    ArtifactSpec upload(long size, RemotePath path, TargetId target) {
        return new ArtifactSpec(ArtifactDirection.UPLOAD, new FileName("한글.bin"), size, new ArtifactOrigin.Transfer(),
            new ArtifactDestination.Assigned(path, target, revision, BindingKind.BOUND), OverwriteMode.REPLACE, Elevation.NONE, UploadProtocol.MCP_JSON_V1,
            ArtifactRetention.RELEASABLE, ArtifactLimits.UPLOAD_TTL);
    }

    ArtifactSpec download(long size) {
        return new ArtifactSpec(ArtifactDirection.DOWNLOAD, new FileName("result.bin"), size, new ArtifactOrigin.Transfer(),
            new ArtifactDestination.Assigned(new PosixRemotePath("/var/log/result.bin"), new TargetId("alpha"), revision, BindingKind.BOUND), OverwriteMode.REPLACE,
            Elevation.NONE, UploadProtocol.UNSPECIFIED, ArtifactRetention.RELEASABLE, ONE_HOUR);
    }

    ArtifactSpec staged(String owner, String operationKey, ArtifactUuid uuid, long size) {
        return new ArtifactSpec(ArtifactDirection.UPLOAD, new FileName("한글😀.bin"), size, new ArtifactOrigin.Staged(uuid, new OwnerId(owner), operationKey),
            new ArtifactDestination.Unassigned(), OverwriteMode.REPLACE, Elevation.NONE, UploadProtocol.MCP_JSON_V1, ArtifactRetention.RELEASABLE,
            ArtifactLimits.UPLOAD_TTL);
    }

    /** A staged file of a fresh UUID and a fresh operation key. */
    ArtifactSpec stagedFile(long size) {
        ArtifactUuid uuid = nextUuid();
        return staged("verified-owner", "staged-key-" + uuid.text(), uuid, size);
    }

    ArtifactUuid nextUuid() {
        return uuids.next();
    }

    /** The id of a successful reservation; any refusal fails the test. */
    ArtifactId reservedId(ArtifactReservation reservation) {
        if (reservation instanceof ArtifactReservation.Reserved reserved) {
            return reserved.id();
        }
        throw new AssertionError("The reservation was refused: " + reservation);
    }

    /** Reserves {@code spec}, acknowledges {@code bytes} as one chunk (none for an empty file) and makes the artifact {@code READY}. */
    ArtifactId readyArtifact(ArtifactRegistry registry, ArtifactSpec spec, byte[] bytes) {
        ArtifactId id = reservedId(registry.reserve(spec, at()));
        if (bytes.length > 0) {
            registry.append(id, 0, chunk(bytes));
        }
        registry.markReady(id, digest(bytes));
        return id;
    }

    byte[] bytes(int length, int fill) {
        byte[] bytes = new byte[length];
        Arrays.fill(bytes, (byte) fill);
        return bytes;
    }

    ChunkDigest chunk(byte[] bytes) {
        return new ChunkDigest(bytes.length, digest(bytes));
    }

    Digest digest(byte[] bytes) {
        return digester.digest(bytes);
    }
}
