// The business rules as plain Java (Principles 3.2): state enums and transitions, queue and scheduling judgements, command classification, redaction, the
// contract records, the sealed errors and their code enums. The JDK is what a rule needs; the one dependency is for annotations a record carries.
// ArchitectureRulesTest (rule A-DOMAIN) fails the build when a class of this module depends on Spring, Jackson databind or any other module.
dependencies {
    // com.fasterxml.jackson.annotation: the annotation package Jackson 3 still uses; the version is the Boot BOM's (jackson-2-bom).
    api("com.fasterxml.jackson.core:jackson-annotations")

    // Jackson 3 databind, for the tests only: they read the contract baseline (JSON files) and serialise the contract records to compare their keys with it
    // (stage 2 design 5.4, decision D-21). The module's classes never use it, and A-DOMAIN reads only the main classes. The version is the Boot BOM's.
    testImplementation("tools.jackson.core:jackson-databind")
}

// The contract baseline (tool schemas, the envelope, the settings vectors) lives once, in portal-web's test resources (docs/migration/regression-cases.md 0.1:
// one source of truth). The domain tests read it from the classpath through this extra resource folder, so no copy exists that could drift (decision D-21).
extensions.configure<SourceSetContainer> {
    named("test") {
        resources.srcDir("../portal-web/src/test/resources")
    }
}
