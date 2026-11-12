package io.github.jaeseongs95.portal.domain.file;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import io.github.jaeseongs95.portal.domain.id.CanonicalForm;
import io.github.jaeseongs95.portal.domain.id.TargetId;
import io.github.jaeseongs95.portal.domain.target.TargetRevision;
import java.nio.charset.StandardCharsets;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

class FileTargetBindingTest {

    private static final String REVISION = "b".repeat(64);

    @Test
    @DisplayName("RC-A-801 neither flat field is no binding; both valid fields are a binding")
    void noneOrBoth() {
        assertThat(FileBinding.of(null, null)).isEqualTo(new FileBinding.Unbound());
        FileBinding bound = FileBinding.of("alpha", REVISION);
        assertThat(bound).isEqualTo(new FileBinding.Bound(new FileTargetBinding(new TargetId("alpha"), TargetRevision.of(REVISION))));
    }

    @Test
    @DisplayName("RC-A-801 a binding with only one field, or with an invalid field, is refused instead of being read as no binding")
    void partialBindingIsRefused() {
        assertThatThrownBy(() -> FileBinding.of("alpha", null)).isInstanceOf(IllegalArgumentException.class);
        assertThatThrownBy(() -> FileBinding.of(null, REVISION)).isInstanceOf(IllegalArgumentException.class);
        assertThatThrownBy(() -> FileBinding.of("Alpha", REVISION)).isInstanceOf(IllegalArgumentException.class);
        assertThatThrownBy(() -> FileBinding.of("alpha", "short")).isInstanceOf(IllegalArgumentException.class);
        assertThatThrownBy(() -> new FileTargetBinding(null, TargetRevision.of(REVISION))).isInstanceOf(NullPointerException.class);
        assertThatThrownBy(() -> new FileTargetBinding(new TargetId("alpha"), null)).isInstanceOf(NullPointerException.class);
    }

    @Test
    @DisplayName("RC-A-801 a binding is part of the contract form; no binding differs from a binding")
    void bindingIsPartOfTheContract() {
        String none = new String(new FileBinding.Unbound().describeTo(new CanonicalForm()).bytes(), StandardCharsets.UTF_8);
        String bound = new String(FileBinding.of("alpha", REVISION).describeTo(new CanonicalForm()).bytes(), StandardCharsets.UTF_8);
        assertThat(none).isEqualTo("file.binding=-\n");
        assertThat(bound).startsWith("file.targetId=5:alpha\n").contains(REVISION);
    }

    @Test
    @DisplayName("S2-VA-01 FileName: 1 to 255 characters without control characters, slashes or backslashes")
    void fileName() {
        assertThat(new FileName("report.txt").value()).isEqualTo("report.txt");
        assertThat(new FileName("x".repeat(255)).value()).hasSize(255);
        for (String bad : new String[] {"", "x".repeat(256), "a/b", "a\\b", "a\nb", "a" + (char) 0x7f}) {
            assertThatThrownBy(() -> new FileName(bad)).isInstanceOf(IllegalArgumentException.class);
        }
    }
}
