package io.github.jaeseongs95.portal.store.policy;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.assertj.core.api.Assertions.catchThrowable;

import java.util.List;
import java.util.Map;
import java.util.concurrent.Callable;
import java.util.concurrent.CyclicBarrier;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;
import java.util.concurrent.TimeUnit;

import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.springframework.context.annotation.Import;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.transaction.annotation.Propagation;
import org.springframework.transaction.annotation.Transactional;

import io.github.jaeseongs95.portal.domain.command.CommandNames;
import io.github.jaeseongs95.portal.domain.command.CommandPolicyDocument;
import io.github.jaeseongs95.portal.domain.command.ConfidenceThreshold;
import io.github.jaeseongs95.portal.domain.command.EvaluatorProvider;
import io.github.jaeseongs95.portal.domain.command.Fallback;
import io.github.jaeseongs95.portal.domain.command.LinuxPolicyName;
import io.github.jaeseongs95.portal.domain.command.PolicyName;
import io.github.jaeseongs95.portal.domain.command.PolicySnapshot;
import io.github.jaeseongs95.portal.domain.command.ProbabilityThreshold;
import io.github.jaeseongs95.portal.domain.command.QuestionVersion;
import io.github.jaeseongs95.portal.domain.command.SourceContract;
import io.github.jaeseongs95.portal.domain.command.TargetRule;
import io.github.jaeseongs95.portal.domain.command.ThresholdTerms;
import io.github.jaeseongs95.portal.domain.command.Thresholds;
import io.github.jaeseongs95.portal.domain.command.WindowsPolicyName;
import io.github.jaeseongs95.portal.domain.error.RequestRefusedException;
import io.github.jaeseongs95.portal.domain.id.TargetId;
import io.github.jaeseongs95.portal.domain.target.ProfileAlias;
import io.github.jaeseongs95.portal.domain.target.TargetOs;
import io.github.jaeseongs95.portal.domain.target.TargetRevision;
import io.github.jaeseongs95.portal.domain.target.Toggle;
import io.github.jaeseongs95.portal.store.StoreTest;

@StoreTest
@Import({JdbcCommandPolicyStore.class, PolicyMapper.class})
class JdbcCommandPolicyStoreTest {

    private static final long WAIT_SECONDS = 30;

    private final JdbcCommandPolicyStore store;
    private final JdbcTemplate jdbc;

    JdbcCommandPolicyStoreTest(JdbcCommandPolicyStore store, JdbcTemplate jdbc) {
        this.store = store;
        this.jdbc = jdbc;
    }

    @Test
    @DisplayName("S2-DB-08: a fresh installation has the empty policy at revision 0")
    void aFreshInstallationHasTheEmptyPolicy() {
        PolicySnapshot snapshot = store.current();

        assertThat(snapshot.revision()).isZero();
        assertThat(snapshot.document()).isEqualTo(CommandPolicyDocument.empty());
    }

    @Test
    @DisplayName("S2-DB-08: a replaced policy is read back equal (names with their order, both threshold bases, Windows names) at the next revision")
    void aReplacedPolicyIsReadBackEqual() {
        CommandPolicyDocument document = new CommandPolicyDocument(List.of(linuxRule("alpha", 'a', List.of("ls", "cat", "df"), List.of("rm"), bothBases()),
            windowsRule("beta", 'b', List.of("powershell.exe", "Get-ChildItem.exe"))));

        PolicySnapshot returned = store.replace(document, 0);
        PolicySnapshot read = store.current();

        assertThat(returned).isEqualTo(new PolicySnapshot(1, document));
        assertThat(read).isEqualTo(new PolicySnapshot(1, document));
    }

    @Test
    @DisplayName("S2-DB-08: a replace with a stale expected revision is refused and changes nothing")
    void aStaleReplaceIsRefused() {
        CommandPolicyDocument first = new CommandPolicyDocument(List.of(linuxRule("alpha", 'a', List.of("ls"), List.of(), Thresholds.none())));
        store.replace(first, 0);

        assertThatThrownBy(() -> store.replace(CommandPolicyDocument.empty(), 0)).isInstanceOf(RequestRefusedException.class);
        assertThatThrownBy(() -> store.replace(CommandPolicyDocument.empty(), 5)).isInstanceOf(RequestRefusedException.class);

        assertThat(store.current()).isEqualTo(new PolicySnapshot(1, first));
    }

