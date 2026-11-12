/**
 * Command classification: the four classes a command line gets ({@code read-only}, {@code safe}, {@code destructive}, {@code privileged}) and the rules that
 * decide them. The rules are the vendor ssh-mcp 2.18.0 classifier ({@code policy/classifier.js}, {@code reader-grammar.js}, {@code awk.js}) ported to Java,
 * documented in docs/migration/vendor-ssh-mcp-rules.md section 1. The consumers (policy, approval) see {@link io.github.jaeseongs95.portal.domain.classify.CommandClassifier}
 * only; {@link io.github.jaeseongs95.portal.domain.classify.VendorCommandClassifier} is the implementation and the 3.0 portal-app registers it as a bean.
 */
package io.github.jaeseongs95.portal.domain.classify;
