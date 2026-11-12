package io.github.jaeseongs95.portal.domain.safety;

/**
 * The token counts a provider reported with an assessment, or the fact that it reported none. The safety observation path always has counts; the command
 * approval path accepts a response without them (command-policy.mjs:86-96 keeps a count only when it is a non-negative safe integer).
 */
public sealed interface UsageNote permits UsageNote.Reported, UsageNote.NotReported {

    /** The largest count that survives a round trip through a JSON number (JavaScript {@code Number.MAX_SAFE_INTEGER}). */
    long MAX_COUNT = 9_007_199_254_740_991L;

    record Reported(long inputTokens, long outputTokens) implements UsageNote {
        public Reported {
            if (inputTokens < 0 || inputTokens > MAX_COUNT || outputTokens < 0 || outputTokens > MAX_COUNT) {
                throw new IllegalArgumentException("A token count is a non-negative safe integer");
            }
        }
    }

    record NotReported() implements UsageNote {
    }
}
