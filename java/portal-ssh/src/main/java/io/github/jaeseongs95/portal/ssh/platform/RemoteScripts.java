package io.github.jaeseongs95.portal.ssh.platform;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.nio.ByteBuffer;
import java.nio.charset.CodingErrorAction;
import java.nio.charset.StandardCharsets;
import java.util.Base64;
import java.util.EnumMap;
import java.util.HashSet;
import java.util.Map;
import java.util.Objects;
import java.util.Set;
import java.util.regex.Matcher;
import java.util.regex.Pattern;
import java.util.zip.Deflater;
import java.util.zip.GZIPOutputStream;

import org.springframework.core.io.ClassPathResource;
import org.springframework.stereotype.Component;

/**
 * Holds the fixed sentences the portal sends to a target (PowerShell and Python text under {@code ssh/remote/} on the classpath) and fills their marks.
 *
 * <p>Why these sentences exist as text and not as Java: a command a user submits runs on the target, and a target has no JVM, so its shell has to be told what to
 * do in its own language. The text is data that this server sends over an SSH channel; the server starts no process for it (docs/external-programs). Keeping the
 * sentences in files lets a test pin their bytes, so a change to what the target receives is always a visible change.
 *
 * <p>All files are read when the object is made, so a missing or damaged file stops the start of the application and not the first command. The text is immutable
 * after that and the object can be shared by every thread.
 */
@Component
public final class RemoteScripts {

    private static final String DIRECTORY = "ssh/remote/";
    private static final Pattern MARK = Pattern.compile("@@([A-Z][A-Z0-9_]*)@@");

    private final Map<RemoteScript, String> texts;

    public RemoteScripts() {
        EnumMap<RemoteScript, String> loaded = new EnumMap<>(RemoteScript.class);
        for (RemoteScript script : RemoteScript.values()) {
            loaded.put(script, read(script));
        }
        this.texts = Map.copyOf(loaded);
    }

    /** The file as it is stored: decoded as UTF-8, with CR LF turned into LF. The final line break of the file is part of it. */
    public String text(RemoteScript script) {
        return texts.get(Objects.requireNonNull(script, "script"));
    }

    /** The text without the one line break that ends the file, for a sentence that is built into a single line. */
    public String line(RemoteScript script) {
        return withoutFinalLineBreak(text(script));
    }

    /**
     * The text of a script with every {@code @@NAME@@} mark replaced by its value, in one pass: a value is never searched for marks, so a value that holds the text
     * {@code @@SHA256@@} (a user command can) does not reach another mark. The final line break of the file is not part of the result. A mark without a value, or a
     * value without a mark, is a mistake of the caller and throws.
     *
     * @param script the script whose marks are filled
     * @param values the value of every mark, by name
     * @return the filled text
     */
    public String fill(RemoteScript script, Map<String, String> values) {
        Objects.requireNonNull(values, "values");
        Matcher matcher = MARK.matcher(line(script));
        StringBuilder filled = new StringBuilder();
        Set<String> used = new HashSet<>();
        while (matcher.find()) {
            String name = matcher.group(1);
            String value = values.get(name);
            if (value == null) {
                throw new IllegalArgumentException("The script " + script + " has the mark " + name + " and no value was given");
            }
            used.add(name);
            matcher.appendReplacement(filled, Matcher.quoteReplacement(value));
        }
        matcher.appendTail(filled);
        Set<String> unused = new HashSet<>(values.keySet());
        unused.removeAll(used);
        if (!unused.isEmpty()) {
            throw new IllegalArgumentException("The script " + script + " has no mark for the values " + unused);
        }
        return filled.toString();
    }

    /**
     * The base64 text of the gzip form of the UTF-8 bytes of the text, compressed as far as the JDK goes. A receiver that is sent in this form fits the line the
     * target's shell accepts even with a working directory and a native preparation in it. The bytes may differ from another gzip implementation; unpacked they are the same.
     */
    public String gzipBase64(String text) {
        Objects.requireNonNull(text, "text");
        ByteArrayOutputStream packed = new ByteArrayOutputStream();
        try (GZIPOutputStream gzip = new BestGzipOutputStream(packed)) {
            gzip.write(text.getBytes(StandardCharsets.UTF_8));
        } catch (IOException e) {
            throw new IllegalStateException("Packing a text into memory failed", e);
        }
        return Base64.getEncoder().encodeToString(packed.toByteArray());
    }

    private static String withoutFinalLineBreak(String text) {
        return text.endsWith("\n") ? text.substring(0, text.length() - 1) : text;
    }

    private static String read(RemoteScript script) {
        ClassPathResource resource = new ClassPathResource(DIRECTORY + script.resourceName(), RemoteScripts.class.getClassLoader());
        try (InputStream in = resource.getInputStream()) {
            String decoded = StandardCharsets.UTF_8.newDecoder().onMalformedInput(CodingErrorAction.REPORT).onUnmappableCharacter(CodingErrorAction.REPORT)
                .decode(ByteBuffer.wrap(in.readAllBytes())).toString();
            return decoded.replace("\r\n", "\n");
        } catch (IOException e) {
            throw new IllegalStateException("The fixed script " + DIRECTORY + script.resourceName() + " cannot be read as UTF-8 from the classpath", e);
        }
    }

    /** A gzip stream at the best compression level: {@link GZIPOutputStream} has no constructor for it, but its deflater is open to a subclass. */
    private static final class BestGzipOutputStream extends GZIPOutputStream {

        BestGzipOutputStream(OutputStream out) throws IOException {
            super(out);
            def.setLevel(Deflater.BEST_COMPRESSION);
        }
    }
}
