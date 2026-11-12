package io.github.jaeseongs95.portal.ssh.profile;

import java.nio.file.FileStore;
import java.nio.file.Path;

/** A {@link FileAccessRule} for tests that are not about access: it supports every file store and gives one verdict for every path. It creates nothing. */
final class FixedAccessRule implements FileAccessRule {

    private final AccessVerdict verdict;

    FixedAccessRule(AccessVerdict verdict) {
        this.verdict = verdict;
    }

    /** A rule that finds every path as private as asked. */
    static FixedAccessRule open() {
        return new FixedAccessRule(new AccessVerdict.Private());
    }

    @Override
    public boolean supports(FileStore store) {
        return true;
    }

    @Override
    public AccessVerdict inspect(Path path, Protection protection) {
        return verdict;
    }

    @Override
    public void createFolder(Path folder) {
    }

    @Override
    public void createFile(Path file) {
    }
}
