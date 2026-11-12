package io.github.jaeseongs95.portal.store.policy;

import org.springframework.dao.DuplicateKeyException;
import org.springframework.data.jdbc.core.JdbcAggregateOperations;
import org.springframework.stereotype.Repository;
import org.springframework.transaction.annotation.Isolation;
import org.springframework.transaction.annotation.Transactional;

import io.github.jaeseongs95.portal.app.policy.CommandPolicyStore;
import io.github.jaeseongs95.portal.domain.command.CommandPolicyDocument;
import io.github.jaeseongs95.portal.domain.command.PolicySnapshot;
import io.github.jaeseongs95.portal.domain.error.RequestErrorCode;
import io.github.jaeseongs95.portal.domain.error.RequestRefusedException;

/**
 * {@link CommandPolicyStore} over the tables of the migration V4 (design 8.2, 2.x {@code command-state.mjs}). The policy is a single revision row plus child rows
 * for the rules, names and thresholds. {@link #replace} is a compare-and-set: one conditional UPDATE of the revision decides the winner (the row lock makes a second
 * writer wait for the first commit and then match no row), and the winner replaces the child rows in the same transaction, so the child rows always belong to
 * the revision that is stored. The rules come back ordered by target id.
 */
@Repository
public class JdbcCommandPolicyStore implements CommandPolicyStore {

    private static final int THE_ROW = 1;

    private final CommandPolicyRowRepository policies;
    private final PolicyRuleRowRepository rules;
    private final PolicyNameRowRepository names;
    private final PolicyThresholdRowRepository thresholds;
    private final JdbcAggregateOperations aggregates;
    private final PolicyMapper mapper;

    public JdbcCommandPolicyStore(CommandPolicyRowRepository policies, PolicyRuleRowRepository rules, PolicyNameRowRepository names,
                                  PolicyThresholdRowRepository thresholds, JdbcAggregateOperations aggregates, PolicyMapper mapper) {
        this.policies = policies;
        this.rules = rules;
        this.names = names;
        this.thresholds = thresholds;
        this.aggregates = aggregates;
        this.mapper = mapper;
    }

    /** The revision and the child rows are read in one snapshot so that a replace that commits in between cannot mix two revisions. */
    @Override
    @Transactional(readOnly = true, isolation = Isolation.REPEATABLE_READ)
    public PolicySnapshot current() {
        CommandPolicyRow row = policies.findById(THE_ROW)
            .orElseThrow(() -> new IllegalStateException("The command policy row (id 1) is missing; the migration V4 inserts it"));
        return new PolicySnapshot(row.revision(), mapper.document(rules.findAllOrdered(), names.findAllOrdered(), thresholds.findAllOrdered()));
    }

    @Override
    @Transactional
    public PolicySnapshot replace(CommandPolicyDocument next, long expectedRevision) {
        if (policies.advanceRevision(expectedRevision) != 1) {
            // The contract has no code of its own for a policy revision conflict yet (reported as a need); REQUEST_REFUSED is the closest.
            throw new RequestRefusedException(RequestErrorCode.REQUEST_REFUSED);
        }
        thresholds.deleteAllThresholds();
        names.deleteAllNames();
        rules.deleteAllRules();
        try {
            for (PolicyRuleRow row : mapper.ruleRows(next)) {
                aggregates.insert(row);
            }
            for (PolicyNameRow row : mapper.nameRows(next)) {
                aggregates.insert(row);
            }
            for (PolicyThresholdRow row : mapper.thresholdRows(next)) {
                aggregates.insert(row);
            }
        } catch (DuplicateKeyException e) {
            throw new RequestRefusedException(RequestErrorCode.REQUEST_REFUSED, e);
        }
        return new PolicySnapshot(expectedRevision + 1, next);
    }
}
