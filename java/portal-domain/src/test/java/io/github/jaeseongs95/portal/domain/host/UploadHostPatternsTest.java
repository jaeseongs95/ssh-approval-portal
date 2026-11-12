package io.github.jaeseongs95.portal.domain.host;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import java.io.IOException;
import java.util.ArrayList;
import java.util.List;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import tools.jackson.databind.JsonNode;

class UploadHostPatternsTest {

    @Test
    @DisplayName("RC-B-887 every shared upload host vector, and a null or 65537 character setting")
    void sharedUploadHostVectors() throws IOException {
        int checked = 0;
        for (JsonNode vector : new SettingsVectors().uploadHostVectors()) {
            String value = vector.get("value").stringValue();
            if (vector.has("valid") && !vector.get("valid").booleanValue()) {
                assertThatThrownBy(() -> UploadHostPatterns.parse(value)).as("setting '%s'", value).isInstanceOf(IllegalArgumentException.class);
            } else {
                List<String> expected = new ArrayList<>();
                for (JsonNode text : vector.get("expected")) {
                    expected.add(text.stringValue());
                }
                assertThat(UploadHostPatterns.parse(value).values().stream().map(UploadHostPattern::text).toList()).as("setting '%s'", value).isEqualTo(expected);
            }
            checked++;
        }
        assertThat(checked).as("the vectors were read").isGreaterThan(20);
        assertThatThrownBy(() -> UploadHostPatterns.parse(null)).isInstanceOf(NullPointerException.class);
        assertThatThrownBy(() -> UploadHostPatterns.parse("x".repeat(65537))).isInstanceOf(IllegalArgumentException.class);
    }

    @Test
    @DisplayName("RC-B-887 every shared match vector: an exact host matches itself, a wildcard matches every host below its domain and nothing else")
    void sharedMatchVectors() throws IOException {
        for (JsonNode vector : new SettingsVectors().uploadHostMatchVectors()) {
            UploadHostPattern pattern = UploadHostPattern.parse(vector.get("pattern").stringValue());
            String host = vector.get("host").stringValue();
            assertThat(pattern.matches(host)).as("%s against %s", pattern.text(), host).isEqualTo(vector.get("allowed").booleanValue());
        }
        UploadHostPatterns patterns = UploadHostPatterns.parse("files.example.test,*.other.test");
        assertThat(patterns.allows("files.example.test")).isTrue();
        assertThat(patterns.allows("a.other.test")).isTrue();
        assertThat(patterns.allows("other.test")).isFalse();
        assertThat(UploadHostPatterns.parse("").allows("files.example.test")).isFalse();
    }

    @Test
    @DisplayName("RC-B-891 the fourteen wrong upload hosts are all refused")
    void wrongUploadHostsAreRefused() {
        List<String> wrong = List.of("https://files.test/a", "*", "files.*.test", "files.test.", "owner@files.test", "files.test:443", "127.0.0.1", "::1", "127.1", "2130706433",
            "0x7f000001", "0177.0.0.1", "files.test,,other.test", "files.test\nBRIDGE_UI_ENABLED=false");
        assertThat(wrong).hasSize(14);
        for (String setting : wrong) {
            assertThatThrownBy(() -> UploadHostPatterns.parse(setting)).as("setting '%s'", setting).isInstanceOf(IllegalArgumentException.class);
        }
    }

    @Test
    @DisplayName("RC-B-891 a host label that is Punycode must be a canonical one")
    void punycodeLabels() {
        assertThat(UploadHostPatterns.parse("xn--bcher-kva.example").values()).hasSize(1);
        assertThatThrownBy(() -> UploadHostPatterns.parse("files.xn--a.example")).isInstanceOf(IllegalArgumentException.class);
        assertThatThrownBy(() -> UploadHostPatterns.parse("xn--abc-.example")).isInstanceOf(IllegalArgumentException.class);
    }

    @Test
    @DisplayName("RC-B-887 the host name rules that decide the vectors: a numeric last label is an address, the IPv6 and IPv4 canonical forms")
    void hostNameRules() {
        assertThat(new HostName("127.0.0.1").isCanonicalIpv4()).isTrue();
        assertThat(new HostName("127.0.0.01").isCanonicalIpv4()).isFalse();
        assertThat(new HostName("1.2.3.256").isCanonicalIpv4()).isFalse();
        assertThat(new HostName("host.123").endsInNumber()).isTrue();
        assertThat(new HostName("host.0x").endsInNumber()).isTrue();
        assertThat(new HostName("host.example").endsInNumber()).isFalse();
        assertThat(new HostName("host.").endsInNumber()).isFalse();
        assertThat(new Ipv6Literal("::1").isCanonical()).isTrue();
        assertThat(new Ipv6Literal("2001:db8::1").isCanonical()).isTrue();
        assertThat(new Ipv6Literal("1:2:3:4:5:6:7:8").isCanonical()).isTrue();
        assertThat(new Ipv6Literal("1::").isCanonical()).isTrue();
        assertThat(new Ipv6Literal("0:0:0:0:0:0:0:1").isCanonical()).isFalse();
        assertThat(new Ipv6Literal("2001:0db8::1").isCanonical()).isFalse();
        assertThat(new Ipv6Literal("1:2:3:4:5:6:7::").isCanonical()).as("one zero piece is not compressed").isFalse();
        assertThat(new Ipv6Literal(":::").isCanonical()).isFalse();
    }
}
