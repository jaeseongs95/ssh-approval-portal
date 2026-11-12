package io.github.jaeseongs95.portal.ssh.platform;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import java.io.ByteArrayInputStream;
import java.io.IOException;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.util.Base64;
import java.util.HashSet;
import java.util.HexFormat;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.regex.Matcher;
import java.util.regex.Pattern;
import java.util.zip.GZIPInputStream;

import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

/**
 * Pins the bytes of every fixed sentence the portal sends to a target (S3-TP-04, S3-TP-06). The sentences are data under {@code ssh/remote/}; what a target receives
 * must never change by accident, so the SHA-256 of each file (LF line breaks, UTF-8, as {@link RemoteScripts#text} returns it) is written in this test.
 *
 * <p><b>When a resource file changes, this test has to change with it</b>: compute the new hash of the file with LF line breaks, write it into {@link #PINNED}, and
 * review the receiver tests ({@code WindowsCommandWrapperTest}, {@code PythonSourceReceiverTest}) in the same change. The hashes are computed over the text after
 * CR LF has become LF, so a checkout that converts line breaks gives the same values.
 */
class RemoteScriptsTest {

    private static final Pattern MARK = Pattern.compile("@@([A-Z][A-Z0-9_]*)@@");

    /** The SHA-256 of the text of every file under ssh/remote/, by script. */
    private static final Map<RemoteScript, String> PINNED = Map.ofEntries(
        Map.entry(RemoteScript.WINDOWS_STDIN_READER, "2f7ca5ca08654ea1a00b1845efe0e4a2e4536e7cdfd2428c891ed825e5e41a05"),
        Map.entry(RemoteScript.WINDOWS_ERROR_REPORT, "430b42abb81efe833a5b321ced53ac434ffa56274a2c5193d0c9b500ec3ac1e3"),
        Map.entry(RemoteScript.WINDOWS_AUTOLOAD_OFF, "40a6def954cd3926e8e0275fa279697646377c1b6df73a6d421349c7fbbea16e"),
        Map.entry(RemoteScript.WINDOWS_IMPORT_MODULE, "ff283e519a9c93b30d1ab1e8945fda4cecb9fd4412eaf09f8f3f1346f7a5e17c"),
        Map.entry(RemoteScript.WINDOWS_WORKDIR, "007b0e30e2c08cbbfaaac189d5f0e8d02657e243e3664fe030479cf9c1e15874"),
        Map.entry(RemoteScript.WINDOWS_WRAPPED_COMMAND, "83032b4bd7d8318cb2c6cf12d53cc4e192c2d39f3a8800f9cb04ce72c7517960"),
        Map.entry(RemoteScript.WINDOWS_COMMAND_RECEIVER, "914c25ef468de3224afefd68fc329ba7ecb6c3b2aee9682d3e99d3c1705357bb"),
        Map.entry(RemoteScript.WINDOWS_RECEIVER_STUB, "54d527ab8b7e12eff3d36cad5ee99e5684c5b6086088ab2b6f7c99d523c42d57"),
        Map.entry(RemoteScript.WINDOWS_SOURCE_LAUNCHER, "109aa3f4f1857297cd57811476672362bbc694e1d83e52c34f6eca559165babc"),
        Map.entry(RemoteScript.WINDOWS_SOURCE_BOOTSTRAP, "746012c1cf4470338b827c47bb9eff6040e48f7781932f8b90d311280a050355"),
        Map.entry(RemoteScript.PYTHON_RECEIVER_POSIX, "02361b80c0ea0e67f2f45509dc621ae5cc1c2dff58c7de7e2fd1c346aaa67ad4"),
        Map.entry(RemoteScript.PYTHON_RECEIVER_WINDOWS, "6ada027eea7943d7245b149b78449a2a6142ab3e2905fe2467e334f7ed8b0ce9"));

