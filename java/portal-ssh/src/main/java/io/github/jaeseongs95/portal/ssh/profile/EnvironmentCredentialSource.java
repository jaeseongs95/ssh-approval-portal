package io.github.jaeseongs95.portal.ssh.profile;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.InvalidPathException;
import java.nio.file.Path;
import java.util.List;
import java.util.Objects;
import java.util.Optional;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.core.env.Environment;
import org.springframework.stereotype.Component;

import io.github.jaeseongs95.portal.app.remote.CredentialLookup;
import io.github.jaeseongs95.portal.app.remote.CredentialMiss;
import io.github.jaeseongs95.portal.app.remote.CredentialPart;
import io.github.jaeseongs95.portal.app.remote.SecretValue;
import io.github.jaeseongs95.portal.app.remote.SshCredential;
import io.github.jaeseongs95.portal.app.remote.SshCredentialSource;
import io.github.jaeseongs95.portal.domain.target.AuthMethod;
import io.github.jaeseongs95.portal.domain.target.ConnectionProfile;
import io.github.jaeseongs95.portal.domain.target.ProfileAlias;
import io.github.jaeseongs95.portal.domain.target.Setting;

/**
 * The {@link SshCredentialSource} that reads the {@code SSH_MCP_*} settings of 2.x from the Spring {@link Environment} (EV-01 to EV-13, decision D3-09). The names are the
 * names of 2.x, so a secret environment file of 2.x keeps working: for a profile with the prefix {@code SSH_MCP_<NAME>} (see {@link CredentialPrefix}) the variables
 * {@code <prefix>_PASSWORD}, {@code <prefix>_PASSPHRASE}, {@code <prefix>_KEY} and {@code <prefix>_CERT}; for every profile the global {@code SSH_MCP_PASSWORD},
 * {@code SSH_MCP_PASSPHRASE} and {@code SSH_MCP_KEY}; the {@code keyRef} of the profile; and {@code SSH_AUTH_SOCK} for an agent. A variable of the profile wins over the
 * global one, and an empty variable counts as no variable. The code never calls {@code System.getenv}: the environment is an argument, so a test and a secret file
 * (see {@link SecretEnvPropertySource}) put their values in it the same way.
 *
 * <p><b>What a profile gets follows its authentication method</b> (the sealed {@link SshCredential} has one variant per method): {@code agent} gets the agent when
 * {@code SSH_AUTH_SOCK} is set; {@code password} gets the password; {@code key} gets the key text of the file that {@code keyRef}, {@code <prefix>_KEY} or
 * {@code SSH_MCP_KEY} names (in that order), with the passphrase and, when the profile says {@code cert = true}, the certificate ({@code <prefix>_CERT} or
 * {@code <key file without .pub>-cert.pub} next to the key); {@code keychain} is {@link CredentialLookup.Unsupported}. 2.x collected every source whatever the method
 * was (EV-10); the result here carries only what the method uses. A key file that is missing, empty or unreadable is a {@link CredentialLookup.Missing} that names the
 * file (2.x skipped a missing file silently); an unreadable file is logged with its cause. A leading {@code ~} name of a key path is the home folder ({@code HOME}, else
 * {@code user.home}); a name that starts with {@code ~} and a user name is not expanded. Nothing is made of {@code SSH_MCP_SUDO_PASSWORD}: 2.x never read it (EV-03).
 *
 * <p>The secrets are {@link SecretValue}s from the moment they are read, and nothing here logs, prints or puts them in a message: a {@link CredentialMiss} names the
 * variable or the file that was searched.
 */
@Component
public final class EnvironmentCredentialSource implements SshCredentialSource {

