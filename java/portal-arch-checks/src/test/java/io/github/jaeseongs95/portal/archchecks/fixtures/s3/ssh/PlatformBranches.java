package io.github.jaeseongs95.portal.archchecks.fixtures.s3.ssh;

import io.github.jaeseongs95.portal.archchecks.fixtures.s3.app.target.TargetPlatform;
import io.github.jaeseongs95.portal.archchecks.fixtures.s3.domain.target.TargetOs;

// Break A-SSH-NO-PLATFORM-BRANCH on purpose (RuleFixturesTest.a_sshNoPlatformBranch): shared portal-ssh code that decides by the target OS itself.

/** An old-style switch on the OS: javac reads the ordinal through a $SwitchMap field. */
final class SwitchesOnOs {
    String shell(TargetOs os) {
        return switch (os) {
            case LINUX -> "sh";
            case WINDOWS -> "cmd";
        };
    }
}

/** An == against a constant of the OS enum. */
final class ComparesOs {
    boolean windows(TargetOs os) {
        return os == TargetOs.WINDOWS;
    }
}

/** Reads the ordinal and the constant list of the OS enum. */
final class EnumeratesOs {
    int position(TargetOs os) {
        return os.ordinal() + TargetOs.values().length;
    }
}

/** The allowed shape: a TargetPlatform implementation names its own OS. No rule may flag it. */
final class PosixPlatform implements TargetPlatform {
    @Override
    public TargetOs os() {
        return TargetOs.LINUX;
    }
}
