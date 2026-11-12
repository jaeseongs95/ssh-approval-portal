package io.github.jaeseongs95.portal.ssh.profile;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import java.io.IOException;
import java.io.InputStream;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Duration;
import java.util.List;

import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.ValueSource;

import io.github.jaeseongs95.portal.domain.target.AccessMode;
import io.github.jaeseongs95.portal.domain.target.AuthMethod;
import io.github.jaeseongs95.portal.domain.target.ConnectionProfile;
import io.github.jaeseongs95.portal.domain.target.ProfileAlias;
import io.github.jaeseongs95.portal.domain.target.Setting;
import io.github.jaeseongs95.portal.domain.target.TtyMode;
import jakarta.validation.Validation;
import jakarta.validation.Validator;

/**
 * The profile file of the SSH adapter (vendor rules PF-01 to PF-28, cases VR-319 to VR-374 of vendor-ssh-mcp-rules.md, section 3.6). The expectations were traced from the
 * vendor source (config/loader.js, config/schema.js) before the first run. The parser is Jackson's TOML module and the schema is Jakarta Validation; the files are real files
 * in a temporary folder.
 */
class TomlProfileLoaderTest {

    private static final Validator VALIDATOR = Validation.buildDefaultValidatorFactory().getValidator();

    @TempDir
    Path directory;

    private final RecordingProfileEvents events = new RecordingProfileEvents();
    private final TomlProfileLoader loader = new TomlProfileLoader(new FileAccessGuard(List.of(FixedAccessRule.open())), VALIDATOR, events);

    private Path write(String toml) throws IOException {
        return Files.writeString(directory.resolve("config.toml"), toml);
    }

    /** A file with one profile {@code a} (name, host and user only), the keys of {@code profileBody} added to it, and a {@code [defaults]} table when there is a body for it. */
    private String document(String defaultsBody, String profileBody) {
        String defaults = defaultsBody == null ? "" : "[defaults]\n" + defaultsBody + "\n";
        return defaults + "[[profiles]]\nname = \"a\"\nhost = \"h\"\nuser = \"u\"\n" + profileBody + "\n";
    }

    private ProfileCatalog load(String toml) throws IOException {
        return loader.load(write(toml));
    }

    private ProfileOptions optionsOfFirst(ProfileCatalog catalog) {
        return catalog.entries().get(0).options();
    }

    private ConnectionProfile connectionOfFirst(ProfileCatalog catalog) {
        return catalog.entries().get(0).connection();
    }

    private void assertRefused(String toml, String... fragments) throws IOException {
        Path path = write(toml);
        assertThatThrownBy(() -> loader.load(path)).isInstanceOf(ProfileConfigException.class).hasMessageContainingAll(fragments);
    }

    private void assertValidationError(String toml, String... fragments) throws IOException {
        Path path = write(toml);
        assertThatThrownBy(() -> loader.load(path)).isInstanceOf(ProfileConfigException.class).hasMessageStartingWith("Config validation error:")
            .hasMessageContainingAll(fragments);
    }

    @Test
    @DisplayName("PF-01: a file that uses every key of the schema loads, and every key reaches the profile or the defaults")
    void aFileWithEveryKeyLoads() throws IOException {
        Path file = directory.resolve("full.toml");
        try (InputStream resource = getClass().getResourceAsStream("/profile/full.toml")) {
            Files.write(file, resource.readAllBytes());
        }

        ProfileCatalog catalog = loader.load(file);

        assertThat(catalog.entries()).extracting(entry -> entry.alias().value()).containsExactly("build", "jump", "db");
        ProfileEntry build = catalog.entries().get(0);
        assertThat(build.connection()).isEqualTo(new ConnectionProfile("build.example.test", 2222, "deploy", Setting.given("SHA256:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"),
            Setting.unset(), AuthMethod.KEY, Setting.given("keys/deploy"), Setting.given("/srv/build"), AccessMode.READ_ONLY, TtyMode.TTY));
        assertThat(build.options().group()).isEqualTo(Setting.given("ci"));
        assertThat(build.options().role()).isEqualTo("builder");
        assertThat(build.options().cert()).isTrue();
        assertThat(build.options().announceAgent()).isFalse();
        assertThat(catalog.entries().get(2).connection().via()).isEqualTo(Setting.given(new ProfileAlias("jump")));
        assertThat(catalog.entries().get(2).connection().auth()).isEqualTo(AuthMethod.KEYCHAIN);
        assertThat(catalog.defaults().transferRoot()).isEqualTo(Setting.given("/srv/transfer"));
        assertThat(catalog.defaults().approval()).isEqualTo(ProfileApproval.ASK_ALL);
        assertThat(events.accessWarnings()).isEmpty();
        assertThat(events.policyReports()).as("the file has a [policy] table").isEqualTo(1);
    }

