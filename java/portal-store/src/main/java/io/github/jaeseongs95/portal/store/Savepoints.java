package io.github.jaeseongs95.portal.store;

import java.util.Objects;
import java.util.function.Supplier;

import org.springframework.stereotype.Component;
import org.springframework.transaction.PlatformTransactionManager;
import org.springframework.transaction.TransactionDefinition;
import org.springframework.transaction.support.TransactionTemplate;

/**
 * Runs statements that a constraint may refuse (a unique key, a foreign key, a CHECK) inside a nested transaction, so that a refusal undoes exactly those statements
 * and the surrounding transaction can go on (case S2-DB-17). PostgreSQL aborts a transaction at the first failed statement and rejects every later one with SQL state
 * 25P02 until it rolls back; H2 goes on. Spring also marks the transaction a {@code @Transactional} method joined as rollback-only when that method throws; the rollback
 * to a savepoint clears that mark too (Spring's {@code JdbcTransactionObjectSupport#rollbackToSavepoint} resets it).
 *
 * <p>Who needs it: the code that <em>continues</em> in the same transaction after a refusal. The stores that catch a violation and then read on (the claim, the journal's
 * accept, the runtime capacity's first write) use it themselves. A store method that only turns the violation into a {@code RequestRefusedException} and throws does not:
 * on a store call of its own transaction the refusal rolls everything back, and a caller that holds a larger transaction and goes on scopes the call with this class (the tests
 * of the stores do). {@code PROPAGATION_NESTED} is a JDBC savepoint when a transaction exists and a new transaction when none does (Spring Framework reference,
 * "Transaction Propagation", NESTED; {@code DataSourceTransactionManager} implements it with {@code Connection#setSavepoint}), so the behaviour is the same on every DBMS and
 * no vendor statement ({@code ON CONFLICT}, {@code MERGE}) is needed.
 *
 * <p>Whatever the body throws is rethrown after the rollback to the savepoint; the caller translates it.
 */
@Component
public final class Savepoints {

    private final TransactionTemplate nested;

    public Savepoints(PlatformTransactionManager transactions) {
        this.nested = new TransactionTemplate(Objects.requireNonNull(transactions, "transactions"));
        this.nested.setPropagationBehavior(TransactionDefinition.PROPAGATION_NESTED);
    }

    /** Runs the statements in a savepoint; a failure rolls back to it and is rethrown. */
    public void run(Runnable statements) {
        Objects.requireNonNull(statements, "statements");
        nested.executeWithoutResult(status -> statements.run());
    }

    /** Runs the statements in a savepoint and returns their result; a failure rolls back to the savepoint and is rethrown. */
    public <T> T call(Supplier<T> statements) {
        Objects.requireNonNull(statements, "statements");
        return Objects.requireNonNull(nested.execute(status -> statements.get()), "result");
    }
}
