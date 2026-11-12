package io.github.jaeseongs95.portal.domain.operation;

/** How an upload reached the server: {@link #UNSPECIFIED} for an upload made through the owner's console, {@link #MCP_JSON_V1} through the MCP contract. */
public enum UploadProtocol {
    UNSPECIFIED, MCP_JSON_V1
}
