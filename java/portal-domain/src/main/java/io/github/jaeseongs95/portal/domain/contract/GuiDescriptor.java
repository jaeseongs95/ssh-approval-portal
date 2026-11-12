package io.github.jaeseongs95.portal.domain.contract;

import com.fasterxml.jackson.annotation.JsonInclude;
import java.util.List;
import java.util.Objects;

/**
 * What the desktop (GUI) of a target offers an agent (public-contract.mjs:48-51, {@code guiDescriptor}). {@code configured} is not an opened or verified desktop.
 * {@code requiresUserClient} is the contract's promise that no user RDP client is needed and is always {@code false}.
 *
 * <p>A null {@code backend}, {@code lifecycle} or {@code reason} is the wire null (null = wire null). A null {@code openRequest} is not written at all: the
 * baseline's {@code openRequest} is optional and never null.
 */
@JsonInclude(JsonInclude.Include.ALWAYS)
public record GuiDescriptor(boolean configured, GuiBackendWire backend, GuiLifecycleWire lifecycle, GuiStatusWire status, String reason, List<GuiActionWire> actions,
                            boolean requiresUserClient, @JsonInclude(JsonInclude.Include.NON_NULL) GuiOpenRequest openRequest) {

    /** The longest {@code reason}, in UTF-16 units as the 2.x schema counts them. */
    public static final int MAX_REASON_LENGTH = 256;
    /** The most actions a descriptor lists: one for each of observe, pointer, key and text. */
    public static final int MAX_ACTIONS = 4;

    public GuiDescriptor {
        Objects.requireNonNull(status, "status");
        if (reason != null && reason.length() > MAX_REASON_LENGTH) {
            throw new IllegalArgumentException("reason is longer than " + MAX_REASON_LENGTH);
        }
        actions = List.copyOf(actions);
        if (actions.size() > MAX_ACTIONS) {
            throw new IllegalArgumentException("actions has more than " + MAX_ACTIONS + " entries");
        }
        if (requiresUserClient) {
            throw new IllegalArgumentException("The contract promises requiresUserClient is false");
        }
    }
}
