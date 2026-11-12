package io.github.jaeseongs95.portal.app.remote;

import io.github.jaeseongs95.portal.app.storage.PayloadRead;

/**
 * The bytes an upload sends, as the caller opens them (the use case opens the artifact payload outside any transaction; the adapter only reads and forwards). Each
 * call opens a read of its own, so a transfer can read the bytes again to verify them; the adapter closes every read it opens.
 */
public interface PayloadSource {

    PayloadRead open();
}