    @Test
    @DisplayName("[policy] (decision of the lead): a file with a [policy] table loads and says once that the table is not enforced; a file without one says nothing")
    void thePolicyTableIsAcceptedWithAWarning() throws IOException {
        load(document(null, "") + "\n[policy]\ndenylist = [\"rm -rf /\"]\n");
        assertThat(events.policyReports()).isEqualTo(1);

        load(document(null, ""));
        assertThat(events.policyReports()).as("no second report for a file without the table").isEqualTo(1);
    }

    @Test
    @DisplayName("[policy] (decision of the lead): a [policy] table that breaks the schema is refused, not warned about")
    void aBrokenPolicyTableIsRefused() throws IOException {
        assertValidationError(document(null, "") + "\n[policy]\nfoo = 1\n", "policy.foo");
        assertThat(events.policyReports()).isZero();
    }

    @Test
    @DisplayName("VR-319: the access check comes before the parsing: a file that others may read and that is not TOML is reported for its mode")
    void theAccessCheckComesBeforeTheParsing() throws IOException {
        TomlProfileLoader strict = new TomlProfileLoader(new FileAccessGuard(List.of(new FixedAccessRule(new AccessVerdict.Refused("Config file is group/world accessible (mode 644)")))),
            VALIDATOR, events);
        Path path = write("this is = = not toml [[[");

        assertThatThrownBy(() -> strict.load(path)).isInstanceOf(ProfileConfigException.class).hasMessageContaining("mode 644").hasMessageNotContaining("Failed to parse");
    }

    @Test
    @DisplayName("VR-329: a file that others may only read loads, and the warning is reported to the events")
    void aReadableFileLoadsWithAWarning() throws IOException {
        TomlProfileLoader warning = new TomlProfileLoader(new FileAccessGuard(List.of(new FixedAccessRule(new AccessVerdict.Exposed("can be read by Users")))), VALIDATOR, events);

        warning.load(write(document(null, "")));

        assertThat(events.accessWarnings()).containsExactly("can be read by Users");
    }

    @Test
    @DisplayName("VR-320: a path with a ~ is used as it is: the file is not found and the error names the path as given")
    void aTildeIsNotExpanded() {
        Path tilde = Path.of("~/c.toml");

        assertThatThrownBy(() -> loader.load(tilde)).isInstanceOfSatisfying(ConfigNotFoundException.class, e -> assertThat(e.path()).startsWith("~").endsWith("c.toml"));
    }

    @Test
    @DisplayName("VR-323: a path that does not exist is a ConfigNotFoundException that names the path")
    void aMissingFileIsNotFound() {
        Path missing = directory.resolve("missing.toml");

        assertThatThrownBy(() -> loader.load(missing)).isInstanceOf(ConfigNotFoundException.class).hasMessageContaining(missing.toString());
    }

    @Test
    @DisplayName("VR-324: a path that is a folder cannot be read: the error says so and keeps the cause, and it is not a not-found error")
    void aFolderCannotBeRead() {
        assertThatThrownBy(() -> loader.load(directory)).isNotInstanceOf(ConfigNotFoundException.class).isInstanceOf(ProfileConfigException.class)
            .hasMessageStartingWith("Config file " + directory).hasMessageContaining("could not be read").hasCauseInstanceOf(IOException.class);
    }