    private static final Logger LOG = LoggerFactory.getLogger(EnvironmentCredentialSource.class);
    private static final String GLOBAL_PASSWORD = "SSH_MCP_PASSWORD";
    private static final String GLOBAL_PASSPHRASE = "SSH_MCP_PASSPHRASE";
    private static final String GLOBAL_KEY = "SSH_MCP_KEY";
    private static final String AGENT_SOCKET = "SSH_AUTH_SOCK";
    private static final String HOME_NAME = "~";
    private static final String CERTIFICATE_SUFFIX = "-cert.pub";
    private static final String PUBLIC_KEY_SUFFIX = ".pub";

    /** What reading a file gave. */
    private sealed interface FileRead permits FileRead.Text, FileRead.Absent, FileRead.Unreadable {

        /** The text of the file. */
        record Text(String text) implements FileRead {
        }

        /** There is no such file (2.x skipped it silently, {@code ENOENT}). */
        record Absent() implements FileRead {
        }

        /** The file is there and cannot be read (2.x threw). */
        record Unreadable() implements FileRead {
        }
    }

    private final Environment environment;
    private final ProfileCatalog catalog;

    public EnvironmentCredentialSource(Environment environment, ProfileCatalog catalog) {
        this.environment = Objects.requireNonNull(environment, "environment");
        this.catalog = Objects.requireNonNull(catalog, "catalog");
    }

    @Override
    public CredentialLookup resolve(ProfileAlias alias, ConnectionProfile profile) {
        Objects.requireNonNull(alias, "alias");
        Objects.requireNonNull(profile, "profile");
        CredentialPrefix prefix = CredentialPrefix.of(alias.value());
        return switch (profile.auth()) {
            case AGENT -> agent();
            case PASSWORD -> password(prefix);
            case KEY -> privateKey(alias, prefix, profile);
            case KEYCHAIN -> new CredentialLookup.Unsupported(AuthMethod.KEYCHAIN);
        };
    }

    private CredentialLookup agent() {
        return text(AGENT_SOCKET).<CredentialLookup>map(socket -> new CredentialLookup.Resolved(new SshCredential.Agent()))
            .orElseGet(() -> missing(CredentialPart.PRIVATE_KEY, AGENT_SOCKET));
    }

    private CredentialLookup password(CredentialPrefix prefix) {
        String own = prefix.variable("PASSWORD");
        return secret(own).or(() -> secret(GLOBAL_PASSWORD)).<CredentialLookup>map(password -> new CredentialLookup.Resolved(new SshCredential.Password(password)))
            .orElseGet(() -> new CredentialLookup.Missing(List.of(new CredentialMiss(CredentialPart.PASSWORD, own), new CredentialMiss(CredentialPart.PASSWORD, GLOBAL_PASSWORD))));
    }

    private CredentialLookup privateKey(ProfileAlias alias, CredentialPrefix prefix, ConnectionProfile profile) {
        String ownKey = prefix.variable("KEY");
        return keyReference(profile).or(() -> text(ownKey)).or(() -> text(GLOBAL_KEY))
            .map(keyText -> privateKeyAt(keyText, alias, prefix))
            .orElseGet(() -> new CredentialLookup.Missing(List.of(new CredentialMiss(CredentialPart.KEY_REFERENCE, "keyRef of the profile"),
                new CredentialMiss(CredentialPart.PRIVATE_KEY, ownKey), new CredentialMiss(CredentialPart.PRIVATE_KEY, GLOBAL_KEY))));
    }

    private CredentialLookup privateKeyAt(String keyText, ProfileAlias alias, CredentialPrefix prefix) {
        Path keyFile;
        try {
            keyFile = locate(keyText);
        } catch (InvalidPathException e) {
            LOG.warn("The key path {} of the profile {} is not a valid path", keyText, alias.value(), e);
            return missing(CredentialPart.PRIVATE_KEY, "the key file " + keyText + " cannot be read");
        }
        return switch (read(keyFile)) {
            case FileRead.Text key when key.text().isEmpty() -> missing(CredentialPart.PRIVATE_KEY, "the key file " + keyText + " is empty");
            case FileRead.Text key -> withPassphraseAndCertificate(SecretValue.of(key.text()), alias, prefix, keyFile);
            case FileRead.Absent absent -> missing(CredentialPart.PRIVATE_KEY, "the key file " + keyText + " does not exist");
            case FileRead.Unreadable unreadable -> missing(CredentialPart.PRIVATE_KEY, "the key file " + keyText + " cannot be read");
        };
    }

