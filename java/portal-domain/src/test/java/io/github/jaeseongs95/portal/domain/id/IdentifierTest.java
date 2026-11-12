package io.github.jaeseongs95.portal.domain.id;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

class IdentifierTest {

    @Test
    @DisplayName("S2-VA-01 OperationId and ArtifactId: 48 lowercase hex characters, nothing else")
    void fortyEightHexCharacters() {
        String valid = "0123456789abcdef".repeat(3);
        assertThat(new OperationId(valid).value()).isEqualTo(valid);
        assertThat(new ArtifactId(valid).value()).isEqualTo(valid);
        for (String bad : new String[] {"a".repeat(47), "a".repeat(49), "A".repeat(48), "a".repeat(47) + "g", "a".repeat(47) + "\n", "", " " + "a".repeat(47)}) {
            assertThatThrownBy(() -> new OperationId(bad)).isInstanceOf(IllegalArgumentException.class);
            assertThatThrownBy(() -> new ArtifactId(bad)).isInstanceOf(IllegalArgumentException.class);
        }
        assertThatThrownBy(() -> new OperationId(null)).isInstanceOf(NullPointerException.class);
    }

    @Test
    @DisplayName("S2-VA-01 Digest: 64 lowercase hex characters; of(byte[]) needs exactly 32 bytes")
    void digestShape() {
        assertThat(new Digest("f".repeat(64)).hex()).isEqualTo("f".repeat(64));
        assertThat(Digest.of(new byte[32]).hex()).isEqualTo("0".repeat(64));
        for (String bad : new String[] {"f".repeat(63), "f".repeat(65), "F".repeat(64), "f".repeat(63) + "\n"}) {
            assertThatThrownBy(() -> new Digest(bad)).isInstanceOf(IllegalArgumentException.class);
        }
        assertThatThrownBy(() -> Digest.of(new byte[31])).isInstanceOf(IllegalArgumentException.class);
    }

    @Test
    @DisplayName("S2-VA-01 RequestKey: 16 to 128 characters of A-Z a-z 0-9 _ . : -, and a final line break is refused")
    void requestKeyShape() {
        assertThat(new RequestKey("a".repeat(16)).value()).hasSize(16);
        assertThat(new RequestKey("Az09_.:-".repeat(16)).value()).hasSize(128);
        for (String bad : new String[] {"a".repeat(15), "a".repeat(129), "a".repeat(15) + "\n", "a".repeat(15) + " ", "a".repeat(15) + "/"}) {
            assertThatThrownBy(() -> new RequestKey(bad)).isInstanceOf(IllegalArgumentException.class);
        }
    }

    @Test
    @DisplayName("S2-VA-01 TargetId: a lowercase letter and up to 31 of a-z 0-9 _ -")
    void targetIdShape() {
        assertThat(new TargetId("a").value()).isEqualTo("a");
        assertThat(new TargetId("a" + "z0_-".repeat(7) + "9").value()).hasSize(30);
        assertThat(new TargetId("a".repeat(32)).value()).hasSize(32);
        for (String bad : new String[] {"", "A", "1a", "_a", "a".repeat(33), "a b", "a\n", "a.b"}) {
            assertThatThrownBy(() -> new TargetId(bad)).isInstanceOf(IllegalArgumentException.class);
        }
    }

    @Test
    @DisplayName("S2-VA-01 OwnerId: 1 to 512 characters without a control character")
    void ownerIdShape() {
        assertThat(new OwnerId("fixture-owner").value()).isEqualTo("fixture-owner");
        assertThat(new OwnerId("x".repeat(512)).value()).hasSize(512);
        for (String bad : new String[] {"", "x".repeat(513), "a\nb", "a" + (char) 0x7f, "a" + (char) 0}) {
            assertThatThrownBy(() -> new OwnerId(bad)).isInstanceOf(IllegalArgumentException.class);
        }
    }

    @Test
    @DisplayName("S2-VA-01 ArtifactUuid: a lowercase version 4 UUID; version 3, upper case and short forms are refused")
    void artifactUuidShape() {
        String valid = "123e4567-e89b-42d3-a456-426614174000";
        assertThat(ArtifactUuid.parse(valid).text()).isEqualTo(valid);
        for (String bad : new String[] {"123e4567-e89b-32d3-a456-426614174000", "123E4567-E89B-42D3-A456-426614174000", "123e4567-e89b-42d3-c456-426614174000", "1-1-4-a-1",
            valid + "\n", ""}) {
            assertThatThrownBy(() -> ArtifactUuid.parse(bad)).isInstanceOf(IllegalArgumentException.class);
        }
        assertThatThrownBy(() -> new ArtifactUuid(java.util.UUID.fromString("123e4567-e89b-32d3-a456-426614174000"))).isInstanceOf(IllegalArgumentException.class);
    }
}
