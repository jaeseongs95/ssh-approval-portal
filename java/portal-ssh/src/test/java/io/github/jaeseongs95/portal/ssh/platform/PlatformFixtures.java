package io.github.jaeseongs95.portal.ssh.platform;

import io.github.jaeseongs95.portal.domain.agentcli.AgentCliAction;
import io.github.jaeseongs95.portal.domain.agentcli.AgentCliIntent;
import io.github.jaeseongs95.portal.domain.agentcli.AgentCliProvider;
import io.github.jaeseongs95.portal.domain.agentcli.AgentCliProviderId;
import io.github.jaeseongs95.portal.domain.agentcli.AgentRelease;
import io.github.jaeseongs95.portal.domain.agentcli.ClaudeCliProvider;
import io.github.jaeseongs95.portal.domain.agentcli.CodexCliProvider;
import io.github.jaeseongs95.portal.domain.id.Digest;
import io.github.jaeseongs95.portal.domain.id.RequestKey;
import io.github.jaeseongs95.portal.domain.id.Sha256Digester;
import io.github.jaeseongs95.portal.domain.id.TargetId;
import io.github.jaeseongs95.portal.domain.target.CapacityOverride;
import io.github.jaeseongs95.portal.domain.target.DesktopSettings;
import io.github.jaeseongs95.portal.domain.target.ProfileAlias;
import io.github.jaeseongs95.portal.domain.target.Setting;
import io.github.jaeseongs95.portal.domain.target.Target;
import io.github.jaeseongs95.portal.domain.target.TargetDisplayName;
import io.github.jaeseongs95.portal.domain.target.TargetOs;
import io.github.jaeseongs95.portal.domain.target.TargetRevision;
import io.github.jaeseongs95.portal.domain.target.Toggle;
import io.github.jaeseongs95.portal.domain.target.WindowsPythonExecutable;
import io.github.jaeseongs95.portal.domain.target.WindowsRuntime;
import java.time.Instant;
import java.util.Base64;

/** Plain builders of the domain values the platform tests need: a target of either system, a release of a tool, the intent to install it. */
public final class PlatformFixtures {

    public static final String VERSION = "1.2.3";
    private final Sha256Digester digester = new Sha256Digester();

    /** An enabled target of the system; a Windows target has a Python configured when {@code python} is true. */
    public Target target(TargetOs os, boolean python) {
        WindowsRuntime runtime = python
            ? new WindowsRuntime(Setting.unset(), Setting.given(new WindowsPythonExecutable("C:\\Python313\\python.exe")))
            : WindowsRuntime.none();
        return new Target(new TargetId("files"), TargetDisplayName.of("Files"), new ProfileAlias("reader"), new ProfileAlias("writer"), new ProfileAlias("rev1"), Toggle.ON, os,
            os == TargetOs.WINDOWS ? runtime : WindowsRuntime.none(), new CapacityOverride.Inherited(), new CapacityOverride.Inherited(), new DesktopSettings.NoDesktop());
    }

    /** The integrity value of the bytes of a package: {@code sha512-} and the base64 of the SHA-512 (what the npm registry announces). */
    public String integrityOf(byte[] sha512) {
        return "sha512-" + Base64.getEncoder().encodeToString(sha512);
    }

    /** A release of the tool with the given integrity. */
    public AgentRelease release(AgentCliProviderId tool, String integrity) {
        AgentCliProvider provider = tool == AgentCliProviderId.CODEX ? new CodexCliProvider() : new ClaudeCliProvider();
        String name = provider.packageName();
        String file = name.substring(name.lastIndexOf('/') + 1);
        return AgentRelease.verify(provider, name, VERSION, "https://registry.npmjs.org/" + name + "/-/" + file + "-" + VERSION + ".tgz", integrity, digester);
    }

    /** An intent to install the release; the platform reads only the tool from it. */
    public AgentCliIntent intent(AgentRelease release) {
        Digest any = digester.digestUtf8("any");
        return new AgentCliIntent(new TargetId("files"), TargetRevision.of("a".repeat(64)), new ProfileAlias("writer"), release.provider(), AgentCliAction.INSTALL,
            release.releaseDigest(), any, Instant.parse("2030-01-01T00:00:00Z"), any, new RequestKey("fixture-request-key-0001"));
    }
}
