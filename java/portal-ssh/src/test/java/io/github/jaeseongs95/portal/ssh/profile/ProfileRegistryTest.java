package io.github.jaeseongs95.portal.ssh.profile;

import static org.assertj.core.api.Assertions.assertThat;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.List;

import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

import io.github.jaeseongs95.portal.app.remote.ProfileLookup;
import io.github.jaeseongs95.portal.domain.target.ProfileAlias;
import jakarta.validation.Validation;
import jakarta.validation.Validator;

/** The {@code ProfileSource} of the SSH adapter (stage 3 design 3.6): the profiles of a real profile file, by name. */
class ProfileRegistryTest {

    private static final Validator VALIDATOR = Validation.buildDefaultValidatorFactory().getValidator();

    @TempDir
    Path directory;

    private ProfileRegistry registry() throws IOException {
        Path file = Files.writeString(directory.resolve("config.toml"), "[[profiles]]\nname = \"web\"\nhost = \"web.example.test\"\nuser = \"deploy\"\n"
            + "[[profiles]]\nname = \"web\"\nhost = \"duplicate.example.test\"\nuser = \"deploy\"\n");
        return new ProfileRegistry(new TomlProfileLoader(new FileAccessGuard(List.of(FixedAccessRule.open())), VALIDATOR, new RecordingProfileEvents()).load(file));
    }

    @Test
    @DisplayName("VR-352, VR-464 (value half): a configured name is found, the first of two of one name wins, and two lookups give equal profiles")
    void aConfiguredNameIsFound() throws IOException {
        ProfileRegistry registry = registry();

        ProfileLookup first = registry.lookup(new ProfileAlias("web"));
        ProfileLookup second = registry.lookup(new ProfileAlias("web"));

        assertThat(first).isInstanceOfSatisfying(ProfileLookup.Found.class, found -> assertThat(found.profile().host()).isEqualTo("web.example.test"));
        assertThat(second).as("the profile of a request can be compared with the profile at dispatch time by value").isEqualTo(first);
    }

    @Test
    @DisplayName("VR-353: a name that no profile has is NotConfigured and names the alias")
    void anUnknownNameIsNotConfigured() throws IOException {
        ProfileAlias missing = new ProfileAlias("no-such-profile");

        assertThat(registry().lookup(missing)).isEqualTo(new ProfileLookup.NotConfigured(missing));
    }
}
