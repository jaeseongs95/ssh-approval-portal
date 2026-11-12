package io.github.jaeseongs95.portal.archchecks.fixtures;

import java.io.File;
import java.io.InputStream;
import java.io.InputStreamReader;
import java.io.OutputStream;
import java.io.OutputStreamWriter;
import java.lang.reflect.Field;
import java.time.Duration;
import java.time.Instant;
import java.time.LocalDate;
import java.time.ZoneId;
import java.time.ZoneOffset;
import java.time.ZonedDateTime;
import java.util.Calendar;
import java.util.Date;
import java.util.Optional;
import java.util.Timer;
import java.util.concurrent.Executors;
import java.util.concurrent.LinkedBlockingQueue;
import java.util.concurrent.ThreadPoolExecutor;
import java.util.concurrent.TimeUnit;
import org.springframework.beans.factory.annotation.Value;
import tools.jackson.databind.json.JsonMapper;

// Classes that break one design rule each, on purpose (RuleFixturesTest). They are never run; they only have to compile and be read by ArchUnit.
// A rule that does not flag its class here would pass the real product vacuously.

final class StreamsOut {
    void run() {
        System.out.println("x");
    }
}

final class StreamsErr {
    void run() {
        System.err.println("x");
    }
}

final class StackPrinter {
    void run() {
        new IllegalStateException("x").printStackTrace();
    }
}

final class ValueOnField {
    @Value("${x}")
    String x;
}

final class ValueOnMethod {
    @Value("${x}")
    void set(String x) {
    }
}

final class ValueOnParameter {
    ValueOnParameter(@Value("${x}") String x) {
    }
}

final class GetsEnv {
    String run() {
        return System.getenv("X");
    }
}

final class GetsProperty {
    String run() {
        return System.getProperty("os.name");
    }
}

final class GetsProperties {
    Object run() {
        return System.getProperties();
    }
}

final class GetsInteger {
    Integer run() {
        return Integer.getInteger("x");
    }
}

final class GetsBoolean {
    boolean run() {
        return Boolean.getBoolean("x");
    }
}

final class NewsJacksonThree {
    Object run() {
        return new JsonMapper();
    }
}

final class BuildsJacksonThree {
    Object run() {
        return JsonMapper.builder().build();
    }
}

final class NewsJacksonTwo {
    Object run() {
        return new com.fasterxml.jackson.databind.ObjectMapper();
    }
}

final class NowInstant {
    Instant run() {
        return Instant.now();
    }
}

final class NowLocalDate {
    LocalDate run() {
        return LocalDate.now();
    }
}

final class NowInZone {
    ZonedDateTime run() {
        return ZonedDateTime.now(ZoneOffset.UTC);
    }
}

final class SystemZone {
    ZoneId run() {
        return ZoneId.systemDefault();
    }
}

final class UsesDate {
    Date run() {
        return new Date();
    }
}

final class UsesCalendar {
    Calendar run() {
        return Calendar.getInstance();
    }
}

final class ReadsFileSeparator {
    String run() {
        return File.separator;
    }
}

final class NewsThread {
    Thread run() {
        return new Thread(() -> { });
    }
}

final class ExtendsThread extends Thread {
}

final class VirtualThreads {
    Thread.Builder run() {
        return Thread.ofVirtual();
    }
}

final class UsesExecutors {
    Object run() {
        return Executors.newFixedThreadPool(1);
    }
}

final class NewsPool {
    Object run() {
        return new ThreadPoolExecutor(1, 1, 0L, TimeUnit.SECONDS, new LinkedBlockingQueue<>());
    }
}

final class NewsTimer {
    Object run() {
        return new Timer();
    }
}

final class StartsProcess {
    Object run() {
        return new ProcessBuilder("x");
    }
}

final class ExecsRuntime {
    Object run() throws java.io.IOException {
        return Runtime.getRuntime().exec(new String[] {"x"});
    }
}

final class OptionalField {
    Optional<String> value;
}

final class OptionalParameter {
    String run(Optional<String> value) {
        return value.orElseThrow();
    }
}

// A record component is a private field and a canonical constructor parameter of type Optional.
record OptionalComponent(Optional<String> name) {
}

final class GetsOptional {
    String run() {
        Optional<String> found = Optional.of("x");
        return found.get();
    }
}

final class GetsBytesWithDefaultCharset {
    byte[] run(String text) {
        return text.getBytes();
    }
}

final class NewsStringFromBytes {
    String run(byte[] bytes) {
        return new String(bytes);
    }
}

final class NewsStringFromByteRange {
    String run(byte[] bytes) {
        return new String(bytes, 0, 1);
    }
}

final class NewsInputStreamReader {
    Object run(InputStream in) {
        return new InputStreamReader(in);
    }
}

final class NewsOutputStreamWriter {
    Object run(OutputStream out) {
        return new OutputStreamWriter(out);
    }
}

final class SleepsMillis {
    void run() throws InterruptedException {
        Thread.sleep(1L);
    }
}

final class SleepsDuration {
    void run() throws InterruptedException {
        Thread.sleep(Duration.ofMillis(1));
    }
}

@lombok.Getter
final class UsesLombok {
}

final class SetsAccessible {
    void run() throws ReflectiveOperationException {
        Field field = String.class.getDeclaredField("value");
        field.setAccessible(true);
    }
}
