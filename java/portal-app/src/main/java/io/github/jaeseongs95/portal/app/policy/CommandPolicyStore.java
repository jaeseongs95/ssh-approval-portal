package io.github.jaeseongs95.portal.app.policy;

import io.github.jaeseongs95.portal.domain.command.CommandPolicyDocument;
import io.github.jaeseongs95.portal.domain.command.PolicySnapshot;

/** The one command policy of the installation with its revision (2.x {@code command-state.mjs}: {@code policy(id=1, revision, body)}). */
public interface CommandPolicyStore {

    /** The stored policy; a fresh installation has the empty policy at revision 0. */
    PolicySnapshot current();

    /**
     * Replaces the policy when the stored revision is {@code expectedRevision}, in one transaction with the rule rows; the revision rises by one. Another revision
     * throws {@code RequestRefusedException(POLICY_REVISION_CONFLICT)} and changes nothing.
     */
    PolicySnapshot replace(CommandPolicyDocument next, long expectedRevision);
}
