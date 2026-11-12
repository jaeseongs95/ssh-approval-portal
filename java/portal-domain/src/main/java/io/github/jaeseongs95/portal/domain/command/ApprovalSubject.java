package io.github.jaeseongs95.portal.domain.command;

import io.github.jaeseongs95.portal.domain.operation.DecisionReason;
import io.github.jaeseongs95.portal.domain.text.CommandText;
import java.util.Objects;

/**
 * What a request wants to run, as far as the approval policy is concerned: a command line, or a program the caller submitted (run through a launcher command).
 * Each kind knows how it is screened by the rule before any model is asked, so the policy does not branch on the kind (command-automation.mjs:134-141).
 */
public sealed interface ApprovalSubject permits ApprovalSubject.ShellCommand, ApprovalSubject.SubmittedSource {

    /** The command line that will run; for submitted source, the launcher command. */
    CommandText command();

    /** What the target's grammar found in {@link #command()}. */
    CommandLineAnalysis analysis();

    /** True when the rule denies what this request would run. */
    boolean deniedBy(TargetRule rule);

    /** What the rule decides about this kind of request without asking a model, or {@link Screening.Undecided} when only an evaluation can. */
    Screening screen(RuleLookup rule);

    /** True when the evidence that would go to the evaluator exceeds the allowed size. Only submitted source carries evidence of that size. */
    boolean evidenceTooLarge();

    /** A command line. It runs when the owner approved every name it uses, otherwise the model or the owner decides. */
    record ShellCommand(CommandText command, CommandLineAnalysis analysis) implements ApprovalSubject {

        public ShellCommand {
            Objects.requireNonNull(command, "command");
            Objects.requireNonNull(analysis, "analysis");
        }

        @Override
        public boolean deniedBy(TargetRule rule) {
            return rule.denies(analysis, command);
        }

        @Override
        public Screening screen(RuleLookup lookup) {
            boolean sudoAllowed = lookup instanceof RuleLookup.Rule found && found.rule().automaticSudo().isOn();
            if (analysis.usesSudo() && !sudoAllowed) {
                return new Screening.Decided(DecisionReason.SUDO_NOT_ENABLED);
            }
            if (lookup instanceof RuleLookup.Rule found && found.rule().approves(analysis)) {
                return new Screening.Decided(DecisionReason.COMMAND_SET);
            }
            return new Screening.Undecided();
        }

        @Override
        public boolean evidenceTooLarge() {
            return false;
        }
    }

    /**
     * A program the caller submitted. A command-name approval never covers submitted code, so the rule must allow the source contract and sudo explicitly and
     * must deny nothing before it can reach a model (command-automation.mjs:19-21).
     *
     * @param denialScanText the launcher command, the source and the arguments as one text, scanned for denied names
     * @param evidence whether the evidence for the evaluator fits its limit
     */
    record SubmittedSource(CommandText command, CommandLineAnalysis analysis, String denialScanText, EvidenceSize evidence) implements ApprovalSubject {

        public SubmittedSource {
            Objects.requireNonNull(command, "command");
            Objects.requireNonNull(analysis, "analysis");
            Objects.requireNonNull(denialScanText, "denialScanText");
            Objects.requireNonNull(evidence, "evidence");
        }

        @Override
        public boolean deniedBy(TargetRule rule) {
            return rule.deniesWords(analysis, denialScanText);
        }

        @Override
        public Screening screen(RuleLookup lookup) {
            if (!(lookup instanceof RuleLookup.Rule found) || found.rule().sourceExecutionContract() != SourceContract.PYTHON_SOURCE_V1) {
                return new Screening.Decided(DecisionReason.SOURCE_EXECUTION_NOT_ENABLED);
            }
            TargetRule rule = found.rule();
            if (!rule.automaticSudo().isOn()) {
                return new Screening.Decided(DecisionReason.SOURCE_PRIVILEGE_POLICY_REVIEW);
            }
            if (!rule.deniedCommands().isEmpty()) {
                return new Screening.Decided(DecisionReason.SOURCE_COMMAND_POLICY_REVIEW);
            }
            return new Screening.Undecided();
        }

        @Override
        public boolean evidenceTooLarge() {
            return evidence == EvidenceSize.TOO_LARGE;
        }
    }

    /** Whether the source evidence for the evaluator fits its limit. */
    enum EvidenceSize {
        WITHIN_LIMIT,
        TOO_LARGE
    }

    /** What a rule decides about a request before a model is asked. */
    sealed interface Screening permits Screening.Decided, Screening.Undecided {

        record Decided(DecisionReason reason) implements Screening {
            public Decided {
                Objects.requireNonNull(reason, "reason");
            }
        }

        record Undecided() implements Screening {
        }
    }
}
