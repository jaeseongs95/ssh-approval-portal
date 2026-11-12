package io.github.jaeseongs95.portal.ssh.session;

import java.util.List;

/**
 * The algorithm names a client offers, in the order it offers them, and the names of the 2.x list that this MINA and this JVM cannot provide (they are left out of the
 * offer, and {@code unsupported} says so: stage 3 design 3.6, "the unsupported name leaves the list and the fact is written down").
 *
 * @param keyExchanges the key exchange names
 * @param ciphers the cipher names
 * @param hostKeys the host key algorithm names
 * @param macs the MAC names
 * @param unsupported the names of the fixed list that are not offered, each with its kind ({@code kex:}, {@code cipher:}, {@code hostkey:}, {@code mac:})
 */
public record AlgorithmSelection(List<String> keyExchanges, List<String> ciphers, List<String> hostKeys, List<String> macs, List<String> unsupported) {
    public AlgorithmSelection {
        keyExchanges = List.copyOf(keyExchanges);
        ciphers = List.copyOf(ciphers);
        hostKeys = List.copyOf(hostKeys);
        macs = List.copyOf(macs);
        unsupported = List.copyOf(unsupported);
    }
}
