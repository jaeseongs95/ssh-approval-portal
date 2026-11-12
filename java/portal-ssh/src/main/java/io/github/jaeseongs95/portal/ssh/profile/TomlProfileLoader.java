package io.github.jaeseongs95.portal.ssh.profile;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.NoSuchFileException;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Objects;
import java.util.Set;
import java.util.TreeSet;

import org.springframework.stereotype.Component;

import io.github.jaeseongs95.portal.domain.target.ProfileAlias;
import jakarta.validation.ConstraintViolation;
import jakarta.validation.Validator;
import tools.jackson.core.JacksonException;
import tools.jackson.core.exc.StreamReadException;
import tools.jackson.databind.DeserializationFeature;
import tools.jackson.databind.MapperFeature;
import tools.jackson.dataformat.toml.TomlMapper;

/**
 * Reads the profile file of the SSH adapter, the TOML file that 2.x named by {@code BRIDGE_CONFIG_PATH} (vendor config/loader.js, config/schema.js). The order is the one
 * of 2.x (PF-01): read the file, check who may use it, parse the TOML, validate the schema, merge the defaults.
 *
 * <ul>
 * <li><b>The path</b> is used as it is given: {@code ~} and variables are not expanded (PF-02). A missing file is a {@link ConfigNotFoundException}; one that exists and
 * cannot be read is a {@link ProfileConfigException} of the code {@code UNREADABLE} (PF-03).
 * <li><b>Who may use the file</b> is decided by {@link FileAccessGuard} for the file and its folder with {@link Protection#NO_OTHER_ACCESS}: no permission for the
 * group or others on a volume with permission bits (PF-04), and no other account that may change it on a volume with an access control list (PF-05). A readable-only
 * entry of an ACL is reported to {@link ProfileEvents#accessWarning}.
 * <li><b>The parser</b> is Jackson's TOML module (no parser of our own). A syntax error is {@code Failed to parse TOML config at <path>: ...} (PF-06). Unknown keys,
 * a text where a number or a boolean is written and a float where an integer is written are refused, never converted (PF-08, PF-11).
 * <li><b>The schema</b> is the Jakarta Validation constraints of the records {@code TomlDocument}, {@code TomlDefaults} and {@code TomlProfile}; the failure is
 * {@code Config validation error:} and a line {@code path: message} for each key (PF-07). Every profile name must be a valid {@code ProfileAlias} (a letter, digit or
 * underscore, then up to 79 of {@code A-Z a-z 0-9 _ . + -}), which is stricter than the vendor schema.
 * <li><b>The {@code [policy]} table</b> is checked as the vendor schema did and then not used; the load says so once through {@link ProfileEvents#policyNotEnforced}.
 * <li><b>Credential prefixes</b>: two names that give the same {@code SSH_MCP_} prefix ({@code a-b} and {@code a_b}) are refused, because they would read each other's
 * environment variables (EV-01, decision D3-09).
 * </ul>
 */
@Component
public final class TomlProfileLoader {

    private static final String VALIDATION_HEADER = "Config validation error:";

    private final FileAccessGuard guard;
    private final Validator validator;
    private final ProfileEvents events;
    private final TomlMapper mapper;

    public TomlProfileLoader(FileAccessGuard guard, Validator validator, ProfileEvents events) {
        this.guard = Objects.requireNonNull(guard, "guard");
        this.validator = Objects.requireNonNull(validator, "validator");
        this.events = Objects.requireNonNull(events, "events");
        // A mapper of its own (an exception of the rule "one JsonMapper bean" of Principles 2.2 category 2): that bean reads JSON, and Jackson's TOML module has no Boot bean.
        this.mapper = TomlMapper.builder()
            .enable(DeserializationFeature.FAIL_ON_UNKNOWN_PROPERTIES)
            .disable(DeserializationFeature.ACCEPT_FLOAT_AS_INT)
            .disable(MapperFeature.ALLOW_COERCION_OF_SCALARS)
            .build();
    }

    /**
     * Loads the profiles of the file.
     *
     * @throws ConfigNotFoundException when there is no file at the path
     * @throws ProfileConfigException when the file cannot be read, is open to other accounts, is not TOML, breaks the schema or has names with a shared credential prefix
     */
    public ProfileCatalog load(Path path) {
        Objects.requireNonNull(path, "path");
        String text = read(path);
        checkAccess(path);
        TomlDocument document = parse(path, text);
        validate(document);
        ProfileCatalog catalog = normalize(document);
        if (document.policy() != null) {
            events.policyNotEnforced();
        }
        return catalog;
    }

