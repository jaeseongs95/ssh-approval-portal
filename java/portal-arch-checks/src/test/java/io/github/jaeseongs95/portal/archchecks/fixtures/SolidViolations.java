package io.github.jaeseongs95.portal.archchecks.fixtures;

// Fixtures of principles 3.0 (RuleFixturesTest): a business helper over data-only types, a public mutable field, an unsupported operation.

record Order(int quantity) {
}

/** Judges a data-only type from outside with static methods: the shape check 32 forbids. */
final class StaticOnlyHelper {
    private StaticOnlyHelper() {
    }

    static boolean isLarge(Order order) {
        return order.quantity() > 10;
    }
}

final class GetsBean {
    Object run(org.springframework.context.ApplicationContext context) {
        return context.getBean("x");
    }
}

final class PublicMutableField {
    public int count;
}

abstract class Store {
    abstract void save(String value);
}

final class ReadOnlyStore extends Store {
    @Override
    void save(String value) {
        throw new UnsupportedOperationException("read only");
    }
}

/** State and its behaviour in one type, a public final field only: no rule flags it. */
final class Counter {
    public final int step = 1;
    private int value;

    int next() {
        value += step;
        return value;
    }
}
