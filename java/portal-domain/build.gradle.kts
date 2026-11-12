// The business rules as plain Java (Principles 3.2): state enums and transitions, queue and scheduling judgements, command classification, redaction, the
// contract records, the sealed errors and their code enums. The JDK is what a rule needs; the one dependency is for annotations a record carries.
// ArchitectureRulesTest (rule A-DOMAIN) fails the build when a class of this module depends on Spring, Jackson databind or any other module.
dependencies {
    // com.fasterxml.jackson.annotation: the annotation package Jackson 3 still uses; the version is the Boot BOM's (jackson-2-bom).
    api("com.fasterxml.jackson.core:jackson-annotations")
}