    /** The marks each file holds; the Javadoc of {@link RemoteScript} lists the same names. */
    private static final Map<RemoteScript, Set<String>> MARKS = Map.ofEntries(
        Map.entry(RemoteScript.WINDOWS_STDIN_READER, Set.of()),
        Map.entry(RemoteScript.WINDOWS_ERROR_REPORT, Set.of()),
        Map.entry(RemoteScript.WINDOWS_AUTOLOAD_OFF, Set.of()),
        Map.entry(RemoteScript.WINDOWS_IMPORT_MODULE, Set.of("MODULE")),
        Map.entry(RemoteScript.WINDOWS_WORKDIR, Set.of("IMPORT_MANAGEMENT", "WORKDIR_BASE64")),
        Map.entry(RemoteScript.WINDOWS_WRAPPED_COMMAND, Set.of("PRELUDE", "COMMAND", "ERROR_REPORT")),
        Map.entry(RemoteScript.WINDOWS_COMMAND_RECEIVER, Set.of("STDIN_READER", "BUFFER_LENGTH", "BYTE_COUNT", "SHA256", "PRELUDE", "ERROR_REPORT")),
        Map.entry(RemoteScript.WINDOWS_RECEIVER_STUB, Set.of("PACKED", "ERROR_REPORT")),
        Map.entry(RemoteScript.WINDOWS_SOURCE_LAUNCHER, Set.of("STDIN_READER", "INTERPRETER_BASE64", "ARGUMENTS", "ERROR_REPORT")),
        Map.entry(RemoteScript.WINDOWS_SOURCE_BOOTSTRAP, Set.of("PACKED")),
        Map.entry(RemoteScript.PYTHON_RECEIVER_POSIX, Set.of()),
        Map.entry(RemoteScript.PYTHON_RECEIVER_WINDOWS, Set.of()));

    private final RemoteScripts scripts = new RemoteScripts();

    @Test
    @DisplayName("S3-TP-04 고정 원문 12개 파일의 SHA-256(LF·UTF-8 기준)이 시험에 고정된 값과 같다")
    void everyScriptHasItsPinnedHash() {
        for (RemoteScript script : RemoteScript.values()) {
            assertThat(sha256(scripts.text(script))).as("sha256 of %s", script.resourceName()).isEqualTo(PINNED.get(script));
        }
    }

    @Test
    @DisplayName("S3-TP-04 고정 표와 표시 표가 RemoteScript 값 전부를 정확히 한 번씩 덮는다(enum에 없는 파일·표에 없는 값 없음)")
    void tablesCoverEveryScriptOnce() {
        assertThat(PINNED.keySet()).containsExactlyInAnyOrder(RemoteScript.values());
        assertThat(MARKS.keySet()).containsExactlyInAnyOrder(RemoteScript.values());
    }

    @Test
    @DisplayName("S3-TP-04 enum이 가진 파일 이름은 서로 다르고 모두 classpath ssh/remote/ 에서 읽히며 text()와 같다")
    void everyNamedResourceIsReadable() throws IOException {
        Set<String> names = new HashSet<>();
        for (RemoteScript script : RemoteScript.values()) {
            assertThat(names.add(script.resourceName())).as("unique name %s", script.resourceName()).isTrue();
            try (InputStream in = RemoteScripts.class.getClassLoader().getResourceAsStream("ssh/remote/" + script.resourceName())) {
                assertThat(in).as("resource %s", script.resourceName()).isNotNull();
                String stored = new String(in.readAllBytes(), StandardCharsets.UTF_8).replace("\r\n", "\n");
                assertThat(stored).as("no byte order mark in %s", script.resourceName()).doesNotStartWith("﻿");
                assertThat(scripts.text(script)).isEqualTo(stored).isNotBlank();
            }
        }
    }

    @Test
    @DisplayName("S3-TP-04 text()는 CR이 없고 줄바꿈 하나로 끝나며 line()은 그 마지막 줄바꿈만 뺀다")
    void textUsesLfAndLineDropsTheFinalBreak() {
        for (RemoteScript script : RemoteScript.values()) {
            String text = scripts.text(script);
            assertThat(text).as(script.resourceName()).doesNotContain("\r").endsWith("\n");
            assertThat(scripts.line(script)).as(script.resourceName()).isEqualTo(text.substring(0, text.length() - 1));
        }
    }