    private CredentialLookup withPassphraseAndCertificate(SecretValue pem, ProfileAlias alias, CredentialPrefix prefix, Path keyFile) {
        Setting<SecretValue> passphrase = secret(prefix.variable("PASSPHRASE")).or(() -> secret(GLOBAL_PASSPHRASE)).<Setting<SecretValue>>map(Setting::given)
            .orElseGet(Setting::unset);
        if (!catalog.wantsCertificate(alias)) {
            return new CredentialLookup.Resolved(new SshCredential.PrivateKey(pem, passphrase, Setting.unset()));
        }
        Path certFile;
        try {
            certFile = text(prefix.variable("CERT")).map(this::locate).orElseGet(() -> certificateNextTo(keyFile));
        } catch (InvalidPathException e) {
            LOG.warn("The certificate path of the profile {} is not a valid path", alias.value(), e);
            return missing(CredentialPart.CERTIFICATE, "the certificate file cannot be read");
        }
        return switch (read(certFile)) {
            case FileRead.Text certificate -> new CredentialLookup.Resolved(new SshCredential.PrivateKey(pem, passphrase, Setting.given(certificate.text())));
            case FileRead.Absent absent -> new CredentialLookup.Resolved(new SshCredential.PrivateKey(pem, passphrase, Setting.unset()));
            case FileRead.Unreadable unreadable -> missing(CredentialPart.CERTIFICATE, "the certificate file " + certFile + " cannot be read");
        };
    }

    private CredentialLookup missing(CredentialPart part, String place) {
        return new CredentialLookup.Missing(List.of(new CredentialMiss(part, place)));
    }

    private Optional<String> keyReference(ConnectionProfile profile) {
        return profile.keyRef() instanceof Setting.Given<String> given && !given.value().isEmpty() ? Optional.of(given.value()) : Optional.empty();
    }

    /** The certificate that goes with a key file: {@code id-cert.pub} next to {@code id} or {@code id.pub}. */
    private Path certificateNextTo(Path keyFile) {
        String name = keyFile.getFileName().toString();
        String stem = name.endsWith(PUBLIC_KEY_SUFFIX) ? name.substring(0, name.length() - PUBLIC_KEY_SUFFIX.length()) : name;
        return keyFile.resolveSibling(stem + CERTIFICATE_SUFFIX);
    }

    /** The value of a setting; an empty value is no value (2.x tested the variable for truth). */
    private Optional<String> text(String name) {
        String value = environment.getProperty(name);
        return value == null || value.isEmpty() ? Optional.empty() : Optional.of(value);
    }

    private Optional<SecretValue> secret(String name) {
        return text(name).map(SecretValue::of);
    }

    /** The path of a file as the configuration spells it; a first name {@code ~} is the home folder when one is known. */
    private Path locate(String spelling) {
        Path path = Path.of(spelling);
        if (path.getRoot() != null || path.getNameCount() == 0 || !HOME_NAME.equals(path.getName(0).toString())) {
            return path;
        }
        return text("HOME").or(() -> text("user.home")).map(Path::of)
            .map(home -> path.getNameCount() == 1 ? home : home.resolve(path.subpath(1, path.getNameCount())))
            .orElse(path);
    }

    private FileRead read(Path file) {
        if (!Files.exists(file)) {
            return new FileRead.Absent();
        }
        try {
            return new FileRead.Text(Files.readString(file, StandardCharsets.UTF_8));
        } catch (IOException e) {
            LOG.warn("The file {} cannot be read", file, e);
            return new FileRead.Unreadable();
        }
    }
}
