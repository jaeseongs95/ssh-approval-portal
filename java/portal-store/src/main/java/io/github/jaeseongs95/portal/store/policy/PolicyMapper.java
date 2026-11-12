package io.github.jaeseongs95.portal.store.policy;

import java.util.ArrayList;
import java.util.Comparator;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.stream.Collectors;

import org.springframework.stereotype.Component;

import io.github.jaeseongs95.portal.domain.command.CommandNames;
import io.github.jaeseongs95.portal.domain.command.CommandPolicyDocument;
import io.github.jaeseongs95.portal.domain.command.ConfidenceThreshold;
import io.github.jaeseongs95.portal.domain.command.EvaluatorProvider;
import io.github.jaeseongs95.portal.domain.command.LinuxPolicyName;
import io.github.jaeseongs95.portal.domain.command.PolicyName;
import io.github.jaeseongs95.portal.domain.command.ProbabilityThreshold;
import io.github.jaeseongs95.portal.domain.command.TargetRule;
import io.github.jaeseongs95.portal.domain.command.Threshold;
import io.github.jaeseongs95.portal.domain.command.ThresholdTerms;
import io.github.jaeseongs95.portal.domain.command.Thresholds;
import io.github.jaeseongs95.portal.domain.command.WindowsPolicyName;
import io.github.jaeseongs95.portal.domain.id.TargetId;
import io.github.jaeseongs95.portal.domain.target.ProfileAlias;
import io.github.jaeseongs95.portal.domain.target.TargetOs;
import io.github.jaeseongs95.portal.domain.target.TargetRevision;

/**
 * Converts between the domain {@link CommandPolicyDocument} and the rows of the three child tables. The domain keeps no Spring Data annotation (rule A-DOMAIN), so
 * the rows are separate records and this component is the only place that knows both.
 */
@Component
class PolicyMapper {

    /** One row per target rule. */
    List<PolicyRuleRow> ruleRows(CommandPolicyDocument document) {
        List<PolicyRuleRow> rows = new ArrayList<>();
        for (TargetRule rule : document.targets()) {
            rows.add(new PolicyRuleRow(rule.targetId().value(), rule.targetRevision().hex(), rule.profile().value(), rule.os(), rule.externalDisclosure(),
                rule.modelExecution(), rule.automaticUploads(), rule.automaticDownloads(), rule.automaticSudo(), rule.testServer(), rule.sourceExecutionContract(),
                rule.fallback()));
        }
        return rows;
    }

    /** One row per listed name, numbered from 0 within its list. */
    List<PolicyNameRow> nameRows(CommandPolicyDocument document) {
        List<PolicyNameRow> rows = new ArrayList<>();
        for (TargetRule rule : document.targets()) {
            addNames(rows, rule.targetId().value(), PolicyListKind.ALLOWED, rule.commands());
            addNames(rows, rule.targetId().value(), PolicyListKind.DENIED, rule.deniedCommands());
        }
        return rows;
    }

    /** One row per configured threshold. */
    List<PolicyThresholdRow> thresholdRows(CommandPolicyDocument document) {
        List<PolicyThresholdRow> rows = new ArrayList<>();
        for (TargetRule rule : document.targets()) {
            for (Map.Entry<EvaluatorProvider, Threshold> entry : rule.thresholds().byProvider().entrySet()) {
                rows.add(thresholdRow(rule.targetId().value(), entry.getKey(), entry.getValue()));
            }
        }
        return rows;
    }

    /** Rebuilds the document from the rows; the rules come in the order of the given rule rows. */
    CommandPolicyDocument document(List<PolicyRuleRow> rules, List<PolicyNameRow> names, List<PolicyThresholdRow> thresholds) {
        Map<String, List<PolicyNameRow>> namesByTarget = names.stream().collect(Collectors.groupingBy(PolicyNameRow::targetId));
        Map<String, List<PolicyThresholdRow>> thresholdsByTarget = thresholds.stream().collect(Collectors.groupingBy(PolicyThresholdRow::targetId));
        List<TargetRule> targets = new ArrayList<>();
        for (PolicyRuleRow rule : rules) {
            List<PolicyNameRow> own = namesByTarget.getOrDefault(rule.targetId(), List.of());
            targets.add(new TargetRule(new TargetId(rule.targetId()), TargetRevision.of(rule.targetRevision()), new ProfileAlias(rule.profile()), rule.os(),
                namesOf(rule.os(), own, PolicyListKind.ALLOWED), namesOf(rule.os(), own, PolicyListKind.DENIED), rule.externalDisclosure(),
                rule.modelExecution(), rule.automaticUploads(), rule.automaticDownloads(), rule.automaticSudo(), rule.testServer(), rule.sourceContract(),
                rule.fallback(), thresholdsOf(thresholdsByTarget.getOrDefault(rule.targetId(), List.of()))));
        }
        return new CommandPolicyDocument(targets);
    }

    private void addNames(List<PolicyNameRow> rows, String targetId, PolicyListKind kind, CommandNames names) {
        int position = 0;
        for (PolicyName name : names.names()) {
            rows.add(new PolicyNameRow(targetId, kind, position, name.text()));
            position++;
        }
    }

    private PolicyThresholdRow thresholdRow(String targetId, EvaluatorProvider provider, Threshold threshold) {
        ThresholdTerms terms = threshold.terms();
        ThresholdBasis basis = switch (threshold) {
            case ProbabilityThreshold probability -> ThresholdBasis.SAFETY_PROBABILITY_V1;
            case ConfidenceThreshold confidence -> ThresholdBasis.LEGACY;
        };
        Double minConfidence = switch (threshold) {
            case ProbabilityThreshold probability -> null;
            case ConfidenceThreshold confidence -> confidence.minConfidence();
        };
        return new PolicyThresholdRow(targetId, provider, terms.model(), terms.questionVersion(), basis, terms.minLowRisk(), minConfidence, terms.validationRef());
    }

    private CommandNames namesOf(TargetOs os, List<PolicyNameRow> rows, PolicyListKind kind) {
        List<PolicyName> names = rows.stream().filter(row -> row.listKind() == kind).sorted(Comparator.comparingInt(PolicyNameRow::position))
            .map(row -> policyName(os, row.commandName())).toList();
        return new CommandNames(names);
    }

    private PolicyName policyName(TargetOs os, String text) {
        return switch (os) {
            case LINUX -> new LinuxPolicyName(text);
            case WINDOWS -> new WindowsPolicyName(text);
        };
    }

    private Thresholds thresholdsOf(List<PolicyThresholdRow> rows) {
        Map<EvaluatorProvider, Threshold> byProvider = new HashMap<>();
        for (PolicyThresholdRow row : rows) {
            ThresholdTerms terms = new ThresholdTerms(row.model(), row.questionVersion(), row.minLowRisk(), row.validationRef());
            byProvider.put(row.provider(), threshold(row, terms));
        }
        return new Thresholds(byProvider);
    }

    private Threshold threshold(PolicyThresholdRow row, ThresholdTerms terms) {
        return switch (row.basis()) {
            case SAFETY_PROBABILITY_V1 -> new ProbabilityThreshold(terms);
            case LEGACY -> new ConfidenceThreshold(terms, row.minConfidence());
        };
    }
}
