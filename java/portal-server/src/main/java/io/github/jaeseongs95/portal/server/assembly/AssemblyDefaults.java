package io.github.jaeseongs95.portal.server.assembly;

import java.util.List;

import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.context.annotation.Primary;
import org.springframework.core.task.SimpleAsyncTaskExecutor;
import org.springframework.core.task.TaskExecutor;
import org.springframework.scheduling.concurrent.ThreadPoolTaskScheduler;

import io.github.jaeseongs95.portal.app.agentcli.AgentReleaseCatalog;
import io.github.jaeseongs95.portal.app.agentcli.TarballResult;
import io.github.jaeseongs95.portal.app.capacity.ConfiguredTargets;
import io.github.jaeseongs95.portal.app.remote.ExecutionLimits;
import io.github.jaeseongs95.portal.app.remote.FilePathPolicy;
import io.github.jaeseongs95.portal.app.remote.PathPolicyDecision;
import io.github.jaeseongs95.portal.app.remote.SshSettings;
import io.github.jaeseongs95.portal.app.target.TargetSource;
import io.github.jaeseongs95.portal.domain.approval.ApprovalPolicy;
import io.github.jaeseongs95.portal.domain.capacity.Capacity;
import io.github.jaeseongs95.portal.domain.schedule.AdmissionLimits;
import io.github.jaeseongs95.portal.domain.schedule.ConcurrencyLimits;
import io.github.jaeseongs95.portal.domain.id.TargetId;
import io.github.jaeseongs95.portal.domain.target.TargetLookup;
import io.github.jaeseongs95.portal.ssh.profile.ProfileCatalog;
import io.github.jaeseongs95.portal.ssh.profile.TomlProfileLoader;
import io.github.jaeseongs95.portal.ssh.session.SessionReapSettings;

/**
 * The values that the parts of the assembly ask for and that stage 4 will bind from {@code bridge.*} ({@code BridgeProperties}, decision D3-12). Until then each one is the 2.x
 * default, and none holds a host, an account, a path or any other value of one installation: where a value needs a place on disk it comes from {@link ConnectionFiles}.
 * <b>Every bean below is replaced by the settings binding in stage 4.</b>
 *
 * <p>The values that are not a number are the safe ones: no target is configured (the first request names a target that is not registered, which is refused), no allowed-root
 * rule is established (a target that has one refuses its file transfers with {@code PATH_POLICY_UNSUPPORTED}, which is never an allowance), and the SSH profiles are the ones of the
 * file of the installation.
 */
@Configuration(proxyBeanMethods = false)
public class AssemblyDefaults {

    private final ConnectionFiles files;

    public AssemblyDefaults(ConnectionFiles files) {
        this.files = files;
    }

    /** Stage 4: replaced by the binding of {@code bridge.ssh.*}. 2.x connection timeout 20 s, keepalive 15 s x 3, trust on first use, the known hosts of {@link ConnectionFiles}. */
    @Bean
    public SshSettings sshSettings() {
        return SshSettings.defaults(files.knownHosts());
    }

    /** Stage 4: replaced by the binding of {@code bridge.ssh.*}. 2.x {@code connectionIdleReapMs}: a session that nobody used for 15 minutes is closed. */
    @Bean
    public SessionReapSettings sessionReapSettings() {
        return SessionReapSettings.defaults();
    }

    /** Stage 4: replaced by the binding of {@code bridge.capacity.*} and the runtime override. */
    @Bean
    public ConcurrencyLimits concurrencyLimits() {
        return ConcurrencyLimits.defaults();
    }

    /** Stage 4: replaced by the binding of {@code bridge.admission.*}. */
    @Bean
    public AdmissionLimits admissionLimits() {
        return AdmissionLimits.defaults();
    }

    /** Stage 4: replaced by the binding of {@code BRIDGE_REQUEST_CAPACITY}; 2.x default 100. */
    @Bean
    public ApprovalPolicy approvalPolicy() {
        return new ApprovalPolicy(new Capacity(100));
    }

    /** Stage 4: replaced by the binding of {@code bridge.execution.*}. 2.x: 120 s, 5 s of grace to stop, 1 MiB of output per stream. */
    @Bean
    public ExecutionLimits executionLimits() {
        return ExecutionLimits.defaults();
    }

    /** Stage 4: replaced by the binding of {@code bridge.ssh.config-path}. Read from the TOML file of the installation; a missing or open file stops the start. */
    @Bean
    public ProfileCatalog profileCatalog(TomlProfileLoader loader) {
        return loader.load(files.profileFile());
    }

    /** Stage 4: replaced by the configuration reader of {@code bridge.targets}. No target is registered until then. */
    @Bean
    public TargetSource targetSource() {
        return NotRegistered.INSTANCE;
    }

    /** Stage 4: replaced by the configuration reader of {@code bridge.targets}. No target is configured until then. */
    @Bean
    public ConfiguredTargets configuredTargets() {
        return List::of;
    }

    /**
     * Stage 4: replaced by the registry adapter (the public registry over an HTTP client, decision D3-01). Until then no catalog is configured: every release is unavailable,
     * so an installation of an agent CLI fails at the known point before the first byte is sent to the target ({@code AgentCliService}), and never installs bytes of unknown origin.
     */
    @Bean
    public AgentReleaseCatalog agentReleaseCatalog() {
        return release -> new TarballResult.Unavailable();
    }

    /** Stage 4: replaced by the test-server mode and the allowed roots of the Windows targets. Until then the rule cannot be established, which refuses and never allows. */
    @Bean
    public FilePathPolicy filePathPolicy() {
        return (target, path) -> new PathPolicyDecision.Unconfirmed();
    }

    /** Stage 4: replaced by the binding of {@code bridge.threads.*}. The timers: the deadline of an execution, the expiry of an operation, the sweep of the session pool. */
    @Bean
    public ThreadPoolTaskScheduler taskScheduler() {
        ThreadPoolTaskScheduler scheduler = new ThreadPoolTaskScheduler();
        scheduler.setPoolSize(8);
        scheduler.setThreadNamePrefix("portal-timer-");
        scheduler.setDaemon(true);
        return scheduler;
    }

    /**
     * Stage 4: replaced by the binding of {@code bridge.threads.*}. The work that blocks (the dispatcher, an execution, the output pump): a virtual thread for each, the number of
     * simultaneous executions is limited by the concurrency limits and not by a pool. {@code @Primary}: the scheduler is a task executor too.
     */
    @Bean
    @Primary
    public TaskExecutor taskExecutor() {
        SimpleAsyncTaskExecutor executor = new SimpleAsyncTaskExecutor("portal-work-");
        executor.setVirtualThreads(true);
        return executor;
    }

    /** No target is registered. */
    private enum NotRegistered implements TargetSource {
        INSTANCE;

        @Override
        public TargetLookup lookup(TargetId id) {
            return new TargetLookup.NotRegistered(id);
        }
    }
}
