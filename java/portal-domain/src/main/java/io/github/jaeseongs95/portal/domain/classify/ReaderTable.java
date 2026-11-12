package io.github.jaeseongs95.portal.domain.classify;

import java.util.Collections;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.Set;
import java.util.regex.Pattern;

/**
 * The programs the classifier vouches for as read-only and what it vouches for about each (vendor {@code READERS}, policy/classifier.js:131-537, rules CL-R001 to
 * CL-R068): 68 names, 48 that accept any argument, 17 with a getopt grammar, 3 with an exact grammar; 14 of the names have two words
 * ({@code docker ps}, {@code git status}, {@code ip addr}, ...) and are looked up with the first two words of the command. Every entry is read-only and its
 * operands are data (the vendor {@code readOnly} and {@code operandsAreData} are {@code true} for every entry, so this table does not carry them).
 * The vendor comments say why a flag is missing from a list (for example {@code arp -d} deletes an entry); only the lists are kept here.
 */
final class ReaderTable {

    /**
     * Entries whose arguments are never inspected: the vendor measured that no option of these programs writes a file or runs a program.
     * Their glob words are allowed too (CL-G03).
     */
    private static final List<String> ANY_ARGUMENT_READERS = List.of("basename", "cat", "comm", "cut", "df", "dig", "dirname", "docker images", "docker inspect",
        "docker logs", "docker ps", "docker stats", "du", "echo", "false", "free", "git status", "grep", "head", "host", "htop", "id", "iostat", "ls", "nslookup",
        "ping", "printenv", "printf", "ps", "pwd", "readlink", "realpath", "seq", "stat", "tail", "test", "top", "tr", "traceroute", "true", "uname", "uptime",
        "vmstat", "wc", "whereis", "which", "who", "whoami");

    /** {@code /^(?!\/[^/]*\/?$)/}: refuses an operand that is one level below the root ({@code /a}, {@code /etc/}) because Windows options start with a slash. */
    private static final Pattern NOT_ONE_LEVEL_BELOW_ROOT = Pattern.compile("^(?!/[^/]*/?\\z)");

    private static final Pattern PLUS_FORMAT = Pattern.compile("^\\+");

    private static final Map<String, ReaderGrammar> READERS = Collections.unmodifiableMap(buildReaders());

    /** True for a program name or a two-word name the classifier vouches for. */
    boolean isReader(String name) {
        return READERS.containsKey(name);
    }

    Optional<ReaderGrammar> grammar(String name) {
        return Optional.ofNullable(READERS.get(name));
    }

    Set<String> names() {
        return READERS.keySet();
    }

