package io.github.jaeseongs95.portal.archchecks;

import static org.assertj.core.api.Assertions.assertThat;

import java.io.IOException;
import java.nio.file.Path;
import java.util.List;
import java.util.regex.Pattern;
import org.junit.jupiter.api.Test;

/**
 * Case F-03: the test JVM that Gradle forks is isolated from the host session that started the build (the root build.gradle.kts sets it up for every module).
 * The agent session that runs the build has CLAUDE*, CODEX* ... variables and a real home folder; none of it may reach a test.
 */
class TestIsolationTest {

    private static final Pattern HOST_SESSION_VARIABLE = Pattern.compile("(AGENT_GOVERNANCE|AGS_|CLAUDE|CODEX|GEMINI|ANTHROPIC|OPENAI|BRIDGE_|PORTAL_).*", Pattern.CASE_INSENSITIVE);

    @Test
    void noHostSessionVariableReachesTheTest() {
        // System.getenv is allowed here: a JUnit test outside Spring checks the environment of the test JVM; A-ENV binds the product code.
        assertThat(System.getenv().keySet()).noneMatch(name -> HOST_SESSION_VARIABLE.matcher(name).matches());
    }

    @Test
    void homeAndTemporaryFoldersLieInsideTheModuleBuildFolder() throws IOException {
        // System.getProperty and System.getenv are allowed in this class: a JUnit test outside Spring checks what Gradle's test JVM setup hands over; A-ENV binds the product code.
        Path isolated = Path.of(System.getProperty("user.dir")).resolve("build/isolated").toRealPath();
        for (String variable : List.of("HOME", "USERPROFILE", "APPDATA", "LOCALAPPDATA", "TEMP", "TMP", "TMPDIR")) {
            assertThat(System.getenv(variable)).as(variable).isNotNull();
            assertThat(Path.of(System.getenv(variable)).toRealPath()).as(variable).startsWith(isolated);
        }
        // System.getProperty is allowed here (see the first line of this method).
        assertThat(Path.of(System.getProperty("user.home")).toRealPath()).startsWith(isolated);
        assertThat(Path.of(System.getProperty("java.io.tmpdir")).toRealPath()).startsWith(isolated);
    }

    @Test
    void theTestJvmHasOneProcessorAndAStatedHeap() {
        assertThat(Runtime.getRuntime().availableProcessors()).isEqualTo(1);
        assertThat(Runtime.getRuntime().maxMemory()).isLessThanOrEqualTo(512L * 1024 * 1024);
    }
}
