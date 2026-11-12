package io.github.jaeseongs95.portal.ssh.platform;

import io.github.jaeseongs95.portal.domain.agentcli.AgentCliProviderId;
import io.github.jaeseongs95.portal.domain.agentcli.AgentRelease;
import java.util.Objects;

/**
 * Where an agent CLI lives under the home directory of the account the profile logs in with: {@code .ssh-approval-portal/agent-cli/<tool>/}, with
 * {@code versions/<version>-<first 16 hex of the release digest>/} for each installed release, {@code versions/<...>.partial/} while one is being put there, and
 * {@code current} pointing at the release in use. The relative path uses {@code /}: SFTP takes it on every operating system, and each platform writes the same place in
 * its own shell syntax. The path of a release is made from the validated parts of the release (a version of three numbers and a hexadecimal digest), so no text of a caller
 * is in it.
 *
 * @param provider the tool
 * @param release the release the directory name is made of
 */
public record AgentCliLayout(AgentCliProviderId provider, AgentRelease release) {

    private static final String BASE = ".ssh-approval-portal/agent-cli";
    private static final int DIGEST_CHARACTERS = 16;

    public AgentCliLayout {
        Objects.requireNonNull(provider, "provider");
        Objects.requireNonNull(release, "release");
        if (release.provider() != provider) {
            throw new IllegalArgumentException("The release is of another provider");
        }
    }

    /** The directory of the tool, relative to the home directory, written with {@code /}. */
    public String providerRoot() {
        return providerRoot(provider);
    }

    /** The directory of a tool, relative to the home directory, written with {@code /}. */
    public static String providerRoot(AgentCliProviderId tool) {
        return BASE + "/" + tool.wire();
    }

    /** The name of the directory of this release: {@code <version>-<16 hex>}. */
    public String versionDirectory() {
        return release.version() + "-" + release.releaseDigest().hex().substring(0, DIGEST_CHARACTERS);
    }

    /** The release directory relative to the home directory. */
    public String finalDirectory() {
        return providerRoot() + "/versions/" + versionDirectory();
    }

    /** The partial directory of this release, relative to the home directory. */
    public String partialDirectory() {
        return finalDirectory() + ".partial";
    }

    /** The {@code current} link of the tool, relative to the home directory. */
    public String currentLink() {
        return providerRoot() + "/current";
    }
}