    @Test
    @DisplayName("VR-330: a file that is not TOML is reported as Failed to parse TOML config at <path>")
    void aSyntaxErrorIsReported() throws IOException {
        Path path = write("[[profiles]\nname = \n");

        assertThatThrownBy(() -> loader.load(path)).isInstanceOf(ProfileConfigException.class).hasMessageStartingWith("Failed to parse TOML config at " + path + ":");
    }

    @Test
    @DisplayName("VR-331: an unknown key in [defaults] is refused with Config validation error and the path of the key")
    void anUnknownDefaultsKeyIsRefused() throws IOException {
        assertValidationError(document("foo = 1", ""), "defaults.foo");
    }

    @Test
    @DisplayName("VR-332: an unknown table at the root is refused")
    void anUnknownRootTableIsRefused() throws IOException {
        assertValidationError(document(null, "") + "\n[extra]\nx = 1\n", "extra");
    }

    @Test
    @DisplayName("VR-333: an unknown key in a profile is refused with the index of the profile")
    void anUnknownProfileKeyIsRefused() throws IOException {
        assertValidationError(document(null, "nme = \"x\""), "profiles.0.nme");
    }

    @Test
    @DisplayName("VR-334: an unknown key in [policy] is refused")
    void anUnknownPolicyKeyIsRefused() throws IOException {
        assertValidationError(document(null, "") + "\n[policy]\nfoo = 1\n", "policy.foo");
    }

    @Test
    @DisplayName("VR-335: a file without [[profiles]] and a file with profiles = [] are refused")
    void thereMustBeAProfile() throws IOException {
        assertValidationError("[defaults]\ncommandTimeoutMs = 1000\n", "profiles");
        assertValidationError("profiles = []\n", "profiles");
    }

    @Test
    @DisplayName("VR-336: a file without [defaults] and with one profile that has a name, a host and a user loads with every default")
    void aMinimalFileLoadsWithTheDefaults() throws IOException {
        ProfileCatalog catalog = load(document(null, ""));

        assertThat(catalog.defaults().sessionMaxPerConnection()).isEqualTo(5);
        assertThat(catalog.defaults().commandTimeout()).isEqualTo(Duration.ofMillis(60_000));
        ConnectionProfile connection = connectionOfFirst(catalog);
        assertThat(connection).isEqualTo(new ConnectionProfile("h", 22, "u", Setting.unset(), Setting.unset(), AuthMethod.AGENT, Setting.unset(), Setting.unset(),
            AccessMode.READ_WRITE, TtyMode.NO_TTY));
    }

    @ParameterizedTest(name = "VR-337: the profile without {0} is refused")
    @ValueSource(strings = {"name", "host", "user"})
    @DisplayName("VR-337")
    void aProfileNeedsANameAHostAndAUser(String missing) throws IOException {
        String body = "[[profiles]]\n" + ("name".equals(missing) ? "" : "name = \"a\"\n") + ("host".equals(missing) ? "" : "host = \"h\"\n")
            + ("user".equals(missing) ? "" : "user = \"u\"\n");

        assertValidationError(body, "profiles.0." + missing);
    }

    @Test
    @DisplayName("VR-338: an empty [defaults] gives every default of the vendor schema, and no transferRoot and no defaultProfile")
    void anEmptyDefaultsTableGivesTheDefaults() throws IOException {
        ProfileDefaults defaults = load("[defaults]\n[[profiles]]\nname = \"a\"\nhost = \"h\"\nuser = \"u\"\n").defaults();

        assertThat(defaults).isEqualTo(new ProfileDefaults(Setting.unset(), 5, Duration.ofMillis(600_000), Duration.ofMillis(3_600_000), Duration.ofMillis(60_000), 5000,
            1_048_576, Duration.ofMillis(900_000), 0, Duration.ZERO, ProfileApproval.ASK_DESTRUCTIVE, Setting.unset(), 268_435_456, Duration.ofMillis(300_000)));
    }

