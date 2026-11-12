package io.github.jaeseongs95.portal.app.remote;

import java.util.List;
import java.util.Objects;

import io.github.jaeseongs95.portal.domain.target.AuthMethod;

/** The answer to "which credential does this profile use": found, not there, or of a kind this installation does not support. */
public sealed interface CredentialLookup permits CredentialLookup.Resolved, CredentialLookup.Missing, CredentialLookup.Unsupported {

    /** The credential is complete. */
    record Resolved(SshCredential credential) implements CredentialLookup {

        public Resolved {
            Objects.requireNonNull(credential, "credential");
        }
    }

    /**
     * No source has the credential.
     *
     * @param misses the places that were searched, at least one
     */
    record Missing(List<CredentialMiss> misses) implements CredentialLookup {

        public Missing {
            misses = List.copyOf(misses);
            if (misses.isEmpty()) {
                throw new IllegalArgumentException("A missing credential names at least one place that was searched");
            }
        }
    }

    /** The profile's authentication method is not supported (the system keychain). */
    record Unsupported(AuthMethod method) implements CredentialLookup {

        public Unsupported {
            Objects.requireNonNull(method, "method");
        }
    }
}
