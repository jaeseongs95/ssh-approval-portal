package io.github.jaeseongs95.portal.store.external;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.HashMap;
import java.util.Map;
import java.util.stream.Collectors;

import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;
import org.springframework.boot.context.properties.bind.Binder;
import org.springframework.core.env.StandardEnvironment;

/**
 * S2-DB-16: the supply of the external DBMS to the storage tests ({@link ExternalDbms}): what the task hands over, how the password is read, and the refusals that keep the
 * schema drop and the Flyway clean away from any schema but the test schema. It runs without a database and without Spring, on every run (H2 and external).
 */
class ExternalDbmsTest {

    private static final String PASSWORD = "päss w0rd/€";

    private static Map<String, String> properties(Path passwordFile) {
        Map<String, String> properties = new HashMap<>();
        properties.put(ExternalDbms.URL, "jdbc:postgresql://127.0.0.1:1/none");
        properties.put(ExternalDbms.USER, "tester");
        properties.put(ExternalDbms.PASSWORD_FILE, passwordFile.toString());
        properties.put(ExternalDbms.SCHEMA, "portal_store_it");
        return properties;
    }

    @Test
    @DisplayName("S2-DB-16: without the URL property the run is the default run on H2 and there is no external DBMS")
    void withoutTheUrlThereIsNoExternalDbms() {
        assertThat(ExternalDbms.from(name -> null)).isEmpty();
    }

    @Test
    @DisplayName("S2-DB-16: a URL with a missing property is an error that names the missing property and never a silent fall back to H2")
    void aMissingPropertyIsNamed(@TempDir Path folder) {
        Map<String, String> properties = properties(folder.resolve("pw"));
        properties.remove(ExternalDbms.PASSWORD_FILE);
        properties.remove(ExternalDbms.USER);

        assertThatThrownBy(() -> ExternalDbms.from(properties::get)).isInstanceOf(IllegalStateException.class).hasMessageContaining(ExternalDbms.PASSWORD_FILE)
            .hasMessageContaining(ExternalDbms.USER);
    }

    @Test
    @DisplayName("S2-DB-16: the password is the file's UTF-8 content without the line terminator at its end, and it is in no message and no toString")
    void thePasswordIsReadFromItsFile(@TempDir Path folder) throws IOException {
        Path file = folder.resolve("pw");
        Files.writeString(file, PASSWORD + "\r\n", StandardCharsets.UTF_8);
        ExternalDbms dbms = ExternalDbms.from(properties(file)::get).orElseThrow();

        assertThat(dbms.password()).isEqualTo(PASSWORD);
        assertThat(dbms.toString()).doesNotContain(PASSWORD).doesNotContain("pw");
        assertThat(dbms.schema()).isEqualTo("portal_store_it");

        Files.writeString(file, PASSWORD, StandardCharsets.UTF_8);
        assertThat(dbms.password()).as("no terminator to remove").isEqualTo(PASSWORD);
    }

    @Test
    @DisplayName("S2-DB-16: the environment gets the datasource, the pool and the Flyway settings, the password binds from its file, and no property source prints it")
    void theEnvironmentCarriesTheSettingsAndTheBoundPassword(@TempDir Path folder) throws IOException {
        Path file = folder.resolve("pw");
        Files.writeString(file, PASSWORD + "\n", StandardCharsets.UTF_8);
        ExternalDbms dbms = ExternalDbms.from(properties(file)::get).orElseThrow();
        StandardEnvironment environment = new StandardEnvironment();

        new ExternalDbmsEnvironment().register(environment, dbms);

        Binder binder = Binder.get(environment);
        assertThat(binder.bind("spring.datasource.url", String.class).get()).isEqualTo("jdbc:postgresql://127.0.0.1:1/none");
        assertThat(binder.bind("spring.datasource.username", String.class).get()).isEqualTo("tester");
        assertThat(binder.bind("spring.datasource.password", String.class).get()).isEqualTo(PASSWORD);
        assertThat(binder.bind("spring.test.database.replace", String.class).get()).isEqualTo("none");
        assertThat(binder.bind("spring.datasource.hikari.maximum-pool-size", Integer.class).get()).isEqualTo(4);
        assertThat(binder.bind("spring.datasource.hikari.schema", String.class).get()).isEqualTo("portal_store_it");
        assertThat(binder.bind("spring.flyway.default-schema", String.class).get()).isEqualTo("portal_store_it");
        assertThat(binder.bind("spring.flyway.clean-disabled", Boolean.class).get()).isFalse();
        assertThat(environment.getPropertySources().stream().map(Object::toString).collect(Collectors.joining("\n"))).doesNotContain(PASSWORD);
    }

    @Test
    @DisplayName("S2-DB-16: an empty or a missing password file is refused with a message that holds no content")
    void anEmptyOrMissingPasswordFileIsRefused(@TempDir Path folder) throws IOException {
        Path empty = folder.resolve("empty");
        Files.writeString(empty, "\n", StandardCharsets.UTF_8);

        assertThatThrownBy(() -> ExternalDbms.from(properties(empty)::get).orElseThrow().password()).isInstanceOf(IllegalStateException.class)
            .hasMessageContaining(ExternalDbms.PASSWORD_FILE);
        assertThatThrownBy(() -> ExternalDbms.from(properties(folder.resolve("absent"))::get).orElseThrow().password()).isInstanceOf(IllegalStateException.class)
            .hasMessageContaining(ExternalDbms.PASSWORD_FILE);
    }

    @Test
    @DisplayName("S2-DB-16: only a schema named portal_..._it is accepted: public, a system schema and an injected name are refused")
    void onlyATestSchemaNameIsAccepted(@TempDir Path folder) {
        for (String refused : new String[] {"public", "information_schema", "pg_catalog", "portal_store_it; DROP SCHEMA public", "portal__it", "Portal_Store_IT", "store_it"}) {
            Map<String, String> properties = properties(folder.resolve("pw"));
            properties.put(ExternalDbms.SCHEMA, refused);
            assertThatThrownBy(() -> ExternalDbms.from(properties::get)).as(refused).isInstanceOf(IllegalStateException.class).hasMessageContaining(ExternalDbms.SCHEMA);
        }
    }

    @Test
    @DisplayName("S2-DB-16: Flyway is cleaned only when it is confined to the test schema")
    void cleanIsRefusedOutsideTheTestSchema(@TempDir Path folder) {
        ExternalDbms dbms = ExternalDbms.from(properties(folder.resolve("pw"))::get).orElseThrow();

        dbms.requireOnlyTheTestSchema("portal_store_it", new String[0]);
        dbms.requireOnlyTheTestSchema("PORTAL_STORE_IT", new String[] {"portal_store_it"});
        assertThatThrownBy(() -> dbms.requireOnlyTheTestSchema(null, new String[0])).isInstanceOf(IllegalStateException.class);
        assertThatThrownBy(() -> dbms.requireOnlyTheTestSchema("public", new String[0])).isInstanceOf(IllegalStateException.class);
        assertThatThrownBy(() -> dbms.requireOnlyTheTestSchema("portal_store_it", new String[] {"portal_store_it", "public"})).isInstanceOf(IllegalStateException.class);
        assertThatThrownBy(() -> dbms.requireOnlyTheTestSchema("portal_store_it", new String[] {"public"})).isInstanceOf(IllegalStateException.class);
    }
}
