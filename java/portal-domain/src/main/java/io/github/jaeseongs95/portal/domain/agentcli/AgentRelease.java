package io.github.jaeseongs95.portal.domain.agentcli;

import java.util.Base64;
import java.util.Objects;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

import io.github.jaeseongs95.portal.domain.id.Digest;
import io.github.jaeseongs95.portal.domain.id.Digester;

/**
 * One release of an agent tool as the public registry announced it, kept to the five public distribution fields and the digest of them (2.x agent-cli.mjs:21-33).
 * The registry's metadata is untrusted: only a stable version, the registry's own address for that version and a sha512 checksum are accepted, so a release plan
 * can never point to another host or to a floating tag.
 *
 * <p>The record checks the shape of its parts. That {@code releaseDigest} really is the digest of the other fields is checked with a {@link Digester}
 * ({@link #digestMatches}), because a value does not hold a hash function.
 */
public record AgentRelease(AgentCliProviderId provider, String packageName, String version, String tarball, String integrity, Digest releaseDigest) {

    /** Three numbers of up to six digits without leading zeros: no tag, range, pre-release or build part (2.x agent-cli.mjs:12). */
    private static final Pattern VERSION = Pattern.compile("(0|[1-9][0-9]{0,5})(\\.(0|[1-9][0-9]{0,5})){2}");
    private static final Pattern PACKAGE = Pattern.compile("(@[a-z0-9][a-z0-9._-]*/)?[a-z0-9][a-z0-9._-]*");
    /** {@code sha512-} and 86 base64 characters and {@code ==}: the base64 of exactly 64 bytes. */
    private static final Pattern INTEGRITY = Pattern.compile("sha512-([A-Za-z0-9+/]{86})==");
    private static final String REGISTRY = "https://registry.npmjs.org/";
    private static final int SHA512_BYTES = 64;
    private static final String DIGEST_LABEL = "sha256:";

    public AgentRelease {
        Objects.requireNonNull(provider, "provider");
        Objects.requireNonNull(packageName, "packageName");
        Objects.requireNonNull(version, "version");
        Objects.requireNonNull(tarball, "tarball");
        Objects.requireNonNull(integrity, "integrity");
        Objects.requireNonNull(releaseDigest, "releaseDigest");
        if (!PACKAGE.matcher(packageName).matches()) {
            throw new IllegalArgumentException("Invalid CLI package name");
        }
        if (!VERSION.matcher(version).matches()) {
            throw new IllegalArgumentException("Invalid CLI release version");
        }
        if (!tarball.equals(registryTarball(packageName, version))) {
            throw new IllegalArgumentException("Untrusted CLI distribution URL");
        }
        requireCanonicalSha512(integrity);
    }

    /**
     * The release of the public metadata a registry returned for the provider. {@code name} must be the provider's package; the digest is computed here from the
     * five fields, so a caller cannot supply one. A part that is missing or malformed fails; nothing but these four texts can enter the release.
     */
    public static AgentRelease verify(AgentCliProvider provider, String name, String version, String tarball, String integrity, Digester digester) {
        Objects.requireNonNull(provider, "provider");
        Objects.requireNonNull(name, "name");
        Objects.requireNonNull(version, "version");
        Objects.requireNonNull(tarball, "tarball");
        Objects.requireNonNull(integrity, "integrity");
        Objects.requireNonNull(digester, "digester");
        if (!name.equals(provider.packageName())) {
            throw new IllegalArgumentException("Invalid CLI release");
        }
        Digest digest = digester.digestUtf8(fieldsJson(provider.id(), name, version, tarball, integrity));
        // The constructor refuses a version, address or checksum of the wrong shape, so the digest of such a text is never returned.
        return new AgentRelease(provider.id(), name, version, tarball, integrity, digest);
    }

    /** Whether {@code releaseDigest} is the digest of the other five fields, that is, whether the release was kept as the registry announced it. */
    public boolean digestMatches(Digester digester) {
        Objects.requireNonNull(digester, "digester");
        return releaseDigest.equals(digester.digestUtf8(fieldsJson(provider, packageName, version, tarball, integrity)));
    }

    /** The digest as the administrator interface carries it: {@code sha256:} and 64 hex characters (2.x agent-cli.mjs:13). */
    public String releaseDigestLabel() {
        return DIGEST_LABEL + releaseDigest.hex();
    }

    /** The registry's tarball address of a version (the scope of a scoped package is part of the path, only the name part of the file). */
    private static String registryTarball(String packageName, String version) {
        return REGISTRY + packageName + "/-/" + packageName.substring(packageName.lastIndexOf('/') + 1) + "-" + version + ".tgz";
    }

    /** The checksum must be base64 of 64 bytes in the canonical form: decoding and encoding again gives the same text. */
    private static void requireCanonicalSha512(String integrity) {
        Matcher matcher = INTEGRITY.matcher(integrity);
        if (!matcher.matches()) {
            throw new IllegalArgumentException("Invalid CLI distribution integrity");
        }
        String base64 = matcher.group(1) + "==";
        byte[] bytes = Base64.getDecoder().decode(base64);
        if (bytes.length != SHA512_BYTES || !Base64.getEncoder().encodeToString(bytes).equals(base64)) {
            throw new IllegalArgumentException("Invalid CLI distribution integrity");
        }
    }

    /**
     * The text that is hashed: the JSON object of the five fields in this order, without spaces (what 2.x {@code JSON.stringify} produced). The accepted
     * fields hold no character that JSON escapes, so concatenation gives the same bytes. An unaccepted field never reaches a stored digest (see {@link #verify}).
     */
    private static String fieldsJson(AgentCliProviderId provider, String packageName, String version, String tarball, String integrity) {
        return "{\"provider\":\"" + provider.wire() + "\",\"packageName\":\"" + packageName + "\",\"version\":\"" + version + "\",\"tarball\":\"" + tarball
                + "\",\"integrity\":\"" + integrity + "\"}";
    }
}
