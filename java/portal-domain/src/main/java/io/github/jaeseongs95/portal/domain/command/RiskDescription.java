package io.github.jaeseongs95.portal.domain.command;

import java.util.Objects;

/** The catalogue's answer for a name: its entry, or the default for a name it does not know. A name that is not in the catalogue is "unknown", not "harmless". */
public sealed interface RiskDescription permits RiskDescription.Known, RiskDescription.Unknown {

    record Known(RiskEntry entry) implements RiskDescription {
        public Known {
            Objects.requireNonNull(entry, "entry");
        }
    }

    record Unknown(DefaultRisk risk) implements RiskDescription {
        public Unknown {
            Objects.requireNonNull(risk, "risk");
        }
    }
}
