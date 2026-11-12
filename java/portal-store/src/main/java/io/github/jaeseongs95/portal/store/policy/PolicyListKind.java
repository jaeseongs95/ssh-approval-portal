package io.github.jaeseongs95.portal.store.policy;

/** Which list of a rule a command name belongs to; the value is the column {@code command_policy_name.list_kind} (stored by name). */
public enum PolicyListKind {
    ALLOWED, DENIED
}
