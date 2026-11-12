package io.github.jaeseongs95.portal.store.storage;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import java.io.IOException;
import java.nio.channels.FileChannel;
import java.nio.file.FileStore;
import java.nio.file.Files;
import java.nio.file.OpenOption;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;
import java.util.Set;

import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

/** The choice of the rule by what the file store offers, and what is the same for every rule. A rule that is a stand-in records what it is asked. */
class PrivateStoragesTest {

    /** A rule that supports what it is told to and records the paths it is asked to check. */
    private static final class Rule implements PrivateStorage {

        private final boolean supported;
        private final List<Path> checked = new ArrayList<>();

        Rule(boolean supported) {
            this.supported = supported;
        }

        @Override
        public boolean supports(FileStore store) {
            return supported;
        }

        @Override
        public void createFolder(Path folder) throws IOException {
            Files.createDirectories(folder);
        }

        @Override
        public FileChannel open(Path file, Set<? extends OpenOption> options) throws IOException {
            return FileChannel.open(file, options);
        }

        @Override
        public void requireProtected(Path path) {
            checked.add(path);
        }
    }

    @Test
    @DisplayName("S2-DB-10: the first rule that supports the file store is the one used; a rule that does not support it is not asked")
    void theFirstSupportingRuleIsChosen(@TempDir Path directory) throws IOException {
        Rule no = new Rule(false);
        Rule first = new Rule(true);
        Rule second = new Rule(true);
        PrivateStorages storages = new PrivateStorages(List.of(no, first, second));

        assertThat(storages.ruleFor(directory)).isSameAs(first);
        assertThat(storages.ruleFor(directory.resolve("not").resolve("there").resolve("yet"))).as("the file store of the nearest folder that exists").isSameAs(first);
    }

    @Test
    @DisplayName("S2-DB-10: a file store that no rule supports is refused, never accepted as not checked (neither permission bits nor an access control list)")
    void aFileStoreWithoutARuleIsRefused(@TempDir Path directory) {
        PrivateStorages storages = new PrivateStorages(List.of(new Rule(false)));

        assertThatThrownBy(() -> storages.ruleFor(directory)).isInstanceOf(UnsafeStorageException.class).hasMessageContaining("neither");
        assertThatThrownBy(() -> storages.createFolder(directory.resolve("new"))).isInstanceOf(UnsafeStorageException.class);
        assertThatThrownBy(() -> storages.requireSafeFolder(directory)).isInstanceOf(UnsafeStorageException.class);
        assertThatThrownBy(() -> new PrivateStorages(List.of()).ruleFor(directory)).as("no rule at all is the same refusal, not an empty list of checks")
            .isInstanceOf(UnsafeStorageException.class);
    }

    @Test
    @DisplayName("S2-DB-10: what is not a regular file is refused before any rule is asked; a folder is a folder, a file is not")
    void kindsAreCheckedBeforeTheRule(@TempDir Path directory) throws IOException {
        Rule rule = new Rule(true);
        PrivateStorages storages = new PrivateStorages(List.of(rule));
        Path file = Files.createFile(directory.resolve("plain"));

        assertThatThrownBy(() -> storages.requireSafeFile(directory)).isInstanceOf(UnsafeStorageException.class).hasMessageContaining("not a regular file");
        assertThatThrownBy(() -> storages.requireSafeFolder(file)).isInstanceOf(UnsafeStorageException.class).hasMessageContaining("not a folder");
        assertThat(rule.checked).isEmpty();

        storages.requireSafeFile(file);
        storages.requireSafeFolder(directory);
        assertThat(rule.checked).containsExactly(file, directory);
    }
}
