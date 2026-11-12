package io.github.jaeseongs95.portal.app.remote;

import java.util.Objects;

import io.github.jaeseongs95.portal.domain.path.PathSyntax;

/**
 * Whether a target has an allowed-root rule for file paths and in which path syntax it is compared. The target platform answers it ({@code TargetPlatform#pathPolicy}):
 * a Linux target has none, a Windows target compares the allowed root, which the {@link FilePathPolicy} names, with the path in Windows syntax (case-insensitive).
 */
public sealed interface PathPolicyBinding permits PathPolicyBinding.NoRootPolicy, PathPolicyBinding.RootPolicy {

    /** The target has no allowed-root rule; the policy's answer is {@link PathPolicyDecision.NotApplicable}. */
    record NoRootPolicy() implements PathPolicyBinding {
    }

    /** The target has an allowed-root rule; a root and a path are compared in this syntax. */
    record RootPolicy(PathSyntax syntax) implements PathPolicyBinding {

        public RootPolicy {
            Objects.requireNonNull(syntax, "syntax");
        }
    }
}
