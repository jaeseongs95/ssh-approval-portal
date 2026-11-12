package io.github.jaeseongs95.portal.domain.id;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import java.nio.charset.StandardCharsets;
import java.util.Random;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

class DigestAndGeneratorTest {

    private final Digester digester = new Sha256Digester();

    @Test
    @DisplayName("S2-VA-07 Sha256Digester gives the SHA-256 of FIPS 180-4 for the empty text and for abc")
    void knownVectors() {
        assertThat(digester.digest(new byte[0]).hex()).isEqualTo("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
        assertThat(digester.digestUtf8("abc").hex()).isEqualTo("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
        assertThat(digester.digest("abc".getBytes(StandardCharsets.UTF_8))).isEqualTo(digester.digestUtf8("abc"));
    }

    @Test
    @DisplayName("S2-VA-07 CanonicalForm: the same fields give the same digest, a value cannot pass for two fields, absent differs from empty")
    void canonicalForm() {
        Digest first = new CanonicalForm().field("a", "x").field("b", "y").digest(digester);
        Digest same = new CanonicalForm().field("a", "x").field("b", "y").digest(digester);
        assertThat(first).isEqualTo(same);
        assertThat(new CanonicalForm().field("b", "y").field("a", "x").digest(digester)).as("the order of fields is part of the form").isNotEqualTo(first);
        assertThat(new CanonicalForm().field("a", "x\nb=1:y").digest(digester)).as("a value with a line break and an equals sign").isNotEqualTo(first);
        assertThat(new CanonicalForm().absent("a").digest(digester)).isNotEqualTo(new CanonicalForm().field("a", "").digest(digester));
        assertThat(new String(new CanonicalForm().field("a", "ä").bytes(), StandardCharsets.UTF_8)).isEqualTo("a=2:ä\n");
        assertThat(new String(new CanonicalForm().field("n", 7).absent("z").bytes(), StandardCharsets.UTF_8)).isEqualTo("n=1:7\nz=-\n");
        assertThatThrownBy(() -> new CanonicalForm().field("bad name", "x")).isInstanceOf(IllegalArgumentException.class);
    }

    @Test
    @DisplayName("S2-VA-01 the generators make well formed identifiers, repeatable from a seed and different from one call to the next")
    void generators() {
        OperationIdGenerator operations = new OperationIdGenerator(new Random(11));
        OperationId one = operations.next();
        OperationId two = operations.next();
        assertThat(one).isNotEqualTo(two);
        assertThat(new OperationIdGenerator(new Random(11)).next()).isEqualTo(one);
        assertThat(new ArtifactIdGenerator(new Random(5)).next().value()).matches("[a-f0-9]{48}");
        ArtifactUuidGenerator uuids = new ArtifactUuidGenerator(new Random(3));
        for (int i = 0; i < 50; i++) {
            ArtifactUuid uuid = uuids.next();
            assertThat(ArtifactUuid.parse(uuid.text())).isEqualTo(uuid);
        }
    }
}