    @Test
    @DisplayName("VR-339: commandMaxChars = 0 means no limit, 9007199254740991, in the defaults and in the profile")
    void zeroCharactersIsUnlimited() throws IOException {
        ProfileCatalog catalog = load(document("commandMaxChars = 0", ""));

        assertThat(catalog.defaults().commandMaxChars()).isEqualTo(9_007_199_254_740_991L);
        assertThat(optionsOfFirst(catalog).commandMaxChars()).isEqualTo(9_007_199_254_740_991L);
    }

    @ParameterizedTest(name = "VR-340: {0} is refused")
    @ValueSource(strings = {"sessionMaxPerConnection = 0", "commandTimeoutMs = -1", "commandMaxChars = -1", "transferTimeoutMs = 2147483648", "commandMaxOutputBytes = 0"})
    @DisplayName("VR-340")
    void numbersOutOfRangeAreRefused(String line) throws IOException {
        assertValidationError(document(line, ""), "defaults." + line.substring(0, line.indexOf(' ')));
    }

    @Test
    @DisplayName("VR-341: transferMaxBytes = 9007199254740991, the largest integer of a JavaScript number, is accepted")
    void theLargestTransferSizeIsAccepted() throws IOException {
        assertThat(load(document("transferMaxBytes = 9007199254740991", "")).defaults().transferMaxBytes()).isEqualTo(9_007_199_254_740_991L);
    }

    @Test
    @DisplayName("VR-342: transferTimeoutMs = 2147483647 is accepted and 2147483648 is refused")
    void theLargestTransferTimeoutIsTheLargest32BitNumber() throws IOException {
        assertThat(load(document("transferTimeoutMs = 2147483647", "")).defaults().transferTimeout()).isEqualTo(Duration.ofMillis(2_147_483_647L));
        assertValidationError(document("transferTimeoutMs = 2147483648", ""), "defaults.transferTimeoutMs");
    }

    @Test
    @DisplayName("VR-343: an approval mode that is not auto, ask-destructive, ask-all or deny is refused")
    void anUnknownApprovalModeIsRefused() throws IOException {
        assertValidationError(document("approvalMode = \"ask-everything\"", ""), "defaults.approvalMode");
    }

    @Test
    @DisplayName("VR-344: a port that is left out is 22; 0, 65536 and 22.5 are refused (2.x와 다름: a TOML float is never taken for an integer, so 22.0 is refused too, where 2.x's JavaScript number took it; stricter, no value is converted)")
    void thePortHasADefaultAndABound() throws IOException {
        assertThat(connectionOfFirst(load(document(null, ""))).port()).isEqualTo(22);
        assertValidationError(document(null, "port = 0"), "profiles.0.port");
        assertValidationError(document(null, "port = 65536"), "profiles.0.port");
        assertValidationError(document(null, "port = 22.5"), "profiles.0.port");
    }

    @Test
    @DisplayName("VR-345: auth is agent when left out, the four methods are accepted and token is refused")
    void theAuthenticationMethodIsOneOfFour() throws IOException {
        assertThat(connectionOfFirst(load(document(null, ""))).auth()).isEqualTo(AuthMethod.AGENT);
        assertThat(connectionOfFirst(load(document(null, "auth = \"key\""))).auth()).isEqualTo(AuthMethod.KEY);
        assertThat(connectionOfFirst(load(document(null, "auth = \"password\""))).auth()).isEqualTo(AuthMethod.PASSWORD);
        assertThat(connectionOfFirst(load(document(null, "auth = \"keychain\""))).auth()).isEqualTo(AuthMethod.KEYCHAIN);
        assertThat(connectionOfFirst(load(document(null, "auth = \"agent\""))).auth()).isEqualTo(AuthMethod.AGENT);
        assertValidationError(document(null, "auth = \"token\""), "profiles.0.auth");
    }

