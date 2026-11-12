package io.github.jaeseongs95.portal.store.external;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.sql.Connection;
import java.sql.DriverManager;
import java.sql.SQLException;
import java.sql.Statement;
import java.util.List;
import java.util.Optional;
import java.util.function.UnaryOperator;
import java.util.regex.Pattern;

/**
 * The external DBMS that the Gradle task {@code externalDbmsTest} points the storage tests at (stage 2 design 13.3a). The task hands over four system properties and
 * nothing else; no password is among them:
 * <ul>
 * <li>{@code portal.test.dbms.url}: the JDBC URL of the database;</li>
 * <li>{@code portal.test.dbms.user}: the account;</li>
 * <li>{@code portal.test.dbms.password-file}: the path of a file that holds the password (read here, as UTF-8, without the line terminator at its end);</li>
 * <li>{@code portal.test.dbms.schema}: the one schema the tests may use, see {@link #SCHEMA_NAME}.</li>
 * </ul>
 * When {@code portal.test.dbms.url} is not set the tests run on the embedded H2 database and {@link #from} returns nothing. A set URL with a missing property is
 * an error that names the property: an external run never falls back to H2 by accident.
 *
 * <p>The password is read from its file when it is needed and kept in no field. It is in no message, no {@code toString} and no log line of this class.
 *
 * <p>The statements that make and drop the schema are PostgreSQL's ({@code DROP SCHEMA ... CASCADE}); the task is registered for PostgreSQL, and another DBMS gets its
 * own statements here when its task is added.
 */
public record ExternalDbms(String url, String user, Path passwordFile, String schema) {

    static final String URL = "portal.test.dbms.url";
    static final String USER = "portal.test.dbms.user";
    static final String PASSWORD_FILE = "portal.test.dbms.password-file";
    static final String SCHEMA = "portal.test.dbms.schema";

    /**
     * The only form of a schema name the tests accept. The schema is dropped with everything in it (before the run and after it), so a name that could be the schema of
     * the product or of the DBMS ({@code public}, {@code information_schema}, {@code pg_catalog}) is refused: a test schema starts with {@code portal_} and ends with
     * {@code _it}.
     */
    static final Pattern SCHEMA_NAME = Pattern.compile("portal_[a-z0-9_]{1,40}_it");

    public ExternalDbms {
        if (!SCHEMA_NAME.matcher(schema).matches()) {
            throw new IllegalStateException("The test schema named by " + SCHEMA + " must match " + SCHEMA_NAME.pattern() + " (a schema that is dropped with all its content)");
        }
    }

    /** The external DBMS of this JVM's system properties, or nothing when the run is the default one on H2. */
    public static Optional<ExternalDbms> fromSystemProperties() {
        return from(System::getProperty);
    }

    /** Same as {@link #fromSystemProperties()} for any source of properties (a test gives its own). */
    static Optional<ExternalDbms> from(UnaryOperator<String> properties) {
        if (properties.apply(URL) == null) {
            return Optional.empty();
        }
        List<String> missing = List.of(USER, PASSWORD_FILE, SCHEMA).stream().filter(name -> properties.apply(name) == null).toList();
        if (!missing.isEmpty()) {
            throw new IllegalStateException("An external DBMS run needs the system properties " + missing + " next to " + URL + " (the Gradle task externalDbmsTest sets them)");
        }
        return Optional.of(new ExternalDbms(properties.apply(URL), properties.apply(USER), Path.of(properties.apply(PASSWORD_FILE)), properties.apply(SCHEMA)));
    }

    /** The password: the whole content of the file, as UTF-8, without the line terminator at its end. Never empty. */
    String password() {
        String content;
        try {
            content = Files.readString(passwordFile, StandardCharsets.UTF_8);
        } catch (IOException e) {
            throw new IllegalStateException("The file named by " + PASSWORD_FILE + " cannot be read as UTF-8 text (" + e.getClass().getSimpleName() + ")", e);
        }
        int end = content.length();
        while (end > 0 && (content.charAt(end - 1) == '\n' || content.charAt(end - 1) == '\r')) {
            end--;
        }
        if (end == 0) {
            throw new IllegalStateException("The file named by " + PASSWORD_FILE + " holds no password");
        }
        return content.substring(0, end);
    }

    /** Makes the test schema empty and ready: drops it with everything in it, then creates it. Runs once before the first test. */
    void recreateSchema() {
        run("DROP SCHEMA IF EXISTS " + schema + " CASCADE", "CREATE SCHEMA " + schema);
    }

    /** Drops the test schema with everything in it. Runs once after the last test, whether the tests passed or failed. */
    void dropSchema() {
        run("DROP SCHEMA IF EXISTS " + schema + " CASCADE");
    }

    /**
     * Refuses a Flyway that is not confined to the test schema. {@code Flyway.clean()} drops every object of the schemas it is configured for; the test configuration
     * calls it only after this check.
     */
    void requireOnlyTheTestSchema(String defaultSchema, String[] schemas) {
        boolean defaultIsTheTestSchema = schema.equalsIgnoreCase(defaultSchema);
        boolean onlyTheTestSchema = schemas.length == 0 || (schemas.length == 1 && schema.equalsIgnoreCase(schemas[0]));
        if (!defaultIsTheTestSchema || !onlyTheTestSchema) {
            throw new IllegalStateException("Flyway is not confined to the test schema " + schema + "; clean is refused");
        }
    }

    private void run(String... statements) {
        try (Connection connection = DriverManager.getConnection(url, user, password()); Statement statement = connection.createStatement()) {
            for (String sql : statements) {
                statement.execute(sql);
            }
        } catch (SQLException e) {
            throw new IllegalStateException("The external test DBMS refused a statement on the schema " + schema + " (SQLState " + e.getSQLState() + "): " + e.getMessage(), e);
        }
    }

    @Override
    public String toString() {
        // No URL (it could carry a credential of its own) and no password file.
        return "ExternalDbms[user=" + user + ", schema=" + schema + "]";
    }
}
