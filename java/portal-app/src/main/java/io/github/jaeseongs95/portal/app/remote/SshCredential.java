package io.github.jaeseongs95.portal.app.remote;

import java.util.Objects;

import io.github.jaeseongs95.portal.domain.target.Setting;

/**
 * What a connection profile proves itself with. The secret values are {@link SecretValue}s, so none of them is in the text of a credential, of a log line or of an
 * exception; the other parts (a public certificate) are not secret. Which variant a profile gets follows its {@code AuthMethod}.
 */
public sealed interface SshCredential permits SshCredential.Agent, SshCredential.Password, SshCredential.PrivateKey {

    /** The SSH agent of the server's account answers; there is nothing to carry. */
    record Agent() implements SshCredential {
    }

    /** A password. */
    record Password(SecretValue password) implements SshCredential {

        public Password {
            Objects.requireNonNull(password, "password");
        }
    }

    /**
     * A private key in PEM text, with the passphrase and the certificate if there are any.
     *
     * @param pem the private key
     * @param passphrase the passphrase of the key, when it has one
     * @param certificate the OpenSSH certificate text that goes with the key, when there is one; public data
     */
    record PrivateKey(SecretValue pem, Setting<SecretValue> passphrase, Setting<String> certificate) implements SshCredential {

        public PrivateKey {
            Objects.requireNonNull(pem, "pem");
            Objects.requireNonNull(passphrase, "passphrase");
            Objects.requireNonNull(certificate, "certificate");
        }
    }
}
