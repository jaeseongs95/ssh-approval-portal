package io.github.jaeseongs95.portal.ssh.profile;

/** How much other accounts may do with a file or a folder that the product reads (what a {@link FileAccessRule} refuses). */
public enum Protection {
    /** Nobody besides the owner may even read: the profile configuration (2.x PF-04, mode 0600 and 0700). */
    NO_OTHER_ACCESS,
    /** Nobody besides the owner may change it: the file of known hosts, which others may read as an OpenSSH {@code known_hosts} usually is. */
    NO_OTHER_WRITE
}
