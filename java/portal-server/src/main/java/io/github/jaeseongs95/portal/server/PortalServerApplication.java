package io.github.jaeseongs95.portal.server;

import org.springframework.boot.SpringApplication;
import org.springframework.boot.autoconfigure.SpringBootApplication;

/**
 * Entry point of the executable jar. The two web contexts (MCP, admin) replace this single-context start in the web step; the foundation only
 * needs a main class so that {@code bootJar} has something to launch.
 */
@SpringBootApplication
public class PortalServerApplication {

    public static void main(String[] args) {
        SpringApplication.run(PortalServerApplication.class, args);
    }
}