    @Test
    @DisplayName("S3-TP-04 각 파일의 @@표시@@ 이름이 RemoteScript Javadoc이 적은 이름과 정확히 같다")
    void marksOfEveryFileAreTheDocumentedOnes() {
        for (RemoteScript script : RemoteScript.values()) {
            Set<String> found = new HashSet<>();
            Matcher matcher = MARK.matcher(scripts.text(script));
            while (matcher.find()) {
                found.add(matcher.group(1));
            }
            assertThat(found).as("marks of %s", script.resourceName()).isEqualTo(MARKS.get(script));
        }
    }

    @Test
    @DisplayName("S3-TP-06 Python 수신기 두 파일은 명령 줄에 실리므로 인쇄 가능한 ASCII·TAB·CR·LF만 있다")
    void pythonReceiversAreAsciiForTheCommandLine() {
        for (RemoteScript script : List.of(RemoteScript.PYTHON_RECEIVER_POSIX, RemoteScript.PYTHON_RECEIVER_WINDOWS)) {
            assertThat(scripts.text(script)).as(script.resourceName()).matches("[\\t\\r\\n\\x20-\\x7e]+");
        }
    }

    @Test
    @DisplayName("S3-TP-04 fill은 표시를 값으로 바꾸고 마지막 줄바꿈을 붙이지 않는다")
    void fillReplacesTheMarks() {
        String filled = scripts.fill(RemoteScript.WINDOWS_IMPORT_MODULE, Map.of("MODULE", "Some.Module"));
        assertThat(filled).contains("'Modules','Some.Module','Some.Module.psd1'").doesNotContain("@@").doesNotEndWith("\n");
    }

    @Test
    @DisplayName("S3-TP-04 fill은 한 번만 훑는다: 값 안의 @@표시@@·$1·역슬래시는 다른 표시로 번지지 않고 그대로 들어간다")
    void fillNeverRescansAValue() {
        String hostile = "@@ERROR_REPORT@@ $1 \\ ${x} @@PRELUDE@@";
        String filled = scripts.fill(RemoteScript.WINDOWS_WRAPPED_COMMAND, Map.of("PRELUDE", "", "COMMAND", hostile, "ERROR_REPORT", "REPORT-ONCE;"));
        assertThat(filled).contains(hostile);
        assertThat(filled.split("REPORT-ONCE;", -1)).as("the real error report is filled once").hasSize(2);
    }

    @Test
    @DisplayName("S3-TP-04 fill은 값이 없는 표시와 표시가 없는 값을 호출자 실수로 거절한다")
    void fillRefusesAMissingOrAnUnusedValue() {
        assertThatThrownBy(() -> scripts.fill(RemoteScript.WINDOWS_IMPORT_MODULE, Map.of())).isInstanceOf(IllegalArgumentException.class).hasMessageContaining("MODULE");
        assertThatThrownBy(() -> scripts.fill(RemoteScript.WINDOWS_IMPORT_MODULE, Map.of("MODULE", "M", "EXTRA", "x")))
            .isInstanceOf(IllegalArgumentException.class).hasMessageContaining("EXTRA");
    }

    @Test
    @DisplayName("S3-TP-04 gzipBase64는 풀면 원문 UTF-8과 같고 base64 문자만 낸다")
    void gzipBase64UnpacksToTheText() throws IOException {
        String text = "한글 😀 'quote' \"double\" $x `y` %PATH% !X!\r\n" + "x".repeat(3000);
        String packed = scripts.gzipBase64(text);
        assertThat(packed).matches("[A-Za-z0-9+/]+={0,2}");
        try (GZIPInputStream gunzip = new GZIPInputStream(new ByteArrayInputStream(Base64.getDecoder().decode(packed)))) {
            assertThat(new String(gunzip.readAllBytes(), StandardCharsets.UTF_8)).isEqualTo(text);
        }
        assertThat(packed.length()).as("repeated text packs smaller").isLessThan(text.length());
    }

    private static String sha256(String text) {
        try {
            return HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(text.getBytes(StandardCharsets.UTF_8)));
        } catch (NoSuchAlgorithmException e) {
            throw new IllegalStateException("Every Java platform has SHA-256", e);
        }
    }
}
