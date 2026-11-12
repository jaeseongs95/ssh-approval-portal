package io.github.jaeseongs95.portal.app.artifact;

import java.util.Objects;

import io.github.jaeseongs95.portal.domain.error.ArtifactErrorCode;
import io.github.jaeseongs95.portal.domain.error.ErrorCode;
import io.github.jaeseongs95.portal.domain.error.ExecutionErrorCode;
import io.github.jaeseongs95.portal.domain.error.RequestRefusedException;

/**
 * A refused reservation as the owner sees it: the error code and the numbers behind it (defect D-0012). Each refusal has its own code and its own values, so the owner
 * can tell "the budget is full" from "the disk is short" and, for the budget, "transfers in flight" from "bytes in quarantine". The values are typed fields, never text.
 *
 * <p>Why not the exception: {@link RequestRefusedException} carries a code and two facts and no values, and the answer envelope that would carry them is stage 4's. The
 * use cases return this value where the owner wants the numbers and use {@link #toException()} where a caller only wants to stop.
 *
 * @param code {@code ARTIFACT_QUOTA}, {@code ARTIFACT_STORAGE_FULL} or {@code FILE_TOO_LARGE}
 * @param detail the numbers
 */
public record ArtifactRefusal(ErrorCode code, Detail detail) {

    public ArtifactRefusal {
        Objects.requireNonNull(code, "code");
        Objects.requireNonNull(detail, "detail");
    }

    /** The refusal of a reservation that was not accepted; a {@link ArtifactReservation.Reserved} is no refusal and is refused here as a programming error. */
    public static ArtifactRefusal of(ArtifactReservation reservation) {
        return switch (Objects.requireNonNull(reservation, "reservation")) {
            case ArtifactReservation.Reserved reserved -> throw new IllegalArgumentException("A reserved artifact is not a refusal");
            case ArtifactReservation.BudgetExceeded budget -> new ArtifactRefusal(ExecutionErrorCode.ARTIFACT_QUOTA,
                new Detail.Budget(budget.requestedBytes(), budget.reserved().liveBytes(), budget.reserved().holdingBytes(), budget.budgetBytes()));
            case ArtifactReservation.DiskSpaceInsufficient disk -> new ArtifactRefusal(ExecutionErrorCode.ARTIFACT_STORAGE_FULL,
                new Detail.Disk(disk.requestedBytes(), disk.usableBytes(), disk.marginBytes()));
            case ArtifactReservation.FileTooLarge large -> new ArtifactRefusal(ArtifactErrorCode.FILE_TOO_LARGE, new Detail.SizeLimit(large.requestedBytes(), large.limitBytes()));
        };
    }

    /** The exception with the code (and its defaults) for a caller that only needs to stop. */
    public RequestRefusedException toException() {
        return new RequestRefusedException(code);
    }

    /** The numbers of a refusal; one variant per refusal. */
    public sealed interface Detail permits Detail.Budget, Detail.Disk, Detail.SizeLimit {

        /**
         * The budget cannot take the file.
         *
         * @param requestedBytes the declared size
         * @param liveBytes what the rows of the artifacts charge
         * @param holdingBytes what stays in quarantine without a row
         * @param budgetBytes the budget
         */
        record Budget(long requestedBytes, long liveBytes, long holdingBytes, long budgetBytes) implements Detail {
        }

        /**
         * The disk cannot take the file.
         *
         * @param requestedBytes the declared size
         * @param usableBytes the usable space the disk reported
         * @param marginBytes the space that must stay free
         */
        record Disk(long requestedBytes, long usableBytes, long marginBytes) implements Detail {
        }

        /**
         * The file is over the per-file limit.
         *
         * @param requestedBytes the declared size
         * @param limitBytes the limit
         */
        record SizeLimit(long requestedBytes, long limitBytes) implements Detail {
        }
    }
}
