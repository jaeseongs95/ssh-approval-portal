package io.github.jaeseongs95.portal.store.output;

import java.util.List;

import org.springframework.data.jdbc.repository.query.Modifying;
import org.springframework.data.jdbc.repository.query.Query;
import org.springframework.data.repository.CrudRepository;
import org.springframework.data.repository.query.Param;

/** Spring Data JDBC repository of the renderings of an output; the key is composite, so rows are read by output and removed by statement. */
interface CommandOutputFormatRowRepository extends CrudRepository<CommandOutputFormatRow, String> {

    List<CommandOutputFormatRow> findByOutputId(String outputId);

    @Modifying
    @Query("DELETE FROM command_output_format WHERE output_id = :outputId")
    int removeByOutputId(@Param("outputId") String outputId);
}
