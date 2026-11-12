package io.github.jaeseongs95.portal.store;

import static org.assertj.core.api.Assertions.assertThat;

import java.io.IOException;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.List;
import java.util.regex.Pattern;

import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.springframework.core.io.Resource;
import org.springframework.core.io.support.PathMatchingResourcePatternResolver;

/**
 * Guard for S2-DB-02. H2 2.4.240 turns an {@code IN} list of two or more constants into a set that keeps the session that created the constraint, so a CHECK written
 * with {@code IN} (or with an {@code OR} chain of equalities that H2 rewrites to one) fails with "Check constraint invalid ... The database has been closed" as soon
 * as the migration connection is closed. The migration scripts therefore check a list of values with {@code CASE WHEN col = 'A' THEN 1 ... END = 1}. This test fails when
 * a script gets an {@code IN} list of literals again.
 */
class NoInListInChecksTest {

    private static final Pattern IN_LIST_OF_LITERALS = Pattern.compile("(?i)\\bIN\\s*\\(\\s*'");

    @Test
    @DisplayName("S2-DB-02: no migration script checks a list of values with IN (H2 2.4.240 cannot evaluate it once the creating connection is closed)")
    void noScriptUsesAnInListOfLiterals() throws IOException {
        List<String> offenders = new ArrayList<>();
        Resource[] scripts = new PathMatchingResourcePatternResolver().getResources("classpath*:db/migration/**/*.sql");
        assertThat(scripts).as("the migration scripts are on the class path").hasSizeGreaterThanOrEqualTo(14);
        for (Resource script : scripts) {
            try (InputStream in = script.getInputStream()) {
                String text = new String(in.readAllBytes(), StandardCharsets.UTF_8);
                String code = text.lines().filter(line -> !line.stripLeading().startsWith("--")).reduce("", (a, b) -> a + "\n" + b);
                if (IN_LIST_OF_LITERALS.matcher(code).find()) {
                    offenders.add(script.getFilename());
                }
            }
        }
        assertThat(offenders).isEmpty();
    }
}
