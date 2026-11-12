package io.github.jaeseongs95.portal.app.remote;

/** Why a target cannot do something it was asked to do: the answer that stands where an {@code UnsupportedOperationException} would (rule A-LSP). */
public enum UnsupportedReason {
    /** The SFTP server of a Windows target does not support {@code chmod} (Win32-OpenSSH wiki: "SFTP doesn't support chmod"). */
    WINDOWS_SFTP_CHMOD
}
