package io.github.jaeseongs95.portal.ssh.session;

import java.util.ArrayList;
import java.util.List;
import java.util.function.Predicate;
import org.apache.sshd.client.ClientBuilder;
import org.apache.sshd.client.SshClient;
import org.apache.sshd.common.cipher.BuiltinCiphers;
import org.apache.sshd.common.kex.BuiltinDHFactories;
import org.apache.sshd.common.kex.KeyExchangeFactory;
import org.apache.sshd.common.mac.BuiltinMacs;
import org.apache.sshd.common.signature.BuiltinSignatures;
import org.springframework.stereotype.Component;

/**
 * The algorithms a client offers: the fixed lists of 2.x ({@code ssh/algorithms.js:3-31}, vendor rules CR-24 to CR-27, in the same order), cut down to what MINA 2.20.1 on
 * this JVM supports (pilot P3-3 showed every name of the lists is supported once BouncyCastle is on the class path, ssh-ed25519 included). The two weak families the lists
 * never had (SHA-1 signatures and MACs, CBC ciphers, group 1 and the SHA-1 group exchange) are not offered because the lists do not name them.
 */
@Component
public final class SshAlgorithmPolicy {

    /** CR-24 */
    static final List<String> KEY_EXCHANGES = List.of("curve25519-sha256", "curve25519-sha256@libssh.org", "ecdh-sha2-nistp256", "ecdh-sha2-nistp384", "ecdh-sha2-nistp521",
        "diffie-hellman-group16-sha512", "diffie-hellman-group14-sha256");
    /** CR-25 */
    static final List<String> CIPHERS = List.of("chacha20-poly1305@openssh.com", "aes256-gcm@openssh.com", "aes128-gcm@openssh.com", "aes256-ctr", "aes192-ctr", "aes128-ctr");
    /** CR-26 */
    static final List<String> HOST_KEYS = List.of("ssh-ed25519", "ecdsa-sha2-nistp256", "ecdsa-sha2-nistp384", "ecdsa-sha2-nistp521", "rsa-sha2-512", "rsa-sha2-256");
    /** CR-27 */
    static final List<String> MACS = List.of("hmac-sha2-256-etm@openssh.com", "hmac-sha2-512-etm@openssh.com", "hmac-sha2-256", "hmac-sha2-512");

    /** The selection this MINA and JVM can offer. */
    public AlgorithmSelection selection() {
        List<String> unsupported = new ArrayList<>();
        List<String> keyExchanges = supported("kex:", KEY_EXCHANGES, unsupported, name -> {
            BuiltinDHFactories factory = BuiltinDHFactories.fromFactoryName(name);
            return factory != null && factory.isSupported();
        });
        List<String> ciphers = supported("cipher:", CIPHERS, unsupported, name -> {
            BuiltinCiphers cipher = BuiltinCiphers.fromFactoryName(name);
            return cipher != null && cipher.isSupported();
        });
        List<String> hostKeys = supported("hostkey:", HOST_KEYS, unsupported, name -> {
            BuiltinSignatures signature = BuiltinSignatures.fromFactoryName(name);
            return signature != null && signature.isSupported();
        });
        List<String> macs = supported("mac:", MACS, unsupported, name -> {
            BuiltinMacs mac = BuiltinMacs.fromFactoryName(name);
            return mac != null && mac.isSupported();
        });
        return new AlgorithmSelection(keyExchanges, ciphers, hostKeys, macs, unsupported);
    }

    /** Offers {@link #selection()} to the client, in order. */
    public AlgorithmSelection apply(SshClient client) {
        AlgorithmSelection selection = selection();
        List<KeyExchangeFactory> exchanges = new ArrayList<>();
        for (String name : selection.keyExchanges()) {
            exchanges.add(ClientBuilder.DH2KEX.apply(BuiltinDHFactories.fromFactoryName(name)));
        }
        client.setKeyExchangeFactories(exchanges);
        client.setCipherFactoriesNames(selection.ciphers());
        client.setSignatureFactoriesNames(selection.hostKeys());
        client.setMacFactoriesNames(selection.macs());
        return selection;
    }

    private List<String> supported(String kind, List<String> names, List<String> unsupported, Predicate<String> isSupported) {
        List<String> offered = new ArrayList<>();
        for (String name : names) {
            if (isSupported.test(name)) {
                offered.add(name);
            } else {
                unsupported.add(kind + name);
            }
        }
        return offered;
    }
}
