package io.github.jaeseongs95.portal.domain.contract;

import static org.assertj.core.api.Assertions.assertThat;

import io.github.jaeseongs95.portal.domain.operation.OperationState;
import io.github.jaeseongs95.portal.domain.text.CommandText;
import io.github.jaeseongs95.portal.domain.text.SourceText;
import java.util.Arrays;
import java.util.List;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import tools.jackson.databind.json.JsonMapper;

/** S2-CO-04 (the state wire values) and S2-CO-05 (the limits an agent reads from {@code targets}). */
class ContractConstantsTest {

    private final JsonMapper mapper = JsonMapper.builder().build();

    @Test
    @DisplayName("S2-CO-04 OperationState writes the 13 lowercase values of public-contract.mjs:15, in that order")
    void operationStateWireValues() {
        List<String> contract = List.of("accepted", "pending", "evaluating", "queued", "starting", "running", "terminating", "completed", "failed", "cancelled", "denied",
            "expired", "unknown");
        assertThat(Arrays.stream(OperationState.values()).map(OperationState::wire).toList()).containsExactlyElementsOf(contract);
        for (OperationState state : OperationState.values()) {
            assertThat(mapper.writeValueAsString(state)).isEqualTo("\"" + state.wire() + "\"");
        }
    }

    @Test
    @DisplayName("S2-CO-05 the limits of targets.limits are the 2.x constants: 32768, 16384, 262144, 16384 and 60000 milliseconds, artifacts up to 64 MiB")
    void limitsAreTheContractConstants() {
        LimitsData limits = new LimitsData(CommandText.MAX_BYTES, SourceText.MAX_BYTES, 67_108_864L, BeginData.MAX_CHUNK_BYTES, 16_384L, 60_000L);
        assertThat(limits.commandBytes()).isEqualTo(32_768L);
        assertThat(limits.sourceBytes()).isEqualTo(16_384L);
        assertThat(limits.artifactBytes()).isEqualTo(67_108_864L);
        assertThat(limits.chunkBytes()).isEqualTo(262_144L);
        assertThat(limits.outputPageBytes()).isEqualTo(16_384L);
        assertThat(limits.maxWaitMs()).isEqualTo(60_000L);
        assertThat(mapper.readTree(mapper.writeValueAsString(limits)).propertyNames())
            .containsExactlyInAnyOrder("commandBytes", "sourceBytes", "artifactBytes", "chunkBytes", "outputPageBytes", "maxWaitMs");
    }
}
