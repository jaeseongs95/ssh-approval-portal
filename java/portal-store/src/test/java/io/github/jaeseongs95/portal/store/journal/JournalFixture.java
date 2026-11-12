package io.github.jaeseongs95.portal.store.journal;

import java.time.Duration;
import java.time.Instant;

import io.github.jaeseongs95.portal.app.journal.JournalInsert;
import io.github.jaeseongs95.portal.app.journal.OperationJournal;
import io.github.jaeseongs95.portal.domain.id.Digest;
import io.github.jaeseongs95.portal.domain.id.Digester;
import io.github.jaeseongs95.portal.domain.id.OwnerId;
import io.github.jaeseongs95.portal.domain.id.RequestKey;
import io.github.jaeseongs95.portal.domain.id.Sha256Digester;
import io.github.jaeseongs95.portal.domain.id.TargetId;
import io.github.jaeseongs95.portal.domain.operation.AgentCliInput;
import io.github.jaeseongs95.portal.domain.operation.CommandInput;
import io.github.jaeseongs95.portal.domain.operation.ConflictKey;
import io.github.jaeseongs95.portal.domain.operation.Deadline;
import io.github.jaeseongs95.portal.domain.operation.NewOperation;
import io.github.jaeseongs95.portal.domain.operation.Operation;
import io.github.jaeseongs95.portal.domain.operation.StartAuthority;
import io.github.jaeseongs95.portal.domain.target.ProfileAlias;
import io.github.jaeseongs95.portal.domain.target.TargetRevision;
import io.github.jaeseongs95.portal.domain.text.CommandText;
import io.github.jaeseongs95.portal.domain.text.Utf8Text;

/** Builds operations for the journal tests: a command operation by key and target, and the steps that bring it to the queue. */
final class JournalFixture {

    static final String REVISION = "0".repeat(64);
    static final Instant NOW = JournalTestBeans.NOW;

    private final Digester digester = new Sha256Digester();

    /** A command operation; the key is padded to the 16 characters a request key needs. */
    NewOperation command(String key, String target, String text, ConflictKey conflictKey) {
        return command(key, target, text, "owner", REVISION, conflictKey, new Deadline.None());
    }

    NewOperation command(String key, String target, String text, String owner, String revision, ConflictKey conflictKey, Deadline expiry) {
        return NewOperation.of(digester, requestKey(key), new OwnerId(owner), new TargetId(target), TargetRevision.of(revision), new ProfileAlias("default"),
            new CommandInput(new CommandText(text), new Utf8Text("caller"), new Utf8Text("display")), conflictKey, expiry);
    }

    /** The operation of an agent CLI installation: it holds only the digest of the intent, the install request itself is the CLI store's. */
    NewOperation agentCli(String key, String target, ConflictKey conflictKey) {
        return NewOperation.of(digester, requestKey(key), new OwnerId("owner"), new TargetId(target), TargetRevision.of(REVISION), new ProfileAlias("default"),
            new AgentCliInput(new Digest("e".repeat(64))), conflictKey, new Deadline.None());
    }

    RequestKey requestKey(String key) {
        // A request key has 16 to 128 characters; the separator keeps "h1" and "h10" apart after the padding.
        return new RequestKey("req-" + key + "-0000000000000000");
    }

    /** Accepts the operation and moves it to the pending state (version 2). */
    Operation pending(OperationJournal journal, NewOperation spec) {
        JournalInsert inserted = journal.accept(spec);
        Operation accepted = inserted.operation();
        return journal.save(accepted.awaitOwnerDecision(NOW), accepted.version());
    }

    /** Accepts the operation and brings it to {@code QUEUED} (version 3), approved by the owner. */
    Operation queued(OperationJournal journal, NewOperation spec) {
        Operation pending = pending(journal, spec);
        return journal.save(pending.enqueue(new StartAuthority.Owner(), NOW.plus(Duration.ofSeconds(1))), pending.version());
    }
}
