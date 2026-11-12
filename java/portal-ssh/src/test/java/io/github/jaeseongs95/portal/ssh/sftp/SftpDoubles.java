package io.github.jaeseongs95.portal.ssh.sftp;

import java.io.FilterInputStream;
import java.io.IOException;
import java.io.InputStream;
import java.lang.reflect.InvocationTargetException;
import java.lang.reflect.Method;
import java.lang.reflect.Proxy;
import java.nio.charset.StandardCharsets;
import java.util.NavigableMap;
import java.util.TreeMap;
import java.util.concurrent.atomic.AtomicInteger;
import org.apache.sshd.sftp.client.SftpClient;
import org.apache.sshd.sftp.client.extensions.openssh.OpenSSHFsyncExtension;
import org.apache.sshd.sftp.common.extensions.openssh.FsyncExtensionParser;

/**
 * Faults the embedded server cannot make, put in front of a real MINA SFTP client with a plain JDK proxy (no mocking library): a server that changes a byte of the file
 * it was given, and a flush ({@code fsync@openssh.com}) that is offered and refused, or not offered at all. Every other call goes to the real client unchanged.
 */
final class SftpDoubles {

    /** Counts the flushes that were tried. */
    static final class FlushCounter {
        private final AtomicInteger tried = new AtomicInteger();

        void flushTried() {
            tried.incrementAndGet();
        }

        int tried() {
            return tried.get();
        }
    }

    /** What a proxied call does, once the proxy has told it which method was called. */
    @FunctionalInterface
    private interface Interception {
        Object handle(Method method, Object[] arguments) throws Throwable;
    }

    /** A client that gives back the file as it is, except for its first byte (what a server with a bad disk would do), when the path ends with the suffix. */
    SftpClient tamperingWhenReading(SftpClient real, String pathSuffix) {
        return proxy(real, (method, arguments) -> {
            if ("read".equals(method.getName()) && arguments != null && arguments.length == 1 && arguments[0] instanceof String path && path.endsWith(pathSuffix)) {
                return new FlippedFirstByte(real.read(path));
            }
            return passThrough(real, method, arguments);
        });
    }

    /** A client whose server offers {@code fsync@openssh.com} (or does not, as chosen) and whose flush always fails; the counter says how often it was tried. */
    SftpClient refusingToFlush(SftpClient real, boolean offered, FlushCounter counter) {
        return proxy(real, (method, arguments) -> {
            if ("getServerExtensions".equals(method.getName())) {
                NavigableMap<String, byte[]> extensions = new TreeMap<>(real.getServerExtensions());
                if (offered) {
                    extensions.put(FsyncExtensionParser.NAME, "1".getBytes(StandardCharsets.US_ASCII));
                } else {
                    extensions.remove(FsyncExtensionParser.NAME);
                }
                return extensions;
            }
            if ("getExtension".equals(method.getName()) && arguments != null && arguments.length == 1 && OpenSSHFsyncExtension.class.equals(arguments[0])) {
                return failingFlush(counter);
            }
            return passThrough(real, method, arguments);
        });
    }

    private OpenSSHFsyncExtension failingFlush(FlushCounter counter) {
        return (OpenSSHFsyncExtension) Proxy.newProxyInstance(OpenSSHFsyncExtension.class.getClassLoader(), new Class<?>[] {OpenSSHFsyncExtension.class},
            (proxy, method, arguments) -> switch (method.getName()) {
                case "fsync" -> {
                    counter.flushTried();
                    throw new IOException("injected: the flush is refused");
                }
                case "isSupported" -> Boolean.TRUE;
                case "getName" -> FsyncExtensionParser.NAME;
                case "equals" -> proxy == arguments[0];
                case "hashCode" -> System.identityHashCode(proxy);
                default -> "failing flush";
            });
    }

    private SftpClient proxy(SftpClient real, Interception interception) {
        return (SftpClient) Proxy.newProxyInstance(SftpClient.class.getClassLoader(), new Class<?>[] {SftpClient.class},
            (proxy, method, arguments) -> interception.handle(method, arguments));
    }

    private Object passThrough(SftpClient real, Method method, Object[] arguments) throws Throwable {
        try {
            return method.invoke(real, arguments);
        } catch (InvocationTargetException e) {
            throw e.getCause();
        }
    }

    /** The first byte that is read is changed; the rest is as it was. */
    private static final class FlippedFirstByte extends FilterInputStream {
        private boolean flipped;

        FlippedFirstByte(InputStream in) {
            super(in);
        }

        @Override
        public int read() throws IOException {
            int value = super.read();
            if (value >= 0 && !flipped) {
                flipped = true;
                return value ^ 1;
            }
            return value;
        }

        @Override
        public int read(byte[] bytes, int offset, int length) throws IOException {
            int count = super.read(bytes, offset, length);
            if (count > 0 && !flipped) {
                flipped = true;
                bytes[offset] ^= 1;
            }
            return count;
        }
    }
}
