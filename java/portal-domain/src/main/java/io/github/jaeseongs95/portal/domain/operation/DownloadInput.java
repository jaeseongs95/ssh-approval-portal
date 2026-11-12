package io.github.jaeseongs95.portal.domain.operation;

import io.github.jaeseongs95.portal.domain.file.FileBinding;
import io.github.jaeseongs95.portal.domain.id.CanonicalForm;
import io.github.jaeseongs95.portal.domain.path.RemotePath;
import io.github.jaeseongs95.portal.domain.text.Utf8Text;
import java.util.Objects;

/** A file on the target that is to be read and stored on the server. */
public record DownloadInput(RemotePath remotePath, Elevation elevation, FileBinding binding, Utf8Text callerContext, Utf8Text displayContext) implements OperationInput {

    public DownloadInput {
        Objects.requireNonNull(remotePath, "remotePath");
        Objects.requireNonNull(elevation, "elevation");
        Objects.requireNonNull(binding, "binding");
        Objects.requireNonNull(callerContext, "callerContext");
        Objects.requireNonNull(displayContext, "displayContext");
    }

    @Override
    public OperationKind kind() {
        return OperationKind.DOWNLOAD;
    }

    @Override
    public CanonicalForm describeTo(CanonicalForm form) {
        CanonicalForm described = form.field("input.kind", "download").field("download.remotePath", remotePath.value()).field("download.elevation", elevation.name())
            .field("download.callerContext", callerContext.value()).field("download.displayContext", displayContext.value());
        return binding.describeTo(described);
    }
}
