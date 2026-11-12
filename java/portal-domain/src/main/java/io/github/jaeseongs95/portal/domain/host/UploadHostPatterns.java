package io.github.jaeseongs95.portal.domain.host;

import io.github.jaeseongs95.portal.domain.text.Utf8Text;
import java.util.ArrayList;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Locale;
import java.util.Objects;

/**
 * The hosts an upload may be fetched from, as the administrator configured them: patterns in the order written, without repeats. An empty list allows nothing.
 */
public record UploadHostPatterns(List<UploadHostPattern> values) {

    /** The upper bound of the setting's text in UTF-8 bytes (2.x upload-hosts.mjs UPLOAD_HOSTS_MAX_BYTES). */
    public static final int MAX_BYTES = 65536;

    public UploadHostPatterns {
        Objects.requireNonNull(values, "values");
        values = List.copyOf(new LinkedHashSet<>(values));
    }

    /**
     * Reads the setting: patterns separated by commas, each trimmed and lowercased. The text has no line break and no NUL; an empty or blank text is the empty list;
     * an empty entry between commas is refused.
     */
    public static UploadHostPatterns parse(String text) {
        Utf8Text setting = new Utf8Text(text);
        if (setting.byteLength() > MAX_BYTES || text.indexOf('\r') >= 0 || text.indexOf('\n') >= 0 || text.indexOf('\0') >= 0) {
            throw new IllegalArgumentException("Configure exact DNS hostnames or leading *.domain suffixes");
        }
        if (setting.isBlank()) {
            return new UploadHostPatterns(List.of());
        }
        List<UploadHostPattern> patterns = new ArrayList<>();
        for (String entry : text.split(",", -1)) {
            patterns.add(UploadHostPattern.parse(new Utf8Text(entry).trimmed().value().toLowerCase(Locale.ROOT)));
        }
        return new UploadHostPatterns(patterns);
    }

    /** True when some pattern covers the host name. */
    public boolean allows(String host) {
        Objects.requireNonNull(host, "host");
        return values.stream().anyMatch(pattern -> pattern.matches(host));
    }
}
