package io.github.jaeseongs95.portal.archchecks.fixtures.s3.app.remote;

/** The one flag query A-REMOTE-RESULT allows to answer with boolean: it reports a request that was made, not an outcome of the remote side. */
public interface CancelToken {
    boolean requested();
}