    @Test
    @DisplayName("VR-346, VR-402 (profile half): tty, readOnly and cert are false and announceAgent is true when left out")
    void theSwitchesHaveTheirDefaults() throws IOException {
        ProfileCatalog catalog = load(document(null, ""));

        assertThat(connectionOfFirst(catalog).tty()).isEqualTo(TtyMode.NO_TTY);
        assertThat(connectionOfFirst(catalog).access()).isEqualTo(AccessMode.READ_WRITE);
        assertThat(optionsOfFirst(catalog).cert()).isFalse();
        assertThat(optionsOfFirst(catalog).announceAgent()).isTrue();
        assertThat(optionsOfFirst(load(document(null, "announceAgent = false"))).announceAgent()).isFalse();
    }

    @Test
    @DisplayName("VR-347: the role is operator when left out")
    void theRoleDefaultsToOperator() throws IOException {
        assertThat(optionsOfFirst(load(document(null, ""))).role()).isEqualTo("operator");
        assertThat(optionsOfFirst(load(document(null, "role = \"reader\""))).role()).isEqualTo("reader");
    }

    @Test
    @DisplayName("VR-348: readOnly = \"true\" (a text) is refused, a TOML boolean is accepted")
    void aBooleanIsATomlBoolean() throws IOException {
        assertValidationError(document(null, "readOnly = \"true\""), "profiles.0.readOnly");
        assertThat(connectionOfFirst(load(document(null, "readOnly = true"))).access()).isEqualTo(AccessMode.READ_ONLY);
    }

    @ParameterizedTest(name = "VR-349: trustedHostKey = \"{0}\" is refused")
    @ValueSource(strings = {"", "   "})
    @DisplayName("VR-349")
    void anEmptyPinIsRefused(String pin) throws IOException {
        assertValidationError(document(null, "trustedHostKey = \"" + pin + "\""), "profiles.0.trustedHostKey", "trustedHostKey cannot be empty");
    }

    @Test
    @DisplayName("VR-350: the blanks around a pinned host key are removed")
    void thePinIsTrimmed() throws IOException {
        assertThat(connectionOfFirst(load(document(null, "trustedHostKey = \"  SHA256:abc  \""))).pinnedHostKey()).isEqualTo(Setting.given("SHA256:abc"));
    }

    @ParameterizedTest(name = "VR-351: {0} = \"\" is refused")
    @ValueSource(strings = {"name", "host", "user"})
    @DisplayName("VR-351")
    void anEmptyNameHostOrUserIsRefused(String key) throws IOException {
        String body = "[[profiles]]\nname = " + ("name".equals(key) ? "\"\"" : "\"a\"") + "\nhost = " + ("host".equals(key) ? "\"\"" : "\"h\"") + "\nuser = "
            + ("user".equals(key) ? "\"\"" : "\"u\"") + "\n";

        assertValidationError(body, "profiles.0." + key);
    }

    @Test
    @DisplayName("VR-352: two profiles of one name load, and select takes the first")
    void twoProfilesOfOneNameLoad() throws IOException {
        ProfileCatalog catalog = load("[[profiles]]\nname = \"a\"\nhost = \"first\"\nuser = \"u\"\n[[profiles]]\nname = \"a\"\nhost = \"second\"\nuser = \"u\"\n");

        assertThat(catalog.entries()).hasSize(2);
        assertThat(catalog.select("a")).isInstanceOfSatisfying(ProfileSelection.Selected.class, selected -> assertThat(selected.entry().connection().host()).isEqualTo("first"));
    }

    @Test
    @DisplayName("VR-353: a via that names no profile is not checked when the file is loaded")
    void aViaIsNotCheckedAtLoad() throws IOException {
        assertThat(connectionOfFirst(load(document(null, "via = \"no-such-profile\""))).via()).isEqualTo(Setting.given(new ProfileAlias("no-such-profile")));
    }

    @Test
    @DisplayName("VR-354: a role named __proto__ is refused with the reserved-name sentence")
    void aReservedRoleNameIsRefused() throws IOException {
        assertValidationError(document(null, "") + "\n[policy.roleBindings.__proto__]\nprod = [\"read-only\"]\n", "Reserved name (__proto__, constructor, prototype). Rename the role or tier.");
    }

