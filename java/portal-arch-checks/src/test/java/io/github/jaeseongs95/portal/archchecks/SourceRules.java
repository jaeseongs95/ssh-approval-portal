package io.github.jaeseongs95.portal.archchecks;

import java.io.IOException;
import java.io.UncheckedIOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;
import java.util.Locale;
import java.util.Set;
import java.util.regex.Matcher;
import java.util.regex.Pattern;
import java.util.stream.Stream;

/**
 * The rules that read text instead of bytecode: a string literal is not in the class file's reachable model, and a build file has no class at all.
 * A violation names its rule id (docs/migration/foundation-cases.md) and the file.
 */
final class SourceRules {

    record Violation(String rule, Path file, String message) {
        @Override
        public String toString() {
            return rule + " " + file + ": " + message;
        }
    }

    private static final Pattern PROJECT_DEPENDENCY = Pattern.compile("project\\(\":portal-([a-z-]+)\"\\)");

    private final ModuleTable table;

    /** The module table says which project dependencies a build file may declare. */
    SourceRules(ModuleTable table) {
        this.table = table;
    }

    /** A-OS (Principles 1.1) and A-LOMBOK (8.2) in the Java sources of one module: {@code <module>/src/main/java}. */
    List<Violation> scanSources(Path moduleDirectory) {
        Path sources = moduleDirectory.resolve("src/main/java");
        if (!Files.isDirectory(sources)) {
            return List.of();
        }
        List<Violation> violations = new ArrayList<>();
        try (Stream<Path> files = Files.walk(sources)) {
            for (Path file : files.filter(f -> f.toString().endsWith(".java")).toList()) {
                String text = Files.readString(file);
                if (text.contains("os.name")) {
                    violations.add(new Violation("A-OS", file, "refers to os.name (Principles 1.1: no operating system judgement)"));
                }
                if (Pattern.compile("\\blombok\\b").matcher(text).find()) {
                    violations.add(new Violation("A-LOMBOK", file, "refers to lombok (Principles 8.2)"));
                }
            }
        } catch (IOException e) {
            throw new UncheckedIOException("cannot read the sources under " + sources, e);
        }
        return violations;
    }

    /**
     * A-DIR (Principles 3.2), A-LOMBOK (8.2) and A-REFLECT (8.2) in the build file of one module. {@code module} is the name without the portal- prefix;
     * a null module is the root build file (no project dependencies to check).
     */
    List<Violation> scanBuildFile(Path buildFile, String module) {
        String text;
        try {
            text = Files.readString(buildFile);
        } catch (IOException e) {
            throw new UncheckedIOException("cannot read " + buildFile, e);
        }
        List<Violation> violations = new ArrayList<>();
        if (text.toLowerCase(Locale.ROOT).contains("lombok")) {
            violations.add(new Violation("A-LOMBOK", buildFile, "mentions lombok (Principles 8.2)"));
        }
        for (String flag : Set.of("add-opens", "enable-preview")) {
            if (text.contains(flag)) {
                violations.add(new Violation("A-REFLECT", buildFile, "uses " + flag + " (Principles 8.1, 8.2)"));
            }
        }
        if (module != null && table.mayUse().containsKey(module)) {
            Matcher matcher = PROJECT_DEPENDENCY.matcher(text);
            while (matcher.find()) {
                String used = matcher.group(1);
                if (!table.mayUse().get(module).contains(used)) {
                    violations.add(new Violation("A-DIR", buildFile, "portal-" + module + " depends on portal-" + used + " (Principles 3.2)"));
                }
            }
        }
        return violations;
    }
}
