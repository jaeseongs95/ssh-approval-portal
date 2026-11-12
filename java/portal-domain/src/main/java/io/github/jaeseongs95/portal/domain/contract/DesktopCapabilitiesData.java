package io.github.jaeseongs95.portal.domain.contract;

import com.fasterxml.jackson.annotation.JsonInclude;

/**
 * What a desktop session can do (public-contract.mjs:251, {@code capabilities}). Every ability is optional on the wire and never null, so a null component is
 * left out of the object, not written as null: this record is the one place in the contract where a null means "absent" and the whole record is
 * {@link JsonInclude.Include#NON_NULL}.
 */
@JsonInclude(JsonInclude.Include.NON_NULL)
public record DesktopCapabilitiesData(Boolean observe, Boolean pointer, Boolean key, Boolean text) {
}
