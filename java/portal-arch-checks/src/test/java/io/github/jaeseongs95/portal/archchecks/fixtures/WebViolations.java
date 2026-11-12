package io.github.jaeseongs95.portal.archchecks.fixtures;

import java.sql.Connection;
import java.sql.DriverManager;
import java.sql.SQLException;
import java.util.Map;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.web.bind.annotation.ExceptionHandler;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RestController;
import org.springframework.web.bind.annotation.RestControllerAdvice;
import org.springframework.web.servlet.mvc.method.annotation.ResponseEntityExceptionHandler;

// Fixtures of the revised principles 3.3, 3.8 and 4.1 (RuleFixturesTest): classes that break a rule on purpose, and the clean counterparts.

final class NewsStringCopy {
    String run() {
        return new String("x");
    }
}

final class InternsString {
    String run() {
        return "x".intern();
    }
}

final class NewsJdbcTemplate {
    Object run() {
        return new JdbcTemplate();
    }
}

final class UsesDriverManager {
    Connection run() throws SQLException {
        return DriverManager.getConnection("jdbc:h2:mem:x");
    }
}

/** An advice that does not extend ResponseEntityExceptionHandler. */
@RestControllerAdvice
final class PlainAdvice {
    @ExceptionHandler(IllegalStateException.class)
    String handle() {
        return "x";
    }
}

/** The allowed shape: one advice that extends ResponseEntityExceptionHandler. */
@RestControllerAdvice
final class GoodAdvice extends ResponseEntityExceptionHandler {
    @ExceptionHandler(IllegalStateException.class)
    String handle() {
        return "x";
    }
}

/** A controller with its own @ExceptionHandler. */
@RestController
final class LocalHandlerController {
    @ExceptionHandler(IllegalStateException.class)
    String handle() {
        return "x";
    }
}

/** A controller that takes the request body as raw bytes. */
@RestController
final class BytesBodyController {
    @PostMapping("/x")
    void take(@RequestBody byte[] body) {
    }
}

/** A controller that answers with a Map. */
@RestController
final class MapResponseController {
    @GetMapping("/x")
    Map<String, Object> read() {
        return Map.of("a", 1);
    }
}

record Answer(String name) {
}

/** The allowed shape: a record response and a record request. */
@RestController
final class GoodController {
    @PostMapping("/y")
    Answer take(@RequestBody Answer body) {
        return body;
    }
}
