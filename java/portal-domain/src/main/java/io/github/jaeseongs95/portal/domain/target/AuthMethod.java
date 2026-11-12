package io.github.jaeseongs95.portal.domain.target;

/** How a connection profile proves itself to the target (vendor profile schema, config/schema.js:2): by the SSH agent, a key, a password, or the system keychain. */
public enum AuthMethod {
    AGENT, KEY, PASSWORD, KEYCHAIN
}
