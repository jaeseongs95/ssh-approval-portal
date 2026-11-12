package io.github.jaeseongs95.portal.domain.contract;

import com.fasterxml.jackson.annotation.JsonInclude;
import com.fasterxml.jackson.annotation.JsonProperty;
import java.util.Objects;

/**
 * One target of the {@code targets} answer (public-contract.mjs:51-56, {@code targets[]}). A null {@code revision} or {@code filePolicy} is the wire null
 * (null = wire null): a target that cannot be addressed has no revision. A null {@code gui} is not written at all: the baseline's {@code gui} is optional and
 * never null, and it is present only when the portal has a desktop provider.
 *
 * <p>The component is named {@code isDefault} on the wire; {@link JsonProperty} pins that name so that it is not read as the bean property {@code default}.
 */
@JsonInclude(JsonInclude.Include.ALWAYS)
public record TargetData(String id, String displayName, boolean enabled, @JsonProperty("isDefault") boolean isDefault, String revision, PlatformWire platform,
                         TargetCapabilitiesData capabilities, @JsonInclude(JsonInclude.Include.NON_NULL) GuiDescriptor gui, FilePolicyData filePolicy) {

    public TargetData {
        WireFormat.TARGET.require(id, "id");
        Objects.requireNonNull(displayName, "displayName");
        WireFormat.DIGEST.requireOrNull(revision, "revision");
        Objects.requireNonNull(platform, "platform");
        Objects.requireNonNull(capabilities, "capabilities");
    }
}
