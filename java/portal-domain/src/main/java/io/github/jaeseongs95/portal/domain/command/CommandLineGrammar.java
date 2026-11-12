package io.github.jaeseongs95.portal.domain.command;

import io.github.jaeseongs95.portal.domain.target.TargetOs;
import io.github.jaeseongs95.portal.domain.text.CommandText;

/**
 * Reads the program names out of a command line, for the one language a target's shell speaks. It is neither a shell evaluator nor a risk classifier: it only
 * answers which names a policy has to approve and whether it could be sure of all of them. The approval policy defines this interface and depends on it; the
 * POSIX and PowerShell implementations belong to the SSH module (stage 3), so a new shell is a new implementation and no policy code changes.
 *
 * <p>The contract every implementation keeps (checked by {@code CommandLineGrammarContract}):
 * <ul>
 *   <li>{@link Completeness#COMPLETE} means every name of the line was established by the grammar and the list is not empty;</li>
 *   <li>{@link Completeness#INCOMPLETE} means "do not approve by name, send the line to the full evaluation"; a construct the grammar does not know is answered
 *       this way and never with an exception;</li>
 *   <li>the answer depends on the command text only.</li>
 * </ul>
 */
public interface CommandLineGrammar {

    /** The names of the command line and whether the grammar is sure of them (command-line.mjs:162, windows-command-line.mjs:231). */
    CommandLineAnalysis analyze(CommandText command);

    /** The policy name for text an owner proposes, or a refusal when the text is not a name this grammar can match. */
    NormalizedName normalize(String proposedName);

    /** The operating system whose shell this grammar reads. An injected list of grammars is looked up by this value. */
    TargetOs platform();
}
