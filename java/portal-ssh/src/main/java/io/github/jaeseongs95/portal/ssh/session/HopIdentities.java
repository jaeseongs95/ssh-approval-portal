package io.github.jaeseongs95.portal.ssh.session;

import io.github.jaeseongs95.portal.app.remote.SecretValue;
import io.github.jaeseongs95.portal.app.remote.SshCredential;
import io.github.jaeseongs95.portal.domain.target.Setting;
import java.io.ByteArrayInputStream;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.security.GeneralSecurityException;
import java.security.KeyPair;
import java.util.Arrays;
import java.util.List;
import org.apache.sshd.client.auth.password.PasswordIdentityProvider;
import org.apache.sshd.common.NamedResource;
import org.apache.sshd.common.config.keys.FilePasswordProvider;
import org.apache.sshd.common.keyprovider.KeyIdentityProvider;
import org.apache.sshd.common.session.SessionContext;
import org.apache.sshd.common.util.security.SecurityUtils;

/**
 * The identities MINA offers to a server, chosen by the credential of the profile of that server ({@link HopRouting}): the one place a {@link SecretValue} is revealed,
 * and only to hand its characters to MINA. The SSH agent is not supported by this adapter: an {@code Agent} credential offers nothing, so the login fails.
 * The certificate of a key credential is not offered either.
 */
final class HopIdentities implements PasswordIdentityProvider, KeyIdentityProvider {

    private final HopRouting routing;
    private final ConnectAttempt attempt;

    HopIdentities(HopRouting routing, ConnectAttempt attempt) {
        this.routing = routing;
        this.attempt = attempt;
    }

    @Override
    public Iterable<String> loadPasswords(SessionContext session) {
        Hop hop = routing.find(session);
        attempt.credentialAsked(hop);
        if (hop.credential() instanceof SshCredential.Password password) {
            char[] characters = password.password().reveal();
            String text = String.valueOf(characters);
            Arrays.fill(characters, '\0');
            return List.of(text);
        }
        return List.of();
    }

    @Override
    public Iterable<KeyPair> loadKeys(SessionContext session) throws IOException, GeneralSecurityException {
        Hop hop = routing.find(session);
        attempt.credentialAsked(hop);
        if (!(hop.credential() instanceof SshCredential.PrivateKey key)) {
            return List.of();
        }
        char[] pem = key.pem().reveal();
        byte[] bytes = String.valueOf(pem).getBytes(StandardCharsets.UTF_8);
        Arrays.fill(pem, '\0');
        FilePasswordProvider passphrase = FilePasswordProvider.EMPTY;
        if (key.passphrase() instanceof Setting.Given<SecretValue> given) {
            char[] characters = given.value().reveal();
            passphrase = FilePasswordProvider.of(String.valueOf(characters));
            Arrays.fill(characters, '\0');
        }
        Iterable<KeyPair> keys = SecurityUtils.loadKeyPairIdentities(session, NamedResource.ofName(hop.alias().value()), new ByteArrayInputStream(bytes), passphrase);
        Arrays.fill(bytes, (byte) 0);
        return keys == null ? List.of() : keys;
    }
}
