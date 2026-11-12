/**
 * Output redaction: secrets that a command printed are replaced by {@code [REDACTED:name:length]} before the text is stored or shown. The rules are the vendor
 * ssh-mcp 2.18.0 redactor ({@code guard/redactor.js}) ported to Java, documented in docs/migration/vendor-ssh-mcp-rules.md section 2. The consumers see
 * {@link io.github.jaeseongs95.portal.domain.redact.OutputRedactor} only; {@link io.github.jaeseongs95.portal.domain.redact.VendorOutputRedactor} is the
 * implementation and the 3.0 portal-app registers it as a bean.
 */
package io.github.jaeseongs95.portal.domain.redact;