    @Test
    @DisplayName("S2-DB-08: a second replace removes the child rows of the rules that are gone")
    void aSecondReplaceRemovesTheOldChildRows() {
        store.replace(new CommandPolicyDocument(List.of(linuxRule("alpha", 'a', List.of("ls", "cat"), List.of("rm"), bothBases()),
            linuxRule("gamma", 'c', List.of("df"), List.of(), bothBases()))), 0);
        CommandPolicyDocument second = new CommandPolicyDocument(List.of(linuxRule("gamma", 'c', List.of("uptime"), List.of(), Thresholds.none())));

        store.replace(second, 1);

        assertThat(store.current()).isEqualTo(new PolicySnapshot(2, second));
        assertThat(count("command_policy_rule")).isEqualTo(1);
        assertThat(count("command_policy_name")).isEqualTo(1);
        assertThat(count("command_policy_threshold")).isZero();
    }

    @Test
    @Transactional(propagation = Propagation.NOT_SUPPORTED)
    @DisplayName("S2-DB-08: two replaces with the same expected revision succeed once; the loser is refused and the child tables hold the winner only")
    void theSameExpectedRevisionWinsOnce() throws Exception {
        CommandPolicyDocument documentA = new CommandPolicyDocument(List.of(linuxRule("alpha", 'a', List.of("ls", "cat"), List.of("rm"), bothBases())));
        CommandPolicyDocument documentB = new CommandPolicyDocument(List.of(linuxRule("beta", 'b', List.of("df"), List.of(), Thresholds.none())));
        try (ExecutorService pool = Executors.newFixedThreadPool(2)) {
            CyclicBarrier barrier = new CyclicBarrier(2);
            Future<Throwable> resultA = pool.submit(attempt(barrier, documentA));
            Future<Throwable> resultB = pool.submit(attempt(barrier, documentB));
            Throwable failureA = resultA.get(WAIT_SECONDS, TimeUnit.SECONDS);
            Throwable failureB = resultB.get(WAIT_SECONDS, TimeUnit.SECONDS);

            assertThat(List.of(failureA == null, failureB == null)).containsExactlyInAnyOrder(true, false);
            Throwable loser = failureA == null ? failureB : failureA;
            assertThat(loser).isInstanceOf(RequestRefusedException.class);
            CommandPolicyDocument winner = failureA == null ? documentA : documentB;
            assertThat(store.current()).isEqualTo(new PolicySnapshot(1, winner));
            assertThat(count("command_policy_rule")).isEqualTo(1);
            assertThat(count("command_policy_name")).isEqualTo(winner.targets().get(0).commands().names().size() + winner.targets().get(0).deniedCommands().names().size());
        } finally {
            jdbc.update("DELETE FROM command_policy_threshold");
            jdbc.update("DELETE FROM command_policy_name");
            jdbc.update("DELETE FROM command_policy_rule");
            jdbc.update("UPDATE command_policy SET revision = 0 WHERE id = 1");
        }
    }

    private Callable<Throwable> attempt(CyclicBarrier barrier, CommandPolicyDocument document) {
        return () -> {
            barrier.await(WAIT_SECONDS, TimeUnit.SECONDS);
            return catchThrowable(() -> store.replace(document, 0));
        };
    }

    private Integer count(String table) {
        return jdbc.queryForObject("SELECT COUNT(*) FROM " + table, Integer.class);
    }

    private Thresholds bothBases() {
        ThresholdTerms probability = new ThresholdTerms("model-one", QuestionVersion.V5, 0.9, "validation/one");
        ThresholdTerms legacy = new ThresholdTerms("model-two", QuestionVersion.V3, 0.8, "validation/two");
        return new Thresholds(Map.of(EvaluatorProvider.JEV, new ProbabilityThreshold(probability), EvaluatorProvider.LUNA, new ConfidenceThreshold(legacy, 0.75)));
    }

    private TargetRule linuxRule(String id, char revision, List<String> allowed, List<String> denied, Thresholds thresholds) {
        return new TargetRule(new TargetId(id), TargetRevision.of(String.valueOf(revision).repeat(64)), new ProfileAlias(id + "-write"), TargetOs.LINUX,
            new CommandNames(linuxNames(allowed)), new CommandNames(linuxNames(denied)), Toggle.OFF, Toggle.ON, Toggle.OFF, Toggle.OFF, Toggle.ON, Toggle.OFF,
            SourceContract.PYTHON_SOURCE_V1, Fallback.LUNA, thresholds);
    }

    private TargetRule windowsRule(String id, char revision, List<String> allowed) {
        List<PolicyName> names = allowed.stream().<PolicyName>map(WindowsPolicyName::new).toList();
        return new TargetRule(new TargetId(id), TargetRevision.of(String.valueOf(revision).repeat(64)), new ProfileAlias(id + "-write"), TargetOs.WINDOWS,
            new CommandNames(names), CommandNames.none(), Toggle.ON, Toggle.OFF, Toggle.ON, Toggle.ON, Toggle.OFF, Toggle.ON, SourceContract.NONE, Fallback.NONE,
            Thresholds.none());
    }

    private List<PolicyName> linuxNames(List<String> texts) {
        return texts.stream().<PolicyName>map(LinuxPolicyName::new).toList();
    }
}
