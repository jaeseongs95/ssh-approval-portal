package io.github.jaeseongs95.portal.app.artifact;

import java.util.Objects;

import io.github.jaeseongs95.portal.domain.id.ArtifactId;

/**
 * The answer of {@link ArtifactRegistry#reserve}. 2.x gave every refusal the one text "Staging budget exhausted" and so the code {@code ARTIFACT_QUOTA}
 * (defect D-0012: a small file was refused as over quota because the disk was short). Each refusal is its own variant now, and the budget and the disk are checked
 * separately (design 8.5).
 */
public sealed interface ArtifactReservation permits ArtifactReservation.Reserved, ArtifactReservation.BudgetExceeded, ArtifactReservation.DiskSpaceInsufficient,
    ArtifactReservation.FileTooLarge {

    /** The row exists in state {@code STAGING}; the bytes may now be appended. */
    record Reserved(ArtifactId id) implements ArtifactReservation {

        public Reserved {
            Objects.requireNonNull(id, "id");
        }
    }

    /** The application's staging budget cannot take the file. */
    record BudgetExceeded(long requestedBytes, long reservedBytes, long budgetBytes) implements ArtifactReservation {
    }

    /** The disk has less usable space than the file needs. */
    record DiskSpaceInsufficient(long requestedBytes, long usableBytes) implements ArtifactReservation {
    }

    /** The file is larger than the per-file limit. */
    record FileTooLarge(long limitBytes) implements ArtifactReservation {
    }
}