    private String read(Path path) {
        try {
            return Files.readString(path, StandardCharsets.UTF_8);
        } catch (NoSuchFileException e) {
            throw new ConfigNotFoundException(path.toString(), e);
        } catch (IOException e) {
            throw new ProfileConfigException(ProfileConfigException.Code.UNREADABLE, "Config file " + path + " could not be read: " + e.getClass().getSimpleName(), e);
        }
    }

    private void checkAccess(Path path) {
        AccessVerdict verdict;
        try {
            verdict = guard.inspect(path, Protection.NO_OTHER_ACCESS);
        } catch (IOException e) {
            throw new ProfileConfigException(ProfileConfigException.Code.UNREADABLE, "Config file " + path + " could not be checked: " + e.getClass().getSimpleName(), e);
        }
        switch (verdict) {
            case AccessVerdict.Refused refused -> throw new ProfileConfigException(ProfileConfigException.Code.ACCESS_REFUSED, refused.reason());
            case AccessVerdict.Exposed exposed -> events.accessWarning(exposed.reason());
            case AccessVerdict.Private ignored -> {
            }
        }
    }

    private TomlDocument parse(Path path, String text) {
        try {
            return mapper.readValue(text, TomlDocument.class);
        } catch (StreamReadException e) {
            throw new ProfileConfigException(ProfileConfigException.Code.NOT_TOML, "Failed to parse TOML config at " + path + ": " + e.getOriginalMessage(), e);
        } catch (JacksonException e) {
            Throwable cause = e.getCause();
            String message = cause instanceof IllegalArgumentException ? cause.getMessage() : e.getOriginalMessage();
            throw new ProfileConfigException(ProfileConfigException.Code.INVALID_SCHEMA, VALIDATION_HEADER + "\n  " + pathOf(e) + ": " + message, e);
        }
    }

    /** The keys from the root to the failing one, joined by dots: {@code profiles.0.port}, or {@code (root)}. */
    private String pathOf(JacksonException failure) {
        List<String> parts = new ArrayList<>();
        for (JacksonException.Reference step : failure.getPath()) {
            parts.add(step.getPropertyName() != null ? step.getPropertyName() : Integer.toString(step.getIndex()));
        }
        return parts.isEmpty() ? "(root)" : String.join(".", parts);
    }

    private void validate(TomlDocument document) {
        Set<ConstraintViolation<TomlDocument>> violations = validator.validate(document);
        if (violations.isEmpty()) {
            return;
        }
        Set<String> lines = new TreeSet<>();
        for (ConstraintViolation<TomlDocument> violation : violations) {
            List<String> parts = new ArrayList<>();
            for (jakarta.validation.Path.Node node : violation.getPropertyPath()) {
                if (node.isInIterable() && node.getIndex() != null) {
                    parts.add(node.getIndex().toString());
                }
                if (node.getName() != null) {
                    parts.add(node.getName());
                }
            }
            lines.add("  " + String.join(".", parts) + ": " + violation.getMessage());
        }
        throw new ProfileConfigException(ProfileConfigException.Code.INVALID_SCHEMA, VALIDATION_HEADER + "\n" + String.join("\n", lines));
    }

    private ProfileCatalog normalize(TomlDocument document) {
        ProfileDefaults defaults = (document.defaults() != null ? document.defaults() : TomlDefaults.none()).normalized();
        List<ProfileEntry> entries = new ArrayList<>();
        List<String> issues = new ArrayList<>();
        for (int i = 0; i < document.profiles().size(); i++) {
            try {
                entries.add(document.profiles().get(i).entry(defaults));
            } catch (IllegalArgumentException e) {
                issues.add("  profiles." + i + ": " + e.getMessage());
            }
        }
        if (!issues.isEmpty()) {
            throw new ProfileConfigException(ProfileConfigException.Code.INVALID_SCHEMA, VALIDATION_HEADER + "\n" + String.join("\n", issues));
        }
        rejectSharedPrefixes(entries);
        return new ProfileCatalog(defaults, entries);
    }

    private void rejectSharedPrefixes(List<ProfileEntry> entries) {
        Map<String, ProfileAlias> nameOfPrefix = new LinkedHashMap<>();
        for (ProfileEntry entry : entries) {
            String prefix = CredentialPrefix.of(entry.alias().value()).value();
            ProfileAlias earlier = nameOfPrefix.putIfAbsent(prefix, entry.alias());
            if (earlier != null && !earlier.equals(entry.alias())) {
                throw new ProfileConfigException(ProfileConfigException.Code.CREDENTIAL_PREFIX_CLASH, "The profile names \"" + earlier.value() + "\" and \""
                    + entry.alias().value() + "\" share the credential prefix " + prefix + ", so they would read each other's SSH_MCP_ variables; rename one of them");
            }
        }
    }
}
