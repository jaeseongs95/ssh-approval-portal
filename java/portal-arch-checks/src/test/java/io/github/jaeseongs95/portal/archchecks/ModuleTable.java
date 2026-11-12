package io.github.jaeseongs95.portal.archchecks;

import java.util.LinkedHashMap;
import java.util.Map;
import java.util.Set;

/**
 * The module dependency direction (Principles 3.2): which module may use which. Keys and values are the module names without the {@code portal-} prefix;
 * the Java package of a module is {@code basePackage + "." + name}. Nothing may use {@code server}; {@code client} needs only {@code domain};
 * {@code migrate} needs only {@code store} and {@code domain}.
 */
record ModuleTable(String basePackage, Map<String, Set<String>> mayUse) {

    static final String PRODUCT_BASE_PACKAGE = "io.github.jaeseongs95.portal";

    static ModuleTable product() {
        Map<String, Set<String>> table = new LinkedHashMap<>();
        table.put("domain", Set.of());
        table.put("app", Set.of("domain"));
        table.put("store", Set.of("app", "domain"));
        table.put("ssh", Set.of("app", "domain"));
        table.put("desktop", Set.of("app", "domain"));
        table.put("web", Set.of("app", "domain"));
        table.put("server", Set.of("domain", "app", "store", "ssh", "desktop", "web"));
        table.put("client", Set.of("domain"));
        table.put("migrate", Set.of("store", "domain"));
        return new ModuleTable(PRODUCT_BASE_PACKAGE, Map.copyOf(table));
    }

    String packageOf(String module) {
        return basePackage + "." + module;
    }
}
