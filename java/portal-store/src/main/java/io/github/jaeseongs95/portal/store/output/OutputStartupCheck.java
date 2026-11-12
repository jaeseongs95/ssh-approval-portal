package io.github.jaeseongs95.portal.store.output;

import java.time.Instant;
import java.util.List;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Component;

import io.github.jaeseongs95.portal.app.output.OutputId;
import io.github.jaeseongs95.portal.app.output.OutputLookup;
import io.github.jaeseongs95.portal.app.output.OutputManifest;
import io.github.jaeseongs95.portal.app.output.OutputManifestStore;
import io.github.jaeseongs95.portal.app.output.OutputPayloadStore;
import io.github.jaeseongs95.portal.app.output.OutputState;
import io.github.jaeseongs95.portal.domain.error.RequestRefusedException;

/**
 * The start-up reconciliation of the output manifests with the output files (2.x {@code CommandOutputs} constructor and {@code reap}, design 8.5). It is not in a
 * transaction: it reads the files first and then calls the manifest store, whose methods are short transactions of their own (Principles 4.4). It is not wired to an
 * {@code ApplicationRunner} here; the assembly of stage 3 calls it.
 *
 * <p>It is split in two so that a caller can honour a maintenance window: {@link #recover} never deletes an output, {@link #reap} does, and {@link #reconcile} runs both.
 * A file or a row that cannot be handled is logged and skipped: one bad output must not stop the start of the portal, and a restart never re-executes a command.
 */
@Component
public class OutputStartupCheck {

    private static final Logger LOG = LoggerFactory.getLogger(OutputStartupCheck.class);

    private final OutputManifestStore manifests;
    private final OutputPayloadStore payloads;

    public OutputStartupCheck(OutputManifestStore manifests, OutputPayloadStore payloads) {
        this.manifests = manifests;
        this.payloads = payloads;
    }

    /** {@link #recover} and then {@link #reap}. */
    public void reconcile(Instant now) {
        recover(now);
        reap(now);
    }

    /**
     * Payload files without a manifest row go to the quarantine folder (a crash can precede the reservation row; file existence never rebuilds an output). Outputs
     * that were {@code PENDING} when the process stopped are given up with their expiry unchanged (a restart does not renew the retention), and the charge of every
     * {@code UNAVAILABLE} output is measured again from the files it holds. Nothing is deleted.
     */
    public void recover(Instant now) {
        quarantineOrphans(now);
        List<OutputManifest> unavailable = manifests.inState(OutputState.UNAVAILABLE);
        for (OutputManifest interrupted : manifests.inState(OutputState.PENDING)) {
            giveUp(interrupted);
        }
        for (OutputManifest old : unavailable) {
            giveUp(old);
        }
    }

    /** Deletes the bytes and then the row of every output whose expiry is not after {@code now}. A failed delete keeps the row, so the next run tries again. */
    public void reap(Instant now) {
        for (OutputManifest expired : manifests.expired(now)) {
            try {
                payloads.delete(expired.id());
                manifests.delete(expired.id());
            } catch (RequestRefusedException e) {
                LOG.error("The expired output {} could not be removed; it stays until the next run", expired.id().value(), e);
            }
        }
    }

    private void quarantineOrphans(Instant now) {
        for (OutputId id : payloads.stored()) {
            if (manifests.find(id, now) instanceof OutputLookup.Missing) {
                try {
                    payloads.quarantine(id);
                } catch (RequestRefusedException e) {
                    LOG.error("The payload of the output {} has no manifest and could not be moved to the quarantine folder", id.value(), e);
                }
            }
        }
    }

    /** {@code markUnavailable} with the expiry the row already has: it settles the state and measures the charge, and changes nothing else. */
    private void giveUp(OutputManifest output) {
        try {
            manifests.markUnavailable(output.id(), output.expiresAt());
        } catch (RequestRefusedException e) {
            LOG.error("The output {} could not be settled at start-up", output.id().value(), e);
        }
    }
}
