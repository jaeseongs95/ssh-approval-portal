package io.github.jaeseongs95.portal.store.output;

import java.nio.file.Path;

import org.springframework.data.jdbc.core.JdbcAggregateOperations;
import org.springframework.stereotype.Component;
import org.springframework.transaction.PlatformTransactionManager;

/** Builds {@link OutputWorld}s from the beans of the test slice (constructor injection of the package-private repositories). */
@Component
class OutputWorldFactory {

    private final CommandOutputRowRepository rows;
    private final CommandOutputFormatRowRepository formats;
    private final CommandOutputPageRowRepository pages;
    private final JdbcAggregateOperations aggregates;
    private final OutputMapper mapper;
    private final PlatformTransactionManager transactionManager;

    OutputWorldFactory(CommandOutputRowRepository rows, CommandOutputFormatRowRepository formats, CommandOutputPageRowRepository pages, JdbcAggregateOperations aggregates,
                       OutputMapper mapper, PlatformTransactionManager transactionManager) {
        this.rows = rows;
        this.formats = formats;
        this.pages = pages;
        this.aggregates = aggregates;
        this.mapper = mapper;
        this.transactionManager = transactionManager;
    }

    OutputWorld create(Path folder, OutputLimits limits) {
        return new OutputWorld(folder, limits, rows, formats, pages, aggregates, mapper, transactionManager);
    }
}
