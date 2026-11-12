package io.github.jaeseongs95.portal.domain.origin;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import io.github.jaeseongs95.portal.domain.host.SettingsVectors;
import java.io.IOException;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import tools.jackson.databind.JsonNode;

class AdminOriginTest {

    @Test
    @DisplayName("RC-B-888 every shared origin vector: a valid origin is kept as it is, the others are refused")
    void sharedOriginVectors() throws IOException {
        SettingsVectors vectors = new SettingsVectors();
        int checked = 0;
        for (JsonNode vector : vectors.originVectors()) {
            String value = vector.get("value").stringValue();
            if (vector.get("valid").booleanValue()) {
                assertThat(new AdminOrigin(value).value()).as("origin %s", value).isEqualTo(value);
            } else {
                assertThatThrownBy(() -> new AdminOrigin(value)).as("origin %s", value).isInstanceOf(IllegalArgumentException.class)
                    .hasMessage("Configure one canonical HTTPS administrator origin");
            }
            checked++;
        }
        assertThat(checked).as("the vectors were read").isGreaterThan(30);
    }

    @Test
    @DisplayName("RC-B-889 an origin is exactly what the URL parser writes back, within the size limit")
    void canonicalOriginAndSizeLimit() throws IOException {
        int limit = new SettingsVectors().originMaxBytes();
        assertThat(new AdminOrigin("https://xn--fa-hia.example").value()).isEqualTo("https://xn--fa-hia.example");
        assertThatThrownBy(() -> new AdminOrigin("https://xn--fa-hia.example\n")).isInstanceOf(IllegalArgumentException.class);
        assertThatThrownBy(() -> new AdminOrigin("https://admin.example.test/")).isInstanceOf(IllegalArgumentException.class);
        assertThatThrownBy(() -> new AdminOrigin("https://" + "a".repeat(limit))).isInstanceOf(IllegalArgumentException.class);
        assertThatThrownBy(() -> new AdminOrigin(null)).isInstanceOf(NullPointerException.class);
    }

    @Test
    @DisplayName("RC-B-888 the ports 1 to 65535 are accepted except the default port 443, a port outside the range is refused")
    void ports() {
        assertThat(new AdminOrigin("https://admin.example.test:1").value()).endsWith(":1");
        assertThat(new AdminOrigin("https://admin.example.test:65535").value()).endsWith(":65535");
        assertThat(new AdminOrigin("https://admin.example.test:39125").value()).endsWith(":39125");
        for (String bad : new String[] {":0", ":65536", ":99999", ":443", ":04443", ":", ":-1", ":1.5"}) {
            assertThatThrownBy(() -> new AdminOrigin("https://admin.example.test" + bad)).as("port %s", bad).isInstanceOf(IllegalArgumentException.class);
        }
    }
}