    private static Map<String, ReaderGrammar> buildReaders() {
        Map<String, ReaderGrammar> readers = new LinkedHashMap<>();
        for (String name : ANY_ARGUMENT_READERS) {
            readers.put(name, ReaderGrammar.any());
        }
        readers.put("arp", ReaderGrammar.getopt(List.of("-a", "-e", "-n", "-v"))
            .withValueFlags(List.of("-H", "-t", "-i"))
            .withOperands(OperandRules.matching(NOT_ONE_LEVEL_BELOW_ROOT, 1)));
        readers.put("date", ReaderGrammar.getopt(List.of("-u", "--utc", "--universal", "-R", "--rfc-2822", "--rfc-email"))
            .withValueFlags(List.of("-r", "--reference", "--rfc-3339", "-v"))
            .withOptionalValueFlags(List.of("-I", "--iso-8601"))
            .withOperands(OperandRules.matching(PLUS_FORMAT, 1)));
        readers.put("diff", ReaderGrammar.getopt(List.of("-q", "--brief", "-s", "--report-identical-files", "-c", "-u", "-e", "--ed", "-n", "--rcs",
                "-y", "--side-by-side", "--left-column", "--suppress-common-lines", "-p", "--show-c-function",
                "-t", "--expand-tabs", "-T", "--initial-tab", "--suppress-blank-empty", "-r", "--recursive",
                "--no-dereference", "-N", "--new-file", "--unidirectional-new-file", "--ignore-file-name-case",
                "--no-ignore-file-name-case", "-i", "--ignore-case", "-E", "--ignore-tab-expansion", "-b",
                "--ignore-space-change", "-w", "--ignore-all-space", "-B", "--ignore-blank-lines", "-a", "--text",
                "--strip-trailing-cr", "-d", "--minimal"))
            .withValueFlags(List.of("-C", "-U", "-W", "--width", "--tabsize", "-F", "--show-function-line", "-I",
                "--ignore-matching-lines", "-D", "--ifdef", "--label", "-x", "--exclude", "-X", "--exclude-from",
                "-S", "--starting-file", "--from-file", "--to-file", "--line-format"))
            .withOptionalValueFlags(List.of("--context", "--unified", "--color"))
            .withOperands(OperandRules.atMost(2)));
        readers.put("file", ReaderGrammar.getopt(List.of("-b", "--brief", "-c", "--checking-printout", "-i", "--mime", "--mime-type", "--mime-encoding",
                "-k", "--keep-going", "-L", "--dereference", "-h", "--no-dereference", "-n", "--no-buffer",
                "-r", "--raw", "-s", "--special-files", "-0", "--print0"))
            .withValueFlags(List.of("-f", "--files-from", "-m", "--magic-file", "-M", "-e", "--exclude", "-F", "--separator")));
        readers.put("find", ReaderGrammar.exact(List.of("-H", "-L", "-P", "-print", "-print0", "-ls", "-not", "-a", "-and", "-o", "-or", "-true", "-false",
                "-empty", "-xdev", "-mount", "-depth", "-daystart", "-executable", "-readable", "-writable"))
            .withValueFlags(List.of("-name", "-iname", "-path", "-ipath", "-wholename", "-iwholename", "-regex", "-iregex",
                "-type", "-perm", "-user", "-group", "-uid", "-gid", "-size", "-mtime", "-mmin", "-atime", "-amin",
                "-ctime", "-cmin", "-newer", "-anewer", "-cnewer", "-links", "-inum", "-maxdepth", "-mindepth",
                "-printf")));
        readers.put("git branch", ReaderGrammar.getopt(List.of("-a", "--all", "-r", "--remotes", "-v", "--verbose", "-q", "--quiet", "--list", "--show-current"))
            .withValueFlags(List.of("--sort"))
            .withOptionalValueFlags(List.of("--color", "--contains", "--merged", "--no-merged"))
            .withOperands(OperandRules.atMost(0)));
        readers.put("git diff", ReaderGrammar.getopt(List.of("-p", "-u", "--patch", "--name-only", "--name-status", "--cached", "--staged", "--raw", "-w",
                "--ignore-all-space", "-b", "--ignore-space-change", "--summary", "--shortstat", "--exit-code",
                "--quiet", "-R", "--no-color", "--first-parent"))
            .withValueFlags(List.of("--diff-filter", "-S", "-G", "-O"))
            .withOptionalValueFlags(List.of("-M", "--find-renames", "-C", "--find-copies", "-U", "--unified", "--color",
                "--word-diff", "--stat")));
        readers.put("git log", ReaderGrammar.getopt(List.of("--oneline", "--graph", "--all", "-p", "-u", "--patch", "--name-only", "--name-status",
                "--abbrev-commit", "--relative-date", "--reverse", "--topo-order", "--date-order", "--parents",
                "--merges", "--no-merges"))
            .withValueFlags(List.of("-n", "--max-count", "--since", "--until", "--author", "--grep", "--date", "-S", "-G",
                "--skip"))
            .withOptionalValueFlags(List.of("--pretty", "--format", "--decorate", "--branches", "--tags", "--remotes",
                "--stat", "-L"))
            .withNumericShort());
        readers.put("git remote", ReaderGrammar.getopt(List.of("-v", "--verbose", "-n", "--push"))
            .withOperands(OperandRules.atMostWithFirst(2, List.of("get-url"))));
        readers.put("git show", ReaderGrammar.getopt(List.of("-s", "--no-patch", "--name-only", "--name-status", "--oneline", "--abbrev-commit", "--raw"))
            .withValueFlags(List.of("--date"))
            .withOptionalValueFlags(List.of("--pretty", "--format", "--decorate", "--stat"))
            .withNumericShort());
        readers.put("hostname", ReaderGrammar.getopt(List.of("-a", "--alias", "-A", "--all-fqdns", "-d", "--domain", "-f", "--fqdn", "--long", "-i",
                "--ip-address", "-I", "--all-ip-addresses", "-s", "--short"))
            .withOperands(OperandRules.atMost(0)));
        readers.put("ifconfig", ReaderGrammar.getopt(List.of("-a", "-s", "-l", "-m", "-d", "-u", "-v", "-L", "-r", "-C"))
            .withValueFlags(List.of("-f"))
            .withOptionsBeforeOperands()
            .withOperands(OperandRules.atMost(1)));
        readers.put("ip addr", ReaderGrammar.exact(List.of()).withOperands(OperandRules.firstIsOneOf(List.of("show", "list"))));
        readers.put("ip route", ReaderGrammar.exact(List.of()).withOperands(OperandRules.firstIsOneOf(List.of("show", "list", "get"))));
        readers.put("journalctl", ReaderGrammar.getopt(List.of("-f", "--follow", "-e", "--pager-end", "-r", "--reverse", "-k", "--dmesg", "-q", "--quiet",
                "-x", "--catalog", "-a", "--all", "-l", "--full", "-m", "--merge", "--no-pager", "--no-hostname",
                "--no-tail", "--disk-usage", "--header", "--list-boots", "--system", "--user"))
            .withValueFlags(List.of("-u", "--unit", "--since", "--until", "-S", "-U", "-o", "--output", "-p", "--priority",
                "-g", "--grep", "-t", "--identifier", "-D", "--directory"))
            .withOptionalValueFlags(List.of("-n", "--lines", "-b", "--boot", "--facility")));
        readers.put("netstat", ReaderGrammar.getopt(List.of("-a", "-n", "-t", "-u", "-l", "-p", "-r", "-i", "-s", "-e", "-W", "-x", "-w", "-4", "-6",
                "-v", "-b", "-d", "-m"))
            .withOptionalValueFlags(List.of("-f", "-I")));
        readers.put("sort", ReaderGrammar.getopt(List.of("-b", "-c", "-d", "-f", "-g", "-h", "-i", "-M", "-m", "-n", "-R", "-r", "-s", "-u", "-V", "-z",
                "--ignore-leading-blanks", "--dictionary-order", "--ignore-case", "--general-numeric-sort",
                "--human-numeric-sort", "--ignore-nonprinting", "--month-sort", "--merge", "--numeric-sort",
                "--random-sort", "--reverse", "--stable", "--unique", "--version-sort", "--debug",
                "--zero-terminated"))
            .withValueFlags(List.of("-k", "--key", "-t", "--field-separator", "-S", "--buffer-size", "--sort", "--parallel"))
            .withOptionalValueFlags(List.of("--check"))
            .withOperands(OperandRules.matching(NOT_ONE_LEVEL_BELOW_ROOT, OperandRules.UNLIMITED)));
        readers.put("ss", ReaderGrammar.getopt(List.of("-H", "--no-header", "-O", "--oneline", "-n", "--numeric", "-r", "--resolve", "-a", "--all",
                "-l", "--listening", "-o", "--options", "-e", "--extended", "-m", "--memory", "-p", "--processes",
                "-i", "--info", "-s", "--summary", "-t", "--tcp", "-u", "--udp", "-d", "--dccp", "-w", "--raw",
                "-x", "--unix", "-4", "-6", "-0", "--packet"))
            .withValueFlags(List.of("-f", "--family", "-A", "--query", "--socket", "-F", "--filter")));
        readers.put("systemctl status", ReaderGrammar.getopt(List.of("-l", "--full", "--no-pager", "-a", "--all", "-q", "--quiet", "--user", "--system", "-r",
                "--recursive", "--no-legend"))
            .withOptionalValueFlags(List.of("-n", "--lines", "-o", "--output")));
        readers.put("uniq", ReaderGrammar.getopt(List.of("-c", "--count", "-d", "--repeated", "-u", "--unique", "-i", "--ignore-case", "-z",
                "--zero-terminated", "-D"))
            .withValueFlags(List.of("-f", "--skip-fields", "-s", "--skip-chars", "-w", "--check-chars"))
            .withOptionalValueFlags(List.of("--all-repeated"))
            .withOptionsBeforeOperands()
            .withOperands(OperandRules.atMost(1)));
        return readers;
    }
}
