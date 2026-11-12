package io.github.jaeseongs95.portal.domain.command;

import static org.assertj.core.api.Assertions.assertThat;

import io.github.jaeseongs95.portal.domain.classify.CommandClass;
import io.github.jaeseongs95.portal.domain.classify.CommandClassification;
import io.github.jaeseongs95.portal.domain.classify.CommandClassifier;
import io.github.jaeseongs95.portal.domain.text.CommandText;
import java.util.ArrayList;
import java.util.List;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

/** The local screen of a command line before a model sees it (2.x command-policy.mjs:74-84 {@code inspectCommand}), with a classifier that answers a fixed class. */
class CommandInspectorTest {

    private final List<String> classified = new ArrayList<>();

    @Test
    @DisplayName("a plain read-only command is not risky and its executable is named")
    void readOnlyIsNotRisky() {
        CommandInspection inspection = inspector(CommandClass.READ_ONLY).inspect(new CommandText("  ls /tmp"));
        assertThat(inspection.executable()).isEqualTo(new CommandInspection.ExecutableName.Named("ls"));
        assertThat(inspection.sensitive()).isFalse();
        assertThat(inspection.risky()).isFalse();
    }

    @Test
    @DisplayName("a class above read-only is risky: safe is the classifier's default for an unknown program, not a proof")
    void aClassAboveReadOnlyIsRisky() {
        for (CommandClass commandClass : List.of(CommandClass.SAFE, CommandClass.DESTRUCTIVE, CommandClass.PRIVILEGED)) {
            assertThat(inspector(commandClass).inspect(new CommandText("ls /tmp")).risky()).as(commandClass.name()).isTrue();
        }
    }

    @Test
    @DisplayName("a shell meta character, a line break or a missing program name makes it risky even when the classifier says read-only")
    void shellMetaCharactersAndMissingProgramAreRisky() {
        CommandInspector inspector = inspector(CommandClass.READ_ONLY);
        for (String command : List.of("ls; rm x", "ls | wc", "ls > out", "echo $(id)", "echo `id`", "ls *", "ls ~", "ls\nid", "ls \\", "ls [a]", "ls {a,b}", "ls ?")) {
            assertThat(inspector.inspect(new CommandText(command)).risky()).as(command).isTrue();
        }
        CommandInspection noProgram = inspector.inspect(new CommandText("/bin/ls"));
        assertThat(noProgram.executable()).isInstanceOf(CommandInspection.ExecutableName.NoExecutable.class);
        assertThat(noProgram.risky()).isTrue();
    }

    @Test
    @DisplayName("a command that mentions secrets is sensitive and risky")
    void sensitiveCommandsAreRisky() {
        CommandInspection inspection = inspector(CommandClass.READ_ONLY).inspect(new CommandText("cat /etc/shadow"));
        assertThat(inspection.sensitive()).isTrue();
        assertThat(inspection.risky()).isTrue();
    }

    @Test
    @DisplayName("sudo and sudo -n are looked through: the classifier judges what runs under them; other forms are judged as written")
    void sudoPrefixIsLookedThrough() {
        CommandInspector inspector = inspector(CommandClass.READ_ONLY);
        inspector.inspect(new CommandText("sudo id"));
        inspector.inspect(new CommandText("sudo -n id"));
        inspector.inspect(new CommandText("  sudo   -n   id /tmp"));
        inspector.inspect(new CommandText("sudo -u root id"));
        inspector.inspect(new CommandText("sudo"));
        assertThat(classified).containsExactly("id", "id", "id /tmp", "-u root id", "sudo");
    }

    @Test
    @DisplayName("a command that is nothing after sudo cannot be read only")
    void nothingAfterSudoIsRisky() {
        CommandInspection inspection = inspector(CommandClass.READ_ONLY).inspect(new CommandText("sudo   "));
        assertThat(inspection.risky()).isTrue();
        assertThat(classified).isEmpty();
    }

    private CommandInspector inspector(CommandClass answer) {
        CommandClassifier classifier = command -> {
            classified.add(command.value());
            return CommandClassification.of(answer);
        };
        return new CommandInspector(classifier);
    }
}
