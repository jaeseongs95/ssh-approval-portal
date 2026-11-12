package io.github.jaeseongs95.portal.app.target;

import io.github.jaeseongs95.portal.domain.classify.CommandClass;
import io.github.jaeseongs95.portal.domain.classify.CommandClassification;
import io.github.jaeseongs95.portal.domain.command.CommandLineGrammar;
import io.github.jaeseongs95.portal.domain.command.TargetRule;
import io.github.jaeseongs95.portal.domain.path.PathSyntax;
import io.github.jaeseongs95.portal.domain.target.Target;
import io.github.jaeseongs95.portal.domain.target.TargetCapabilities;
import io.github.jaeseongs95.portal.domain.target.TargetOs;
import io.github.jaeseongs95.portal.domain.text.CommandText;

/**
 * What differs between the operating systems of a <em>target</em> (not of this server): the path grammar, the capabilities, how a command is classified and how
 * its names are read. One implementation per {@link TargetOs} ({@code LinuxTargetPlatform}, {@code WindowsTargetPlatform}) is a bean of portal-ssh (stage 3);
 * {@link TargetPlatformRegistry} collects them. A caller that needs a capability the target lacks reads {@link #capabilities(Target)} and refuses with
 * {@code RequestRefusedException(TARGET_CAPABILITY_UNSUPPORTED)}; an implementation never throws {@code UnsupportedOperationException} (rule A-LSP).
 *
 * <p>Stage 3 adds the methods that need SSH (permission change, elevation check, agent CLI plan); only names are listed in design 7.3.
 */
public interface TargetPlatform {

    /** The identification value the registry keys the implementations by. */
    TargetOs os();

    /** Which {@code RemotePath} variant a path on this target is written in; {@link PathSyntax#path(String)} makes it. */
    PathSyntax pathSyntax();

    /** 2.x {@code targetCapabilities} ({@code target-platform.mjs:8-14}). */
    TargetCapabilities capabilities(Target target);

    /** 2.x {@code classifyForTarget}: Linux delegates to the command classifier, Windows answers {@link CommandClass#READ_ONLY} for two cmdlets and {@link CommandClass#SAFE} otherwise. */
    CommandClassification classify(CommandText command);

    /** 2.x {@code commandNamesForTarget}. */
    CommandLineGrammar commandLineGrammar();

    /** 2.x {@code deniedForTarget}: Windows compares the lower-cased last path segment, Linux asks {@code TargetRule#denies}. */
    boolean deniesName(TargetRule rule, CommandText command);
}
