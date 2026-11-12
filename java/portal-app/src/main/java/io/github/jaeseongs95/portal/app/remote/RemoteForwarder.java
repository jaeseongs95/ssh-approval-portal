package io.github.jaeseongs95.portal.app.remote;

/** Opens {@code direct-tcpip} channels through a target's connection. Only the name and the signature are fixed in stage 3; the desktop module of stage 5 uses it. */
public interface RemoteForwarder {

    ForwardOpenResult open(ForwardRequest request, ExecutionControl control);
}
