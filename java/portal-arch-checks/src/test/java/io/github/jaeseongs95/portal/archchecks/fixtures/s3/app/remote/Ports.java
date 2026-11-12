package io.github.jaeseongs95.portal.archchecks.fixtures.s3.app.remote;

import java.util.Optional;

// The app.remote side of the stage 3 fixtures (RuleFixturesTest): ports that break A-REMOTE-RESULT on purpose, and the allowed shapes next to them.
// A type another package needs has its own file (ExecutionReport, RemoteExecutor, CancelToken); the rest are package-private like the other fixtures.

/** A sealed result: the allowed way to say "found", "missing" and nothing else. */
sealed interface GoodResult permits GoodResult.Found, GoodResult.Missing {
    record Found(String value) implements GoodResult {
    }

    record Missing() implements GoodResult {
    }
}

/** Not sealed: a result that anyone may extend, so "unknown" can hide in a new subtype. */
interface LooseResult {
}

/** Allowed: sealed result and record result. No rule may flag it (RuleFixturesTest). */
interface GoodPort {
    GoodResult lookup(String key);

    ExecutionReport run(String request);
}

/** Folds "none" and "unknown" into an empty Optional: A-REMOTE-RESULT. */
interface OptionalLookupPort {
    Optional<String> lookup(String key);
}

/** Folds "refused", "unsupported" and "unknown" into false: A-REMOTE-RESULT. */
interface BooleanPort {
    boolean reachable(String target);
}

/** Answers with an interface that is not sealed: A-REMOTE-RESULT. */
interface LooseResultPort {
    LooseResult lookup(String key);
}
