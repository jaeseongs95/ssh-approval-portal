package io.github.jaeseongs95.portal.domain.release;

import io.github.jaeseongs95.portal.domain.text.Utf8Text;
import java.math.BigInteger;
import java.util.List;
import java.util.Objects;
import java.util.Optional;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * A release version in the form of Semantic Versioning 2.0.0: three numbers, an optional pre-release after a hyphen, build metadata after a plus (ignored). A
 * leading {@code v} is accepted when the text is read, as in a release tag. Versions are ordered by the rules of the specification: the three numbers first, a
 * release above any of its pre-releases, and pre-release identifiers one by one with numbers below words (2.x portal-release.mjs parseSemver/compareSemver).
 */
public record SemanticVersion(int major, int minor, int patch, List<String> prerelease) implements Comparable<SemanticVersion> {

    private static final Pattern SHAPE = Pattern.compile(
        "v?(0|[1-9][0-9]{0,8})\\.(0|[1-9][0-9]{0,8})\\.(0|[1-9][0-9]{0,8})(?:-([0-9A-Za-z.-]{1,64}))?(?:\\+[0-9A-Za-z.-]{1,64})?");
    private static final Pattern NUMERIC = Pattern.compile("[0-9]+");

    public SemanticVersion {
        if (major < 0 || minor < 0 || patch < 0) {
            throw new IllegalArgumentException("A version number is not negative");
        }
        prerelease = List.copyOf(prerelease);
        for (String identifier : prerelease) {
            if (identifier.isEmpty() || !identifier.chars().allMatch(c -> c >= '0' && c <= '9' || c >= 'a' && c <= 'z' || c >= 'A' && c <= 'Z' || c == '-')) {
                throw new IllegalArgumentException("A pre-release identifier is not empty and has only 0-9 A-Z a-z and a hyphen");
            }
        }
    }

    /** Reads a version, trimming white space and accepting a leading {@code v}; nothing when the text is not a version. */
    public static Optional<SemanticVersion> parse(String text) {
        Objects.requireNonNull(text, "text");
        Matcher matcher = SHAPE.matcher(new Utf8Text(text).trimmed().value());
        if (!matcher.matches()) {
            return Optional.empty();
        }
        List<String> prerelease = matcher.group(4) == null ? List.of() : List.of(matcher.group(4).split("\\.", -1));
        for (String identifier : prerelease) {
            if (identifier.isEmpty()) {
                return Optional.empty();
            }
        }
        return Optional.of(new SemanticVersion(Integer.parseInt(matcher.group(1)), Integer.parseInt(matcher.group(2)), Integer.parseInt(matcher.group(3)), prerelease));
    }

    /** The version without a leading {@code v} and without build metadata, for example {@code 2.4.1-rc.1}. */
    public String normalized() {
        String core = major + "." + minor + "." + patch;
        return prerelease.isEmpty() ? core : core + "-" + String.join(".", prerelease);
    }

    @Override
    public int compareTo(SemanticVersion other) {
        int result = Integer.compare(major, other.major);
        if (result == 0) {
            result = Integer.compare(minor, other.minor);
        }
        if (result == 0) {
            result = Integer.compare(patch, other.patch);
        }
        if (result != 0) {
            return result;
        }
        if (prerelease.isEmpty() || other.prerelease.isEmpty()) {
            return Boolean.compare(prerelease.isEmpty(), other.prerelease.isEmpty());
        }
        return comparePrerelease(other.prerelease);
    }

    private int comparePrerelease(List<String> other) {
        int common = Math.min(prerelease.size(), other.size());
        for (int i = 0; i < common; i++) {
            int result = compareIdentifier(prerelease.get(i), other.get(i));
            if (result != 0) {
                return result;
            }
        }
        return Integer.compare(prerelease.size(), other.size());
    }

    private static int compareIdentifier(String left, String right) {
        boolean leftNumeric = NUMERIC.matcher(left).matches();
        boolean rightNumeric = NUMERIC.matcher(right).matches();
        if (leftNumeric && rightNumeric) {
            return new BigInteger(left).compareTo(new BigInteger(right));
        }
        if (leftNumeric != rightNumeric) {
            return leftNumeric ? -1 : 1;
        }
        return left.compareTo(right);
    }
}
