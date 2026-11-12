package io.github.jaeseongs95.portal.store;

import org.springframework.beans.factory.config.BeanPostProcessor;
import org.springframework.data.relational.core.mapping.RelationalMappingContext;
import org.springframework.stereotype.Component;

/**
 * Turns off the quoting of table and column names that Spring Data JDBC does by default ({@code RelationalMappingContext#setForceQuote}, default {@code true}).
 * The migration scripts name tables and columns without quotes, and every DBMS folds an unquoted name by its own rule (H2 to upper case, PostgreSQL to lower case,
 * MariaDB and MySQL as the file system and the settings say). A generated statement that quotes {@code "operation"} in lower case would not find the table H2 stored
 * as {@code OPERATION}. With the quoting off the generated SQL is folded the same way as the scripts, on every DBMS
 * (https://docs.spring.io/spring-data/relational/reference/jdbc/mapping.html, "Naming Strategy" and the {@code forceQuote} setting of the mapping context;
 * the Javadoc of {@code RelationalMappingContext#setForceQuote}).
 *
 * <p>It is a post processor because Boot builds the mapping context in its own auto-configuration and offers no property for this setting; the setting must be made
 * before the first entity is registered, and a post processor runs before the context initializes itself.
 */
@Component
class IdentifierQuoting implements BeanPostProcessor {

    @Override
    public Object postProcessBeforeInitialization(Object bean, String beanName) {
        if (bean instanceof RelationalMappingContext context) {
            context.setForceQuote(false);
        }
        return bean;
    }
}
