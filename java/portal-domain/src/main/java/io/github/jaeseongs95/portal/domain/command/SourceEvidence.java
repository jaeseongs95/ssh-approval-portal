package io.github.jaeseongs95.portal.domain.command;

import io.github.jaeseongs95.portal.domain.id.Digest;
import io.github.jaeseongs95.portal.domain.text.SourceText;
import java.util.Objects;

/**
 * The submitted program as the evaluator sees it. A request that runs submitted source has the exact source text and the digest of its plan; the digest proves
 * identity, not safety (command-policy 2.x {@code submittedSource}). A request that runs a command line has no source evidence.
 */
public sealed interface SourceEvidence permits SourceEvidence.NoSource, SourceEvidence.Submitted {

    /**
     * The most characters the source evidence may add to an evaluation context: six times the source limit (JSON escaping of every character), three times the
     * argument allowance, six times the working directory allowance and a fixed part for the manifest and the provenance text (execution-context.mjs:7).
     */
    int MAX_CHARS = 6 * SourceText.MAX_BYTES + 3 * 4096 + 6 * 512 + 4096;

    record NoSource() implements SourceEvidence {
    }

    record Submitted(SourceText source, Digest planDigest) implements SourceEvidence {
        public Submitted {
            Objects.requireNonNull(source, "source");
            Objects.requireNonNull(planDigest, "planDigest");
        }
    }
}
