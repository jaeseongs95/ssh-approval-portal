package io.github.jaeseongs95.portal.store.journal;

import java.lang.annotation.Documented;
import java.lang.annotation.ElementType;
import java.lang.annotation.Retention;
import java.lang.annotation.RetentionPolicy;
import java.lang.annotation.Target;

import org.springframework.context.annotation.Import;

import io.github.jaeseongs95.portal.store.StoreTest;

/** The storage slice with every adapter of the journal and the helper beans they need. */
@Documented
@Retention(RetentionPolicy.RUNTIME)
@Target(ElementType.TYPE)
@StoreTest
@Import({JournalTestBeans.class, OperationMapper.class, OperationStorage.class, JdbcOperationJournal.class, JdbcOperationQueueView.class, JdbcClaimStore.class,
    JdbcRestartRecovery.class, JdbcHistoryQuery.class})
@interface JournalTest {
}
