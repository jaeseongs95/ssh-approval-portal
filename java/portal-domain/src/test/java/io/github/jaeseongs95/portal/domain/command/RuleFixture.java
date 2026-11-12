package io.github.jaeseongs95.portal.domain.command;

import io.github.jaeseongs95.portal.domain.id.TargetId;
import io.github.jaeseongs95.portal.domain.target.ProfileAlias;
import io.github.jaeseongs95.portal.domain.target.TargetOs;
import io.github.jaeseongs95.portal.domain.target.TargetRevision;
import io.github.jaeseongs95.portal.domain.target.Toggle;
import java.util.ArrayList;
import java.util.EnumMap;
import java.util.List;
import java.util.Map;

/** Builds a {@link TargetRule} for the tests: everything off, no names, no threshold, until a test says otherwise. */
final class RuleFixture {

    static final TargetId TARGET = new TargetId("synthetic");
    static final TargetRevision REVISION = TargetRevision.of("a".repeat(64));
    static final ProfileAlias PROFILE = new ProfileAlias("writer");

    private TargetOs os = TargetOs.LINUX;
    private final List<String> commands = new ArrayList<>();
    private final List<String> denied = new ArrayList<>();
    private Toggle externalDisclosure = Toggle.OFF;
    private Toggle modelExecution = Toggle.OFF;
    private Toggle automaticSudo = Toggle.OFF;
    private Toggle testServer = Toggle.OFF;
    private SourceContract sourceContract = SourceContract.NONE;
    private Fallback fallback = Fallback.NONE;
    private final Map<EvaluatorProvider, Threshold> thresholds = new EnumMap<>(EvaluatorProvider.class);

    static RuleFixture rule() {
        return new RuleFixture();
    }

    RuleFixture windows() {
        os = TargetOs.WINDOWS;
        return this;
    }

    RuleFixture commands(String... names) {
        commands.addAll(List.of(names));
        return this;
    }

    RuleFixture denied(String... names) {
        denied.addAll(List.of(names));
        return this;
    }

    RuleFixture disclosure() {
        externalDisclosure = Toggle.ON;
        return this;
    }

    RuleFixture modelExecution() {
        modelExecution = Toggle.ON;
        return this;
    }

    RuleFixture sudo() {
        automaticSudo = Toggle.ON;
        return this;
    }

    RuleFixture testServer() {
        testServer = Toggle.ON;
        return this;
    }

    RuleFixture pythonSource() {
        sourceContract = SourceContract.PYTHON_SOURCE_V1;
        return this;
    }

    RuleFixture fallback(Fallback value) {
        fallback = value;
        return this;
    }

    /** The probability threshold in force: model jev-1.14.0, question v5, minimum {@code minLowRisk}. */
    RuleFixture jevThreshold(double minLowRisk) {
        return threshold(EvaluatorProvider.JEV, new ProbabilityThreshold(terms("jev-1.14.0", QuestionVersion.V5, minLowRisk)));
    }

    RuleFixture threshold(EvaluatorProvider provider, Threshold threshold) {
        thresholds.put(provider, threshold);
        return this;
    }

    static ThresholdTerms terms(String model, QuestionVersion version, double minLowRisk) {
        return new ThresholdTerms(model, version, minLowRisk, "validation:synthetic-1");
    }

    TargetRule build() {
        return new TargetRule(TARGET, REVISION, PROFILE, os, names(commands), names(denied), externalDisclosure, modelExecution, Toggle.OFF, Toggle.OFF, automaticSudo,
            testServer, sourceContract, fallback, new Thresholds(thresholds));
    }

    private CommandNames names(List<String> texts) {
        List<PolicyName> names = new ArrayList<>();
        for (String text : texts) {
            names.add(os == TargetOs.WINDOWS ? new WindowsPolicyName(text) : new LinuxPolicyName(text));
        }
        return new CommandNames(names);
    }
}
