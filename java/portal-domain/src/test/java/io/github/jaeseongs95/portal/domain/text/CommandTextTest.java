package io.github.jaeseongs95.portal.domain.text;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import java.util.List;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

class CommandTextTest {

    @Test
    @DisplayName("RC-B-072 a multiline command is accepted as written: LF, CR LF, here-documents, tabs")
    void multilineInputIsAccepted() {
        List<String> commands = List.of("cat <<'EOF'\nline\nEOF\n", "cat <<EOF\n$HOME\nEOF\n", "cat <<-EOF\n\tindented\n\tEOF\n", "cat <<EOF | sort\nb\na\nEOF\n",
            "@'\nline\n'@", "@\"\r\nline\r\n\"@\r\n", "\tcommand\r\n\tnext\r\n", "printf\tfixture", "printf first\r\nprintf second\r\n");
        for (String command : commands) {
            assertThat(new CommandText(command).value()).as("kept exactly as written").isEqualTo(command);
        }
    }

    @Test
    @DisplayName("RC-B-073 line breaks, tabs and outer white space stay part of the text, so each variant is another command")
    void textIsNeverNormalized() {
        List<String> variants = List.of("printf first\nprintf second\n", "printf first\r\nprintf second\r\n", " printf first\nprintf second\n", "printf first\nprintf second",
            "printf\tfirst\nprintf second\n");
        assertThat(variants.stream().map(variant -> new CommandText(variant).value()).distinct()).hasSize(variants.size());
        assertThat(new CommandText("printf first\nprintf second\n").isMultiline()).isTrue();
        assertThat(new CommandText("printf first").isMultiline()).isFalse();
    }

    @Test
    @DisplayName("RC-B-074 S2-VA-02 32768 UTF-8 bytes are accepted for one-, three- and four-byte characters, 32769 is refused")
    void thirtyTwoKibiBytesBoundary() {
        for (String atom : new String[] {"x", "ä", "가", "😀"}) {
            String exact = heredocOfBytes(atom, CommandText.MAX_BYTES);
            assertThat(new CommandText(exact).byteLength()).as("atom of %d bytes", atom.getBytes(java.nio.charset.StandardCharsets.UTF_8).length).isEqualTo(32768);
            assertThatThrownBy(() -> new CommandText(exact + "x")).isInstanceOf(IllegalArgumentException.class);
        }
    }

    @Test
    @DisplayName("RC-B-074 the control characters and lone surrogates between two lines are refused, as are blank commands")
    void hiddenCharactersAreRefused() {
        int[] codes = {0, '\r', 1, 8, 0x0b, 0x0c, 0x1b, 0x1f, 0x7f, 0x85, 0x202e, 0x2066, 0x200b, 0xfeff, 0xd800, 0xdc00};
        for (int code : codes) {
            String command = "printf first\n" + (char) code + "printf second";
            assertThatThrownBy(() -> new CommandText(command)).as("code point %04x", code).isInstanceOf(IllegalArgumentException.class);
        }
        for (String blank : new String[] {"", " \n\t\r\n", " ", "﻿"}) {
            assertThatThrownBy(() -> new CommandText(blank)).as("blank command").isInstanceOf(IllegalArgumentException.class);
        }
        assertThatThrownBy(() -> new CommandText(null)).isInstanceOf(NullPointerException.class);
    }

    @Test
    @DisplayName("S2-VA-02 a SourceText is 1 to 16384 UTF-8 bytes without a NUL")
    void sourceTextBoundary() {
        assertThat(new SourceText("x".repeat(SourceText.MAX_BYTES)).byteLength()).isEqualTo(16384);
        assertThatThrownBy(() -> new SourceText("x".repeat(SourceText.MAX_BYTES + 1))).isInstanceOf(IllegalArgumentException.class);
        assertThatThrownBy(() -> new SourceText("")).isInstanceOf(IllegalArgumentException.class);
        assertThatThrownBy(() -> new SourceText("a\0b")).isInstanceOf(IllegalArgumentException.class);
        assertThat(new SourceText("print('ä')\n").value()).contains("\n");
    }

    @Test
    @DisplayName("S2-VA-02 Utf8Text refuses a lone surrogate and trims the way JavaScript does, including the no-break space")
    void utf8TextRules() {
        assertThatThrownBy(() -> new Utf8Text("a" + (char) 0xd800)).isInstanceOf(IllegalArgumentException.class);
        assertThat(new Utf8Text("가").byteLength()).isEqualTo(3);
        assertThat(new Utf8Text("  x ﻿").trimmed().value()).isEqualTo("x");
        assertThat(new Utf8Text(" x").hasOuterWhitespace()).isTrue();
        assertThat(new Utf8Text("x").hasOuterWhitespace()).isFalse();
        assertThat(new Utf8Text("").isBlank()).isTrue();
        assertThat(new Utf8Text("a​b").hasHiddenCharacters()).isTrue();
        assertThat(new Utf8Text("a\nb").hasHiddenCharactersBesidesLayout()).isFalse();
        assertThat(new Utf8Text("a\rb").hasHiddenCharactersBesidesLayout()).isTrue();
    }

    /** A here-document whose UTF-8 length is exactly the wanted number of bytes: a fixed frame, the atom repeated, and plain x to fill the rest. */
    private static String heredocOfBytes(String atom, int totalBytes) {
        String head = "cat <<'EOF'\n\t";
        String tail = "\nEOF\n";
        int atomBytes = atom.getBytes(java.nio.charset.StandardCharsets.UTF_8).length;
        int room = totalBytes - head.length() - tail.length();
        return head + atom.repeat(room / atomBytes) + "x".repeat(room % atomBytes) + tail;
    }
}
