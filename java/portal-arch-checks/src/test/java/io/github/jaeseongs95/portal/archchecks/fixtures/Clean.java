package io.github.jaeseongs95.portal.archchecks.fixtures;

import java.io.InputStream;
import java.io.InputStreamReader;
import java.io.OutputStream;
import java.io.OutputStreamWriter;
import java.io.Reader;
import java.io.Writer;
import java.nio.charset.StandardCharsets;
import java.time.Clock;
import java.time.Instant;
import java.util.Optional;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

/** A class that follows every rule: no rule may flag it (RuleFixturesTest). */
final class Clean {

    private static final Logger LOG = LoggerFactory.getLogger(Clean.class);

    Instant at(Clock clock) {
        return Instant.now(clock);
    }

    void report(Exception failure) {
        LOG.error("the work failed", failure);
    }

    /** Optional as a return type is the one place the rules allow it; orElseThrow() is the way to take the value out. */
    Optional<String> find(String key) {
        return key.isEmpty() ? Optional.empty() : Optional.of(key);
    }

    String require(String key) {
        return find(key).orElseThrow();
    }

    byte[] encode(String text) {
        return text.getBytes(StandardCharsets.UTF_8);
    }

    String decode(byte[] bytes) {
        return new String(bytes, StandardCharsets.UTF_8);
    }

    String decodeRange(byte[] bytes) {
        return new String(bytes, 0, bytes.length, StandardCharsets.UTF_8);
    }

    Reader reader(InputStream in) {
        return new InputStreamReader(in, StandardCharsets.UTF_8);
    }

    Writer writer(OutputStream out) {
        return new OutputStreamWriter(out, StandardCharsets.UTF_8);
    }

    /** Wait for the event, not for the clock. */
    boolean finished(CountDownLatch latch) throws InterruptedException {
        return latch.await(1, TimeUnit.SECONDS);
    }
}
