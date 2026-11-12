package io.github.jaeseongs95.portal.app.output;

import java.util.Objects;

/**
 * The answer of {@link OutputManifestStore#reserve}. The limits are 2.x {@code command-output.mjs:8, 144-147}: one hour of retention, 16 MiB per output,
 * 128 MiB in total, at most 1000 outputs, and the disk needs the limit plus 1 MiB free. Each refusal is a variant of its own.
 */
public sealed interface OutputReservation permits OutputReservation.Reserved, OutputReservation.TooLarge, OutputReservation.BudgetExceeded, OutputReservation.CountExceeded,
    OutputReservation.DiskSpaceInsufficient {

    /** The row exists in state {@code PENDING}. */
    record Reserved(OutputId id) implements OutputReservation {

        public Reserved {
            Objects.requireNonNull(id, "id");
        }
    }

    record TooLarge(long limitBytes) implements OutputReservation {
    }

    record BudgetExceeded(long requestedBytes, long chargedBytes, long budgetBytes) implements OutputReservation {
    }

    record CountExceeded(int maxCount) implements OutputReservation {
    }

    record DiskSpaceInsufficient(long requiredBytes, long usableBytes) implements OutputReservation {
    }
}
