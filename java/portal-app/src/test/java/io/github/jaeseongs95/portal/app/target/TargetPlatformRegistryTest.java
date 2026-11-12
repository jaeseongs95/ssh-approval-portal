package io.github.jaeseongs95.portal.app.target;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import java.util.List;

import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.springframework.boot.test.context.runner.ApplicationContextRunner;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;

import io.github.jaeseongs95.portal.domain.classify.CommandClassification;
import io.github.jaeseongs95.portal.domain.command.CommandLineGrammar;
import io.github.jaeseongs95.portal.domain.command.TargetRule;
import io.github.jaeseongs95.portal.domain.path.PathSyntax;
import io.github.jaeseongs95.portal.domain.target.Target;
import io.github.jaeseongs95.portal.domain.target.TargetCapabilities;
import io.github.jaeseongs95.portal.domain.target.TargetOs;
import io.github.jaeseongs95.portal.domain.text.CommandText;

class TargetPlatformRegistryTest {

    /** A platform that only knows which operating system it answers for; the registry calls nothing else. */
    private record OnlyOs(TargetOs os) implements TargetPlatform {

        @Override
        public PathSyntax pathSyntax() {
            return os == TargetOs.WINDOWS ? PathSyntax.WINDOWS : PathSyntax.POSIX;
        }

        @Override
        public TargetCapabilities capabilities(Target target) {
            throw new IllegalStateException("not used by the registry");
        }

        @Override
        public CommandClassification classify(CommandText command) {
            throw new IllegalStateException("not used by the registry");
        }

        @Override
        public CommandLineGrammar commandLineGrammar() {
            throw new IllegalStateException("not used by the registry");
        }

        @Override
        public boolean deniesName(TargetRule rule, CommandText command) {
            throw new IllegalStateException("not used by the registry");
        }
    }

    @Test
    @DisplayName("S2-AP-02: one platform per operating system is found by its operating system")
    void everyOsHasOnePlatform() {
        TargetPlatform linux = new OnlyOs(TargetOs.LINUX);
        TargetPlatform windows = new OnlyOs(TargetOs.WINDOWS);
        TargetPlatformRegistry registry = new TargetPlatformRegistry(List.of(linux, windows));
        assertThat(registry.platformOf(TargetOs.LINUX)).isSameAs(linux);
        assertThat(registry.platformOf(TargetOs.WINDOWS)).isSameAs(windows);
    }

    @Test
    @DisplayName("S2-AP-02: a missing platform stops the start with IllegalStateException")
    void aMissingPlatformIsRefused() {
        assertThatThrownBy(() -> new TargetPlatformRegistry(List.of(new OnlyOs(TargetOs.LINUX)))).isInstanceOf(IllegalStateException.class).hasMessageContaining("WINDOWS");
    }

    @Test
    @DisplayName("S2-AP-02: two platforms for one operating system stop the start with IllegalStateException")
    void aDoubledPlatformIsRefused() {
        assertThatThrownBy(() -> new TargetPlatformRegistry(List.of(new OnlyOs(TargetOs.LINUX), new OnlyOs(TargetOs.LINUX), new OnlyOs(TargetOs.WINDOWS))))
            .isInstanceOf(IllegalStateException.class).hasMessageContaining("LINUX");
    }

    @Test
    @DisplayName("S2-AP-02: in a Spring context the registry collects the platform beans, and a missing one fails the context start")
    void theContextCollectsTheBeans() {
        ApplicationContextRunner runner = new ApplicationContextRunner().withUserConfiguration(Registry.class);
        runner.withUserConfiguration(BothPlatforms.class).run(context -> {
            assertThat(context).hasNotFailed();
            assertThat(context.getBean(TargetPlatformRegistry.class).platformOf(TargetOs.WINDOWS).os()).isEqualTo(TargetOs.WINDOWS);
        });
        runner.withUserConfiguration(LinuxOnly.class).run(context -> {
            assertThat(context).hasFailed();
            assertThat(context.getStartupFailure()).hasRootCauseInstanceOf(IllegalStateException.class);
        });
    }

    @Configuration(proxyBeanMethods = false)
    static class Registry {

        @Bean
        TargetPlatformRegistry registry(List<TargetPlatform> platforms) {
            return new TargetPlatformRegistry(platforms);
        }
    }

    @Configuration(proxyBeanMethods = false)
    static class BothPlatforms {

        @Bean
        TargetPlatform linux() {
            return new OnlyOs(TargetOs.LINUX);
        }

        @Bean
        TargetPlatform windows() {
            return new OnlyOs(TargetOs.WINDOWS);
        }
    }

    @Configuration(proxyBeanMethods = false)
    static class LinuxOnly {

        @Bean
        TargetPlatform linux() {
            return new OnlyOs(TargetOs.LINUX);
        }
    }
}