    @Test
    @DisplayName("VR-355: an empty role name is refused")
    void anEmptyRoleNameIsRefused() throws IOException {
        assertRefused(document(null, "") + "\n[policy.roleBindings.\"\"]\nprod = [\"read-only\"]\n", "Role and tier names cannot be empty.");
    }

    @Test
    @DisplayName("VR-356: a tier that is not read-only, safe, destructive or privileged is refused")
    void anUnknownCommandClassIsRefused() throws IOException {
        assertValidationError(document(null, "") + "\n[policy.roleBindings.operator]\nprod = [\"priviledged\"]\n", "policy.roleBindings.operator.prod");
    }

    @Test
    @DisplayName("VR-357, VR-358: the command timeout of a profile that has none is the default, and one that has its own keeps it")
    void theTimeoutIsMerged() throws IOException {
        assertThat(optionsOfFirst(load(document("commandTimeoutMs = 45000", ""))).commandTimeout()).isEqualTo(Duration.ofMillis(45_000));
        assertThat(optionsOfFirst(load(document("commandTimeoutMs = 45000", "timeout = 1000"))).commandTimeout()).isEqualTo(Duration.ofMillis(1000));
    }

    @Test
    @DisplayName("VR-359, VR-360: maxChars is 5000 when neither file part says, and 0 of a profile is unlimited")
    void theMaximumCharactersAreMerged() throws IOException {
        assertThat(optionsOfFirst(load(document(null, ""))).commandMaxChars()).isEqualTo(5000);
        assertThat(optionsOfFirst(load(document(null, "maxChars = 0"))).commandMaxChars()).isEqualTo(9_007_199_254_740_991L);
    }

    @Test
    @DisplayName("VR-361: maxOutputBytes of a profile that has none is the default")
    void theOutputLimitIsMerged() throws IOException {
        assertThat(optionsOfFirst(load(document("commandMaxOutputBytes = 2048", ""))).commandMaxOutputBytes()).isEqualTo(2048);
    }

    @Test
    @DisplayName("VR-362: the approval policy of a profile that has none is the approval mode of the defaults")
    void theApprovalIsMerged() throws IOException {
        assertThat(optionsOfFirst(load(document("approvalMode = \"ask-all\"", ""))).approval()).isEqualTo(ProfileApproval.ASK_ALL);
        assertThat(optionsOfFirst(load(document("approvalMode = \"ask-all\"", "approvalPolicy = \"auto\""))).approval()).isEqualTo(ProfileApproval.AUTO);
    }

    @Test
    @DisplayName("VR-363, VR-364, VR-365: the session values of a profile that has none are the defaults")
    void theSessionValuesAreMerged() throws IOException {
        ProfileOptions options = optionsOfFirst(load(document("sessionMaxPerConnection = 7\nsessionIdleTimeoutMs = 1000\nsessionBackgroundMaxMs = 2000", "")));

        assertThat(options.sessionMaxPerConnection()).isEqualTo(7);
        assertThat(options.sessionIdleTimeout()).isEqualTo(Duration.ofMillis(1000));
        assertThat(options.sessionBackgroundMax()).isEqualTo(Duration.ofMillis(2000));
    }

    @Test
    @DisplayName("VR-366: a quota of 0 in the profile wins over the default quota of 10")
    void anExplicitZeroWins() throws IOException {
        assertThat(optionsOfFirst(load(document("commandQuotaPerDay = 10", "commandQuotaPerDay = 0"))).commandQuotaPerDay()).isZero();
    }

    @Test
    @DisplayName("VR-367, VR-368: the transfer values of a profile that has none are the defaults, and 300000 ms when no default is given either")
    void theTransferValuesAreMerged() throws IOException {
        assertThat(optionsOfFirst(load(document("transferMaxBytes = 1024", ""))).transferMaxBytes()).isEqualTo(1024);
        assertThat(optionsOfFirst(load(document(null, ""))).transferTimeout()).isEqualTo(Duration.ofMillis(300_000));
    }

