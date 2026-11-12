package io.github.jaeseongs95.portal.domain.release;

import static org.assertj.core.api.Assertions.assertThat;

import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

class SemanticVersionTest {

    @Test
    @DisplayName("RC-B-525 a version is read with a v prefix and a pre-release, and a text that is no version gives nothing")
    void parsing() {
        assertThat(SemanticVersion.parse("v2.4.0")).map(SemanticVersion::normalized).hasValue("2.4.0");
        assertThat(SemanticVersion.parse("2.4.1-rc.1")).map(SemanticVersion::normalized).hasValue("2.4.1-rc.1");
        assertThat(SemanticVersion.parse(" 3.0.0+build.5 ")).map(SemanticVersion::normalized).hasValue("3.0.0");
        for (String text : new String[] {"invalid", "", "2.4", "2.4.0.1", "02.4.0", "2.4.0-", "2.4.0-a..b", "V2.4.0", "1.2.3-ä"}) {
            assertThat(SemanticVersion.parse(text)).as("text '%s'", text).isEmpty();
        }
    }

    @Test
    @DisplayName("RC-B-525 versions are compared by number, a release is above its pre-releases, identifiers are compared one by one")
    void ordering() {
        assertThat(compare("2.5.0", "2.4.0")).isEqualTo(1);
        assertThat(compare("2.4.0", "2.4.0")).isZero();
        assertThat(compare("2.3.9", "2.4.0")).isEqualTo(-1);
        assertThat(compare("2.4.0", "2.4.0-rc.1")).isEqualTo(1);
        assertThat(compare("2.4.0-rc.1", "2.4.0-rc.2")).isEqualTo(-1);
        assertThat(compare("2.4.0-rc.2", "2.4.0-rc.10")).as("numbers compare as numbers").isEqualTo(-1);
        assertThat(compare("2.4.0-rc", "2.4.0-rc.1")).as("a shorter list is lower").isEqualTo(-1);
        assertThat(compare("2.4.0-1", "2.4.0-alpha")).as("a number is lower than a word").isEqualTo(-1);
        assertThat(compare("2.4.0-alpha", "2.4.0-beta")).isEqualTo(-1);
        assertThat(compare("v10.0.0", "9.99.99")).isEqualTo(1);
    }

    private static int compare(String left, String right) {
        return Integer.signum(SemanticVersion.parse(left).orElseThrow().compareTo(SemanticVersion.parse(right).orElseThrow()));
    }
}
