package io.github.jaeseongs95.portal.ssh.profile;

import java.util.Map;
import java.util.stream.Collectors;

import org.springframework.core.env.PropertySource;

import io.github.jaeseongs95.portal.app.remote.SecretValue;

/**
 * The {@code SSH_MCP_*} entries of a secret environment file as a Spring property source, so that {@code EnvironmentCredentialSource} reads them from the {@code Environment}
 * like any other setting. Only names that start with {@code SSH_MCP_} (upper case, as 2.x copied them, vendor.mjs:177) are in it. It is added to the environment before
 * the system environment, so a value of the file wins over a variable of the process (2.x secrets.mjs:23). The values stay {@link SecretValue}s until they are asked for,
 * so the text of this source (which Spring prints at debug level) holds no secret.
 */
public final class SecretEnvPropertySource extends PropertySource<Map<String, SecretValue>> {

    private static final String PREFIX = "SSH_MCP_";

    public SecretEnvPropertySource(String name, Map<String, SecretValue> entries) {
        super(name, entries.entrySet().stream().filter(entry -> entry.getKey().startsWith(PREFIX)).collect(Collectors.toUnmodifiableMap(Map.Entry::getKey, Map.Entry::getValue)));
    }

    @Override
    public Object getProperty(String name) {
        SecretValue value = source.get(name);
        return value == null ? null : new String(value.reveal());
    }
}