    @Test
    @DisplayName("VR-369: a quota of 0 in the defaults stays 0 and is not turned into a limit")
    void theQuotaZeroIsNotChanged() throws IOException {
        assertThat(optionsOfFirst(load(document("commandQuotaPerDay = 0", ""))).commandQuotaPerDay()).isZero();
    }

    @Test
    @DisplayName("VR-370: connectionIdleReapMs stays in the defaults and is not copied to the profiles")
    void someDefaultsStayInTheDefaults() throws IOException {
        assertThat(load(document("connectionIdleReapMs = 5000", "")).defaults().connectionIdleReap()).isEqualTo(Duration.ofMillis(5000));
    }

    private ProfileCatalog twoProfiles(String defaultsBody) throws IOException {
        String defaults = defaultsBody == null ? "" : "[defaults]\n" + defaultsBody + "\n";
        return load(defaults + "[[profiles]]\nname = \"a\"\nhost = \"h1\"\nuser = \"u\"\n[[profiles]]\nname = \"b\"\nhost = \"h2\"\nuser = \"u\"\n");
    }

    @Test
    @DisplayName("VR-371: with defaultProfile = b, an empty name selects b")
    void anEmptyNameSelectsTheDefaultProfile() throws IOException {
        ProfileCatalog catalog = twoProfiles("defaultProfile = \"b\"");

        assertThat(catalog.select("")).isInstanceOfSatisfying(ProfileSelection.Selected.class, selected -> assertThat(selected.entry().alias().value()).isEqualTo("b"));
        assertThat(catalog.select(null)).isInstanceOf(ProfileSelection.Selected.class);
    }

    @Test
    @DisplayName("VR-372: two profiles, no default and no name: the answer lists the names and says how to choose")
    void severalProfilesNeedAName() throws IOException {
        assertThat(twoProfiles(null).select(null)).isInstanceOfSatisfying(ProfileSelection.Ambiguous.class, ambiguous -> assertThat(ambiguous.message())
            .isEqualTo("No profile selected and no default configured, but 2 profiles exist: a, b. Pass a \"profile\" argument, or set defaults.defaultProfile in the config."));
    }

    @Test
    @DisplayName("VR-373: one profile, no default and no name: that profile")
    void aSingleProfileIsTheDefault() throws IOException {
        assertThat(load(document(null, "")).select(null)).isInstanceOfSatisfying(ProfileSelection.Selected.class,
            selected -> assertThat(selected.entry().alias().value()).isEqualTo("a"));
    }

    @Test
    @DisplayName("VR-374: a name that no profile has: Profile \"x\" not found")
    void anUnknownNameIsNotFound() throws IOException {
        assertThat(twoProfiles(null).select("x")).isInstanceOfSatisfying(ProfileSelection.NotFound.class,
            notFound -> assertThat(notFound.message()).isEqualTo("Profile \"x\" not found"));
    }

    @Test
    @DisplayName("EV-01, D3-09 (2.x와 다름: 2.x let a-b and a_b read each other's SSH_MCP_ variables; refused at load so no credential is read by the wrong profile): two profile names that give one credential prefix are refused when the file is loaded")
    void namesWithOneCredentialPrefixAreRefused() throws IOException {
        assertRefused("[[profiles]]\nname = \"a-b\"\nhost = \"h\"\nuser = \"u\"\n[[profiles]]\nname = \"a_b\"\nhost = \"h\"\nuser = \"u\"\n", "SSH_MCP_A_B", "a-b", "a_b");
    }

    @Test
    @DisplayName("PF-11 (2.x와 다름: the vendor schema took any text as a name; the domain type ProfileAlias is the rule, so a name with a blank or a symbol is refused at load, not at the first use): a profile name that is not a valid ProfileAlias is refused with its index")
    void aNameThatIsNotAnAliasIsRefused() throws IOException {
        assertValidationError("[[profiles]]\nname = \"a b\"\nhost = \"h\"\nuser = \"u\"\n", "profiles.0");
    }
}
