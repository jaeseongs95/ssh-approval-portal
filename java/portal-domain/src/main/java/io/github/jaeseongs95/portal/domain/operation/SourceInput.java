package io.github.jaeseongs95.portal.domain.operation;

import io.github.jaeseongs95.portal.domain.id.CanonicalForm;
import io.github.jaeseongs95.portal.domain.id.Digest;
import io.github.jaeseongs95.portal.domain.text.CommandText;
import io.github.jaeseongs95.portal.domain.text.SourceText;
import io.github.jaeseongs95.portal.domain.text.Utf8Text;
import java.util.Objects;

/**
 * A script to run on the target through a fixed launcher. The source text itself is not stored: it lives only in the private plan of the running process, so a
 * restart finds the operation unknown instead of running a plan nobody can verify (2.x operation_source). What is stored identifies the plan: its digest, the digest
 * and the length of the source, the arguments as JSON, the working directory and the revision of the environment it was planned against.
 *
 * @param launcher the fixed launcher command; the source never appears in it
 * @param planDigest the digest of the whole execution plan
 * @param sourceSha256 the digest of the source text
 * @param sourceBytes the length of the source text in UTF-8 bytes, 1 to {@value SourceText#MAX_BYTES}
 * @param argvJson the arguments as a JSON array, written by the serialization boundary
 * @param cwd the working directory, at most 512 UTF-8 bytes
 * @param elevation whether the script runs with elevated rights
 * @param environmentRevision the revision of the target environment the plan was made for
 * @param callerContext the caller's description
 * @param displayContext the text shown to the owner
 */
public record SourceInput(CommandText launcher, Digest planDigest, Digest sourceSha256, int sourceBytes, Utf8Text argvJson, Utf8Text cwd, Elevation elevation,
                          Digest environmentRevision, Utf8Text callerContext, Utf8Text displayContext) implements OperationInput {

    private static final int MAX_CWD_BYTES = 512;

    public SourceInput {
        Objects.requireNonNull(launcher, "launcher");
        Objects.requireNonNull(planDigest, "planDigest");
        Objects.requireNonNull(sourceSha256, "sourceSha256");
        Objects.requireNonNull(argvJson, "argvJson");
        Objects.requireNonNull(cwd, "cwd");
        Objects.requireNonNull(elevation, "elevation");
        Objects.requireNonNull(environmentRevision, "environmentRevision");
        Objects.requireNonNull(callerContext, "callerContext");
        Objects.requireNonNull(displayContext, "displayContext");
        if (sourceBytes < 1 || sourceBytes > SourceText.MAX_BYTES) {
            throw new IllegalArgumentException("A source is 1 to " + SourceText.MAX_BYTES + " UTF-8 bytes");
        }
        if (cwd.byteLength() > MAX_CWD_BYTES) {
            throw new IllegalArgumentException("A working directory is at most " + MAX_CWD_BYTES + " UTF-8 bytes");
        }
    }

    @Override
    public OperationKind kind() {
        return OperationKind.SOURCE;
    }

    @Override
    public CanonicalForm describeTo(CanonicalForm form) {
        return form.field("input.kind", "source").field("source.launcher", launcher.value()).field("source.planDigest", planDigest.hex())
            .field("source.sha256", sourceSha256.hex()).field("source.bytes", sourceBytes).field("source.argv", argvJson.value()).field("source.cwd", cwd.value())
            .field("source.elevation", elevation.name()).field("source.environmentRevision", environmentRevision.hex())
            .field("source.callerContext", callerContext.value()).field("source.displayContext", displayContext.value());
    }
}
