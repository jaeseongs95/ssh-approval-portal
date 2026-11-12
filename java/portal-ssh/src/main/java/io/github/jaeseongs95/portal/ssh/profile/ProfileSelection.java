package io.github.jaeseongs95.portal.ssh.profile;

import java.util.List;
import java.util.Objects;

/**
 * The answer to "which profile does this name (or no name) select" (2.x vendor config/loader.js:180-207, PF-25 to PF-28): a profile, no name with several profiles to
 * choose from, or a name no profile has.
 */
public sealed interface ProfileSelection permits ProfileSelection.Selected, ProfileSelection.Ambiguous, ProfileSelection.NotFound {

    /** The profile that was selected. */
    record Selected(ProfileEntry entry) implements ProfileSelection {

        public Selected {
            Objects.requireNonNull(entry, "entry");
        }
    }

    /** No name was given, there is no default profile, and there are several profiles. */
    record Ambiguous(List<String> names) implements ProfileSelection {

        public Ambiguous {
            names = List.copyOf(names);
        }

        /** The sentence for the person who runs the product. */
        public String message() {
            return "No profile selected and no default configured, but " + names.size() + " profiles exist: " + String.join(", ", names)
                + ". Pass a \"profile\" argument, or set defaults.defaultProfile in the config.";
        }
    }

    /** A name was given (or is the default) and no profile has it. */
    record NotFound(String name) implements ProfileSelection {

        public NotFound {
            Objects.requireNonNull(name, "name");
        }

        /** The sentence for the person who runs the product. */
        public String message() {
            return "Profile \"" + name + "\" not found";
        }
    }
}
