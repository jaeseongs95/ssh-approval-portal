# vendor ssh-mcp 2.18.0 행동 규칙 목록 (3.0 portal-domain·portal-ssh 이식 입력)

- 대상: `vendor/ssh-mcp-2.18.0.tgz`(패키지 `ssh-mcp` 2.18.0, `package.json:3`). 파일은 모두 `package/build/` 아래 컴파일된 JS이며, 이 문서의 「파일:줄」은 `package/build/`를 뺀 경로와 `cat -n` 기준 줄 번호다(예: `policy/classifier.js:20`). `README.md`만 `package/README.md`다.
- 2.x 소스 위치는 저장소 루트 기준(`src/...`, `app.mjs`)이다.
- 근거 판본: feature-map 메인 판정 C4(test-server-mode 키 이름)·C5(vendor 분류기·redactor 규칙 목록)·C6(`SSH_MCP_*`·프로필 TOML)의 선행 조사 결과다(`java/docs/migration/feature-map.md:87`, `:125`, `:133`).
- 표기 규칙
  - 이중 백틱(`` `` ``)으로 감싼 글은 근거 위치의 원문 그대로다(공백 연속은 한 칸으로 줄였고, 표 안의 `|`는 `\|`로 적었다). 단일 백틱은 이 문서의 설명이다.
  - 규칙 ID: `CL-`(분류기), `RG-`(분류기가 쓰는 reader 문법 엔진), `AW-`(awk 읽기), `RD-`(redactor), `PF-`(프로필 TOML), `EV-`(환경 변수), `CR-`(연결 레지스트리·호스트 키·keepalive), `TS-`(test-server-mode), `OV-`(2.x 덮어쓰기). 사례 ID는 `VR-nnn`.
- 이 조사에서 Node·Python을 실행하지 않았다. 「3.0 사례 초안」의 기대 결과는 모두 소스를 읽어 손으로 추적한 값이며 vendor를 실제로 돌려 확인한 값이 아니다(전 사례 「미검증: 실행 안 함」). 구현 담당은 JUnit 사례로 옮기기 전에 모호한 사례를 2.x 시험(`test/`)이나 vendor 단위 시험으로 한 번 대조하는 것이 안전하다.
- 2.x가 vendor에서 실제로 쓰는 export는 다섯 가지뿐이다(`src/adapters/ssh/vendor.mjs:3-7`): `loadConfig`, `ConnectionRegistry`, `classifyCommand`, `SftpClient`, `redactText`. 다른 export(`findForbiddenMatch`, `nestedCommands`, `redactRecord`, 정책 엔진 `policy/engine.js`, 세션 도구 등)는 2.x가 부르지 않는다. 부르지 않지만 `classifyCommand`가 내부에서 쓰는 함수(금지 목록·중첩 명령 추출)는 규칙으로 포함했다.

## 0. 요약 (절별 규칙 수, 사례 수)

| 절 | 규칙 ID 수 | 세부 항목 | 사례 초안 |
|---|---|---|---|
| 1 분류기 | 154 (`CL-` 65 + `CL-R` 68 + `RG-` 12 + `AW-` 9) | `READERS` 68개(`any` 48, `getopt` 17, `exact` 3, 두 단어 14), 금지 정규식 9 + 금지 규칙 13, 인터프리터 21, 권한 접두 11, 실행 래퍼 14, 접두 값 플래그 18, `SORT_LONG_OPTIONS` 30 | 274 (VR-001~273, 515) |
| 2 redactor | 13 (`RD-`) | 정규식 패턴 7, 엔트로피 1(임계 4.5, 최소 길이 20, 실효 23종 이상), 미사용 `redactRecord` 필드 10 | 45 (VR-274~318) |
| 3 프로필 TOML | 28 (`PF-`) | `[defaults]` 키 14, `[[profiles]]` 키 27, 병합 10 | 56 (VR-319~374) |
| 4 `SSH_MCP_*` | 13 (`EV-`) | 환경 변수 이름 9(프로필별 5 + 전역 4) + 보조 3, 비밀 파일 규칙 | 34 (VR-375~408) |
| 5 연결·호스트 키 | 34 (`CR-`) | 호스트 키 판정 분기 6, 고정 알고리즘 목록 4 | 56 (VR-409~464) |
| 6 test-server-mode | 4 (`TS-`) + 키 이름 3 | `BRIDGE_TEST_SERVER_SECRET_REF`, `testServerSecretRef`, `testServer` | 14 (VR-465~478) |
| 7 2.x 덮어쓰기 | 12 (`OV-`) | - | 41 (VR-479~514, 516~520) |
| 8 이식 위험 | 18 (`RK-`) | - | (VR-514 연결) |
| 합계 | 276 | | 520 |

## 1. 명령 분류기 (`policy/classifier.js`, 보조 `policy/reader-grammar.js`, `policy/awk.js`)

2.x 호출: `classify: classifyCommand`(`src/adapters/ssh/vendor.mjs:184`)를 인자 하나(`command`)로 부른다. 이후 2.x는 `.class`만 읽는다(`src/domain/validation.mjs:17`, `src/domain/command-policy.mjs:81`, `src/application/command-automation.mjs:45`). `binary`·`fullCommand`·`readOnlyRejection`을 읽는 2.x 코드는 없다(`grep -rn "readOnlyRejection\|\.binary\b\|fullCommand" src app.mjs` 결과 0건, 이 조사에서 확인).

### 1.1 분류 결과 값

- 값의 집합(4개, 낮은 순): `read-only` < `safe` < `destructive` < `privileged`.
  - `policy/classifier.js:682-687`: ``CLASS_RANK = { 'read-only': 0, safe: 1, destructive: 2, privileged: 3, }`` (원문은 여러 줄; 줄 685는 `safe: 1,`)
  - 설정 스키마도 같은 4값이다(`config/schema.js:4`): ``z.enum(['read-only', 'safe', 'destructive', 'privileged'])``.
- 반환 형태: `{ binary, fullCommand, class }` + 선택 `readOnlyRejection: { binary, word }`(`policy/classifier.js:2120-2123`, `:2181-2186`). `fullCommand`는 `command.trim()`이다(`:2087`).
- `read-only`가 아닌 알 수 없는 프로그램의 기본값은 `safe`다(`:2200`). `safe`는 「위험 없음」 증명이 아니다(2.x 주석 `src/domain/command-policy.mjs:82`).
- `forbidden`이라는 별도 결과 값은 없다. 금지 목록(1.4절)에 걸린 명령은 `classifyCommand`에서 `destructive`로 나온다(`:1590-1593`, `:2137-2139`). 금지/비금지 구분은 2.x가 쓰지 않는 `findForbiddenMatch`에만 있다.

### 1.2 판정 순서와 합성 (우선순위)

`classifyCommand`(`:2074-2085`) → `classifyCommandInDialect`(`:2086-2125`) → `classifyOuter`(`:2127-2201`).

- **CL-A01** 방언 두 개. 명령에 백슬래시가 없으면 `posix` 한 번(`:2080-2081`). 있으면 `posix`와 `windows` 둘 다 분류하고 더 높은 쪽을 택한다. 같으면 `posix` 결과(`:2083-2084`).
  - ``if (!command.includes('\\'))`` (`policy/classifier.js:2080`)
  - ``return CLASS_RANK[windows.class] > CLASS_RANK[posix.class] ? windows : posix;`` (`policy/classifier.js:2084`)
- **CL-A02** 바깥 명령 판정 순서(`classifyOuter`). 먼저 걸린 것이 이긴다.
  1. 권한 상승 → `privileged`: ``const elevated = elevatedBinaryOf(trimmed, dialect);`` (`policy/classifier.js:2133`), ``return { binary: elevated, fullCommand, class: 'privileged' };`` (`policy/classifier.js:2135`)
  2. 읽을 수 없는 프로그램·위험 awk·파괴적·금지 인자 → `destructive`: ``if (hasUnreadableProgram(trimmed, dialect) || hasDangerousAwk(trimmed, dialect)`` (`policy/classifier.js:2137`) ``|| isDestructive(trimmed, dialect) || hasDisqualifyingArgs(trimmed, dialect)) {`` (`policy/classifier.js:2138`)
  3. 명령어 이름을 알 수 없음 → `destructive`: ``if (hasUnnameableCommand(trimmed, dialect)) {`` (`policy/classifier.js:2149`)
  4. 허용 목록 분기(`:2154-2199`): ``if (READ_ONLY_ALLOWLIST.has(binary) || READ_ONLY_ALLOWLIST.has(twoWordPrefix)`` (`policy/classifier.js:2154`) ``|| READ_ONLY_SYNTHETIC.has(binary)) {`` (`policy/classifier.js:2155`). 셸 제어 문자가 있으면 `safe`(``if (SHELL_CONTROL_CHARS.test(trimmed)) {`` `policy/classifier.js:2156`); 합성 동사면 `read-only`; 인용 없는 glob 단어가 있고 문법이 `any`가 아니면 `safe`+rejection; 문법이 거절하면 `safe`+rejection; 통과하면 `read-only`.
  5. 그 밖은 `safe`: ``return { binary, fullCommand, class: 'safe' };`` (`policy/classifier.js:2200`)
- **CL-A03** 합성 바닥(floor): 첫 단어가 `SYNTHETIC_CLASSES`에 있고 그 등급이 현재보다 높으면 그 등급으로 올린다. 바닥은 올리기만 한다(``if (floor !== undefined && CLASS_RANK[floor] > CLASS_RANK[highest.class]) {`` `policy/classifier.js:2101`).
- **CL-A04** 중첩: `nestedCommands(trimmed, true, dialect)`가 낸 안쪽 명령마다 재귀 분류하고, 안쪽이 **엄격히 더 높을 때만** 교체한다(최댓값)(`:2104-2111`). 바깥을 낮추지 못한다. `binary`는 이긴 쪽을 따른다.
  - ``if (CLASS_RANK[parsed.class] > CLASS_RANK[highest.class])`` (`policy/classifier.js:2109`)
- **CL-A05** 중첩 깊이 한도: ``const MAX_NESTING_DEPTH = 8;`` (`policy/classifier.js:812`). `depth >= 8`이면 더 읽지 않고 `privileged`를 돌려준다(`:2089-2094`).
- **CL-A06** `readOnlyRejection`은 최종 등급을 정한 쪽이 바깥 명령 자신일 때만 붙는다(``if (highest === outer && outer.readOnlyRejection) {`` `policy/classifier.js:2121`).
- **CL-A07** 빈 명령: 공백만이면 분류는 `safe`(모든 검사 미해당, `:2200`). 2.x는 그 앞에서 빈 명령을 거절한다(OV-01).
- **CL-A08** `binary` 계산(`extractBinary`, `:1600-1615`): 첫 세그먼트의 단어를 공백으로 이어 붙이고(``let cmd = (tokenizeSegments(command, dialect)[0] ?? []).join(' ').trim();`` `policy/classifier.js:1606`) 앞쪽 ``/^\s*sudo\b/,`` (`policy/classifier.js:1595`), ``/^\s*su\b/,`` (`policy/classifier.js:1596`), ``/^\s*doas\b/,`` (`policy/classifier.js:1597`), ``/^\s*pkexec\b/,`` (`policy/classifier.js:1598`)를 이 순서로 한 번씩 지운 뒤, ``if (cmd.startsWith('-c ')) {`` (`policy/classifier.js:1610`)이면 3자를 자르고, 공백으로 나눈 첫 토큰을 돌려준다(``const parts = cmd.split(/\s+/);`` `policy/classifier.js:1613`). **경로 접두·대소문자는 정규화하지 않는다**: `/bin/ls`의 binary는 `/bin/ls`라서 허용 목록에 없다(→ `safe`). `LS`도 `safe`. 단 이 `binary`가 허용 목록 조회의 키다(`:2154`).

### 1.3 토크나이저 (`tokenizeSegmentsDetailed`, `:837-931`)

분류기의 모든 규칙이 이 토크나이저의 단어 목록 위에서 돈다. 구현은 바이트가 아니라 UTF-16 코드 단위(`command[i]`)를 한 글자씩 읽는다.

- **CL-T01** 세그먼트 구분자는 인용·이스케이프 밖의 `;` `&` `|` 줄바꿈 `\n`이다. `>` `<` 와 `\r`은 구분자가 아니다.
  - ``if (ch === ';' || ch === '&' || ch === '|' || ch === '\n') {`` (`policy/classifier.js:912`)
- **CL-T02** 단어 구분자는 인용 밖의 JS `\s` 한 글자다: ``if (/\s/.test(ch)) {`` (`policy/classifier.js:916`). JS `\s`는 ASCII 공백뿐 아니라 `U+00A0`, `U+FEFF`, `Zs` 범주, `U+2028`, `U+2029`를 포함한다(구현 위험 RK-03).
- **CL-T03** 각 세그먼트는 `{ words, sep }`이고 `sep`은 그 세그먼트를 연 구분자다. 첫 세그먼트는 `''`. `||`·`&&`처럼 구분자가 연속하면 빈 세그먼트는 버려지고 `sep`은 마지막 구분자다(예: `a || b`의 두 번째 세그먼트 `sep`은 `|`). 맨 앞 `|`는 첫 세그먼트의 `sep`에 남는다(`:865-871`, `:1189`).
  - ``segments.push({ words, sep: pending });`` (`policy/classifier.js:868`)
- **CL-T04** 따옴표: 작은따옴표 안은 모두 글자 그대로(백슬래시 포함). 큰따옴표 안에서 백슬래시는 다음 글자가 `$ ` " \ 개행` 중 하나일 때(또는 문자열 끝일 때)만 이스케이프이고 아니면 백슬래시를 남긴다(`:881-901`).
  - ``const DOUBLE_QUOTE_ESCAPABLE = new Set(['$', '`', '"', '\\', '\n']);`` (`policy/classifier.js:829`)
- **CL-T05** 인용 밖 백슬래시는 `posix` 방언에서만 다음 글자를 이스케이프(글자만 남기고 백슬래시 제거)한다. `windows` 방언에서는 백슬래시가 일반 글자다(`:903-906`, `:883`, `:874-880`).
  - ``if (dialect === 'posix' && ch === '\\') {`` (`policy/classifier.js:903`)
- **CL-T06** 인용된 빈 단어(`''`)는 살아남는다(`quotedWord`). 인용 없는 빈 문자열은 단어가 아니다(`:858-864`).
  - ``if (current || quotedWord)`` (`policy/classifier.js:860`)
- **CL-T07** 닫히지 않은 따옴표: 인용 부호를 일반 글자로 보는 `honorQuotes = false`로 전체를 다시 토큰화한다(`:928-929`).
  - ``if (quote !== null)`` (`policy/classifier.js:928`)
  - ``return tokenizeSegmentsDetailed(command, false, dialect);`` (`policy/classifier.js:929`)
- **CL-T08** 정규식 규칙용 정규화 문자열(`normalizeCommand`, `:938-960`): 단어마다 ``.map((words) => words.map((w) => (QUOTED_CONTENT.test(w) ? PLACEHOLDER : w)).join(' '))`` (`policy/classifier.js:958`)로 바꾸고 단어를 공백으로, 세그먼트를 `; `로 잇는다. 인용 안의 공백·구분자 포함 단어는 명령처럼 읽히지 않게 NUL 한 글자로 대체한다.
  - ``const QUOTED_CONTENT = /[\s;&|\n]/;`` (`policy/classifier.js:973`)
  - ``const PLACEHOLDER = '\u0000';`` (`policy/classifier.js:982`)
  - 문자열 정규식 규칙은 원문과 정규화본 둘 다에 시험한다: ``return test(command) || test(normalizeCommand(command, dialect));`` (`policy/classifier.js:999`)
  - 캐시(8개, `:938-955`)는 성능용이라 이식 대상이 아니다.
- **CL-T09** `unquote`(`:1307-1309`)는 단어 한 쌍의 겉 따옴표만 벗긴다: ``return word.replace(/^(['"])(.*)\1$/, '$2');`` (`policy/classifier.js:1308`)
- **CL-T10** `stripPath`(`:1321-1324`): 마지막 `/` 또는 `\` 뒤만 남긴다. ``const cut = Math.max(word.lastIndexOf('/'), word.lastIndexOf('\\'));`` (`policy/classifier.js:1322`)

### 1.4 금지 목록 (모두 `destructive`로 분류됨)

`isDestructive`(`:1590-1593`) = `isForbidden`(`FORBIDDEN_RULES` 13개 + 중첩 명령 재귀) 또는 `DESTRUCTIVE_PATTERNS`(1개). 정규식 9개는 원문과 정규화본에 모두 시험한다(`matchesEitherForm`, CL-T08). 정규식 9개는 모두 앵커가 없는 부분 일치(`find`)다.

- **CL-F01** ``/rm\s+-rf?\s+\/(\s|$)/`` (`policy/classifier.js:621`). `rm -rf /`, `rm -r /`. `-fr`, `-Rf`, `-r -f`는 걸리지 않는다. 끝의 `/` 다음이 공백이거나 문자열 끝일 때만.
- **CL-F02** ``/mkfs\./`` (`policy/classifier.js:622`)
- **CL-F03** ``/>\s*\/dev\/sd/`` (`policy/classifier.js:623`)
- **CL-F04** 포크 폭탄 ``/:\s*\(\s*\)\s*\{\s*:\s*\|\s*:\s*&\s*\}\s*;\s*:/`` (`policy/classifier.js:636`). 다른 이름·`&`/`;` 구분 변형·중간 주석은 잡지 못한다고 원문 주석이 밝힌다(`:628-635`).
- **CL-F05** ``/>\s*\/etc\/cron/`` (`policy/classifier.js:637`)
- **CL-F06** ``/>\s*\/etc\/systemd/`` (`policy/classifier.js:638`)
- **CL-F07** ``/>\s*~\/.ssh\/authorized_keys/`` (`policy/classifier.js:639`). `.ssh`의 `.`은 이스케이프되지 않아 임의 한 글자다.
- **CL-F08** ``/\biptables\s+-F\b/`` (`policy/classifier.js:640`)
- **CL-F09** ``/\bchmod\s+-R\s+777\s+\//`` (`policy/classifier.js:641`)
- **CL-F10** 전원 명령 호출(단어 기반, 정규식 아님): ``const FORBIDDEN_INVOCATIONS = new Set(['shutdown', 'reboot', 'halt', 'poweroff', 'eval']);`` (`policy/classifier.js:658`). 각 세그먼트의 명령어(권한 접두를 건너뛴 `head`, `stripPath` 적용)를 보며(`:1449-1461`), 머리가 ``const ACTION_MULTIPLEXERS = new Set(['systemctl', 'init', 'telinit']);`` (`policy/classifier.js:660`)이면 그 인자 중 `-`로 시작하지 않는 단어(`stripPath`)도 호출 단어로 본다. 규칙 정의: ``label: 'invoking a power-state command (shutdown, reboot, halt, poweroff) or eval',`` (`policy/classifier.js:1510`). 언급은 걸리지 않는다(`last reboot`, `grep -r reboot /etc/`).
- **CL-F11** 내려받아 셸로 파이프: ``const SHELLS = new Set(['sh', 'bash', 'zsh']);`` (`policy/classifier.js:1462`), ``const DOWNLOADERS = new Set(['curl', 'wget']);`` (`policy/classifier.js:1463`). 세그먼트 중 맨 앞이거나 구분자가 `|`인 세그먼트의 머리만 모아(``const heads = segments`` `policy/classifier.js:1478`), 첫 downloader 뒤에 shell이 하나라도 있으면 참(`:1481-1484`). `||`도 구분자가 `|`라 걸린다. `;`로 이은 `curl -O x; bash build.sh`는 걸리지 않는다.
- **CL-F12** 블록 장치에 dd: ``head === 'dd' && args.some((a) => a.startsWith('of=/dev/'))`` (`policy/classifier.js:1488`)
- **CL-F13** 루트 재귀 chown: 머리 `chown`이고 인자에 정확히 `-R`가 있고, `-`로 시작하지 않는 마지막 인자가 `/`일 때(``positional[positional.length - 1] === '/'``, `policy/classifier.js:1501`). `-R`은 `args.includes('-R')`이므로 `-Rv`·`-rf`는 해당하지 않는다(`:1498`).
- **CL-F14** (금지는 아니고 destructive 전용) ``/rm\s+-rf?\s+\//`` (`policy/classifier.js:1580`). `rm -rf /tmp/build`가 이 규칙으로 `destructive`가 된다.
- **CL-F15** 금지 검사의 중첩: `nestedCommands(command, false, dialect)`로 낸 안쪽 명령에 같은 규칙을 재귀 적용한다(깊이 8에서 중단하고 거절 아님, `null`)(`:1563-1570`). 추측성 피연산자(CL-N06)는 이 재귀에서 끈다.
  - ``if (depth >= MAX_NESTING_DEPTH)`` (`policy/classifier.js:1563`)
  - ``for (const inner of nestedCommands(command, false, dialect)) {`` (`policy/classifier.js:1565`)

### 1.5 권한 상승 (`privileged`)

- **CL-P01** 권한 접두 이름(정확히 이 11개): ``'sudo', 'su', 'doas', 'pkexec',`` (`policy/classifier.js:1200`) ``'su-exec', 'gosu', 'sudo-rs', 'run0', 'pfexec',`` (`policy/classifier.js:1203`) ``'runuser', 'setpriv',`` (`policy/classifier.js:1205`). `sudoedit`은 포함되지 않는다(`:661-675` 주석).
- **CL-P02** 실행 래퍼 이름(건너뜀): ``'env', 'nohup', 'nice', 'ionice', 'command', 'exec', 'setsid', 'stdbuf',`` (`policy/classifier.js:1222`) ``'timeout', 'chrt', 'taskset', 'xargs', 'watch',`` (`policy/classifier.js:1223`) ``'busybox',`` (`policy/classifier.js:1225`).
- **CL-P03** 접두 옵션 중 값을 하나 먹는 것: ``'-u', '-g', '-p', '-C', '-h', '-r', '-t', '-U', '-c',`` (`policy/classifier.js:1316`) ``'--user', '--group', '--prompt', '--close-from', '--host', '--role', '--type',`` (`policy/classifier.js:1317`) ``'--other-user', '--command',`` (`policy/classifier.js:1318`). 접두 뒤의 `-`로 시작하는 단어를 건너뛰되 위 목록이면 다음 단어까지 건너뛴다(`:1378-1383`).
- **CL-P04** 아직 명령이 아닌 단어(건너뜀): 할당 ``const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;`` (`policy/classifier.js:1290`), 래퍼, `-`로 시작하는 단어, ``const BARE_NUMERIC = /^\d+(\.\d+)?[smhd]?$/;`` (`policy/classifier.js:1292`).
- **CL-P05** 알고리즘(`elevatedBinary`, `:1368-1401`): 왼쪽부터 읽으며 접두를 만나면 `prefix`를 기록하고 접두 옵션을 건너뛴다. 건너뛸 단어가 아니면 「진짜 명령」: `prefix === null`이면 상승 아님(`null`), 아니면 그 단어(`stripPath(unquote(raw))`)를 돌려준다. 접두만 있고 뒤가 없으면 접두 이름을 돌려준다. 모든 세그먼트를 보고 처음 찾은 것을 쓴다(`:1412-1419`). 상승이면 등급은 `privileged`, `binary`는 상승 아래 실행되는 이름이다.
  - ``return prefix === null ? null : word;`` (`policy/classifier.js:1396`)
  - ``return prefix;`` (`policy/classifier.js:1400`)

### 1.6 인터프리터와 실행기

- **CL-I01** 인터프리터 표(21개). 각 항목은 `{ programBearingWords: [...], readable: ... }` 형태다. 이름은 정확히 대소문자를 구분하는 키다.

  | 이름 | programBearingWords | readable | 줄 |
  |---|---|---|---|
  | `sh` `bash` `dash` `zsh` `ksh` `ash` | `-c` | true | `:689-694` |
  | `python` `python2` `python3` | `-c` | false | `:695-697` |
  | `perl` | `-e`, `-E` | false | `:698` |
  | `ruby` | `-e` | false | `:699` |
  | `node` | `-e`, `--eval`, `-p`, `--print` | false | `:701` |
  | `php` | `-r` | false | `:702` |
  | `osascript` `lua` `Rscript` `bun` | `-e` | false | `:707-710` |
  | `tclsh` | (빈 목록) | false | `:717` |
  | `deno` | `eval` | false | `:719` |
  | `pwsh` `powershell` | `-c`, `-Command`, `-e`, `-EncodedCommand` | false | `:720-721` |

  원문 확인용(역시 이중 백틱): ``sh: { programBearingWords: ['-c'], readable: true },`` (`policy/classifier.js:689`), ``ash: { programBearingWords: ['-c'], readable: true },`` (`policy/classifier.js:694`), ``perl: { programBearingWords: ['-e', '-E'], readable: false },`` (`policy/classifier.js:698`), ``node: { programBearingWords: ['-e', '--eval', '-p', '--print'], readable: false },`` (`policy/classifier.js:701`), ``php: { programBearingWords: ['-r'], readable: false },`` (`policy/classifier.js:702`), ``Rscript: { programBearingWords: ['-e'], readable: false },`` (`policy/classifier.js:709`), ``tclsh: { programBearingWords: [], readable: false },`` (`policy/classifier.js:717`), ``deno: { programBearingWords: ['eval'], readable: false },`` (`policy/classifier.js:719`), ``pwsh: { programBearingWords: ['-c', '-Command', '-e', '-EncodedCommand'], readable: false },`` (`policy/classifier.js:720`), ``powershell: { programBearingWords: ['-c', '-Command', '-e', '-EncodedCommand'], readable: false },`` (`policy/classifier.js:721`).
- **CL-I02** 이름 조회(`resolveInterpreter`, `:758-763`): 정확히 일치를 먼저 보고, 없으면 끝의 ``/\.(exe|cmd|bat)$/i`` (`policy/classifier.js:734`)를 지우고 소문자로 접어 소문자 키 색인(`:732`)에서 찾는다. 그래서 `powershell.exe`, `PWSH.EXE`, `Node.EXE`, `rscript`가 모두 인터프리터다. 플래그 대소문자는 인터프리터별로 구분한다(CL-I05).
- **CL-I03** 읽을 수 없는 프로그램(`hasUnreadableProgram`, `:1972-1995`) → `destructive`:
  - 파이프 뒤 세그먼트(`sep === '|'`)가 ``if (sep === '|' && readsProgramFromStdin(words))`` (`policy/classifier.js:1976`)이면 참.
  - 명령 단어의 피연산자가 데이터인 허용 목록 명령(CL-N02)이 아닐 때, 모든 단어를 보며 `readable: false`인 인터프리터마다 `programAfterFlag`가 `null`이 아니면 참(`:1978-1991`). `readable: true`인 셸(`sh bash dash zsh ksh ash`)은 이 검사에서 제외되고 안쪽 프로그램이 중첩 분류로 읽힌다.
- **CL-I04** `programAfterFlag`(`:1754-1806`): 인터프리터 단어 `from` 뒤 단어를 훑는다.
  1. 단어가 프로그램 플래그와 정확히 같으면(대소문자 구분은 인터프리터별), 다음 단어가 프로그램이다. 플래그가 `-`로 시작하지 않는 하위 명령(`deno eval`)이면 그 사이의 빈 단어·`-` 옵션을 건너뛴다(`:1760-1771`).
  2. 플래그가 단어 앞부분이고 단어가 더 길면(`attached`): 나머지에 공백이 있거나 `=`로 시작하면 그 나머지가 프로그램(`-c'sudo id'`, `--eval=…`), 아니면 클러스터로 보고 다음 단어가 프로그램: ``const attached = flags.find((f) => word.startsWith(f) && word.length > f.length);`` (`policy/classifier.js:1783`), ``if (/\s/.test(rest) || rest.startsWith('=')) {`` (`policy/classifier.js:1789`). 이 분기는 대소문자를 구분한다.
  3. 클러스터(`clusterCarriesFlag`): ``if (!/^-[A-Za-z]{2,3}$/.test(word))`` (`policy/classifier.js:1846`)에 맞는 2~3글자 단어에서, 단어 안 글자 순서대로 짧은 플래그(2글자)를 찾는다. 찾으면 다음 단어가 프로그램(`:1842-1863`, `:1797-1801`).
  4. 그 밖에 단어가 빈 문자열이거나 `-`로 시작하면 건너뛰고, 아니면 `null`(``if (!skippableBetweenFlags(word) && !tolerateUnknownWords)`` `policy/classifier.js:1802`). 단, `pwsh`/`powershell`이고 `from`이 효과적 명령 단어(`effectiveCommandIndex`)면 모르는 단어도 건너뛴다(`tolerateUnknownWordsAtHead`, ``const tolerateUnknownWords = tolerateUnknownWordsAtHead && from === effectiveCommandIndex(words);`` `policy/classifier.js:1755`).
  - ``function skippableBetweenFlags(word) { return word === '' || word.startsWith('-'); }`` (`policy/classifier.js:1697-1699`, 줄 1697에 `function skippableBetweenFlags(word) {`)
- **CL-I05** 플래그 대소문자: `-EncodedCommand`를 프로그램 플래그로 가진 항목(pwsh·powershell)만 대소문자를 접는다(``const caseInsensitive = spec?.programBearingWords.includes('-EncodedCommand') ?? false;`` `policy/classifier.js:1118`). 나머지는 구분(perl `-E`≠`-e`). 이 항목에서만 `-ENC`·`-ec` 같은 클러스터가 `-e`로 풀린다(`:1857-1861`).
- **CL-I06** 플래그 값 제외(``function isFlagValue(words, i, flags, caseInsensitive = false) {`` `policy/classifier.js:1712`): 바로 앞 단어가 이 인터프리터의 프로그램 플래그면 지금 단어는 값이므로 인터프리터로 보지 않는다(`grep -e perl -e python`). `i === 0`이면 항상 아니다.
- **CL-I07** 인코딩 명령(`-EncodedCommand`·`-e`로 매칭된 pwsh 계열): base64를 UTF-16LE로 풀어 안쪽 명령으로 추가 분류한다. 입력이 64Ki자(``const MAX_ENCODED_CHARS = 64 * 1024;`` `policy/classifier.js:1808`)를 넘으면 4의 배수로 맞춘 앞부분만 푼다. 푼 결과에 U+FFFD가 있거나 공백뿐이면 `null`(`:1825-1831`, 호출 ``if (caseInsensitive && (result.flag === '-EncodedCommand' || result.flag === '-e')) {`` `policy/classifier.js:1135`). 플래그만으로 이미 `destructive`다(CL-I03).
- **CL-I08** 표준 입력에서 프로그램 읽기(`readsProgramFromStdin`, `:1874-1910`): 명령 단어가 인터프리터이고, 뒤 단어를 훑으며 (a) 프로그램 플래그로 시작하는 단어를 만나면 거짓, (b) `-s`를 만나면 기억하고 계속, (c) ``if (word === '--') {`` (`policy/classifier.js:1900`)를 만나면 `sawStdinFlag`이거나 뒤 단어가 없거나 표준 입력 경로면 참 아니면 거짓, (d) 표준 입력 경로이면 참, (e) `-`로 시작하지 않는 단어면 거짓, 다 읽으면 참. 표준 입력 경로 집합: ``const STDIN_PATHS = new Set(['-', '/dev/stdin', '/dev/fd/0', '/proc/self/fd/0']);`` (`policy/classifier.js:1865`).
- **CL-I09** 효과적 명령 단어(``function effectiveCommandIndex(words) {`` `policy/classifier.js:1633`): 접두·래퍼(와 그 옵션)를 건너뛰고, 할당·`-` 단어·BARE_NUMERIC을 건너뛴 첫 단어의 위치.

### 1.7 중첩 명령 추출 (`nestedCommands`, `:1030-1198`)

분류기는 안쪽 명령을 따로 분류해 최댓값을 취한다(CL-A04). 추출 대상:

- **CL-N01** `$(…)`, `<(…)`, `>(…)`: 괄호 깊이를 세는 스캔. `$((`는 산술이라 건너뜀(``if (opensSubstitution && command[i + 2] === '(')`` `policy/classifier.js:1042`). 닫는 괄호가 없으면 아무것도 추출하지 않는다(`:1035-1057`).
- **CL-N02** 백틱: ``const backticks = command.match(/`([^`]*)`/g);`` (`policy/classifier.js:1059`). 중첩은 보지 않는다.
- **CL-N03** awk 발견물(AW 절)의 `commands`와 `pipedInto`를 추가한다(`:1082-1089`).
- **CL-N04** 데이터 피연산자 예외(``function operandsAreData(words) {`` `policy/classifier.js:1666`): 명령 단어가 `READERS`에 있으면(이름은 `stripPath(unquote())`) 인터프리터·추측성 피연산자 스캔을 하지 않는다. 그 밖에는 CL-I04로 모든 단어에서 인터프리터를 찾아 `programAfterFlag`가 낸 프로그램을 추가한다(`:1090-1141`). 소비한 피연산자 위치는 기록한다.
- **CL-N05** 인터프리터가 읽은 프로그램의 인덱스는 추측 스캔에서 제외한다(``const consumedOperands = new Set();`` `policy/classifier.js:1110`).
- **CL-N06** 추측성 피연산자(`speculativeOperands`, 분류에서는 `true`, 금지 검사에서는 `false`): awk가 아닌 세그먼트에서 아무도 읽지 않은, `-`로 시작하지 않는, 공백이 들어 있는 피연산자 단어는 그 자체를 명령으로 추가한다(`:1162-1171`).
  - ``if (speculativeOperands && awk === null) {`` (`policy/classifier.js:1162`)
  - ``if (/\s/.test(words[i]))`` (`policy/classifier.js:1168`)
- **CL-N07** `find`류 실행 플래그: ``const FIND_EXEC_FLAGS = new Set(['-exec', '-execdir', '-ok', '-okdir']);`` (`policy/classifier.js:765`). 플래그 뒤 단어를 `+` 또는 `;` 전까지(없으면 끝까지) 이은 문자열을 명령으로 추가하고 인덱스를 그 뒤로 옮긴다(`:1174-1185`).
- **CL-N08** 파이프 뒤 세그먼트가 `readsProgramFromStdin`이면 바로 앞 세그먼트의 단어들을 이은 문자열을 명령으로 추가한다(`:1190-1196`). 시작은 `i = 1`(``for (let i = 1; i < segments.length; i++) {`` `policy/classifier.js:1190`).
- **CL-N09** 결과에서 공백뿐인 문자열은 버린다(``return found.filter((c) => c.trim().length > 0);`` `policy/classifier.js:1197`).

### 1.8 읽기 전용 허용 목록을 깨는 인자 (`DISQUALIFYING_ARGS`)

`hasDisqualifyingArgs`(`:1440-1448`)는 효과적 명령 단어(`effectiveCommandIndex`)의 `stripPath` 이름으로 표를 찾고, 뒤 인자 중 하나라도 정규식에 맞으면 `destructive`다. 표는 null-prototype 객체다(`:1237`).

- **CL-D01** `find`: ``find: /^-(exec|execdir|ok|okdir|delete|fprintf?|fls)$/,`` (`policy/classifier.js:1238`)
- **CL-D02** `sort`: 아래 세 갈래의 OR(`:1285-1287`).
  - ``sort: new RegExp(`^(?:${unambiguousLongOptionSource('compress-program')}` `` (`policy/classifier.js:1285`)
  - ``+ `|${unambiguousLongOptionSource('output')}` `` (`policy/classifier.js:1286`)
  - ``+ '|-[bcCdfghiMmnRrsuVz]*o)'),`` (`policy/classifier.js:1287`)
  - 생성 규칙(`:795-804`): 긴 옵션 전체 이름의 접두 중 `SORT_LONG_OPTIONS`(``const SORT_LONG_OPTIONS = [`` `policy/classifier.js:780`, 30개 이름, `:781-787`)에서 **정확히 하나**에만 해당하는 접두를 골라 ``--(?:접두1|접두2|…)(?:=|$)``로 만든다. 계산 결과:
    - `compress-program`: `c`는 `check`와 겹쳐 제외, `co` ~ `compress-program`(15개 접두)
    - `output`: `o` ~ `output`(6개 접두)
    - 따라서 최종 정규식은 ``^(?:--(?:co|com|comp|compr|compre|compres|compress|compress-|compress-p|compress-pr|compress-pro|compress-prog|compress-progr|compress-progra|compress-program)(?:=|$)|--(?:o|ou|out|outp|outpu|output)(?:=|$)|-[bcCdfghiMmnRrsuVz]*o)``다(이 줄은 생성 결과의 계산값이며 원문 한 줄이 아니다).
    - 이 정규식에 `$`가 두 번 쓰이므로 Java에서는 `\z`로 써야 한다(RK-02).
  - 세 번째 갈래는 `-`로 시작하고 값을 먹지 않는 짧은 플래그 몇 개 뒤에 `o`가 오는 모든 단어(`-o`, `-ofile`, `-mo`)다. `-t`·`-k`·`-S`·`-T`는 목록에 없어 `-tofile`은 해당하지 않는다(`:1270-1278`).

### 1.9 awk 읽기 (`policy/awk.js`, `classifier.js:1927-1971`)

awk류 명령 단어는 ``export const AWK_NAMES = new Set(['awk', 'gawk', 'mawk', 'nawk']);`` (`policy/awk.js:36`)이고 `effectiveCommandIndex` 위치의 단어(`stripPath(unquote())`)가 그 이름일 때만 해당한다(`classifier.js:1927-1943`). 이 결과는 `hasDangerousAwk`(→ `destructive`)와 중첩 명령(`commands`, `pipedInto`)에 반영된다.

- **AW-01** 인자 읽기(``export function readAwkInvocation(args) {`` `policy/awk.js:424`): `--`는 옵션 끝. 단독 `-`나 `-`로 시작하지 않는 단어는 프로그램 시작. ``const INFO_FLAGS = new Set(['--version', '--help']);`` (`policy/awk.js:55`)는 건너뜀. ``const VALUE_FLAGS = new Set(['-F', '-v', '-f']);`` (`policy/awk.js:43`)는 단어 앞 두 글자로 판정: `-f`는 즉시 `unreadable`(프로그램 파일), `-F`·`-v`는 단어 길이가 2면 다음 단어까지 건너뛰고 아니면(붙은 값) 그 단어만 건너뜀. 그 밖의 모든 플래그는 `unreadable`(`:424-453`).
- **AW-02** 프로그램이 없으면(`awk` 단독, `awk --version`) `null`(발견 없음, ``const program = args[i];`` `policy/awk.js:454`).
- **AW-03** 프로그램 길이 한도: ``const MAX_PROGRAM_CHARS = 256 * 1024;`` (`policy/awk.js:53`), ``if (program.length > MAX_PROGRAM_CHARS)`` (`policy/awk.js:463`)이면 `unreadable`.
- **AW-04** 렉서(``if (c === '"') {`` `policy/awk.js:216`, 렉서 전체 `policy/awk.js:190-297`): 개행은 `nl` 토큰, 공백·탭·CR은 무시, 백슬래시-개행은 이어쓰기, `#` 주석은 줄 끝까지 무시. 문자열은 큰따옴표로 끝까지 읽으며 이스케이프를 해석한다. 닫히지 않은 문자열·문자열 안 개행·정규식 안 개행·닫히지 않은 정규식은 `null`(→ `unreadable`). 정규식 시작 판정은 ``function regexCanStart(previous) {`` (`policy/awk.js:124`): 앞 토큰이 없거나, `num`/`str`/`regex`가 아니고, `word`면 ``const AWK_KEYWORDS = new Set([`` (`policy/awk.js:111`)의 예약어(``'print', 'printf', 'if', 'while', 'do', 'for', 'return', 'delete',`` `policy/awk.js:112`, ``'else', 'in', 'BEGIN', 'END', 'function', 'exit', 'next',`` `policy/awk.js:113`)일 때, `punct`면 ``![')', ']', '++', '--', '$'].includes(previous.v)`` (`policy/awk.js:132`)일 때. 정규식 안의 `[...]` 안 `/`는 리터럴.
- **AW-05** 이스케이프 해석(`readEscape`, `awk.js:165-182`): 8진 최대 3자리(``if (OCTAL.test(c)) {`` `policy/awk.js:167`), `\x`+16진 최대 2자리(``if (c === 'x' && HEX.test(source[at + 1] ?? '')) {`` `policy/awk.js:174`), 단순 이스케이프 표(``n: '\n'.slice(0), t: '\t', r: '\r',`` `policy/awk.js:139`, ``'\\': '\\', '"': '"', '/': '/',`` `policy/awk.js:140`, ``a: '\x07', b: '\b', f: '\f', v: '\v',`` `policy/awk.js:141`), 그 밖은 그 글자 자신.
- **AW-06** 연산자 토큰(긴 것 우선): ``'**=',`` (`policy/awk.js:70`) ``'|&', '&&', '||', '==', '!=', '<=', '>=', '>>', '++', '--',`` (`policy/awk.js:71`) ``'+=', '-=', '*=', '/=', '%=', '^=', '!~', '**',`` (`policy/awk.js:72`).
- **AW-07** 걷기(`walk`, `awk.js:306-415`):
  - `@`가 나오면 `unreadable`(``if (t.v === '@') {`` `policy/awk.js:335`).
  - `print`/`printf` 단어가 나오면 그 괄호 깊이를 `printDepth`로 기록한다. `{` `}` `;` 개행에서 해제, `)`로 깊이가 내려가면 해제.
  - `printDepth`와 같은 깊이에서 `>` 또는 `>>`: 다음 토큰이 문자열이고 ``const NON_FILE_TARGETS = new Set(['/dev/stdout', '/dev/stderr', '/dev/null', '/dev/fd/1', '/dev/fd/2']);`` (`policy/awk.js:62`)에 있으면 파일 쓰기가 아니다. 그 외(계산된 이름 포함)는 `writesFile = true`.
  - 같은 깊이에서 `|` 또는 `|&`: 다음 토큰이 문자열이고 그 다음이 문자열도 단어도 아니면 `pipedInto`에 그 문자열 추가, 아니면 `unreadable`(``if (target?.k === 'str' && after?.k !== 'str' && after?.k !== 'word') {`` `policy/awk.js:358`).
  - `print` 밖의 `"cmd" | getline`: 앞 토큰이 문자열이고 그 앞이 문자열도 단어도 아니면 `commands`에 추가, 아니면 `unreadable`(``if (before?.k === 'str' && earlier?.k !== 'str' && earlier?.k !== 'word') {`` `policy/awk.js:378`).
  - `system(` 다음에 문자열 하나와 `)`가 오면 `commands`에 추가, 아니면 `unreadable`(``if (arg?.k === 'str' && close?.k === 'punct' && close.v === ')')`` `policy/awk.js:406`).
- **AW-08** `hasDangerousAwk`(``function hasDangerousAwk(command, dialect = 'posix') {`` `policy/classifier.js:1952`; 이 단계가 읽는 `awkFindings`: ``function awkFindings(words) {`` `policy/classifier.js:1927`): `writesFile`이거나 `unreadable`이면 참. `pipedInto`의 문자열을 토큰화해 첫 세그먼트가 `readsProgramFromStdin`이면 참(`print … | "sh"` 형태).
- **AW-09** 중첩 분류에 쓰이는 `commands`·`pipedInto`는 각각 독립 명령으로 분류된다(CL-N03). `awk` 세그먼트의 추측성 피연산자 스캔은 끈다(``if (speculativeOperands && awk === null) {`` `policy/classifier.js:1162`).

### 1.10 명령 이름을 알 수 없음

- **CL-U01** ``function hasUnnameableCommand(command, dialect = 'posix') {`` (`policy/classifier.js:2013`). 각 세그먼트의 효과적 명령 단어(`effectiveCommandWord`)가 있고 ``/[$`]/`` (`policy/classifier.js:2016`)에 맞으면(단어에 `$` 또는 백틱) `destructive`. 인자의 `$`는 해당 없음(`echo $HOME`).

### 1.11 합성 동사 (도구 계층이 만드는 명령 텍스트)

- **CL-S01** 읽기 전용으로 낮추는 합성 동사: ``const READ_ONLY_SYNTHETIC = new Set(['sftp:list', 'sftp:download']);`` (`policy/classifier.js:587`). 허용 목록 분기에서 `binary`가 이 집합에 있고 셸 제어 문자가 없으면 인자를 보지 않고 `read-only`(`:2154-2164`).
- **CL-S02** 바닥(올리기만 함, `:2053-2058`):
  - ``'sftp:upload': 'destructive',`` (`policy/classifier.js:2054`)
  - ``'sftp:upload-file': 'destructive',`` (`policy/classifier.js:2055`)
  - ``'sftp:download-file': 'destructive',`` (`policy/classifier.js:2056`)
  - ``'session:open': 'destructive',`` (`policy/classifier.js:2057`)
  - 동사는 첫 세그먼트의 첫 단어다(``return tokenizeSegments(command, dialect)[0]?.[0] ?? '';`` `policy/classifier.js:2061`). `session:close`는 의도적으로 없다.
  - 2.x는 이 합성 동사 텍스트를 분류기에 보내지 않는다(`grep -rn "sftp:" src app.mjs` 결과 0건, 이 조사에서 확인). 이식 우선순위는 낮지만 규칙은 vendor에 있으므로 목록에 둔다.

### 1.12 허용 목록(`READERS`) 판정과 문법 엔진

#### 1.12.1 허용 목록 분기의 공통 규칙

- **CL-G01** 셸 제어 문자: ``const SHELL_CONTROL_CHARS = /[;&|<>`$(){}\n\r]/;`` (`policy/classifier.js:20`). 허용 목록 명령이어도 원문(`trimmed`)에 하나라도 있으면 `safe`(``if (SHELL_CONTROL_CHARS.test(trimmed)) {`` `policy/classifier.js:2156`). 인용 안이어도 원문 검사라 걸린다(`echo "a;b"` → `safe`). 글자 `\`는 목록에 없다.
- **CL-G02** 두 단어 항목: 첫 세그먼트 단어의 앞 두 개를 ``const twoWordPrefix = words.slice(0, 2).join(' ');`` (`policy/classifier.js:2153`)로 만들어 `READ_ONLY_ALLOWLIST`에 있으면 그 항목을 쓰고, 문법은 세 번째 단어부터 읽는다(``const argWords = words.slice(matchedTwoWord ? 2 : 1);`` `policy/classifier.js:2171`).
- **CL-G03** 인용 없는 glob 단어: ``if (ch === '*' || ch === '?' || ch === '[')`` (`policy/classifier.js:84`)인 글자가 이스케이프(`posix`)·인용 밖에 있는 첫 단어를 돌려준다(`:44-95`). 문법이 `any`가 아닌 항목에 이런 단어가 있으면 `safe`+`readOnlyRejection{binary: 항목 이름, word: 그 단어}`(``if (entry.grammar.args !== 'any') {`` `policy/classifier.js:2178`). 닫히지 않은 인용이면 인용 부호를 일반 글자로 보고 다시 검사한다(``if (honorQuotes && quote !== null)`` `policy/classifier.js:92`). 방언이 `windows`면 백슬래시를 이스케이프로 보지 않는다(`:59`, `:69`).
- **CL-G04** 문법 불일치면 `safe` + `readOnlyRejection{ binary: readerName, word: match.word }`(``if (!match.ok) {`` `policy/classifier.js:2190`). 일치하면 `read-only`(`:2198`).

#### 1.12.2 reader 문법 엔진 (`policy/reader-grammar.js`)

`matchesGrammar(words, grammar)`는 `{ ok: true }` 또는 `{ ok: false, word }`를 돌려준다. `grammar` 필드: `args`(`'any' | 'getopt' | 'exact'`), `flags`, `valueFlags`, `optionalValueFlags`, `numericShort`, `optionsBeforeOperands`, `operands{ max, first, each }`.

- **RG-01** ``if (grammar.args === 'any') {`` (`policy/reader-grammar.js:36`) → 모든 단어 수락.
- **RG-02** 옵션처럼 보이는 단어: ``const looksLikeOption = !optionsEnded && word.length > 1 && word.startsWith('-');`` (`policy/reader-grammar.js:48`). 단독 `-`는 피연산자.
- **RG-03** `optionsBeforeOperands`가 켜진 항목: 피연산자가 하나라도 나온 뒤 옵션처럼 보이는 단어(`--` 포함)는 거절(``if (grammar.optionsBeforeOperands && operands.length > 0 && looksLikeOption) {`` `policy/reader-grammar.js:59`).
- **RG-04** `getopt`에서만 `--`가 옵션 끝: ``if (grammar.args === 'getopt' && !optionsEnded && word === '--') {`` (`policy/reader-grammar.js:65`). 그 뒤 단어는 모두 피연산자. `exact`에서 `--`는 목록에 없으면 거절.
- **RG-05** 피연산자는 모아서 마지막에 `operands` 규칙으로 검사(``operands.push(word);`` `policy/reader-grammar.js:70`).
- **RG-06** `numericShort`(getopt 전용): 단어가 숫자만(``/^-\d+$/``, `policy/reader-grammar.js:88`)이면 선두 `-숫자` 글자나 단어가 어느 목록에도 명시돼 있지 않을 때 무조건 수락(`git log -20`). 명시돼 있으면 일반 클러스터 파서로 넘어간다. 두 이름 중 하나라도 여러 목록에 있으면 거절(`:88-107`).
- **RG-07** getopt 짧은 옵션 묶음(`-` 한 개로 시작, `--` 아님; `matchShortCluster`, `policy/reader-grammar.js:175-202`): 글자를 하나씩 `-글자`로 읽는다. 여러 목록에 있으면 거절. `flags`면 계속. `valueFlags`면 단어 나머지가 비어 있지 않으면 값이 붙은 것(수락, 다음 단어 소비 없음), 비어 있고 뒤에 단어가 없으면 거절(`word: ch`), 있으면 다음 단어를 값으로 소비. `optionalValueFlags`면 나머지를 값으로 보고 이 단어를 끝냄(다음 단어 소비 없음). 그 밖은 거절(`word`는 전체 단어).
- **RG-08** 긴 옵션(getopt의 `--` 시작)·`exact`의 모든 `-` 단어: 이름은 getopt에서만 처음 `=` 앞까지(``const eqIndex = grammar.args === 'getopt' ? word.indexOf('=') : -1;`` `policy/reader-grammar.js:120`), `exact`는 단어 전체. 이름이 `flags`·`valueFlags`·`optionalValueFlags` 중 둘 이상에 있으면 거절(``if (isAmbiguousName(name, flags, valueFlags, optionalValueFlags)) {`` `policy/reader-grammar.js:127`, 판정 함수 `policy/reader-grammar.js:157-162`).
- **RG-09** `valueFlags`: `=`로 붙은 값이면 수락, 아니면 뒤에 단어가 없으면 거절(`word: name`), 있으면 소비(``if (valueFlags.has(name)) {`` `policy/reader-grammar.js:130`).
- **RG-10** `optionalValueFlags`: 맨 이름이거나 `=값`이 붙으면 수락, 다음 단어는 건드리지 않는다(``if (optionalValueFlags.has(name)) {`` `policy/reader-grammar.js:140`).
- **RG-11** `flags`: `=`가 붙어 있으면(`eqIndex !== -1`) 거절(``if (flags.has(name) && eqIndex === -1) {`` `policy/reader-grammar.js:146`). 어디에도 없으면 거절(`:149`).
- **RG-12** 피연산자 검사(`checkOperands`, `policy/reader-grammar.js:210-246`) 순서: 각 피연산자에 대해 `first`(첫 피연산자가 목록에 있어야 함)와 `each`(정규식, 매번 `lastIndex = 0`으로 초기화한 뒤 `test`)를 보고, 마지막에 `max`(피연산자 수가 한도를 넘으면 `operands[limit]`를 `word`로 거절). `max`가 음이 아닌 정수가 아니면 한도 0으로 본다(`:240-241`). 피연산자 규칙이 없으면 통과.
  - ``if (i === 0 && rules.first && !rules.first.includes(operand)) {`` (`policy/reader-grammar.js:215`)
  - ``if (rules.each) {`` (`policy/reader-grammar.js:218`)
  - ``const validMax = Number.isInteger(rules.max) && rules.max >= 0;`` (`policy/reader-grammar.js:240`)

#### 1.12.3 `READERS` 항목 68개 (`:131-537`)

모든 항목이 `readOnly: true, operandsAreData: true`이고 `grammar.args`가 `any` 48개·`getopt` 17개·`exact` 3개다. 두 단어 항목 14개는 이름에 공백이 있다.

`any` 항목(48개)은 「모든 인자 수락」이며 문법 검사가 없다. 인용 없는 glob도 허용한다(CL-G03).

| ID | 이름(원문 키) | 줄 | 비고 |
|---|---|---|---|
| CL-R002 | ``"basename"`` | `policy/classifier.js:150` | any |
| CL-R003 | ``"cat"`` | `policy/classifier.js:151` | any |
| CL-R004 | ``"comm"`` | `policy/classifier.js:152` | any |
| CL-R005 | ``"cut"`` | `policy/classifier.js:153` | any |
| CL-R007 | ``"df"`` | `policy/classifier.js:173` | any |
| CL-R009 | ``"dig"`` | `policy/classifier.js:200` | any |
| CL-R010 | ``"dirname"`` | `policy/classifier.js:201` | any |
| CL-R011 | ``"docker images"`` | `policy/classifier.js:202` | any, 두 단어 |
| CL-R012 | ``"docker inspect"`` | `policy/classifier.js:203` | any, 두 단어 |
| CL-R013 | ``"docker logs"`` | `policy/classifier.js:204` | any, 두 단어 |
| CL-R014 | ``"docker ps"`` | `policy/classifier.js:205` | any, 두 단어 |
| CL-R015 | ``"docker stats"`` | `policy/classifier.js:206` | any, 두 단어 |
| CL-R016 | ``"du"`` | `policy/classifier.js:207` | any |
| CL-R017 | ``"echo"`` | `policy/classifier.js:208` | any |
| CL-R018 | ``"false"`` | `policy/classifier.js:209` | any |
| CL-R021 | ``"free"`` | `policy/classifier.js:252` | any |
| CL-R027 | ``"git status"`` | `policy/classifier.js:332` | any, 두 단어 |
| CL-R028 | ``"grep"`` | `policy/classifier.js:333` | any |
| CL-R029 | ``"head"`` | `policy/classifier.js:334` | any |
| CL-R030 | ``"host"`` | `policy/classifier.js:335` | any |
| CL-R032 | ``"htop"`` | `policy/classifier.js:349` | any |
| CL-R033 | ``"id"`` | `policy/classifier.js:350` | any |
| CL-R035 | ``"iostat"`` | `policy/classifier.js:369` | any |
| CL-R039 | ``"ls"`` | `policy/classifier.js:411` | any |
| CL-R041 | ``"nslookup"`` | `policy/classifier.js:427` | any |
| CL-R042 | ``"ping"`` | `policy/classifier.js:428` | any |
| CL-R043 | ``"printenv"`` | `policy/classifier.js:429` | any |
| CL-R044 | ``"printf"`` | `policy/classifier.js:430` | any |
| CL-R045 | ``"ps"`` | `policy/classifier.js:431` | any |
| CL-R046 | ``"pwd"`` | `policy/classifier.js:432` | any |
| CL-R047 | ``"readlink"`` | `policy/classifier.js:433` | any |
| CL-R048 | ``"realpath"`` | `policy/classifier.js:434` | any |
| CL-R049 | ``"seq"`` | `policy/classifier.js:435` | any |
| CL-R052 | ``"stat"`` | `policy/classifier.js:488` | any |
| CL-R054 | ``"tail"`` | `policy/classifier.js:503` | any |
| CL-R055 | ``"test"`` | `policy/classifier.js:504` | any |
| CL-R056 | ``"top"`` | `policy/classifier.js:505` | any |
| CL-R057 | ``"tr"`` | `policy/classifier.js:506` | any |
| CL-R058 | ``"traceroute"`` | `policy/classifier.js:507` | any |
| CL-R059 | ``"true"`` | `policy/classifier.js:508` | any |
| CL-R060 | ``"uname"`` | `policy/classifier.js:509` | any |
| CL-R062 | ``"uptime"`` | `policy/classifier.js:530` | any |
| CL-R063 | ``"vmstat"`` | `policy/classifier.js:531` | any |
| CL-R064 | ``"wc"`` | `policy/classifier.js:532` | any |
| CL-R065 | ``"whereis"`` | `policy/classifier.js:533` | any |
| CL-R066 | ``"which"`` | `policy/classifier.js:534` | any |
| CL-R067 | ``"who"`` | `policy/classifier.js:535` | any |
| CL-R068 | ``"whoami"`` | `policy/classifier.js:536` | any |

(`CL-R` 번호는 원문 순서(알파벳)로 매긴 1~68이다. 위 표는 `any` 48개이고, 번호가 비는 20개(001, 006, 008, 019, 020, 022~026, 031, 034, 036~038, 040, 050, 051, 053, 061)가 아래 `getopt`·`exact` 항목이다.)

`getopt`·`exact` 항목(20개)은 목록을 원문 그대로 적는다. 항목에 없는 필드(`flags` 등)는 빈 목록으로 본다. 각 항목의 줄 범위에는 설계 근거 주석이 함께 들어 있다(이식 시 주석은 불필요하지만 「왜 이 플래그가 빠졌는지」를 담고 있어 JUnit 사례 이유로 쓸 수 있다).

- **CL-R001 `arp`** (`policy/classifier.js:146-149`, `args: 'getopt'`)
  - ``flags: ['-a', '-e', '-n', '-v'],``
  - ``valueFlags: ['-H', '-t', '-i'],``
  - ``operands: { max: 1, each: /^(?!\/[^/]*\/?$)/ } } },``
  - `each`는 `/` 바로 아래 한 단계 경로(`/a`, `/etc/`)를 거절한다(Windows 슬래시 옵션 때문, 주석 `:132-145`).
- **CL-R006 `date`** (`policy/classifier.js:168-172`, `getopt`)
  - ``flags: ['-u', '--utc', '--universal', '-R', '--rfc-2822', '--rfc-email'],``
  - ``valueFlags: ['-r', '--reference', '--rfc-3339', '-v'],``
  - ``optionalValueFlags: ['-I', '--iso-8601'],``
  - ``operands: { max: 1, each: /^\+/ } } },``
- **CL-R008 `diff`** (`policy/classifier.js:187-199`, `getopt`)
  - ``flags: ['-q', '--brief', '-s', '--report-identical-files', '-c', '-u', '-e', '--ed', '-n', '--rcs', '-y', '--side-by-side', '--left-column', '--suppress-common-lines', '-p', '--show-c-function', '-t', '--expand-tabs', '-T', '--initial-tab', '--suppress-blank-empty', '-r', '--recursive', '--no-dereference', '-N', '--new-file', '--unidirectional-new-file', '--ignore-file-name-case', '--no-ignore-file-name-case', '-i', '--ignore-case', '-E', '--ignore-tab-expansion', '-b', '--ignore-space-change', '-w', '--ignore-all-space', '-B', '--ignore-blank-lines', '-a', '--text', '--strip-trailing-cr', '-d', '--minimal'],``
  - ``valueFlags: ['-C', '-U', '-W', '--width', '--tabsize', '-F', '--show-function-line', '-I', '--ignore-matching-lines', '-D', '--ifdef', '--label', '-x', '--exclude', '-X', '--exclude-from', '-S', '--starting-file', '--from-file', '--to-file', '--line-format'],``
  - ``optionalValueFlags: ['--context', '--unified', '--color'],``
  - ``operands: { max: 2 } } },``
- **CL-R019 `file`** (`policy/classifier.js:224-228`, `getopt`)
  - ``flags: ['-b', '--brief', '-c', '--checking-printout', '-i', '--mime', '--mime-type', '--mime-encoding', '-k', '--keep-going', '-L', '--dereference', '-h', '--no-dereference', '-n', '--no-buffer', '-r', '--raw', '-s', '--special-files', '-0', '--print0'],``
  - ``valueFlags: ['-f', '--files-from', '-m', '--magic-file', '-M', '-e', '--exclude', '-F', '--separator'] } },``
- **CL-R020 `find`** (`policy/classifier.js:245-251`, `args: 'exact'`)
  - ``flags: ['-H', '-L', '-P', '-print', '-print0', '-ls', '-not', '-a', '-and', '-o', '-or', '-true', '-false', '-empty', '-xdev', '-mount', '-depth', '-daystart', '-executable', '-readable', '-writable'],``
  - ``valueFlags: ['-name', '-iname', '-path', '-ipath', '-wholename', '-iwholename', '-regex', '-iregex', '-type', '-perm', '-user', '-group', '-uid', '-gid', '-size', '-mtime', '-mmin', '-atime', '-amin', '-ctime', '-cmin', '-newer', '-anewer', '-cnewer', '-links', '-inum', '-maxdepth', '-mindepth', '-printf'] } },``
  - `-ls`가 `flags`에 있으나 `-fls`는 CL-D01이 막는다. 피연산자 규칙 없음.
- **CL-R022 `git branch`** (`policy/classifier.js:263-267`, `getopt`)
  - ``flags: ['-a', '--all', '-r', '--remotes', '-v', '--verbose', '-q', '--quiet', '--list', '--show-current'],``
  - ``valueFlags: ['--sort'],``
  - ``optionalValueFlags: ['--color', '--contains', '--merged', '--no-merged'],``
  - ``operands: { max: 0 } } },``
- **CL-R023 `git diff`** (`policy/classifier.js:278-284`, `getopt`)
  - ``flags: ['-p', '-u', '--patch', '--name-only', '--name-status', '--cached', '--staged', '--raw', '-w', '--ignore-all-space', '-b', '--ignore-space-change', '--summary', '--shortstat', '--exit-code', '--quiet', '-R', '--no-color', '--first-parent'],``
  - ``valueFlags: ['--diff-filter', '-S', '-G', '-O'],``
  - ``optionalValueFlags: ['-M', '--find-renames', '-C', '--find-copies', '-U', '--unified', '--color', '--word-diff', '--stat'] } },``
- **CL-R024 `git log`** (`policy/classifier.js:296-304`, `getopt`)
  - ``flags: ['--oneline', '--graph', '--all', '-p', '-u', '--patch', '--name-only', '--name-status', '--abbrev-commit', '--relative-date', '--reverse', '--topo-order', '--date-order', '--parents', '--merges', '--no-merges'],``
  - ``valueFlags: ['-n', '--max-count', '--since', '--until', '--author', '--grep', '--date', '-S', '-G', '--skip'],``
  - ``optionalValueFlags: ['--pretty', '--format', '--decorate', '--branches', '--tags', '--remotes', '--stat', '-L'],``
  - ``numericShort: true } },``
- **CL-R025 `git remote`** (`policy/classifier.js:316-318`, `getopt`)
  - ``flags: ['-v', '--verbose', '-n', '--push'],``
  - ``operands: { max: 2, first: ['get-url'] } } },``
- **CL-R026 `git show`** (`policy/classifier.js:327-331`, `getopt`)
  - ``flags: ['-s', '--no-patch', '--name-only', '--name-status', '--oneline', '--abbrev-commit', '--raw'],``
  - ``valueFlags: ['--date'],``
  - ``optionalValueFlags: ['--pretty', '--format', '--decorate', '--stat'],``
  - ``numericShort: true } },``
- **CL-R031 `hostname`** (`policy/classifier.js:345-348`, `getopt`)
  - ``flags: ['-a', '--alias', '-A', '--all-fqdns', '-d', '--domain', '-f', '--fqdn', '--long', '-i', '--ip-address', '-I', '--all-ip-addresses', '-s', '--short'],``
  - ``operands: { max: 0 } } },``
- **CL-R034 `ifconfig`** (`policy/classifier.js:364-368`, `getopt`)
  - ``flags: ['-a', '-s', '-l', '-m', '-d', '-u', '-v', '-L', '-r', '-C'],``
  - ``valueFlags: ['-f'],``
  - ``optionsBeforeOperands: true,``
  - ``operands: { max: 1 } } },``
- **CL-R036 `ip addr`** (`policy/classifier.js:380`, `args: 'exact'`, 두 단어)
  - ``"ip addr": { readOnly: true, operandsAreData: true, grammar: { args: 'exact', operands: { first: ['show', 'list'] } } },``
- **CL-R037 `ip route`** (`policy/classifier.js:388`, `args: 'exact'`, 두 단어)
  - ``"ip route": { readOnly: true, operandsAreData: true, grammar: { args: 'exact', operands: { first: ['show', 'list', 'get'] } } },``
- **CL-R038 `journalctl`** (`policy/classifier.js:404-410`, `getopt`)
  - ``flags: ['-f', '--follow', '-e', '--pager-end', '-r', '--reverse', '-k', '--dmesg', '-q', '--quiet', '-x', '--catalog', '-a', '--all', '-l', '--full', '-m', '--merge', '--no-pager', '--no-hostname', '--no-tail', '--disk-usage', '--header', '--list-boots', '--system', '--user'],``
  - ``valueFlags: ['-u', '--unit', '--since', '--until', '-S', '-U', '-o', '--output', '-p', '--priority', '-g', '--grep', '-t', '--identifier', '-D', '--directory'],``
  - ``optionalValueFlags: ['-n', '--lines', '-b', '--boot', '--facility'] } },``
- **CL-R040 `netstat`** (`policy/classifier.js:423-426`, `getopt`)
  - ``flags: ['-a', '-n', '-t', '-u', '-l', '-p', '-r', '-i', '-s', '-e', '-W', '-x', '-w', '-4', '-6', '-v', '-b', '-d', '-m'],``
  - ``optionalValueFlags: ['-f', '-I'] } },``
- **CL-R050 `sort`** (`policy/classifier.js:466-474`, `getopt`)
  - ``flags: ['-b', '-c', '-d', '-f', '-g', '-h', '-i', '-M', '-m', '-n', '-R', '-r', '-s', '-u', '-V', '-z', '--ignore-leading-blanks', '--dictionary-order', '--ignore-case', '--general-numeric-sort', '--human-numeric-sort', '--ignore-nonprinting', '--month-sort', '--merge', '--numeric-sort', '--random-sort', '--reverse', '--stable', '--unique', '--version-sort', '--debug', '--zero-terminated'],``
  - ``valueFlags: ['-k', '--key', '-t', '--field-separator', '-S', '--buffer-size', '--sort', '--parallel'],``
  - ``optionalValueFlags: ['--check'],``
  - ``operands: { each: /^(?!\/[^/]*\/?$)/ } } },``
  - `-o`/`--output`/`--compress-program`은 CL-D02가 이 문법보다 먼저 `destructive`로 올린다.
- **CL-R051 `ss`** (`policy/classifier.js:482-487`, `getopt`)
  - ``flags: ['-H', '--no-header', '-O', '--oneline', '-n', '--numeric', '-r', '--resolve', '-a', '--all', '-l', '--listening', '-o', '--options', '-e', '--extended', '-m', '--memory', '-p', '--processes', '-i', '--info', '-s', '--summary', '-t', '--tcp', '-u', '--udp', '-d', '--dccp', '-w', '--raw', '-x', '--unix', '-4', '-6', '-0', '--packet'],``
  - ``valueFlags: ['-f', '--family', '-A', '--query', '--socket', '-F', '--filter'] } },``
- **CL-R053 `systemctl status`** (`policy/classifier.js:499-502`, `getopt`, 두 단어)
  - ``flags: ['-l', '--full', '--no-pager', '-a', '--all', '-q', '--quiet', '--user', '--system', '-r', '--recursive', '--no-legend'],``
  - ``optionalValueFlags: ['-n', '--lines', '-o', '--output'] } },``
- **CL-R061 `uniq`** (`policy/classifier.js:523-529`, `getopt`)
  - ``flags: ['-c', '--count', '-d', '--repeated', '-u', '--unique', '-i', '--ignore-case', '-z', '--zero-terminated', '-D'],``
  - ``valueFlags: ['-f', '--skip-fields', '-s', '--skip-chars', '-w', '--check-chars'],``
  - ``optionalValueFlags: ['--all-repeated'],``
  - ``optionsBeforeOperands: true,``
  - ``operands: { max: 1 } } },``

참고: 2.x가 부르지 않는 보조 export — `extractBinary`(`:1600`), `nestedCommands`(`:1030`), `findForbiddenMatch`(`:1526`), `isForbidden`(`:1572`), `isDestructive`·`formatReadOnlyRejection`·`READERS`·`READ_ONLY_ALLOWLIST`·`READ_ONLY_SYNTHETIC`(`:2222`). 단 `classifyCommand`가 안에서 쓰는 것은 위 규칙에 모두 포함했다.

### 1.13 3.0 사례 초안 (분류기)

- 입력 칸의 `<LF>`는 U+000A, `<NBSP>`는 U+00A0이다. 기대 결과의 「rej」는 `readOnlyRejection{binary, word}`다. 등급 값만 적은 칸은 `class`만 본다는 뜻이다.
- 모든 사례의 대상은 `CommandClassifier.classify(command).commandClass()`(이름은 구현 담당이 정함)다. 모든 사례는 「미검증: 실행 안 함」(소스 추적값)이다.

| 사례 ID | 대상 | 입력 | 기대 결과 | 근거 위치 |
|---|---|---|---|---|
| VR-001 | CL-A01 | `find . -name \*.conf` | `safe`, rej{find, `\*.conf`} (posix는 `read-only`, windows가 더 높아 채택) | policy/classifier.js:2084 |
| VR-002 | CL-A01 | `ls C:\Users` | `read-only` (두 방언이 같으면 posix 결과) | policy/classifier.js:2084 |
| VR-003 | CL-A01 | `ls /tmp` | `read-only` (백슬래시가 없으면 방언 한 번) | policy/classifier.js:2080 |
| VR-004 | CL-A02 | `sudo rm -rf /` | `privileged` (권한 상승이 금지 규칙보다 먼저) | policy/classifier.js:2135 |
| VR-005 | CL-A02 | `rm -rf /` | `destructive` | policy/classifier.js:2137 |
| VR-006 | CL-A02 | `$S id` | `destructive` (명령 이름 불명) | policy/classifier.js:2149 |
| VR-007 | CL-A02 | `echo hi` | `read-only` | policy/classifier.js:2154 |
| VR-008 | CL-A02 | `echo hi; ls` | `safe` (셸 제어 문자 `;`) | policy/classifier.js:2156 |
| VR-009 | CL-A02 | `frobnicate --now` | `safe` (미등록 프로그램 기본값) | policy/classifier.js:2200 |
| VR-010 | CL-A03 | `sftp:upload /tmp/x; sudo id` | `privileged` (바닥은 올리기만 함) | policy/classifier.js:2101 |
| VR-011 | CL-A04 | `sudo sh -c 'rm -rf /etc'` | `privileged` (바깥 privileged, 안쪽 destructive) | policy/classifier.js:2109 |
| VR-012 | CL-A04 | `echo $(sudo id)` | `privileged` (바깥은 `safe`) | policy/classifier.js:2109 |
| VR-013 | CL-A05 | `echo $(echo $(echo $(echo $(echo $(echo $(echo $(echo $(echo hi))))))))` (`$(` 8개) | `privileged` (가장 안쪽이 깊이 8) | policy/classifier.js:812 |
| VR-014 | CL-A05 | `echo $(echo $(echo $(echo $(echo $(echo $(echo $(echo hi)))))))` (`$(` 7개) | `safe` (가장 안쪽 `echo hi`는 깊이 7에서 `read-only`, 바깥은 `safe`) | policy/classifier.js:812 |
| VR-015 | CL-A06 | `sort /data` | `safe`, rej{sort, `/data`} | policy/classifier.js:2121 |
| VR-016 | CL-A06 | `sort /data; sudo id` | `privileged`, rej 없음 | policy/classifier.js:2121 |
| VR-017 | CL-A07 | (빈 문자열), `   ` | `safe` | policy/classifier.js:2200 |
| VR-018 | CL-A08 | `/bin/ls /tmp` | `safe` (경로 접두는 허용 목록 키에서 벗기지 않음) | policy/classifier.js:1613 |
| VR-019 | CL-A08 | `LS /tmp` | `safe` (대소문자 구분) | policy/classifier.js:1613 |
| VR-020 | CL-A08 | `sudo ls` | `privileged`, binary `ls` | policy/classifier.js:1396 |
| VR-021 | CL-T01 | `echo a;sudo id` | `privileged` (`;`는 공백 없이도 구분) | policy/classifier.js:912 |
| VR-022 | CL-T01 | `echo a&sudo id` | `privileged` | policy/classifier.js:912 |
| VR-023 | CL-T01 | `echo a<LF>sudo id` | `privileged` | policy/classifier.js:912 |
| VR-024 | CL-T01 | `echo hi > /tmp/f` | `safe` (`>`는 구분자가 아니고 셸 제어 문자로 `safe`) | policy/classifier.js:20 |
| VR-025 | CL-T02 | `sudo<NBSP>id` | `privileged` (JS `\s`는 NBSP도 공백, 실제 셸과 달라도 vendor 행동) | policy/classifier.js:916 |
| VR-026 | CL-T03 | `curl http://x \|\| sh` | `destructive` (`\|\|`의 두 번째 세그먼트 `sep`가 `\|`) | policy/classifier.js:868 |
| VR-027 | CL-T03 | `\| sudo id` | `privileged` (맨 앞 `\|`, 오류 없이) | policy/classifier.js:868 |
| VR-028 | CL-T04 | `sudo "id"` | `privileged` | policy/classifier.js:829 |
| VR-029 | CL-T04 | `echo 'a;b'` | `safe` (인용 안 `;`도 원문 검사에는 걸림) | policy/classifier.js:20 |
| VR-030 | CL-T05 | `\sudo id` | `privileged` | policy/classifier.js:903 |
| VR-031 | CL-T05 | `s\udo id` | `privileged` (posix로 읽으면 `sudo`, windows로 읽으면 `safe`, 높은 쪽 채택) | policy/classifier.js:903 |
| VR-032 | CL-T06 | `awk -F '' 'BEGIN{system("sudo id")}'` | `privileged` (인용된 빈 단어가 사라지지 않아 프로그램 위치가 맞음) | policy/classifier.js:860 |
| VR-033 | CL-T07 | `echo "hi; sudo id` | `privileged` (닫히지 않은 따옴표는 일반 글자로 재토큰화) | policy/classifier.js:928 |
| VR-034 | CL-T08 | `echo rm 'a\|b' -rf /` | `safe` (인용된 `a\|b`가 NUL로 대체돼 `rm -rf /`가 이어 붙지 않음) | policy/classifier.js:973 |
| VR-035 | CL-T08 | `rm -rf "/etc"` | `destructive` (정규화본이 `rm -rf /etc`) | policy/classifier.js:999 |
| VR-036 | CL-T09 | `"sudo" id "` (따옴표 3개, 닫히지 않음) | `privileged` (재토큰화된 `"sudo"`를 `unquote`가 벗김) | policy/classifier.js:1308 |
| VR-037 | CL-T10 | `/usr/bin/sudo id` | `privileged` | policy/classifier.js:1322 |
| VR-038 | CL-T10 | `/sbin/reboot` | `destructive`, binary `/sbin/reboot` | policy/classifier.js:1322 |
| VR-039 | CL-F01 | `rm -rf /` | `destructive` | policy/classifier.js:621 |
| VR-040 | CL-F01 | `rm -r /` | `destructive` | policy/classifier.js:621 |
| VR-041 | CL-F01 | `rm -fr /` | `safe` (정규식 `-rf?`가 `-fr`을 못 잡음, vendor 구멍) | policy/classifier.js:621 |
| VR-042 | CL-F02 | `mkfs.ext4 /dev/sdb1` | `destructive` | policy/classifier.js:622 |
| VR-043 | CL-F02 | `echo mkfs.x` | `destructive` (언급도 걸림, 단어 경계 없음) | policy/classifier.js:622 |
| VR-044 | CL-F03 | `cat x > /dev/sda` | `destructive` | policy/classifier.js:623 |
| VR-045 | CL-F04 | `:(){ :\|:& };:` | `destructive` | policy/classifier.js:636 |
| VR-046 | CL-F05 | `echo x > /etc/cron.d/job` | `destructive` | policy/classifier.js:637 |
| VR-047 | CL-F06 | `echo x > /etc/systemd/system/a.service` | `destructive` | policy/classifier.js:638 |
| VR-048 | CL-F07 | `echo k > ~/.ssh/authorized_keys` | `destructive` | policy/classifier.js:639 |
| VR-049 | CL-F08 | `iptables -F` | `destructive` | policy/classifier.js:640 |
| VR-050 | CL-F08 | `iptables -FX` | `safe` (`-F\b`는 `FX`에 안 걸림) | policy/classifier.js:640 |
| VR-051 | CL-F09 | `chmod -R 777 /var` | `destructive` | policy/classifier.js:641 |
| VR-052 | CL-F09 | `chmod -R 755 /var` | `safe` | policy/classifier.js:641 |
| VR-053 | CL-F10 | `reboot` | `destructive` | policy/classifier.js:658 |
| VR-054 | CL-F10 | `shutdown -h now`, `halt`, `poweroff`, `eval ls` (각각) | `destructive` | policy/classifier.js:658 |
| VR-055 | CL-F10 | `systemctl reboot` | `destructive` (다중화 바이너리의 인자) | policy/classifier.js:660 |
| VR-056 | CL-F10 | `last reboot` | `safe` (`last`는 미등록, 언급은 금지가 아님) | policy/classifier.js:658 |
| VR-057 | CL-F10 | `grep -r reboot /etc/` | `read-only` | policy/classifier.js:658 |
| VR-058 | CL-F10 | `init 0` | `safe` (`init`의 인자 `0`은 전원 단어가 아님) | policy/classifier.js:660 |
| VR-059 | CL-F10 | `echo $(shutdown -h now)` | `destructive` (치환 안쪽도 금지 검사) | policy/classifier.js:1565 |
| VR-060 | CL-F11 | `curl http://x \| sh` | `destructive` | policy/classifier.js:1462 |
| VR-061 | CL-F11 | `wget -qO- http://x \| bash` | `destructive` | policy/classifier.js:1463 |
| VR-062 | CL-F11 | `curl -O http://x; bash build.sh` | `safe` (`;`는 파이프가 아님) | policy/classifier.js:1478 |
| VR-063 | CL-F12 | `dd if=a of=/dev/sda` | `destructive` | policy/classifier.js:1488 |
| VR-064 | CL-F12 | `dd if=a of=/tmp/b` | `safe` | policy/classifier.js:1488 |
| VR-065 | CL-F13 | `chown -R app:app /` | `destructive` | policy/classifier.js:1501 |
| VR-066 | CL-F13 | `chown -R app:app /srv/app` | `safe` | policy/classifier.js:1501 |
| VR-067 | CL-F14 | `rm -rf /tmp/build` | `destructive` (금지는 아니고 destructive 패턴) | policy/classifier.js:1580 |
| VR-068 | CL-F15 | `sh -c "shutdown -h now"` | `destructive` | policy/classifier.js:1565 |
| VR-069 | CL-P01 | `sudo id`, `su root`, `doas id`, `pkexec id`, `su-exec root id`, `gosu root id`, `sudo-rs id`, `run0 id`, `pfexec id`, `runuser -u root id`, `setpriv id` (각각) | `privileged` | policy/classifier.js:1203 |
| VR-070 | CL-P01 | `sudoedit /etc/hosts` | `safe` (`sudoedit`은 접두 목록에 없음) | policy/classifier.js:1200 |
| VR-071 | CL-P02 | `env sudo id`, `nohup sudo id`, `timeout 5 sudo id`, `nice -n 10 sudo id`, `command sudo id`, `FOO=1 sudo id`, `xargs sudo id`, `busybox sudo id` (각각) | `privileged` | policy/classifier.js:1222 |
| VR-072 | CL-P02 | `grep sudo /var/log/auth.log` | `read-only` (언급은 상승이 아님) | policy/classifier.js:1396 |
| VR-073 | CL-P02 | `env ls` | `safe` (`env`는 읽기 전용 목록에 없음) | policy/classifier.js:1222 |
| VR-074 | CL-P03 | `sudo -u root reboot` | `privileged`, binary `reboot` (`-u`가 `root`를 먹음) | policy/classifier.js:1316 |
| VR-075 | CL-P03 | `sudo -n id` | `privileged`, binary `id` (`-n`은 값을 먹지 않음) | policy/classifier.js:1316 |
| VR-076 | CL-P04 | `FOO=1 ls` | `safe` (할당은 허용 목록 키 `ls`를 가림) | policy/classifier.js:1290 |
| VR-077 | CL-P04 | `timeout 5s sudo id` | `privileged` (`5s`는 BARE_NUMERIC) | policy/classifier.js:1292 |
| VR-078 | CL-P05 | `sudo` | `privileged`, binary `sudo` | policy/classifier.js:1400 |
| VR-079 | CL-P05 | `echo hi; sudo id` | `privileged`, binary `id` | policy/classifier.js:1396 |
| VR-080 | CL-I01 | `python3 -c 'print(1)'`, `python -c 1`, `python2 -c 1`, `node -e 1`, `node --eval=1`, `node -p 1`, `perl -e 1`, `perl -E 1`, `ruby -e 1`, `php -r 1`, `lua -e 1`, `osascript -e 1`, `Rscript -e 1`, `bun -e 1`, `pwsh -c 1`, `powershell -Command 1` (각각) | `destructive` | policy/classifier.js:698 |
| VR-081 | CL-I01 | `deno eval 1` | `destructive` | policy/classifier.js:719 |
| VR-082 | CL-I01 | `echo x \| tclsh` | `destructive` (빈 플래그 목록, 표준 입력 프로그램) | policy/classifier.js:717 |
| VR-083 | CL-I01 | `sh -c ls`, `bash -c ls`, `dash -c ls`, `zsh -c ls`, `ksh -c ls`, `ash -c ls` (각각) | `safe` (readable: 셸은 안쪽 `ls`가 `read-only`, 바깥 `safe`) | policy/classifier.js:689 |
| VR-084 | CL-I02 | `powershell.exe -c 1`, `PWSH.EXE -Command 1`, `Node.EXE -e 1`, `RSCRIPT -e 1` (각각) | `destructive` (확장자 제거·소문자 접기) | policy/classifier.js:734 |
| VR-085 | CL-I02 | `cat /usr/bin/python3` | `read-only` (언급은 호출이 아님) | policy/classifier.js:734 |
| VR-086 | CL-I03 | `echo "sudo id" \| bash` | `destructive` (파이프 뒤 셸이 표준 입력에서 프로그램을 읽음) | policy/classifier.js:1976 |
| VR-087 | CL-I03 | `cat data \| python3 app.py` | `safe` (파이프는 데이터) | policy/classifier.js:1976 |
| VR-088 | CL-I04 | `python3 script.py` | `safe` | policy/classifier.js:1802 |
| VR-089 | CL-I04 | `python3 -m http.server` | `safe` | policy/classifier.js:1802 |
| VR-090 | CL-I04 | `python3 script.py -c evil` | `safe` (스크립트 뒤의 `-c`는 스크립트 인자) | policy/classifier.js:1802 |
| VR-091 | CL-I04 | `bash -xc 'sudo id'` | `privileged` (클러스터 `-xc`) | policy/classifier.js:1846 |
| VR-092 | CL-I04 | `bash -cx 'sudo id'` | `privileged` (`-c`가 앞, 나머지는 클러스터) | policy/classifier.js:1783 |
| VR-093 | CL-I04 | `sh -c'sudo id'` | `privileged` (프로그램이 플래그에 붙음) | policy/classifier.js:1789 |
| VR-094 | CL-I04 | `deno eval --unstable 'sudo id'` | `privileged` (하위 명령 `eval` 뒤 옵션을 건너뜀) | policy/classifier.js:1697 |
| VR-095 | CL-I04 | `sh '' -c 'sudo id'` | `privileged` (인용된 빈 단어는 건너뜀) | policy/classifier.js:1697 |
| VR-096 | CL-I04 | `foo . -name perl -type f` | `safe` (`-type`은 3글자 이하 클러스터가 아님) | policy/classifier.js:1846 |
| VR-097 | CL-I05 | `pwsh -ENC cwB1AGQAbwAgAGkAZAA=` | `privileged` (대소문자를 접어 `-e`로 풀고 base64를 디코딩해 `sudo id` 분류) | policy/classifier.js:1118 |
| VR-098 | CL-I05 | `perl -x 1` | `safe` (`perl`은 대소문자 구분, `-x`는 프로그램 플래그 아님) | policy/classifier.js:1118 |
| VR-099 | CL-I06 | `grep -e perl -e python file` | `read-only` | policy/classifier.js:1712 |
| VR-100 | CL-I06 | `nsenter -t 1 -m sh -c 'sudo id'` | `privileged` (`-m`은 `sh`의 프로그램 플래그가 아니므로 `sh`를 건너뛰지 않음) | policy/classifier.js:1712 |
| VR-101 | CL-I07 | `pwsh -EncodedCommand cwB1AGQAbwAgAGkAZAA=` | `privileged` | policy/classifier.js:1135 |
| VR-102 | CL-I07 | `pwsh -EncodedCommand AAAA` | `destructive` (디코딩 결과 NUL 한 글자, 안쪽 `safe`) | policy/classifier.js:1830 |
| VR-103 | CL-I07 | `pwsh -ExecutionPolicy Bypass -Command 'sudo id'` | `privileged` (모르는 옵션의 값을 건너뜀) | policy/classifier.js:1755 |
| VR-104 | CL-I08 | `echo hi \| bash`, `echo hi \| bash -`, `echo hi \| bash -s -- arg` (각각) | `destructive` | policy/classifier.js:1865 |
| VR-105 | CL-I08 | `echo hi \| bash -- process.sh` | `safe` (`-s` 없이 `--` 뒤 단어는 스크립트 파일) | policy/classifier.js:1900 |
| VR-106 | CL-I09 | `env sh -c 'sudo id'` | `privileged` | policy/classifier.js:1633 |
| VR-107 | CL-N01 | `echo $(sudo id)` | `privileged` | policy/classifier.js:1042 |
| VR-108 | CL-N01 | `echo $(echo $(sudo id))` | `privileged` (괄호 깊이 스캔) | policy/classifier.js:1042 |
| VR-109 | CL-N01 | `cat <(sudo id)` | `privileged` (`<(`) | policy/classifier.js:1042 |
| VR-110 | CL-N01 | `echo $((1 + 1))` | `safe` (산술은 명령이 아님, 셸 제어 문자로 `safe`) | policy/classifier.js:1042 |
| VR-111 | CL-N01 | `echo $(sudo id` | `safe` (닫는 괄호 없음, 추출 안 함) | policy/classifier.js:1042 |
| VR-112 | CL-N02 | ``echo `sudo id` `` | `privileged` | policy/classifier.js:1059 |
| VR-113 | CL-N04 | `grep python3 -c /var/log/x` | `read-only` (허용 목록 명령의 피연산자는 데이터) | policy/classifier.js:1666 |
| VR-114 | CL-N05 | `unknownbin sh -c true 'sudo id'` | `privileged` (소비한 피연산자 `true`만 제외하고 `'sudo id'`는 추측 스캔) | policy/classifier.js:1110 |
| VR-115 | CL-N06 | `git commit -m 'reboot the worker pool'` | `destructive` (추측성 피연산자가 명령으로 분류됨; 단 금지 검사는 이 추측을 끔) | policy/classifier.js:1162 |
| VR-116 | CL-N06 | `git commit -m 'fix typo'` | `safe` (안쪽 `fix typo`도 `safe`) | policy/classifier.js:1168 |
| VR-117 | CL-N07 | `find / -exec sudo id +` | `privileged` (바깥은 `destructive`, 안쪽 `sudo id`) | policy/classifier.js:765 |
| VR-118 | CL-N08 | `echo hi \| sh` | `destructive` (바로 앞 세그먼트도 명령으로 분류되나 `read-only`) | policy/classifier.js:1190 |
| VR-119 | CL-N09 | `echo $()` | `safe` (빈 치환은 버림) | policy/classifier.js:1197 |
| VR-120 | CL-D01 | `find /var/www -delete` | `destructive` | policy/classifier.js:1238 |
| VR-121 | CL-D01 | `find . -fprint /tmp/x`, `find . -fprintf /tmp/x %p`, `find . -fls /tmp/x`, `find . -execdir id +` (각각) | `destructive` | policy/classifier.js:1238 |
| VR-122 | CL-D01 | `env find . -delete` | `destructive` (래퍼를 건너뛴 효과적 명령 단어 기준) | policy/classifier.js:1238 |
| VR-123 | CL-D02 | `sort -o out in`, `sort -mo out in`, `sort -ofile in`, `sort --output=out in`, `sort --out=x in`, `sort --o x in`, `sort --compress-program=x in`, `sort --co=x in` (각각) | `destructive` | policy/classifier.js:1285 |
| VR-124 | CL-D02 | `sort --c=x k` | `safe`, rej{sort, `--c=x`} (`--c`는 `--check`와 모호해 sort 자체가 거절, 쓰기 아님) | policy/classifier.js:1285 |
| VR-125 | CL-D02 | `sort -tofile k` | `read-only` (`-t`가 값 `ofile`을 먹음, `-o` 아님) | policy/classifier.js:1287 |
| VR-126 | CL-D02 | `env sort --compress-program=x in` | `destructive` | policy/classifier.js:1286 |
| VR-127 | AW-01 | `awk '{print $1}' f` | `safe` | policy/awk.js:424 |
| VR-128 | AW-01 | `awk -F: '{print $1}' f`, `awk -F ':' '{print $1}' f`, `awk -v x=1 '{print x}' f` (각각) | `safe` (값 플래그를 건너뛰고 프로그램을 찾음) | policy/awk.js:43 |
| VR-129 | AW-01 | `awk -f prog.awk f`, `awk -f- f`, `awk -W version`, `awk -i inplace '{print}'` (각각) | `destructive` (프로그램 파일·알 수 없는 플래그는 `unreadable`) | policy/awk.js:43 |
| VR-130 | AW-01 | `awk --version`, `awk --help`, `awk` | `safe` (프로그램 없음, `null`) | policy/awk.js:55 |
| VR-131 | AW-01 | `awk -- '{print}' f` | `safe` | policy/awk.js:424 |
| VR-132 | AW-02 | `awk` (인자 없음) | `safe` | policy/awk.js:454 |
| VR-133 | AW-03 | `awk '` + 262145자 프로그램 + `'` | `destructive` (2.x는 32KiB 한도로 이 입력을 이미 거절하므로 도메인 단위 시험) | policy/awk.js:463 |
| VR-134 | AW-03 | `awk '` + 정확히 262144자 프로그램(`{` + 공백 262142 + `}`) + `'` | `safe` | policy/awk.js:463 |
| VR-135 | AW-04 | `awk 'BEGIN{print "x}'` | `destructive` (닫히지 않은 문자열) | policy/awk.js:216 |
| VR-136 | AW-04 | `awk '/a>b/{print}' f` | `safe` (정규식 안 `>`) | policy/awk.js:124 |
| VR-137 | AW-04 | `awk '{print a/b}' f` | `safe` (단어 뒤 `/`는 나눗셈) | policy/awk.js:111 |
| VR-138 | AW-04 | `awk 'BEGIN{not=2; x = not / system("sudo id") / 3}'` | `privileged` (`not`은 예약어 아님, `/`는 나눗셈, `system` 호출 읽음) | policy/awk.js:111 |
| VR-139 | AW-05 | `awk 'BEGIN{system("\163udo id")}'` | `privileged` (8진 이스케이프 `\163`=`s`) | policy/awk.js:167 |
| VR-140 | AW-05 | `awk 'BEGIN{system("\x73udo id")}'` | `privileged` (16진 이스케이프) | policy/awk.js:174 |
| VR-141 | AW-06 | `awk '{print $1 >> "log"}'` | `destructive` (`>>`가 한 토큰) | policy/awk.js:71 |
| VR-142 | AW-07 | `awk '{print > "out"}'` | `destructive` | policy/awk.js:62 |
| VR-143 | AW-07 | `awk '{print > "/dev/stderr"}'` | `safe` | policy/awk.js:62 |
| VR-144 | AW-07 | `awk '{print $1 > $2}'` | `destructive` (계산된 대상도 파일 쓰기) | policy/awk.js:62 |
| VR-145 | AW-07 | `awk 'NR>1' f` | `safe` (print 밖의 `>`는 비교) | policy/awk.js:62 |
| VR-146 | AW-07 | `awk '{print (a>b)}' f` | `safe` (괄호 안 `>`는 비교) | policy/awk.js:62 |
| VR-147 | AW-07 | `awk '{print \| "sh"}'` | `destructive` (셸로 파이프) | policy/awk.js:358 |
| VR-148 | AW-07 | `awk '{print \| "sort"}'` | `safe` | policy/awk.js:358 |
| VR-149 | AW-07 | `awk 'BEGIN{"date" \| getline}'` | `safe` (안쪽 `date`는 `read-only`) | policy/awk.js:378 |
| VR-150 | AW-07 | `awk 'BEGIN{system("rm " f)}'` | `destructive` (조립된 명령은 읽을 수 없음) | policy/awk.js:406 |
| VR-151 | AW-07 | `awk 'BEGIN{system("sudo id")}'` | `privileged` | policy/awk.js:406 |
| VR-152 | AW-07 | `awk '@load "x"'` | `destructive` | policy/awk.js:335 |
| VR-153 | AW-07 | `awk 'BEGIN{print "x" \| "id" "; sudo sh"}'` | `destructive` (연결된 문자열은 읽을 수 없음) | policy/awk.js:358 |
| VR-154 | AW-08 | `man awk` | `safe` (명령 단어가 `awk`가 아님) | policy/classifier.js:1927 |
| VR-155 | AW-08 | `readlink -f /usr/bin/awk` | `read-only` | policy/classifier.js:1927 |
| VR-156 | AW-09 | `awk '{print "a b"}'` | `safe` (awk는 추측성 피연산자 스캔에서 제외) | policy/classifier.js:1162 |
| VR-157 | CL-U01 | `$S id`, `$PREFIX/bin/tool` (각각) | `destructive` | policy/classifier.js:2016 |
| VR-158 | CL-U01 | `echo $HOME` | `safe` (인자의 `$`는 해당 없음, 제어 문자로 `safe`) | policy/classifier.js:2016 |
| VR-159 | CL-U01 | `env $X id` | `destructive` (래퍼를 건너뛴 효과적 명령 단어가 `$X`) | policy/classifier.js:2016 |
| VR-160 | CL-U01 | `` `which sudo` id `` (백틱 포함) | `destructive` | policy/classifier.js:2016 |
| VR-161 | CL-S01 | `sftp:list /tmp`, `sftp:download /tmp/x` (각각) | `read-only` | policy/classifier.js:587 |
| VR-162 | CL-S01 | `sftp:list /tmp sh -c 'sudo id'` | `privileged` (합성 동사도 중첩 스캔 대상) | policy/classifier.js:587 |
| VR-163 | CL-S01 | `sftp:list /tmp; ls` | `safe` (셸 제어 문자) | policy/classifier.js:587 |
| VR-164 | CL-S02 | `sftp:upload /tmp/x`, `sftp:upload-file a b`, `sftp:download-file a b`, `session:open` (각각) | `destructive` | policy/classifier.js:2054 |
| VR-165 | CL-S02 | `session:close` | `safe` (바닥 없음) | policy/classifier.js:2057 |
| VR-166 | CL-G01 | `echo "a;b"` | `safe` | policy/classifier.js:20 |
| VR-167 | CL-G01 | `ls \| wc -l`, `cat < f`, `echo $HOME`, `echo {a,b}`, `uname -a && id` (각각) | `safe` | policy/classifier.js:2156 |
| VR-168 | CL-G02 | `docker ps -a`, `git status -s` (각각) | `read-only` | policy/classifier.js:2153 |
| VR-169 | CL-G02 | `docker run x`, `git commit x`, `systemctl restart nginx`, `ip -4 addr show` (각각) | `safe` (두 단어 키가 허용 목록에 없음) | policy/classifier.js:2153 |
| VR-170 | CL-G03 | `uniq /root/.ssh/id_ed25519*` | `safe`, rej{uniq, `/root/.ssh/id_ed25519*`} | policy/classifier.js:2178 |
| VR-171 | CL-G03 | `find . -name '*.conf'`, `find . -name "*.conf"` (각각) | `read-only` (인용된 glob은 데이터) | policy/classifier.js:84 |
| VR-172 | CL-G03 | `find . -name *.conf` | `safe`, rej{find, `*.conf`} | policy/classifier.js:84 |
| VR-173 | CL-G03 | `ls *` | `read-only` (`any` 항목은 glob 면제) | policy/classifier.js:2178 |
| VR-174 | CL-G03 | `find . -name '*.conf` (따옴표 미종결) | `safe`, rej{find, `'*.conf`} (인용 부호를 일반 글자로 재검사) | policy/classifier.js:92 |
| VR-175 | CL-G04 | `uniq a b` | `safe`, rej{uniq, `b`} | policy/classifier.js:2190 |
| VR-176 | RG-01 | `cat -z --weird file` | `read-only` (`any`는 모든 단어 수락) | policy/reader-grammar.js:36 |
| VR-177 | RG-02 | `uniq -`, `sort -` (각각) | `read-only` (단독 `-`는 피연산자) | policy/reader-grammar.js:48 |
| VR-178 | RG-03 | `uniq in -c` | `safe`, rej{uniq, `-c`} | policy/reader-grammar.js:59 |
| VR-179 | RG-03 | `ifconfig eth0 -a` | `safe`, rej{ifconfig, `-a`} | policy/reader-grammar.js:59 |
| VR-180 | RG-03 | `uniq -c in` | `read-only` | policy/reader-grammar.js:59 |
| VR-181 | RG-04 | `git diff -- -x` | `read-only` (`--` 뒤는 모두 피연산자) | policy/reader-grammar.js:65 |
| VR-182 | RG-04 | `find -- d` | `safe`, rej{find, `--`} (`exact`는 `--`를 목록에 없는 단어로 거절) | policy/reader-grammar.js:65 |
| VR-183 | RG-05 | `date +%s` | `read-only` | policy/reader-grammar.js:70 |
| VR-184 | RG-06 | `git log --oneline -20`, `git show -3` (각각) | `read-only` | policy/reader-grammar.js:88 |
| VR-185 | RG-06 | `git log -2x` | `safe`, rej{git log, `-2x`} | policy/reader-grammar.js:88 |
| VR-186 | RG-06 | `git diff -20` | `safe`, rej{git diff, `-20`} (`numericShort` 없는 항목) | policy/reader-grammar.js:88 |
| VR-187 | RG-07 | `sort -rn /etc/hosts`, `sort -k2,2 /etc/hosts`, `sort -k 2 /etc/hosts` (각각) | `read-only` | policy/reader-grammar.js:175 |
| VR-188 | RG-07 | `sort -k` | `safe`, rej{sort, `-k`} (값 플래그에 값이 없음) | policy/reader-grammar.js:175 |
| VR-189 | RG-07 | `date -Iseconds` | `read-only` (선택 값 플래그, 나머지는 값) | policy/reader-grammar.js:175 |
| VR-190 | RG-07 | `date -I seconds` | `safe`, rej{date, `seconds`} (다음 단어는 소비되지 않고 피연산자가 됨) | policy/reader-grammar.js:175 |
| VR-191 | RG-08 | `git branch --sort=-committerdate`, `date --rfc-3339=seconds` (각각) | `read-only` | policy/reader-grammar.js:120 |
| VR-192 | RG-08 | 엔진 직접 시험: 문법 `{args:'getopt', flags:['-x'], valueFlags:['-x']}`에 단어 `['-x']` | `ok=false`, word `-x` (여러 목록에 있는 이름은 거절) | policy/reader-grammar.js:127 |
| VR-193 | RG-09 | `journalctl -u nginx --since today`, `journalctl --since=today` (각각) | `read-only` | policy/reader-grammar.js:130 |
| VR-194 | RG-09 | `journalctl -u` | `safe`, rej{journalctl, `-u`} | policy/reader-grammar.js:130 |
| VR-195 | RG-10 | `journalctl -b1`, `journalctl -n 50`, `sort --check=silent f` (각각) | `read-only` | policy/reader-grammar.js:140 |
| VR-196 | RG-10 | `journalctl -b -1` | `safe`, rej{journalctl, `-1`} (`-b`는 다음 단어를 먹지 않음) | policy/reader-grammar.js:140 |
| VR-197 | RG-11 | `git branch --list=x` | `safe`, rej{git branch, `--list=x`} (값 없는 플래그에 `=값`) | policy/reader-grammar.js:146 |
| VR-198 | RG-11 | `git diff --output=x` | `safe`, rej{git diff, `--output=x`} | policy/reader-grammar.js:146 |
| VR-199 | RG-12 | `git remote add x y` | `safe`, rej{git remote, `add`} (`first`) | policy/reader-grammar.js:215 |
| VR-200 | RG-12 | `git remote get-url origin`, `git remote -v`, `git remote` (각각) | `read-only` | policy/reader-grammar.js:215 |
| VR-201 | RG-12 | `date foo` | `safe`, rej{date, `foo`} (`each`) | policy/reader-grammar.js:218 |
| VR-202 | RG-12 | `git branch newbr` | `safe`, rej{git branch, `newbr`} (`max: 0`) | policy/reader-grammar.js:231 |
| VR-203 | RG-12 | `diff a b c` | `safe`, rej{diff, `c`} (`max: 2`, 한도 번째 피연산자) | policy/reader-grammar.js:231 |
| VR-204 | RG-12 | 엔진 직접 시험: 문법 `{args:'getopt', operands:{max:1.5}}`, 단어 `['a']` | `ok=false`, word `a` (정수가 아닌 max는 한도 0) | policy/reader-grammar.js:240 |
| VR-205 | RG-12 | `sort /data`, `sort /etc/`, `arp /a` (각각) | `safe`, rej는 각각 `/data`, `/etc/`, `/a` (`/` 바로 아래 한 단계 경로 거절) | policy/reader-grammar.js:218 |
| VR-206 | CL-R001 | `arp -a` / `arp -d host` | `read-only` / `safe` rej{arp, `-d`} | policy/classifier.js:146 |
| VR-207 | CL-R002 | `basename /a/b` | `read-only` | policy/classifier.js:150 |
| VR-208 | CL-R003 | `cat /etc/hostname` | `read-only` | policy/classifier.js:151 |
| VR-209 | CL-R004 | `comm a b` | `read-only` | policy/classifier.js:152 |
| VR-210 | CL-R005 | `cut -d: -f1 /etc/passwd` | `read-only` | policy/classifier.js:153 |
| VR-211 | CL-R006 | `date -u` / `date -s x` | `read-only` / `safe` rej{date, `-s`} | policy/classifier.js:168 |
| VR-212 | CL-R007 | `df -h` | `read-only` | policy/classifier.js:173 |
| VR-213 | CL-R008 | `diff -u a b` / `diff -l a b` | `read-only` / `safe` rej{diff, `-l`} | policy/classifier.js:187 |
| VR-214 | CL-R009 | `dig example.com` | `read-only` | policy/classifier.js:200 |
| VR-215 | CL-R010 | `dirname /a/b` | `read-only` | policy/classifier.js:201 |
| VR-216 | CL-R011 | `docker images` | `read-only` | policy/classifier.js:202 |
| VR-217 | CL-R012 | `docker inspect abc` | `read-only` | policy/classifier.js:203 |
| VR-218 | CL-R013 | `docker logs abc` | `read-only` | policy/classifier.js:204 |
| VR-219 | CL-R014 | `docker ps` | `read-only` | policy/classifier.js:205 |
| VR-220 | CL-R015 | `docker stats` | `read-only` | policy/classifier.js:206 |
| VR-221 | CL-R016 | `du -sh /var` | `read-only` | policy/classifier.js:207 |
| VR-222 | CL-R017 | `echo hi` | `read-only` | policy/classifier.js:208 |
| VR-223 | CL-R018 | `false` | `read-only` | policy/classifier.js:209 |
| VR-224 | CL-R019 | `file -b /bin/ls` / `file -C -m x` / `file -z x` | `read-only` / `safe` rej{file, `-C`} / `safe` rej{file, `-z`} | policy/classifier.js:224 |
| VR-225 | CL-R020 | `find . -name '*.conf' -type f` / `find . -prune` / `find . -exe` | `read-only` / `safe` rej{find, `-prune`} / `safe` rej{find, `-exe`} | policy/classifier.js:245 |
| VR-226 | CL-R021 | `free -m` | `read-only` | policy/classifier.js:252 |
| VR-227 | CL-R022 | `git branch -a` / `git branch -D x` | `read-only` / `safe` rej{git branch, `-D`} | policy/classifier.js:263 |
| VR-228 | CL-R023 | `git diff --cached` / `git diff -U5 HEAD~1` | `read-only` / `read-only` | policy/classifier.js:278 |
| VR-229 | CL-R024 | `git log --oneline -20` / `git log --output=out.txt HEAD` | `read-only` / `safe` rej{git log, `--output=out.txt`} | policy/classifier.js:296 |
| VR-230 | CL-R025 | `git remote -v` / `git remote show origin` | `read-only` / `safe` rej{git remote, `show`} | policy/classifier.js:316 |
| VR-231 | CL-R026 | `git show -3` / `git show --output=x` | `read-only` / `safe` rej{git show, `--output=x`} | policy/classifier.js:327 |
| VR-232 | CL-R027 | `git status -s` | `read-only` | policy/classifier.js:332 |
| VR-233 | CL-R028 | `grep -r foo /etc` | `read-only` | policy/classifier.js:333 |
| VR-234 | CL-R029 | `head -n 5 /etc/hosts` | `read-only` | policy/classifier.js:334 |
| VR-235 | CL-R030 | `host example.com` | `read-only` | policy/classifier.js:335 |
| VR-236 | CL-R031 | `hostname -f` / `hostname web1` | `read-only` / `safe` rej{hostname, `web1`} | policy/classifier.js:345 |
| VR-237 | CL-R032 | `htop` | `read-only` | policy/classifier.js:349 |
| VR-238 | CL-R033 | `id` | `read-only` | policy/classifier.js:350 |
| VR-239 | CL-R034 | `ifconfig -a` / `ifconfig eth0 up` | `read-only` / `safe` rej{ifconfig, `up`} | policy/classifier.js:364 |
| VR-240 | CL-R035 | `iostat` | `read-only` | policy/classifier.js:369 |
| VR-241 | CL-R036 | `ip addr show` / `ip addr add 10.0.0.1/24 dev eth0` / `ip addr` | `read-only` / `safe` rej{ip addr, `add`} / `read-only` | policy/classifier.js:380 |
| VR-242 | CL-R037 | `ip route get 10.0.0.1` / `ip route add x` | `read-only` / `safe` rej{ip route, `add`} | policy/classifier.js:388 |
| VR-243 | CL-R038 | `journalctl -u nginx --since today` / `journalctl --vacuum-time=1s` | `read-only` / `safe` rej{journalctl, `--vacuum-time=1s`} | policy/classifier.js:404 |
| VR-244 | CL-R039 | `ls -la /tmp` | `read-only` | policy/classifier.js:411 |
| VR-245 | CL-R040 | `netstat -tlnp` / `netstat -z` | `read-only` / `safe` rej{netstat, `-z`} | policy/classifier.js:423 |
| VR-246 | CL-R041 | `nslookup example.com` | `read-only` | policy/classifier.js:427 |
| VR-247 | CL-R042 | `ping -c1 example.com` | `read-only` | policy/classifier.js:428 |
| VR-248 | CL-R043 | `printenv HOME` | `read-only` | policy/classifier.js:429 |
| VR-249 | CL-R044 | `printf hello` | `read-only` | policy/classifier.js:430 |
| VR-250 | CL-R045 | `ps aux` | `read-only` | policy/classifier.js:431 |
| VR-251 | CL-R046 | `pwd` | `read-only` | policy/classifier.js:432 |
| VR-252 | CL-R047 | `readlink -f /x` | `read-only` | policy/classifier.js:433 |
| VR-253 | CL-R048 | `realpath .` | `read-only` | policy/classifier.js:434 |
| VR-254 | CL-R049 | `seq 1 3` | `read-only` | policy/classifier.js:435 |
| VR-255 | CL-R050 | `sort -rn /etc/hosts` / `sort /data` | `read-only` / `safe` rej{sort, `/data`} | policy/classifier.js:466 |
| VR-256 | CL-R051 | `ss -tlnp` / `ss -K` | `read-only` / `safe` rej{ss, `-K`} | policy/classifier.js:482 |
| VR-257 | CL-R052 | `stat /etc/hosts` | `read-only` | policy/classifier.js:488 |
| VR-258 | CL-R053 | `systemctl status nginx` / `systemctl status --host x` | `read-only` / `safe` rej{systemctl status, `--host`} | policy/classifier.js:499 |
| VR-259 | CL-R054 | `tail -n 5 /var/log/syslog` | `read-only` | policy/classifier.js:503 |
| VR-260 | CL-R055 | `test -f /etc/hostname` | `read-only` | policy/classifier.js:504 |
| VR-261 | CL-R056 | `top -bn1` | `read-only` | policy/classifier.js:505 |
| VR-262 | CL-R057 | `tr a-z A-Z` | `read-only` | policy/classifier.js:506 |
| VR-263 | CL-R058 | `traceroute example.com` | `read-only` | policy/classifier.js:507 |
| VR-264 | CL-R059 | `true` | `read-only` | policy/classifier.js:508 |
| VR-265 | CL-R060 | `uname -a` | `read-only` | policy/classifier.js:509 |
| VR-266 | CL-R061 | `uniq -c f` / `uniq in out` | `read-only` / `safe` rej{uniq, `out`} | policy/classifier.js:523 |
| VR-267 | CL-R062 | `uptime` | `read-only` | policy/classifier.js:530 |
| VR-268 | CL-R063 | `vmstat 1` | `read-only` | policy/classifier.js:531 |
| VR-269 | CL-R064 | `wc -l /etc/hosts` | `read-only` | policy/classifier.js:532 |
| VR-270 | CL-R065 | `whereis ls` | `read-only` | policy/classifier.js:533 |
| VR-271 | CL-R066 | `which ls` | `read-only` | policy/classifier.js:534 |
| VR-272 | CL-R067 | `who` | `read-only` | policy/classifier.js:535 |
| VR-273 | CL-R068 | `whoami` | `read-only` | policy/classifier.js:536 |

## 2. redactor (`guard/redactor.js`)

2.x 호출은 모두 `redactText(text, { entropyScan: true })`이며 임계값을 넘기지 않아 기본 4.5가 쓰인다.

- `src/adapters/ssh/vendor.mjs:58`: ``const defaultRedact = text => redactText(text, { entropyScan: true });``
- `src/adapters/ssh/vendor.mjs:64-65`(`commandOutcome`): ``const stdout = auditRedact(result.stdout), rawStderr = auditRedact(result.stderr), stderr = presentStderr(rawStderr), parts = [];`` (stdout·stderr 전체에 적용)
- `src/adapters/ssh/vendor.mjs:290`: ``const diagnostics = () => ({ text: defaultRedact(Buffer.concat(stderr).toString('utf8')),`` (원격 helper stderr)
- `src/adapters/desktop/local-process.mjs:51`: ``stderr: { text: redactText(Buffer.concat(captured).toString('utf8'), { entropyScan: true }),`` (로컬 프로세스 stderr)
- `src/adapters/audit/jsonl.mjs:30`: ``if (command) { record.commandHash = hash(command); record.command = redact(command, { entropyScan: true }); }`` (감사 기록의 명령. `redact`는 `bridge.mjs`가 `auditRedact`로 주입)
- 2.x는 `redactRecord`와 `SENSITIVE_FIELDS`를 쓰지 않는다(`grep -rn "redactRecord" src app.mjs bridge.mjs` 결과 0건, 이 조사에서 확인).

### 2.1 패턴과 적용 순서

`redactText(text, opts = {})`(`guard/redactor.js:32-49`)는 `result = text`에서 시작해 아래 순서로 **앞 단계 결과 위에** 차례로 치환한다(``for (const { name, pattern } of REGEX_PATTERNS) {`` `guard/redactor.js:34`). 모든 패턴은 `g` 플래그이고 앵커·단어 경계가 없는 부분 일치다. 입력은 문자열이어야 한다(`null`·`undefined`는 처리 코드가 없다. 2.x는 문자열만 넘긴다).

- **RD-01 `aws-access-key`** ``{ name: 'aws-access-key', pattern: /AKIA[0-9A-Z]{16}/g },`` (`guard/redactor.js:6`)
- **RD-02 `github-token`** ``{ name: 'github-token', pattern: /gh[pousr]_[A-Za-z0-9]{36,}/g },`` (`guard/redactor.js:7`)
- **RD-03 `gitlab-token`** ``{ name: 'gitlab-token', pattern: /glpat-[A-Za-z0-9_-]{20}/g },`` (`guard/redactor.js:8`)
- **RD-04 `jwt`** ``{ name: 'jwt', pattern: /eyJ[A-Za-z0-9_-]+\.eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g },`` (`guard/redactor.js:9`)
- **RD-05 `pem-private-key`** ``{ name: 'pem-private-key', pattern: /-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----[\s\S]{0,65536}?-----END (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----/g },`` (`guard/redactor.js:14`). 본문은 지연 한정(`{0,65536}?`)이고 65536자까지만 허용한다(원문 주석 `:10-13`: 끝 표지 없는 BEGIN이 많을 때 입력 끝까지 재탐색하는 비용 때문). `ENCRYPTED PRIVATE KEY`·`PGP`·`PUBLIC KEY`는 해당하지 않는다.
- **RD-06 `bearer-auth`** ``{ name: 'bearer-auth', pattern: /[Bb]earer\s+[A-Za-z0-9._~+\/-]+=*/g },`` (`guard/redactor.js:15`). 첫 글자만 대소문자 둘 다이고 `BEARER`는 해당하지 않는다. `\s+`는 개행도 포함한다.
- **RD-07 `generic-api-key`** ``{ name: 'generic-api-key', pattern: /(?:api[_-]?key|api[_-]?secret)["'\s]*[:=]\s*["']([A-Za-z0-9_\-]{20,})["']/gi },`` (`guard/redactor.js:16`). `i` 플래그. 캡처 그룹은 치환에 쓰이지 않고 **일치 전체**(키 이름·구분자·따옴표 포함)가 치환된다. 값은 따옴표로 감싸져 있어야 하고 20자 이상.
- **RD-08 치환 문자열** ``return `[REDACTED:${name}:${match.length}]`;`` (`guard/redactor.js:36`). 길이는 일치한 문자열의 JS `length`(UTF-16 코드 단위 수)다.
- **RD-09 적용 순서**: RD-01 → 02 → 03 → 04 → 05 → 06 → 07 → (옵션) 엔트로피 RD-10. 앞 패턴이 치환한 `[REDACTED:…]`는 뒤 패턴과 겹치지 못한다(`[`가 뒤 패턴들의 문자 집합에 없음): `Bearer <JWT>`는 `jwt`가 먼저 치환해 `Bearer [REDACTED:jwt:N]`이 되고 `bearer-auth`는 더 이상 일치하지 않는다.
- **RD-10 엔트로피 검사**(`opts.entropyScan`이 참일 때만, 모든 정규식 치환 뒤):
  - ``if (opts.entropyScan) {`` (`guard/redactor.js:39`)
  - 임계값: ``const threshold = opts.entropyThreshold ?? 4.5;`` (`guard/redactor.js:40`)
  - 후보: ``result = result.replace(/[A-Za-z0-9+/=_-]{20,}/g, (match) => {`` (`guard/redactor.js:41`). 후보 문자 집합은 67자(영숫자 62 + `+ / = _ -`)이고 `.` `:` 공백은 후보를 끊는다. `/`가 들어 있어 긴 경로 조각도 후보가 된다.
  - 판정: ``if (shannonEntropy(match) > threshold) {`` (`guard/redactor.js:42`) (엄격히 큼)
  - 치환: ``return `[REDACTED:entropy:${match.length}]`;`` (`guard/redactor.js:43`)
- **RD-11 샤넌 엔트로피**(`guard/redactor.js:18-31`): 길이 20 미만이면 0을 돌려준다(``if (!str || str.length < 20)`` `guard/redactor.js:19`). 아니면 글자(코드 포인트, `for (const ch of str)`)별 빈도 `count`로 `p = count / str.length`, `H = -Σ p·log2(p)`를 **Map 삽입 순서(처음 나온 순서)대로** 더한다(``const p = count / str.length;`` `guard/redactor.js:27`, ``entropy -= p * Math.log2(p);`` `guard/redactor.js:28`). 후보가 항상 20자 이상이라 20 미만 분기는 `redactText`에서 도달하지 않는다. 한 가지 수학적 귀결: 서로 다른 글자가 k개면 `H ≤ log2(k)`이므로 임계값 4.5를 넘으려면 서로 다른 글자가 **23개 이상**(`log2(22)=4.459`, `log2(23)=4.524`)이어야 해서 길이 20~22인 후보는 절대 치환되지 않는다.
- **RD-12 예외·건너뛰기 규칙은 없다**: 해시(16진 64자는 균등 분포라 `H=4.0`이라 걸리지 않음)나 UUID(`H≤log2(17)=4.09`)가 걸리지 않는 것은 별도 예외가 아니라 임계값 때문이다. 이미 `[REDACTED:…]`인지 보는 검사도 없다.
- **RD-13 (2.x 미사용) `redactRecord`**(`guard/redactor.js:50-67`): 객체의 각 키가 ``const SENSITIVE_FIELDS = new Set([`` (`guard/redactor.js:1`) ``'password', 'privateKey', 'sudoPassword', 'suPassword', 'passphrase',`` (`guard/redactor.js:2`) ``'token', 'secret', 'apiKey', 'api_key', 'authorization',`` (`guard/redactor.js:3`)에 있거나 정규식 ``/(?<![^a-z])(token|secret|key|password)$/i`` (`guard/redactor.js:53`)에 맞으면 값 전체를 `'[REDACTED]'`로 바꾼다. 문자열 값은 `redactText`, 중첩 객체(배열 제외)는 재귀, 그 밖은 그대로. 정규식은 「키 이름 끝의 `token|secret|key|password` 바로 앞이 영문자이거나 문자열 시작」일 때만 맞는다(`mykey` 맞음, `my_key`·`api-key` 안 맞음). 이식 필요 여부는 3.0에서 정한다.

### 2.2 3.0 사례 초안 (redactor)

대상은 `Redactor.redact(text)`(= `redactText(text, {entropyScan:true})`)이며, 「엔트로피 끔」으로 적은 사례는 `entropyScan=false` 변형이다. 길이 값은 모두 손으로 센 값이다.

| 사례 ID | 대상 | 입력 | 기대 결과 | 근거 위치 |
|---|---|---|---|---|
| VR-274 | RD-01 | `AKIAIOSFODNN7EXAMPLE` | `[REDACTED:aws-access-key:20]` | guard/redactor.js:6 |
| VR-275 | RD-01 | `AKIAIOSFODNN7EXAMPLEX` | `[REDACTED:aws-access-key:20]X` (경계 없음, 앞 20자만) | guard/redactor.js:6 |
| VR-276 | RD-01 | `AKIAIOSFODNN7EXAMPL`(19자), `akiaiosfodnn7example` | 변경 없음 | guard/redactor.js:6 |
| VR-277 | RD-02 | `ghp_0123456789abcdefghijklmnopqrstuvwxyz` (`ghp_` + 36자) | `[REDACTED:github-token:40]` | guard/redactor.js:7 |
| VR-278 | RD-02 | `ghp_0123456789abcdefghijklmnopqrstuvwxy` (35자, 엔트로피 끔) | 변경 없음 (엔트로피를 켜면 39자 후보가 `[REDACTED:entropy:39]`가 됨) | guard/redactor.js:7 |
| VR-279 | RD-02 | `gho_`, `ghu_`, `ghs_`, `ghr_` + 같은 36자 (각각) | 각각 `[REDACTED:github-token:40]` | guard/redactor.js:7 |
| VR-280 | RD-02 | `ghx_0123456789abcdefghijklmnopqrstuvwxyz` (엔트로피 끔) | 변경 없음 | guard/redactor.js:7 |
| VR-281 | RD-03 | `glpat-abcdefghij0123456789` | `[REDACTED:gitlab-token:26]` | guard/redactor.js:8 |
| VR-282 | RD-03 | `glpat-abcdefghij0123456789Z` | `[REDACTED:gitlab-token:26]Z` | guard/redactor.js:8 |
| VR-283 | RD-03 | `glpat-abcdefghij012345678` (19자, 엔트로피 끔) | 변경 없음 | guard/redactor.js:8 |
| VR-284 | RD-04 | `eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.abc_DEF-123` | `[REDACTED:jwt:48]` | guard/redactor.js:9 |
| VR-285 | RD-04 | `eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0` (서명 없음, 엔트로피 끔) | 변경 없음 | guard/redactor.js:9 |
| VR-286 | RD-05 | `-----BEGIN PRIVATE KEY-----<LF>abc<LF>-----END PRIVATE KEY-----` | `[REDACTED:pem-private-key:57]` | guard/redactor.js:14 |
| VR-287 | RD-05 | `-----BEGIN RSA PRIVATE KEY-----<LF>MIIE<LF>-----END RSA PRIVATE KEY-----` | `[REDACTED:pem-private-key:66]` | guard/redactor.js:14 |
| VR-288 | RD-05 | `-----BEGIN PRIVATE KEY-----<LF>abc` (끝 표지 없음, 엔트로피 켬·끔 모두) | 변경 없음 | guard/redactor.js:14 |
| VR-289 | RD-05 | `-----BEGIN ENCRYPTED PRIVATE KEY-----x-----END ENCRYPTED PRIVATE KEY-----` (엔트로피 켬·끔 모두) | 변경 없음 | guard/redactor.js:14 |
| VR-290 | RD-05 | BEGIN/END 사이 본문이 `A` 65536자 | `[REDACTED:pem-private-key:65588]` (27 + 65536 + 25) | guard/redactor.js:14 |
| VR-291 | RD-05 | BEGIN/END 사이 본문이 `A` 65537자 (엔트로피 켬·끔 모두) | 변경 없음 | guard/redactor.js:14 |
| VR-292 | RD-05 | `-----BEGIN PRIVATE KEY-----😀-----END PRIVATE KEY-----` | `[REDACTED:pem-private-key:54]` (이모지는 UTF-16 두 단위) | guard/redactor.js:36 |
| VR-293 | RD-06 | `Authorization: Bearer abc.def-ghi==` | `Authorization: [REDACTED:bearer-auth:20]` | guard/redactor.js:15 |
| VR-294 | RD-06 | `bearer abc` | `[REDACTED:bearer-auth:10]` | guard/redactor.js:15 |
| VR-295 | RD-06 | `BEARER abc` | 변경 없음 | guard/redactor.js:15 |
| VR-296 | RD-06 | `Bearer token expired` | `[REDACTED:bearer-auth:12] expired` (오탐도 vendor 행동) | guard/redactor.js:15 |
| VR-297 | RD-06 | `Bearer<LF>abc` | `[REDACTED:bearer-auth:10]` (`\s+`는 개행 포함) | guard/redactor.js:15 |
| VR-298 | RD-07 | `api_key="abcdefghij1234567890"` | `[REDACTED:generic-api-key:30]` | guard/redactor.js:16 |
| VR-299 | RD-07 | `{"apiKey": "abcdefghij1234567890"}` | `{"[REDACTED:generic-api-key:31]}` (`i` 플래그, 일치 전체 치환, 앞 `"`는 남음) | guard/redactor.js:16 |
| VR-300 | RD-07 | `API-SECRET: 'abcdefghij1234567890'` | `[REDACTED:generic-api-key:34]` | guard/redactor.js:16 |
| VR-301 | RD-07 | `api_key="abcdefghij123456789"` (19자) | 변경 없음 | guard/redactor.js:16 |
| VR-302 | RD-07 | `api_key=abcdefghij1234567890` (따옴표 없음, 엔트로피 끔) | 변경 없음 | guard/redactor.js:16 |
| VR-303 | RD-08 | (VR-292와 같은 입력) | 길이는 UTF-16 코드 단위 수(`String.length`) | guard/redactor.js:36 |
| VR-304 | RD-09 | `Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.abc_DEF-123` | `Bearer [REDACTED:jwt:48]` | guard/redactor.js:34 |
| VR-305 | RD-09 | `api_key="AKIAIOSFODNN7EXAMPLE"` | `api_key="[REDACTED:aws-access-key:20]"` (aws가 먼저, generic은 더 이상 안 맞음) | guard/redactor.js:34 |
| VR-306 | RD-10 | `abcdefghijklmnopqrstuvwxyz` (서로 다른 26자, 엔트로피 켬) | `[REDACTED:entropy:26]` (`H=log2(26)≈4.700`) | guard/redactor.js:42 |
| VR-307 | RD-10 | `abcdefghijklmnopqrstuvwxyz` (엔트로피 끔) | 변경 없음 | guard/redactor.js:39 |
| VR-308 | RD-10 | `abcdefghijklmnopqrstuvw` (서로 다른 23자) | `[REDACTED:entropy:23]` (`H=log2(23)≈4.524`) | guard/redactor.js:42 |
| VR-309 | RD-10 | `abcdefghijklmnopqrstuv` (서로 다른 22자) | 변경 없음 (`H≈4.459`) | guard/redactor.js:42 |
| VR-310 | RD-10 | `abcdefghijklmnopqrstuv`, 임계값 4.4로 호출(vendor `entropyThreshold` 옵션) | `[REDACTED:entropy:22]` (2.x는 임계값을 넘기지 않으므로 선택 사례) | guard/redactor.js:40 |
| VR-311 | RD-10 | `abcdefghijklmnopqrstuvwxyz.abcdefghijklmnopqrstuvwxyz` | `[REDACTED:entropy:26].[REDACTED:entropy:26]` (`.`가 후보를 끊음) | guard/redactor.js:41 |
| VR-312 | RD-10 | `/abcdefghijklmnopqrstuvwxyz/` (28자, `/` 두 개 포함) | `[REDACTED:entropy:28]` (`/`도 후보 문자, `H≈4.736`) | guard/redactor.js:41 |
| VR-313 | RD-10 | `aaaaaaaaaaaaaaaaaaaaaaaa` (24자) | 변경 없음 (`H=0`) | guard/redactor.js:42 |
| VR-314 | RD-11 | `0123456789abcdef` × 4 (64자 16진) | 변경 없음 (균등 16종, `H=4.0`) | guard/redactor.js:27 |
| VR-315 | RD-11 | 엔트로피 단위 시험: `ababababababababab`(20자) | `H = 1.0` | guard/redactor.js:28 |
| VR-316 | RD-11 | 엔트로피 단위 시험: `abcdefghijklmnopqrs`(19자, 서로 다른 19) | `0` (20자 미만) | guard/redactor.js:19 |
| VR-317 | RD-12 | `550e8400-e29b-41d4-a716-446655440000` (UUID 36자) | 변경 없음 (서로 다른 글자 ≤ 17이라 `H ≤ 4.09`) | guard/redactor.js:42 |
| VR-318 | RD-13 | (선택, 2.x 미사용) `{"mykey":"v","my_key":"v","password":"x","nested":{"apiKey":"y","list":[1]}}` | `mykey`·`password`·`nested.apiKey`는 `"[REDACTED]"`, `my_key`는 `"v"` 유지, `list`는 `[1]` 유지 | guard/redactor.js:53 |

## 3. 프로필 TOML 로더 (`config/loader.js`, `config/schema.js`)

2.x 호출: ``const config = await loadConfig(settings.BRIDGE_CONFIG_PATH);`` (`src/adapters/ssh/vendor.mjs:178`). 옵션 인자는 넘기지 않는다(`opts = {}`). 저장소의 예시 `config/config.example.toml`이 쓰는 키는 모두 아래 스키마에 있다(`defaultProfile`, `commandTimeoutMs`, `transferMaxBytes`, `transferTimeoutMs`, 프로필의 `name host port user auth keyRef trustedHostKey group role readOnly announceAgent`; 이 조사에서 키 이름만 추출해 대조했고 값은 보지 않았다).

### 3.1 파일 위치·읽기·검증 순서

- **PF-01 읽기 순서**: 경로 결정 → 읽기 → 권한 검사 → TOML 파싱 → 스키마 검증 → 정규화(`loader.js:82-123`).
  - ``raw = await readFile(configPath, 'utf8');`` (`config/loader.js:86`)
  - ``await checkPermissions(configPath, opts);`` (`config/loader.js:104`)
  - ``parsed = parseTOML(raw);`` (`config/loader.js:107`)
  - ``const result = configSchema.safeParse(parsed);`` (`config/loader.js:112`)
- **PF-02 경로**: 인자가 있으면 그대로 쓴다(``if (customPath)`` `config/loader.js:9`). **`~`·환경 변수 확장은 하지 않는다.** 인자가 없을 때만 기본 경로를 쓴다(2.x는 `BRIDGE_CONFIG_PATH`가 비어 있을 때만 해당):
  - macOS: ``return join(home, 'Library', 'Application Support', 'ssh-mcp', 'config.toml');`` (`config/loader.js:14`)
  - Windows: ``return join(process.env.APPDATA || join(home, 'AppData', 'Roaming'), 'ssh-mcp', 'config.toml');`` (`config/loader.js:17`)
  - 그 밖: ``const xdgConfig = process.env.XDG_CONFIG_HOME || join(home, '.config');`` (`config/loader.js:19`) 다음 ``return join(xdgConfig, 'ssh-mcp', 'config.toml');`` (`config/loader.js:20`)
- **PF-03 읽기 실패**: ``throw new ConfigNotFoundError(configPath);`` (`config/loader.js:93`, 파일 없음 `ENOENT`일 때). 그 밖의 읽기 오류(디렉터리·권한)는 `OperatorError("Config file <path> could not be read: <원인>")`에 원인 `.code`를 보존해 던진다(`config/loader.js:102`).
- **PF-04 권한 검사 (POSIX)**(`config/loader.js:49-81`): 파일이 없으면(`stat`이 `ENOENT`) 조용히 통과(`:65-66`). 파일 모드의 ``if (fileMode & 0o077) {`` (`config/loader.js:67`)이면 거절(그룹·기타에 어떤 권한이라도 있으면). 메시지는 ``Config file ${filePath} is group/world accessible (mode ${fileMode.toString(8)}). `` (`config/loader.js:68`) + ``Required: 0600. Run: chmod 600 ${filePath}`` (`config/loader.js:69`). 파일 검사를 먼저 하고 디렉터리 검사는 그 뒤다(``if (dirMode !== null && dirMode & 0o077) {`` `config/loader.js:72`): ``Config directory ${dir} is group/world accessible (mode ${dirMode.toString(8)}). `` (`config/loader.js:73`) + ``Required: 0700. Run: chmod 700 ${dir}\n`` (`config/loader.js:74`) + 컨테이너 안내 두 줄(`:78-79`).
- **PF-05 권한 검사 (Windows)**: `assertPrivateOnWindows`(`config/windows-acl.js:472-497`)가 파일과 그 디렉터리를 각각 검사한다. 외부 프로그램 `icacls.exe`를 `C:\Windows\System32`의 절대 경로로 호출해 DACL(SDDL)을 읽어 판정한다(``const CANONICAL_SYSTEM32 = 'C:\\Windows\\System32';`` `config/windows-acl.js:12`, 호출 ``export async function inspectAcl(path, signal) {`` `config/windows-acl.js:210`). 기본 자세는 `waived`(`:453-463`)가 정한다: 다른 계정이 **쓸 수 있는** 권한(변경)이면 거절하고, **읽기만** 허용하면 경고만 한다. ACL을 알 수 없으면 거절하되 `icacls` 없음(`tool-missing`)과 시간 초과(`timed-out`)는 경고만 한다. NULL DACL은 읽기 전용으로 치지 않는다. 옵션 `allowUnchecked`·`enforce`는 2.x가 넘기지 않는다. 이 검사의 판정표(SDDL 해석 `config/sddl.js`, 위험 계정 목록)는 이 조사에서 읽지 않았다(미확인).
  - ``function waived(finding, opts) {`` (`config/windows-acl.js:453`)
  - ``return finding.status === 'broad' && !finding.grants.some((g) => g.writes);`` (`config/windows-acl.js:462`)
- **PF-06 TOML 파싱**: `smol-toml`(`package.json`의 의존성 `^1.7.1`)로 파싱한다. 실패하면 ``throw new OperatorError(`Failed to parse TOML config at ${configPath}: ${err.message}`);`` (`config/loader.js:110`). 파서 메시지 본문은 `smol-toml` 소스에 있으며 조사하지 않았다(미확인).
- **PF-07 스키마 오류 출력**: 이슈마다 ``.map((i) => `  ${i.path.length ? i.path.join('.') : '(root)'}: ${i.message}`)`` (`config/loader.js:118`), 전체는 ``throw new OperatorError(`Config validation error:\n${issues}`);`` (`config/loader.js:120`). 경로는 `.`로 이은 키(예: `profiles.0.port`), 루트 수준 이슈는 `(root)`. 각 이슈의 `message` 문구는 zod 4(`^4.4.3`)가 만들며 이 tgz에 없다(미확인). 3.0에서는 「`Config validation error:`로 시작하고 경로를 포함한다」까지만 계약으로 삼고 나머지 문구는 3.0이 정한다.

### 3.2 스키마: 알 수 없는 키·필수·타입·기본값

- **PF-08 알 수 없는 키는 거절한다.** 루트·`[defaults]`·프로필·`[policy]` 네 곳 모두 `.strict()`다(``}).strict();`` `config/schema.js:137`, ``}).strict();`` `config/schema.js:187`, ``}).strict();`` `config/schema.js:209`, ``}).strict();`` `config/schema.js:217`). 철자 오류가 조용히 무시되는 것을 막기 위함(원문 주석 `:210-212`). 허용 루트 키는 ``defaults: defaultsSchema.prefault({}),`` (`config/schema.js:214`), ``profiles: z.array(profileSchema).min(1),`` (`config/schema.js:215`), ``policy: policySchema.optional(),`` (`config/schema.js:216`)뿐이다.
- **PF-09 필수 여부**: `defaults` 구역은 생략 가능(`prefault({})`로 전부 기본값). `profiles`는 필수이고 **1개 이상**. 프로필의 필수 키는 `name`, `host`, `user`뿐이다(기본값이 없고 `optional()`도 아님). `policy`는 선택.
- **PF-10 `[defaults]` 키**(모두 선택, 기본값이 있으면 생략 시 적용):

  | 키 | 원문 | 줄 |
  |---|---|---|
  | `defaultProfile` | ``defaultProfile: z.string().optional(),`` | `config/schema.js:87` |
  | `sessionMaxPerConnection` | ``sessionMaxPerConnection: z.number().int().positive().default(5),`` | `config/schema.js:88` |
  | `sessionIdleTimeoutMs` | ``sessionIdleTimeoutMs: z.number().int().positive().default(600_000),`` | `config/schema.js:89` |
  | `sessionBackgroundMaxMs` | ``sessionBackgroundMaxMs: z.number().int().positive().default(3_600_000),`` | `config/schema.js:90` |
  | `commandTimeoutMs` | ``commandTimeoutMs: z.number().int().positive().default(60_000),`` | `config/schema.js:91` |
  | `commandMaxChars` | ``commandMaxChars: z.number().int().nonnegative().default(5000),`` (0 = 무제한) | `config/schema.js:95` |
  | `commandMaxOutputBytes` | ``commandMaxOutputBytes: z.number().int().positive().default(1_048_576),`` | `config/schema.js:96` |
  | `connectionIdleReapMs` | ``connectionIdleReapMs: z.number().int().positive().default(900_000),`` | `config/schema.js:97` |
  | `commandQuotaPerDay` | ``commandQuotaPerDay: z.number().int().nonnegative().default(0),`` (0 = 무제한) | `config/schema.js:99` |
  | `approvalGrantTtlMs` | ``approvalGrantTtlMs: z.number().int().nonnegative().default(0),`` | `config/schema.js:102` |
  | `approvalMode` | ``approvalMode: approvalModeSchema.default('ask-destructive'),`` | `config/schema.js:103` |
  | `transferRoot` | ``transferRoot: z.string().optional(),`` (기본값 없음, 프로필 키 아님) | `config/schema.js:114` |
  | `transferMaxBytes` | ``transferMaxBytes: z.number().int().positive().max(Number.MAX_SAFE_INTEGER).default(268_435_456),`` | `config/schema.js:124` |
  | `transferTimeoutMs` | ``transferTimeoutMs: z.number().int().positive().max(2_147_483_647).default(300_000),`` | `config/schema.js:136` |

- **PF-11 `[[profiles]]` 키**:

  | 키 | 원문 | 줄 |
  |---|---|---|
  | `name` (필수) | ``name: z.string().min(1),`` | `config/schema.js:139` |
  | `host` (필수) | ``host: z.string().min(1),`` | `config/schema.js:140` |
  | `port` | ``port: z.number().int().min(1).max(65535).default(22),`` | `config/schema.js:141` |
  | `user` (필수) | ``user: z.string().min(1),`` | `config/schema.js:142` |
  | `auth` | ``auth: authMethodSchema.default('agent'),`` (허용값 `agent` `key` `password` `keychain`, `config/schema.js:2`) | `config/schema.js:143` |
  | `keyRef` | ``keyRef: z.string().optional(),`` | `config/schema.js:144` |
  | `keychainEntry` | ``keychainEntry: z.string().optional(),`` | `config/schema.js:145` |
  | `via` | ``via: z.string().optional(),`` (ProxyJump 프로필 이름) | `config/schema.js:146` |
  | `group` | ``group: z.string().optional(),`` | `config/schema.js:149` |
  | `workdir` | ``workdir: z.string().optional(),`` | `config/schema.js:150` |
  | `trustedHostKey` | ``trustedHostKey: z.string().trim().min(1, 'trustedHostKey cannot be empty').optional(),`` | `config/schema.js:159` |
  | `tty` | ``tty: z.boolean().default(false),`` | `config/schema.js:160` |
  | `role` | ``role: z.string().default('operator'),`` | `config/schema.js:161` |
  | `readOnly` | ``readOnly: z.boolean().default(false),`` | `config/schema.js:162` |
  | `cert` | ``cert: z.boolean().default(false),`` | `config/schema.js:163` |
  | `announceAgent` | ``announceAgent: z.boolean().default(true),`` | `config/schema.js:169` |
  | `timeout` | ``timeout: z.number().int().positive().optional(),`` | `config/schema.js:173` |
  | `maxChars` | ``maxChars: z.number().int().nonnegative().optional(),`` | `config/schema.js:175` |
  | `maxOutputBytes` | ``maxOutputBytes: z.number().int().positive().optional(),`` | `config/schema.js:176` |
  | `approvalPolicy` | ``approvalPolicy: approvalModeSchema.optional(),`` (허용값 `auto` `ask-destructive` `ask-all` `deny`, `config/schema.js:3`) | `config/schema.js:177` |
  | `sessionMaxPerConnection` | ``sessionMaxPerConnection: z.number().int().positive().optional(),`` | `config/schema.js:178` |
  | `sessionIdleTimeoutMs` | ``sessionIdleTimeoutMs: z.number().int().positive().optional(),`` | `config/schema.js:179` |
  | `sessionBackgroundMaxMs` | ``sessionBackgroundMaxMs: z.number().int().positive().optional(),`` | `config/schema.js:180` |
  | `commandQuotaPerDay` | ``commandQuotaPerDay: z.number().int().nonnegative().optional(),`` | `config/schema.js:181` |
  | `transferMaxBytes` | ``transferMaxBytes: z.number().int().positive().max(Number.MAX_SAFE_INTEGER).optional(),`` | `config/schema.js:185` |
  | `transferTimeoutMs` | ``transferTimeoutMs: z.number().int().positive().max(2_147_483_647).optional(),`` | `config/schema.js:186` |

  - 숫자 키는 정수만 허용한다(`z.number().int()`). TOML 실수 `22.0`은 JS에서 정수 22가 되어 통과한다(추정: `smol-toml`이 실수를 `Number`로 돌려주기 때문, 미실행).
  - 불리언 키는 TOML 불리언만 허용한다(문자열 `"true"` 거절).
  - `trustedHostKey`는 **앞뒤 공백을 지운 값**이 저장되고, 지운 뒤 빈 문자열이면 `trustedHostKey cannot be empty`로 거절된다(비교가 정확 일치라 개행이 붙은 값이 조용히 항상 불일치하던 문제를 막으려는 규칙, 원문 주석 `:151-158`).
  - `role`·`group`은 자유 문자열이며 값 검증이 없다. `name` 중복, `via`가 존재하는 프로필 이름인지, `via` 순환은 **로드 시 검사하지 않는다**(`schema.js`·`loader.js`에 해당 검사 코드가 없음을 확인; 순환 시 동작은 미확인).
- **PF-12 `[policy]`**(2.x 설정 예시에는 없음, 스키마는 허용): ``roleBindings: z.unknown()`` (`config/schema.js:204`)에 예약어 검사 ``.superRefine(checkReservedKeys)`` (`config/schema.js:205`)와 형태 검증 ``.pipe(z.record(bindingKeySchema, z.record(bindingKeySchema, z.array(commandClassSchema))))`` (`config/schema.js:206`), 그리고 ``denylist: z.array(z.string()).optional(),`` (`config/schema.js:208`). 역할·등급 이름은 `__proto__`·`constructor`·`prototype`이거나 빈 문자열이면 거절(``const RESERVED_BINDING_KEYS = ['__proto__', 'constructor', 'prototype'];`` `config/schema.js:13`; 메시지 ``Reserved name (${RESERVED_BINDING_KEYS.join(', ')}). Rename the role or tier.`` `config/schema.js:14`, 빈 이름 ``'Role and tier names cannot be empty.'`` `config/schema.js:77`). 2.x는 이 정책 구역을 쓰지 않으므로(`classifyCommand`만 쓰고 `policy/engine.js`는 안 씀) 3.0 `SshProfile` 로더가 `[policy]`를 받아들일지(무시) 거절할지는 3.0 설계 판정이다.

### 3.3 `defaults`와 프로필의 병합 (`normalizeConfig`, `config/loader.js:147-179`)

프로필마다 아래 열 개를 「프로필 값이 있으면 그 값, 없으면 `[defaults]` 값」으로 채운다(`??` 이므로 값이 0이어도 프로필 값이 이긴다). 나머지 `[defaults]` 키(`defaultProfile`, `connectionIdleReapMs`, `approvalGrantTtlMs`, `transferRoot`)는 프로필로 내려가지 않고 `config.defaults`에 그대로 있다.

- **PF-13** ``timeout: p.timeout ?? defaults.commandTimeoutMs,`` (`config/loader.js:164`)
- **PF-14** ``maxChars: uncapZero(p.maxChars ?? defaults.commandMaxChars),`` (`config/loader.js:165`)
- **PF-15** ``maxOutputBytes: p.maxOutputBytes ?? defaults.commandMaxOutputBytes,`` (`config/loader.js:166`)
- **PF-16** ``approvalPolicy: p.approvalPolicy ?? defaults.approvalMode,`` (`config/loader.js:167`)
- **PF-17** ``sessionMaxPerConnection: p.sessionMaxPerConnection ?? defaults.sessionMaxPerConnection,`` (`config/loader.js:168`)
- **PF-18** ``sessionIdleTimeoutMs: p.sessionIdleTimeoutMs ?? defaults.sessionIdleTimeoutMs,`` (`config/loader.js:169`)
- **PF-19** ``sessionBackgroundMaxMs: p.sessionBackgroundMaxMs ?? defaults.sessionBackgroundMaxMs,`` (`config/loader.js:170`)
- **PF-20** ``commandQuotaPerDay: p.commandQuotaPerDay ?? defaults.commandQuotaPerDay,`` (`config/loader.js:171`)
- **PF-21** ``transferMaxBytes: p.transferMaxBytes ?? defaults.transferMaxBytes,`` (`config/loader.js:172`)
- **PF-22** ``transferTimeoutMs: p.transferTimeoutMs ?? defaults.transferTimeoutMs,`` (`config/loader.js:173`)
- **PF-23** `0`은 「무제한」으로 쓰이는 `commandMaxChars`/`maxChars`만 `Number.MAX_SAFE_INTEGER`(9007199254740991)로 바꾼다(`defaults`와 프로필 양쪽, ``return maxChars === 0 ? Number.MAX_SAFE_INTEGER : maxChars;`` `config/loader.js:138`). `commandQuotaPerDay`의 0은 그대로 0이다(소비하는 쪽이 0을 무제한으로 해석).
- **PF-24** 프로필 객체는 `...p`로 스키마가 채운 모든 필드(기본값 적용 후)를 그대로 가지며 위 열 개만 덮어쓴다(``const profiles = raw.profiles.map((p) => ({`` `config/loader.js:162`, ``...p,`` `config/loader.js:163`). 반환은 ``return { defaults, profiles, policy: raw.policy };`` (`config/loader.js:178`).

### 3.4 프로필 선택 (`getProfile`, `config/loader.js:180-207`)

- **PF-25** 이름 우선순위: ``const targetName = name || config.defaults.defaultProfile;`` (`config/loader.js:181`). 빈 문자열 이름은 「지정 안 함」과 같다.
- **PF-26** 이름도 기본도 없고 프로필이 둘 이상이면 오류: ``throw new OperatorError(`No profile selected and no default configured, but ${config.profiles.length} profiles exist: ${names}. ` +`` (`config/loader.js:190`) 다음 줄 ``` `Pass a "profile" argument, or set defaults.defaultProfile in the config.`); ``` (`config/loader.js:191`). `names`는 프로필 이름을 `, `로 이은 것.
- **PF-27** 이름도 기본도 없고 프로필이 하나면 그 프로필(``return config.profiles[0];`` `config/loader.js:201`).
- **PF-28** 이름이 있는데 없으면 ``throw new OperatorError(`Profile "${targetName}" not found`);`` (`config/loader.js:205`) (``config.profiles.find((p) => p.name === targetName)`` `config/loader.js:203`, 이름 중복이면 첫 항목).

### 3.5 2.x가 실제로 쓰는 프로필 필드와 안 쓰는 필드

- 쓰는 필드: `host` `port` `user` `auth`(연결·자격 증명), `keyRef` `cert` `via` `trustedHostKey`, `tty`(PTY, `src/adapters/ssh/vendor.mjs:94`), `workdir`(``exactCommand = connection.applyWorkdir(command); channelOptions = connection.channelEnv();`` `src/adapters/ssh/vendor.mjs:93`), `announceAgent`(같은 줄 `channelEnv()`), `maxOutputBytes`(``{ maxOutputBytes: connection.profile.maxOutputBytes ?? DEFAULT_OUTPUT_BYTES, ...options }`` `src/adapters/ssh/vendor.mjs:103`), `transferTimeoutMs`(``const idleTimeoutMs = binding.connection.profile.transferTimeoutMs;`` `src/adapters/ssh/vendor.mjs:414`), `readOnly`·`tty`(원본 소스 실행 거절 조건, `src/adapters/ssh/vendor.mjs:128`).
- 명령 시간 한도는 프로필 `timeout`이 아니라 `BRIDGE_COMMAND_TIMEOUT_MS`(기본 120000)다(``const timeoutMs = Number(settings.BRIDGE_COMMAND_TIMEOUT_MS ?? DEFAULT_RUN_TIMEOUT_MS);`` `src/adapters/ssh/vendor.mjs:181`). 전송 한도 `transferMaxBytes`도 프로필 값이 아니라 `BRIDGE_TRANSFER_MAX_BYTES`의 저장소 한도(`this.store.maxBytes`, `src/adapters/ssh/transfers.mjs:151`)를 쓴다. 따라서 이 두 프로필 키는 2.x에서 효과가 없었다(`grep "profile\.timeout\|profile\.transferMaxBytes" src app.mjs` 결과 0건으로 확인).
- 2.x 자체 경계 규칙: Windows 대상은 프로필 `workdir`·`tty`를 거절한다(``if (entry.platform === 'windows' && (reader.workdir || writer.workdir)) throw Error('Windows targets cannot use a POSIX profile workdir');`` `src/adapters/config/targets.mjs:67`, ``if (entry.platform === 'windows' && (reader.tty === true || writer.tty === true)) throw Error('Windows targets require non-TTY profiles');`` `src/adapters/config/targets.mjs:68`).

### 3.6 3.0 사례 초안 (프로필 로더)

대상은 `TomlProfileLoader.load(path)` / `SshProfiles.select(name)`(이름은 구현 담당이 정함)이다. 파일 권한 사례(VR-325~327)는 POSIX 권한을 줄 수 있는 임시 디렉터리에서만 실행한다. 모든 사례는 「미검증: 실행 안 함」이다.

| 사례 ID | 대상 | 입력 | 기대 결과 | 근거 위치 |
|---|---|---|---|---|
| VR-319 | PF-01 | 읽기 → 권한 → 파싱 → 검증 → 정규화 순서(권한이 나쁜 파일에 TOML 문법 오류도 있을 때) | 권한 오류가 먼저 보고됨 | config/loader.js:104 |
| VR-320 | PF-02 | 경로 인자 `~/c.toml` | 확장 없이 그대로 열려 해당 파일이 없으면 `ConfigNotFoundError` | config/loader.js:9 |
| VR-321 | PF-02 | 경로 인자 없음, Linux, `XDG_CONFIG_HOME=/x` | `/x/ssh-mcp/config.toml` | config/loader.js:19 |
| VR-322 | PF-02 | 경로 인자 없음, Windows, `APPDATA=C:\A` | `C:\A\ssh-mcp\config.toml` | config/loader.js:17 |
| VR-323 | PF-03 | 존재하지 않는 경로 | `ConfigNotFoundError`(코드 `ENOENT`, 메시지에 경로) | config/loader.js:93 |
| VR-324 | PF-03 | 경로가 디렉터리 | 읽기 오류 `Config file <path> could not be read: …`, 원인 코드 보존(`EISDIR`) | config/loader.js:102 |
| VR-325 | PF-04 | 파일 0644 | 거절, 메시지가 `is group/world accessible (mode 644)`·`Required: 0600`를 포함 | config/loader.js:68 |
| VR-326 | PF-04 | 파일 0600, 디렉터리 0755 | 거절, `Config directory …  (mode 755)`·`Required: 0700` | config/loader.js:73 |
| VR-327 | PF-04 | 파일 0600, 디렉터리 0700 | 통과 | config/loader.js:67 |
| VR-328 | PF-05 | (Windows) 다른 계정에 쓰기 권한이 있는 ACL | 거절 | config/windows-acl.js:462 |
| VR-329 | PF-05 | (Windows) 다른 계정에 읽기만 허용 | 로드 성공 + 경고 | config/windows-acl.js:462 |
| VR-330 | PF-06 | 문법 오류 TOML | `Failed to parse TOML config at <path>: …` | config/loader.js:110 |
| VR-331 | PF-07 | `[defaults]`에 알 수 없는 키 `foo = 1` | `Config validation error:`로 시작하는 실패(경로 `defaults`, 문구 미확인) | config/loader.js:120 |
| VR-332 | PF-08 | 루트에 알 수 없는 표 `[extra]` | 실패(경로 `(root)`) | config/schema.js:217 |
| VR-333 | PF-08 | 프로필에 알 수 없는 키 `nme = "x"` | 실패(경로 `profiles.0`) | config/schema.js:187 |
| VR-334 | PF-08 | `[policy]`에 알 수 없는 키 | 실패 | config/schema.js:209 |
| VR-335 | PF-09 | `[[profiles]]`가 없음 또는 `profiles = []` | 실패 | config/schema.js:215 |
| VR-336 | PF-09 | `[defaults]` 구역 없이 프로필 하나(`name host user`만) | 로드 성공, 모든 기본값 적용 | config/schema.js:214 |
| VR-337 | PF-09 | 프로필에 `name` 없음 / `host` 없음 / `user` 없음 (각각) | 실패 | config/schema.js:139 |
| VR-338 | PF-10 | 빈 `[defaults]` | `sessionMaxPerConnection=5`, `sessionIdleTimeoutMs=600000`, `sessionBackgroundMaxMs=3600000`, `commandTimeoutMs=60000`, `commandMaxChars=5000`, `commandMaxOutputBytes=1048576`, `connectionIdleReapMs=900000`, `commandQuotaPerDay=0`, `approvalGrantTtlMs=0`, `approvalMode="ask-destructive"`, `transferMaxBytes=268435456`, `transferTimeoutMs=300000`, `transferRoot`·`defaultProfile`은 없음 | config/schema.js:88 |
| VR-339 | PF-10 | `commandMaxChars = 0` | 프로필 `maxChars`와 `defaults.commandMaxChars` 모두 9007199254740991 | config/loader.js:138 |
| VR-340 | PF-10 | `sessionMaxPerConnection = 0`, `commandTimeoutMs = -1`, `commandMaxChars = -1`, `transferTimeoutMs = 2147483648`, `commandMaxOutputBytes = 0` (각각) | 실패 | config/schema.js:96 |
| VR-341 | PF-10 | `transferMaxBytes = 9007199254740991` | 통과(상한 값). 이보다 큰 정수의 동작은 미확인(TOML 파서 의존) | config/schema.js:124 |
| VR-342 | PF-10 | `transferTimeoutMs = 2147483647` / `2147483648` | 통과 / 실패 | config/schema.js:136 |
| VR-343 | PF-10 | `approvalMode = "ask-everything"` | 실패(허용값 `auto` `ask-destructive` `ask-all` `deny`) | config/schema.js:103 |
| VR-344 | PF-11 | 프로필 `port` 생략 / `0` / `65536` / `22.5` | 22 / 실패 / 실패 / 실패 | config/schema.js:141 |
| VR-345 | PF-11 | 프로필 `auth` 생략 / `"agent"` `"key"` `"password"` `"keychain"` / `"token"` | `agent` / 통과 / 실패 | config/schema.js:143 |
| VR-346 | PF-11 | 프로필 `tty`·`readOnly`·`cert`·`announceAgent` 생략 | `false`·`false`·`false`·`true` | config/schema.js:169 |
| VR-347 | PF-11 | 프로필 `role` 생략 | `"operator"` | config/schema.js:161 |
| VR-348 | PF-11 | `readOnly = "true"`(문자열) | 실패 | config/schema.js:162 |
| VR-349 | PF-11 | `trustedHostKey = ""` / `"   "` | 실패(`trustedHostKey cannot be empty`) | config/schema.js:159 |
| VR-350 | PF-11 | `trustedHostKey = "  SHA256:abc  "` | 저장값 `SHA256:abc`(공백 제거) | config/schema.js:159 |
| VR-351 | PF-11 | `name = ""` / `host = ""` / `user = ""` | 각각 실패 | config/schema.js:140 |
| VR-352 | PF-11 | 같은 `name`의 프로필 둘 | 로드 성공(중복 검사 없음), `select(name)`은 첫 항목 | config/loader.js:203 |
| VR-353 | PF-11 | `via = "no-such-profile"` | 로드 성공(검사 없음), 연결 시점에 `Profile "no-such-profile" not found` | config/schema.js:146 |
| VR-354 | PF-12 | `[policy.roleBindings.__proto__]` | 실패, 메시지에 `Reserved name (__proto__, constructor, prototype). Rename the role or tier.` | config/schema.js:14 |
| VR-355 | PF-12 | `[policy.roleBindings.""]` (빈 역할 이름) | 실패, `Role and tier names cannot be empty.` | config/schema.js:77 |
| VR-356 | PF-12 | `[policy.roleBindings.operator]` 아래 `prod = ["priviledged"]` | 실패(등급 열거형 위반, `read-only` `safe` `destructive` `privileged`만) | config/schema.js:206 |
| VR-357 | PF-13 | 프로필에 `timeout` 없음, `defaults.commandTimeoutMs = 45000` | 프로필 `timeout = 45000` | config/loader.js:164 |
| VR-358 | PF-13 | 프로필 `timeout = 1000`, `defaults.commandTimeoutMs = 45000` | `1000`(프로필이 이김) | config/loader.js:164 |
| VR-359 | PF-14 | 프로필 `maxChars` 생략, `defaults.commandMaxChars` 생략 | `5000` | config/loader.js:165 |
| VR-360 | PF-14 | 프로필 `maxChars = 0` | 9007199254740991 | config/loader.js:165 |
| VR-361 | PF-15 | 프로필 `maxOutputBytes` 생략 / `defaults.commandMaxOutputBytes = 2048` | 2048 | config/loader.js:166 |
| VR-362 | PF-16 | 프로필 `approvalPolicy` 생략, `defaults.approvalMode = "ask-all"` | `ask-all` | config/loader.js:167 |
| VR-363 | PF-17 | 프로필 `sessionMaxPerConnection` 생략, `defaults` = 7 | 7 | config/loader.js:168 |
| VR-364 | PF-18 | 프로필 `sessionIdleTimeoutMs` 생략, `defaults` = 1000 | 1000 | config/loader.js:169 |
| VR-365 | PF-19 | 프로필 `sessionBackgroundMaxMs` 생략, `defaults` = 2000 | 2000 | config/loader.js:170 |
| VR-366 | PF-20 | 프로필 `commandQuotaPerDay = 0`, `defaults.commandQuotaPerDay = 10` | `0`(명시한 0이 이김) | config/loader.js:171 |
| VR-367 | PF-21 | 프로필 `transferMaxBytes` 생략, `defaults` = 1024 | 1024 | config/loader.js:172 |
| VR-368 | PF-22 | 프로필 `transferTimeoutMs` 생략, `defaults` 생략 | `300000` | config/loader.js:173 |
| VR-369 | PF-23 | 프로필 `commandQuotaPerDay` 생략, `defaults.commandQuotaPerDay = 0` | `0`(변환 없음) | config/loader.js:138 |
| VR-370 | PF-24 | `defaults.connectionIdleReapMs = 5000` | 프로필에는 내려가지 않고 `config.defaults.connectionIdleReapMs = 5000` | config/loader.js:178 |
| VR-371 | PF-25 | 프로필 `a`·`b`, `defaultProfile = "b"`, `select("")` | `b`(빈 이름은 지정 안 함) | config/loader.js:181 |
| VR-372 | PF-26 | 프로필 `a`·`b`, 기본 없음, `select(null)` | `No profile selected and no default configured, but 2 profiles exist: a, b. Pass a "profile" argument, or set defaults.defaultProfile in the config.` | config/loader.js:190 |
| VR-373 | PF-27 | 프로필 `a` 하나, 기본 없음, `select(null)` | `a` | config/loader.js:201 |
| VR-374 | PF-28 | `select("x")` (없음) | `Profile "x" not found` | config/loader.js:205 |

## 4. `SSH_MCP_*` 환경 변수 (`config/credential-resolver.js`)

### 4.1 이름·의미·기본값

`resolveCredentials(profile)`(`config/credential-resolver.js:32-120`)가 연결 직전(`ConnectionRegistry.getOrCreate`, `ssh/connection-registry.js:52`)에 프로필별로 자격 증명을 모은다. 값은 환경 변수(`process.env`)에서만 읽으며 기본값은 모두 「없음」이다(``const creds = {};`` `config/credential-resolver.js:33`). 빈 문자열은 없는 것과 같다(참 거짓 검사).

- **EV-01 프로필 접두**: ``const envPrefix = `SSH_MCP_${profile.name.toUpperCase().replace(/[^A-Z0-9]/g, '_')}`;`` (`config/credential-resolver.js:34`). `aws-local` → `SSH_MCP_AWS_LOCAL`. 연속 치환을 합치지 않고(`a--b` → `A__B`), 서로 다른 이름이 같은 접두로 충돌할 수 있다(`a-b`와 `a_b`).
- **EV-02 비밀번호**: ``if (process.env[`${envPrefix}_PASSWORD`]) {`` (`config/credential-resolver.js:62`), 아니면 ``else if (process.env.SSH_MCP_PASSWORD) {`` (`config/credential-resolver.js:65`). 프로필 전용 변수가 전역 변수보다 우선한다. 키체인에서 이미 비밀번호를 얻었으면 그것이 유지된다(``creds.password = creds.password || …``, `config/credential-resolver.js:63`, `:66`).
- **EV-03 sudo 비밀번호**: ``if (process.env[`${envPrefix}_SUDO_PASSWORD`]) {`` (`config/credential-resolver.js:68`), 아니면 ``else if (process.env.SSH_MCP_SUDO_PASSWORD) {`` (`config/credential-resolver.js:71`). 2.x는 이 값을 쓰는 코드가 없다(`getSudoPassword` 호출처 없음, 이 조사에서 `grep -rn "getSudoPassword\|sudoPassword" src app.mjs` 0건으로 확인).
- **EV-04 키 패스프레이즈**: ``if (process.env[`${envPrefix}_PASSPHRASE`]) {`` (`config/credential-resolver.js:74`), 아니면 ``else if (process.env.SSH_MCP_PASSPHRASE) {`` (`config/credential-resolver.js:77`). 개인 키가 있을 때만 `connect`에 전달된다(``if (this.credentials.passphrase) {`` `ssh/connection.js:275`).
- **EV-05 키 파일 경로**: ``const keyPath = profile.keyRef || process.env[`${envPrefix}_KEY`] || process.env.SSH_MCP_KEY;`` (`config/credential-resolver.js:80`). 우선순위는 프로필 `keyRef` > 프로필 전용 `…_KEY` > 전역 `SSH_MCP_KEY`. 키체인에서 개인 키를 이미 얻었으면 읽지 않는다(``if (keyPath && !creds.privateKey) {`` `config/credential-resolver.js:81`).
- **EV-06 `~` 확장**: ``creds.privateKey = await readFile(resolve(keyPath.replace(/^~/, process.env.HOME || '~')), 'utf8');`` (`config/credential-resolver.js:83`). 맨 앞의 `~` 한 글자를 `HOME` 환경 변수로 바꾸고(`~user/x`도 `HOME` + `user/x`가 됨) `resolve`로 절대 경로화한다. `HOME`이 없으면(Windows 기본) `~`가 그대로 남아 현재 작업 디렉터리 아래 `~` 폴더로 해석된다. 파일이 없으면(`ENOENT`) 조용히 건너뛰고 그 밖의 오류(권한·디렉터리)는 던진다(``if (err.code !== 'ENOENT')`` `config/credential-resolver.js:86`).
- **EV-07 인증서**: ``if (profile.cert && creds.privateKey) {`` (`config/credential-resolver.js:90`). 경로는 ``const certPath = process.env[`${envPrefix}_CERT`]`` (`config/credential-resolver.js:91`) 또는 ``|| (keyPath ? `${keyPath.replace(/\.pub$/, '')}-cert.pub` : undefined);`` (`config/credential-resolver.js:92`). 전역 `SSH_MCP_CERT`는 없다. 읽은 인증서는 개인 키 뒤에 개행을 두고 이어 붙여 `privateKey`로 넘긴다(``? this.credentials.privateKey + '\n' + this.credentials.certificate`` `ssh/connection.js:273`). 인증서 파일이 없으면 조용히 건너뛴다(`:98`).
- **EV-08 SSH 에이전트**: ``if (process.env.SSH_AUTH_SOCK && profile.auth === 'agent') {`` (`config/credential-resolver.js:35`). 프로필 `auth`가 `agent`일 때만 `SSH_AUTH_SOCK`을 쓴다.
- **EV-09 키체인**: `auth = "keychain"`이고 `keychainEntry`가 있고 선택 의존성 `@napi-rs/keyring`이 있을 때만(``if (profile.auth === 'keychain' && profile.keychainEntry && keyringGet) {`` `config/credential-resolver.js:45`). 항목은 `서비스/계정`으로 나누며 비면 서비스 `ssh-mcp`, 계정은 프로필 이름이다(``const secret = await keyringGet(service || 'ssh-mcp', account || profile.name);`` `config/credential-resolver.js:48`). 비밀은 `keyRef`가 있으면 개인 키, 없으면 비밀번호로 쓴다(`:50-55`). 라이브러리가 없으면 경고를 출력하고 나머지 출처로 계속한다(`:41-44`). 2.x가 이 의존성을 설치하는지는 확인하지 않았다(미확인, `package.json`은 `ssh-mcp`의 것).
- **EV-10 모든 출처를 `auth`와 무관하게 모은다**: 비밀번호·키·sudo·패스프레이즈 출처는 `auth` 값과 상관없이 모두 읽는다(에이전트와 키체인만 `auth`로 걸러짐). `connect`는 모인 것을 전부 ssh2에 넘긴다(에이전트 `ssh/connection.js:268-270`, 키 `:271-278`, 비밀번호 ``if (this.credentials.password) {`` `ssh/connection.js:279`).
- **EV-11 자격 증명이 하나도 없을 때**: ``if (!creds.password && !creds.privateKey && !creds.agentSocket) {`` (`config/credential-resolver.js:103`). 오류 메시지는 ``throw new OperatorError(`No credentials resolved for profile "${profile.name}", which asks for auth = "${asked}": ${why[asked] ?? 'nothing was found'}.\n` +`` (`config/credential-resolver.js:114`)로 시작하고, `why`는 `agent`: ``agent: 'SSH_AUTH_SOCK is unset or the agent holds no usable key',`` (`config/credential-resolver.js:109`), `password`: ``password: `SSH_MCP_PASSWORD and SSH_MCP_${profile.name.toUpperCase().replace(/[^A-Z0-9]/g, '_')}_PASSWORD are both unset`,`` (`config/credential-resolver.js:112`), `key`·`keychain`은 `:110-111`.
- **EV-12 그 밖의 `SSH_MCP_*`**: ``const isTestMode = process.env.SSH_MCP_TEST === '1';`` (`index.js:150`), ``const isCliEnabled = process.env.SSH_MCP_DISABLE_MAIN !== '1';`` (`index.js:151`). 둘 다 vendor 자체의 CLI 진입·시험용 스위치이며 2.x는 쓰지 않는다. `cli.js:117-119`는 설정 파일에 비밀번호 키를 넣었을 때의 안내 문구에만 이름이 나온다. `AI_AGENT`는 프로세스 환경 변수가 아니라 exec 채널 환경으로 보내는 이름(``const AGENT_ENV = Object.freeze({ AI_AGENT: 'ssh-mcp' });`` `ssh/connection.js:54`)이며 `SSH_MCP_*` 이름 공간 밖이다.
- **EV-13 기본 설정·감사 경로용 환경 변수**(vendor 자체 기본값, 2.x는 명시 경로를 넘겨 쓰지 않음): `XDG_CONFIG_HOME`·`APPDATA`(PF-02), 감사 로그 기본 경로의 ``return join(process.env.LOCALAPPDATA || join(home, 'AppData', 'Local'), 'ssh-mcp', 'audit.log');`` (`audit/store.js:17`)와 ``const xdgData = process.env.XDG_DATA_HOME || join(home, '.local', 'share');`` (`audit/store.js:19`).

### 4.2 2.x가 값을 설정하는 방식과 출처

2.x 코드는 `SSH_MCP_*` 값을 **직접 만들거나 정하지 않는다**(`grep -rn "SSH_MCP" src app.mjs bridge.mjs scripts config docs`: 사용처는 아래 셋과 시험뿐, 이 조사에서 확인). 운영자가 환경 또는 비밀 환경 파일에 넣은 값을 전달만 한다.

- 출처 1 — 프로세스 환경: ``const env = await loadSecrets();`` (`bridge.mjs:9`)가 `process.env`와 비밀 파일을 합친다.
- 출처 2 — `BRIDGE_SECRET_ENV_FILE`이 가리키는 파일: ``return { ...env, ...(file ? parseSecretText(await readFile(file, 'utf8')) : {}) };`` (`src/adapters/config/secrets.mjs:23`). 파일의 값이 환경보다 우선한다. 파싱 규칙은 `src/adapters/config/secrets.mjs:5-17`: 빈 줄과 `#`로 시작하는 줄은 건너뜀, 한 줄은 ``/^([A-Z_][A-Z0-9_]*)=(.*)$/``, 키는 설정 계약의 허용 키이거나 ``/^SSH_MCP_[A-Z0-9_]+$/``여야 함(아니면 `Unsupported secret configuration entry`), 값은 앞뒤 공백 제거 후 짝이 맞는 겉 따옴표 한 쌍 제거, 값에 CR·LF·NUL이 있으면 `Invalid secret configuration value`.
  - ``if (!match || (!allowed.has(match[1]) && !/^SSH_MCP_[A-Z0-9_]+$/.test(match[1]))) throw Error('Unsupported secret configuration entry');`` (`src/adapters/config/secrets.mjs:10`)
  - ``if (/^(['"]).*\1$/.test(value)) value = value.slice(1, -1);`` (`src/adapters/config/secrets.mjs:12`)
  - ``if (/[\r\n\0]/.test(value)) throw Error('Invalid secret configuration value');`` (`src/adapters/config/secrets.mjs:13`)
- 전달: ``for (const [key, value] of Object.entries(settings)) if (key.startsWith('SSH_MCP_')) process.env[key] = value;`` (`src/adapters/ssh/vendor.mjs:177`). `SSH_MCP_`로 시작하는 키만 `process.env`에 복사한다(대문자·소문자 구분).
- 관련 2.x 설정(vendor 스위치와 별개): ``const registry = new ConnectionRegistry(config, settings.BRIDGE_HOST_KEY_MODE ?? 'tofu');`` (`src/adapters/ssh/vendor.mjs:179`) — 호스트 키 모드(CR절). 기본값은 ``"BRIDGE_HOST_KEY_MODE": "tofu",`` (`config/settings-contract.json:6`).
- 시험 고정물에 나온 이름 예: `SSH_MCP_AWS_LOCAL_PASSPHRASE`(`test/secrets.test.mjs:10`), `SSH_MCP_FIXTURE2_KEY`(`test/config-contracts.test.mjs:169`). 실제 값은 이 조사에서 읽지 않았다.

### 4.3 3.0 사례 초안 (환경 변수 → 자격 증명)

대상은 `CredentialResolver.resolve(profile, env)`(환경은 `Map`으로 주입, 구현 담당이 정함)이다. 「오류」는 `OperatorError` 계열이다. 모든 사례는 「미검증: 실행 안 함」이다.

| 사례 ID | 대상 | 입력 | 기대 결과 | 근거 위치 |
|---|---|---|---|---|
| VR-375 | EV-01 | 프로필 이름 `aws-local` | 접두 `SSH_MCP_AWS_LOCAL` | config/credential-resolver.js:34 |
| VR-376 | EV-01 | 프로필 이름 `a--b`, `my.host_1`, `a b`, `ß` (각각) | `SSH_MCP_A__B`, `SSH_MCP_MY_HOST_1`, `SSH_MCP_A_B`, `SSH_MCP_SS` (`ß`는 대문자화로 `SS`, 로케일 독립) | config/credential-resolver.js:34 |
| VR-377 | EV-02 | `SSH_MCP_AWS_LOCAL_PASSWORD=p1`, `SSH_MCP_PASSWORD=p2`, 프로필 `aws-local` | 비밀번호 `p1` | config/credential-resolver.js:62 |
| VR-378 | EV-02 | `SSH_MCP_PASSWORD=p2`만 | 비밀번호 `p2` | config/credential-resolver.js:65 |
| VR-379 | EV-02 | `SSH_MCP_AWS_LOCAL_PASSWORD=` (빈 값), `SSH_MCP_PASSWORD=p2` | 비밀번호 `p2` (빈 값은 없는 것) | config/credential-resolver.js:62 |
| VR-380 | EV-03 | `SSH_MCP_AWS_LOCAL_SUDO_PASSWORD=s1`, `SSH_MCP_SUDO_PASSWORD=s2` / 전역만 | `s1` / `s2` | config/credential-resolver.js:68 |
| VR-381 | EV-04 | `SSH_MCP_AWS_LOCAL_PASSPHRASE=f1`, `SSH_MCP_PASSPHRASE=f2` / 전역만 | `f1` / `f2` | config/credential-resolver.js:74 |
| VR-382 | EV-05 | 프로필 `keyRef=/k/a`, `SSH_MCP_AWS_LOCAL_KEY=/k/b`, `SSH_MCP_KEY=/k/c` | `/k/a`를 읽음 | config/credential-resolver.js:80 |
| VR-383 | EV-05 | `keyRef` 없음, `SSH_MCP_AWS_LOCAL_KEY=/k/b`, `SSH_MCP_KEY=/k/c` | `/k/b`를 읽음 | config/credential-resolver.js:80 |
| VR-384 | EV-05 | `keyRef` 없음, `…_KEY` 없음, `SSH_MCP_KEY=/k/c` | `/k/c`를 읽음 | config/credential-resolver.js:80 |
| VR-385 | EV-06 | `keyRef=~/.ssh/id`, `HOME=/home/u` | `/home/u/.ssh/id`를 읽음 | config/credential-resolver.js:83 |
| VR-386 | EV-06 | `keyRef=~u/x`, `HOME=/home/u` | `/home/uu/x`를 읽음 (`~user` 형식 미지원, 뒤 글자가 붙음) | config/credential-resolver.js:83 |
| VR-387 | EV-06 | `keyRef=~/k`, `HOME` 없음, 작업 디렉터리 `/w` | `/w/~/k`를 읽음 (홈으로 확장되지 않음) | config/credential-resolver.js:83 |
| VR-388 | EV-06 | `keyRef`가 없는 경로 + 다른 자격 증명(`SSH_MCP_PASSWORD`) 있음 | 키는 건너뛰고 비밀번호로 성공 | config/credential-resolver.js:86 |
| VR-389 | EV-06 | `keyRef`가 디렉터리 | 오류(원인 `EISDIR`)를 던짐, 건너뛰지 않음 | config/credential-resolver.js:86 |
| VR-390 | EV-07 | `cert=true`, `keyRef=/k/id`, 키 읽힘, `…_CERT` 없음 | `/k/id-cert.pub`을 읽어 `키 + "\n" + 인증서`를 개인 키로 전달 | config/credential-resolver.js:92 |
| VR-391 | EV-07 | `cert=true`, `keyRef=/k/id.pub` | 인증서 경로 `/k/id-cert.pub` (`.pub` 제거) | config/credential-resolver.js:92 |
| VR-392 | EV-07 | `cert=true`, `SSH_MCP_AWS_LOCAL_CERT=/c/x` | `/c/x`를 읽음 | config/credential-resolver.js:91 |
| VR-393 | EV-07 | `cert=true`, 인증서 파일 없음 | 건너뜀(개인 키만 전달) | config/credential-resolver.js:91 |
| VR-394 | EV-08 | `auth=agent`, `SSH_AUTH_SOCK=/s` | 에이전트 소켓 `/s` | config/credential-resolver.js:35 |
| VR-395 | EV-08 | `auth=key`, `SSH_AUTH_SOCK=/s`, 키 읽힘 | 에이전트 소켓은 사용하지 않음 | config/credential-resolver.js:35 |
| VR-396 | EV-09 | `auth=keychain`, `keychainEntry=svc/acct`, `keyRef` 있음 | 키체인 비밀이 개인 키가 됨(파일은 읽지 않음) | config/credential-resolver.js:50 |
| VR-397 | EV-09 | `auth=keychain`, `keychainEntry=`/`/` 형태(서비스·계정 비어 있음) | 서비스 `ssh-mcp`, 계정 프로필 이름 | config/credential-resolver.js:48 |
| VR-398 | EV-10 | `auth=password`, `SSH_MCP_PASSWORD`와 `keyRef` 둘 다 | 비밀번호와 개인 키가 모두 전달됨 | config/credential-resolver.js:103 |
| VR-399 | EV-11 | `auth=password`, 출처 없음 | 오류, 메시지가 `No credentials resolved for profile "aws-local", which asks for auth = "password": SSH_MCP_PASSWORD and SSH_MCP_AWS_LOCAL_PASSWORD are both unset.`로 시작 | config/credential-resolver.js:114 |
| VR-400 | EV-11 | `auth=agent`, `SSH_AUTH_SOCK` 없음, 다른 출처 없음 | 오류, 이유 `SSH_AUTH_SOCK is unset or the agent holds no usable key` | config/credential-resolver.js:109 |
| VR-401 | EV-12 | 프로세스 환경에 `SSH_MCP_TEST=1` | 3.0은 이 스위치를 구현하지 않는다(2.x 미사용 vendor CLI 스위치) | index.js:150 |
| VR-402 | EV-12 | exec 채널 환경 | 기본 `AI_AGENT=ssh-mcp`, 프로필 `announceAgent=false`면 없음 | ssh/connection.js:54 |
| VR-403 | EV-13 | (2.x 미사용) 기본 설정 경로 | VR-321·322와 같은 규칙 | audit/store.js:17 |
| VR-404 | 4.2 비밀 파일 | 한 줄 `SSH_MCP_AWS_LOCAL_PASSPHRASE=synthetic` | 환경에 `SSH_MCP_AWS_LOCAL_PASSPHRASE=synthetic`이 추가됨(파일이 환경보다 우선) | src/adapters/config/secrets.mjs:10 |
| VR-405 | 4.2 비밀 파일 | `SSH_MCP_lower=x` / `SSH_FOO=x` | 오류 `Unsupported secret configuration entry` | src/adapters/config/secrets.mjs:10 |
| VR-406 | 4.2 비밀 파일 | `SSH_MCP_FIXTURE2_KEY="private-value"` | 값 `private-value`(겉 따옴표 한 쌍 제거) | src/adapters/config/secrets.mjs:12 |
| VR-407 | 4.2 비밀 파일 | 값에 NUL이 있는 줄 | 오류 `Invalid secret configuration value` | src/adapters/config/secrets.mjs:13 |
| VR-408 | 4.2 전달 | 설정에 `SSH_MCP_X=1`, `ssh_mcp_y=2`, `OTHER=3` | `SSH_MCP_X`만 환경에 복사됨 | src/adapters/ssh/vendor.mjs:177 |

## 5. 연결 레지스트리·호스트 키·keepalive (`ssh/connection-registry.js`, `ssh/connection.js`, `ssh/host-key.js`)

2.x는 `ConnectionRegistry` 하나를 만들어 모든 SSH 작업이 그 `getOrCreate(profile)`로 연결을 받는다(``const registry = new ConnectionRegistry(config, settings.BRIDGE_HOST_KEY_MODE ?? 'tofu');`` `src/adapters/ssh/vendor.mjs:179`, 획득 ``connection = await registry.getOrCreate(profile);`` `src/adapters/ssh/connection-lifecycle.mjs:87`). 2.x는 `reapIdleConnections`·`listConnections`를 부르지 않고(`grep -rn "reapIdle\|listConnections" src app.mjs bridge.mjs` 0건으로 확인) `closeAll`은 종료 절차에서만 부른다(``finally { await registry.closeAll(); }`` `app.mjs:494`는 긴 한 줄 안에 있음).

### 5.1 세션(연결) 재사용·재연결

- **CR-01 재사용**: 같은 프로필 이름의 연결이 `isConnected()`면 그대로 돌려준다(``if (existing && existing.isConnected()) {`` `ssh/connection-registry.js:18`). `isConnected()`는 ``return this.connected && this.client !== null;`` (`ssh/connection.js:289`).
- **CR-02 동시 호출 합치기**: 연결 중인 프로필이면 같은 `Promise`를 돌려준다(``const inFlight = this.pending.get(profile.name);`` `ssh/connection-registry.js:21`). 끝나면 `pending`에서 지운다(``this.pending.delete(profile.name);`` `ssh/connection-registry.js:63`).
- **CR-03 죽은 연결의 재연결**: 일반 프로필은 같은 `SSHConnection` 객체를 재사용해 `ensureConnected()`가 새 ssh2 `Client`를 만든다(``await conn.ensureConnected();`` `ssh/connection-registry.js:55`). **ProxyJump 프로필**은 연결이 끊겼으면 객체를 닫고 맵에서 지우고 새로 만든다(``if (conn && profile.via && !conn.isConnected()) {`` `ssh/connection-registry.js:33`; 이유: 우회 채널이 이미 죽어 같은 객체 재연결은 항상 실패, 원문 주석 `:28-32`).
- **CR-04 연결 실패 시 정리**: 연결 시도가 실패하면 맵에서 그 프로필 항목을 지운다(``this.connections.delete(profile.name);`` `ssh/connection-registry.js:59`). 다음 호출은 새 `SSHConnection`을 만든다.
- **CR-05 ProxyJump**: 프로필 `via`가 있으면 그 프로필의 연결을 같은 레지스트리에서 받아(``const bastionConn = await this.getOrCreate(profile.via);`` `ssh/connection-registry.js:41`) 그 위에 ``bastionClient.forwardOut('', 0, profile.host, profile.port, (err, stream) => {`` (`ssh/connection-registry.js:44`)로 채널을 열어 `sock`으로 쓴다. 실패 메시지는 ``reject(new Error(`ProxyJump via "${profile.via}" failed: ${err.message}`));`` (`ssh/connection-registry.js:46`). 유휴 정리에서 `via` 대상은 건너뛴다(``if (viaTargets.has(name))`` `ssh/connection-registry.js:106`).
- **CR-06 `ensureConnected`**: 연결돼 있으면 반환, 연결 중이면 그 `Promise`, 아니면 새로 `connect()`(``if (this.isConnected())`` `ssh/connection.js:163`, ``if (this.connecting)`` `ssh/connection.js:165`, ``this.connecting = this.connect();`` `ssh/connection.js:167`).
- **CR-07 프로필 없음 처리**: 프로필이 하나도 없으면 모든 작업을 거절한다(``if (this.config.profiles.length === 0)`` `ssh/connection-registry.js:87`, `loadConfig` 경로에서는 스키마 `min(1)`로 도달하지 않음).
- **CR-08 유휴 정리(2.x 미사용)**: ``const idleThreshold = Date.now() - this.config.defaults.connectionIdleReapMs;`` (`ssh/connection-registry.js:101`) 이전에 마지막 활동이 있고 세션 수가 0인 연결을 닫고 맵에서 지운다(``if (info.sessionCount === 0 && info.lastActivity && info.lastActivity.getTime() < idleThreshold) {`` `ssh/connection-registry.js:109`). 기본 `connectionIdleReapMs`는 900000(PF-10). **2.x는 이 정리를 호출하지 않는다**: 연결은 끊기기 전까지 계속 쓰인다.
- **CR-09 전체 종료(2.x는 서버 종료 절차에서만 호출, `app.mjs:494`)**: ``await Promise.all([...this.connections.values()].map((conn) => conn.close().catch(() => { })));`` (`ssh/connection-registry.js:119`) 뒤 맵을 비운다.

### 5.2 연결 수립·keepalive·시간 한도 기본값

- **CR-10 연결 시간 한도**: 연결 시도마다 20초 타이머(``}, 20000);`` `ssh/connection.js:217`). 만료 시 ``reject(new Error('SSH connection timeout'));`` (`ssh/connection.js:215`)와 클라이언트 종료.
- **CR-11 ssh2 연결 옵션**: ``readyTimeout: 20000,`` (`ssh/connection.js:264`), ``keepaliveInterval: 15000,`` (`ssh/connection.js:265`), ``keepaliveCountMax: 3,`` (`ssh/connection.js:266`). keepalive는 15초마다 보내고 응답 없는 횟수가 3을 넘으면 연결을 끊는다(ssh2 동작 설명은 이 tgz 밖이며, 「약 45~60초 안에 끊김 감지」는 추정). 알고리즘은 ``algorithms: FROZEN_ALGORITHMS,`` (`ssh/connection.js:254`)로 고정한다(5.4절).
- **CR-12 이벤트 처리**: ``reject(new Error(`SSH connection error: ${err.message}`));`` (`ssh/connection.js:230`). `end`·`close`가 오면(현재 클라이언트일 때만) ``this.connected = false;`` (`ssh/connection.js:239`), 세션을 끊김으로 표시, `client = null`로 바꾸고 아직 핸드셰이크 중이면 ``settle(() => reject(new Error(`SSH connection ${reason} during handshake`)));`` (`ssh/connection.js:246`)로 거절한다(``client.on('end', onDisconnect('ended'));`` `ssh/connection.js:248`, ``client.on('close', onDisconnect('closed'));`` `ssh/connection.js:249`). 이전 시도의 늦은 이벤트는 새 연결을 건드리지 않는다(`isCurrent()` 검사 `:194`).
- **CR-13 `getClient`**: 연결이 없으면 ``throw new Error('SSH connection not established');`` (`ssh/connection.js:293`).
- **CR-14 채널 열기 재시도(`openWithRetry`)**: ``export async function openWithRetry(open, { attempts = 3, delayMs = 150 } = {}) {`` (`ssh/channel-retry.js:1`). 시도가 실패하면 ``await new Promise((resolve) => setTimeout(resolve, delayMs * attempt));`` (`ssh/channel-retry.js:10`)(첫 실패 뒤 150ms, 둘째 실패 뒤 300ms) 대기 후 다시 하고, 마지막 시도도 실패하면 ``throw lastError instanceof Error ? lastError : new Error(String(lastError));`` (`ssh/channel-retry.js:14`). 3회 모두 실패까지 대기 합계는 450ms이다. vendor의 `SSHConnection.exec`(``openWithRetry(openExecChannel).then(`` `ssh/connection.js:458`)와 SFTP 열기(`ssh/sftp.js:340`)가 쓴다. 2.x의 명령 실행은 vendor `exec`가 아니라 자체 감독기가 채널을 한 번 연다(`src/adapters/ssh/vendor.mjs:89-104`).
- **CR-15 시간 한도·활동 기록**: vendor `exec`의 기본 시간 한도는 ``const timeoutMs = opts.timeoutMs ?? this.profile.timeout;`` (`ssh/connection.js:312`)(기본 60000), 만료 시 ``reject(new Error(`Command timed out after ${timeoutMs}ms${note}`));`` (`ssh/connection.js:326`). 2.x는 이 경로를 쓰지 않고 `BRIDGE_COMMAND_TIMEOUT_MS`(기본 120000)를 쓴다(3.3절 끝). `lastActivity`는 연결 성립 시와 exec 종료 시 갱신된다(`ssh/connection.js:222`, `:442`).
- **CR-16 채널 환경·작업 디렉터리·PTY**: 에이전트 선언 ``return this.profile.announceAgent === false ? {} : { env: AGENT_ENV };`` (`ssh/connection.js:160`). 작업 디렉터리: ``if (!this.profile.workdir)`` (`ssh/connection.js:305`)가 아니면 ``return `cd ${shellSingleQuote(this.profile.workdir)} && ${command}`;`` (`ssh/connection.js:307`), 인용은 ``return `'${s.replace(/'/g, "'\\''")}'`;`` (`guard/sanitizer.js:175`). PTY: ``if (opts.tty || this.profile.tty) {`` (`ssh/connection.js:330`) 일 때 `term: 'xterm-256color', cols: 200, rows: 50`(``execOpts.pty = { term: 'xterm-256color', cols: 200, rows: 50 };`` `ssh/connection.js:331`).
- **CR-17 종료**: ``async close() {`` (`ssh/connection.js:478`)는 세션을 닫고 `client.end()`, `connected = false`.

### 5.3 호스트 키 검증 (`ssh/host-key.js`)

`verifyHostKey(host, port, fingerprint, knownHosts, mode, pinnedFingerprint)`는 `true`를 돌려주거나 `OperatorError`를 던진다. 판정 순서가 규칙이다. 저장소는 프로세스 메모리의 `Map` 하나이고 모든 프로필이 공유하며 키는 `host:port`다(``const key = `${host}:${port}`;`` `ssh/host-key.js:35`). **디스크에 쓰지 않고 `known_hosts`도 읽지 않아 재시작하면 처음부터 다시 신뢰한다**(`README.md:995-999`; 3.0의 `KnownHostsServerKeyVerifier` 방향은 이 행동과 다르므로 의도적 변경으로 문서화해야 한다).

- **CR-18 지문 계산**: ``const hash = createHash('sha256').update(key).digest('base64');`` (`ssh/host-key.js:10`) 후 ``return `SHA256:${hash.replace(/={0,2}$/, '')}`;`` (`ssh/host-key.js:15`). `key`는 ssh2가 `hostVerifier`에 주는 호스트 공개 키 바이트(와이어 형식)이고 결과는 OpenSSH `SHA256:` 지문과 같은 형식(패딩 `=` 제거). 빈 바이트의 지문은 `SHA256:47DEQpj8HBSa+/TImW+5JCeuQeRkm5NMpJWZG3hSuFU`(SHA-256 빈 입력의 알려진 값).
- **CR-19 고정(핀) 우선**: ``if (pinnedFingerprint) {`` (`ssh/host-key.js:45`)이면(참 거짓 검사) 모드와 무관하게 결정한다. 다르면 ``throw new OperatorError(`HOST_KEY_PIN_MISMATCH: the key presented by ${host}:${port} is not the pinned key.\n` +`` (`ssh/host-key.js:50`) + `  pinned   <핀>` + `  received <받은 지문>` + 설명. 같으면 `tofu` 모드이고 저장소에 그 키가 없을 때만 기록한다(``if (mode === 'tofu' && !knownHosts.has(key))`` `ssh/host-key.js:70`, ``knownHosts.set(key, fingerprint);`` `ssh/host-key.js:71`) 후 `true`. 핀이 일치할 때만 기록하며 거절 경로에서는 기록하지 않는다. 핀은 저장소를 읽지 않는다.
- **CR-20 `insecure`**: 핀이 없을 때 ``if (mode === 'insecure')`` (`ssh/host-key.js:74`)이면 무조건 `true`(기록 없음).
- **CR-21 저장된 키와 비교**: ``const stored = knownHosts.get(key);`` (`ssh/host-key.js:76`)가 있고 다르면 ``throw new OperatorError(`HOST_KEY_MISMATCH: the key presented by ${host}:${port} is not the one seen before.\n` +`` (`ssh/host-key.js:82`) + `  expected <저장값>` + `  received <받은 값>` + 설명. 같으면 `true`.
- **CR-22 `strict`와 처음 보는 호스트**: ``if (mode === 'strict') {`` (`ssh/host-key.js:95`)이면 ``throw new OperatorError(`HOST_KEY_UNKNOWN: No known key for ${host}:${port} and --hostKeyMode=strict is set. ` +`` (`ssh/host-key.js:96`) + 안내. 그 밖은 저장하고 `true`(``knownHosts.set(key, fingerprint);`` `ssh/host-key.js:99`) — 즉 `tofu`와 알 수 없는 모드 문자열은 같게 동작하되, 핀 일치 시의 기록은 정확히 `tofu`일 때만 한다.
- **CR-23 모드 값과 기본값**: 레지스트리 생성자의 기본은 ``constructor(config, hostKeyMode = 'tofu') {`` (`ssh/connection-registry.js:11`). 유효 값은 `tofu`(기본) `strict` `insecure`(vendor CLI는 ``Expected one of: tofu, strict, insecure.`` `cli.js:204`로 검증하나 2.x는 `BRIDGE_HOST_KEY_MODE`를 검증하지 않고 그대로 넘긴다: `src/adapters/ssh/vendor.mjs:179`). 2.x가 `strict`로 여는 곳은 계정 준비 스크립트뿐이다(``runtime = await createSshRuntime({ ...env, BRIDGE_HOST_KEY_MODE: 'strict' });`` `scripts/provision-gui-account.mjs:147`).

### 5.4 고정 알고리즘 (`ssh/algorithms.js`)

연결은 아래 목록으로 협상을 제한한다(``algorithms: FROZEN_ALGORITHMS,`` `ssh/connection.js:254`).

- **CR-24 kex**: ``'curve25519-sha256', 'curve25519-sha256@libssh.org', 'ecdh-sha2-nistp256', 'ecdh-sha2-nistp384', 'ecdh-sha2-nistp521', 'diffie-hellman-group16-sha512', 'diffie-hellman-group14-sha256',`` (`ssh/algorithms.js:3-9`)
- **CR-25 cipher**: ``'chacha20-poly1305@openssh.com', 'aes256-gcm@openssh.com', 'aes128-gcm@openssh.com', 'aes256-ctr', 'aes192-ctr', 'aes128-ctr',`` (`ssh/algorithms.js:12-17`)
- **CR-26 serverHostKey**: ``'ssh-ed25519', 'ecdsa-sha2-nistp256', 'ecdsa-sha2-nistp384', 'ecdsa-sha2-nistp521', 'rsa-sha2-512', 'rsa-sha2-256',`` (`ssh/algorithms.js:20-25`)
- **CR-27 hmac**: ``'hmac-sha2-256-etm@openssh.com', 'hmac-sha2-512-etm@openssh.com', 'hmac-sha2-256', 'hmac-sha2-512',`` (`ssh/algorithms.js:28-31`)

### 5.5 D-0038(0.07초 반복 unavailable)과 관련된 세션 수명 처리

원인은 이 조사로 확정하지 못했다(미확인: 재현·장부 원인 분석을 읽지 않았고 vendor를 실행하지 않음). 아래는 「세션이 끊긴 뒤 다음 요청이 어떻게 처리되는지」에 관여하는 vendor·2.x 코드의 위치이며, 0.07초라는 시간은 vendor 재시도 대기(CR-14: 실패 시 최소 450ms)로는 설명되지 않는다는 것이 읽어서 확인된 사실이다. 즉시(대기 없이) 거절하는 경로만 그 시간에 맞는다(추정).

- **CR-28 stale 거절 재생 방지(vendor #197)**: ``if (this.connectAttempt === attempt)`` (`ssh/connection.js:203`) 이면 ``this.connecting = null;`` (`ssh/connection.js:204`). 이 정리가 빠졌을 때는 한 번 실패한 연결 Promise가 프로세스 수명 동안 재생되어 이후 모든 호출이 즉시 같은 오류로 실패했다(원문 주석 `ssh/connection.js:171-186`). 2.18.0은 이미 고쳐져 있다.
- **CR-29 끊김 직후 상태**: `close` 이벤트가 오기 전에는 `connected`가 참이라 `isConnected()`는 참이고 레지스트리는 그 연결을 돌려준다(CR-01). 끊김 감지는 소켓 `close`/`end` 또는 keepalive 실패(CR-11, 15초 × 3)에 의존한다.
- **CR-30 채널 열기마다 재연결 확인**: `exec`용 채널 열기 콜백 안에서도 ``await this.ensureConnected();`` (`ssh/connection.js:339`)를 먼저 부른다(원문 주석 `:333-338`: 재시도마다 연결 상태를 다시 보지 않으면 죽은 클라이언트에 같은 오류를 세 번 반복).
- **CR-31 2.x가 vendor 위에 얹은 퇴역·재획득**(`src/adapters/ssh/connection-lifecycle.mjs`): 채널 열기가 같은 클라이언트에서 3번 거절되면(``const OPEN_ATTEMPTS = 3;`` `src/adapters/ssh/connection-lifecycle.mjs:5`, ``if (operation.failedOpens >= OPEN_ATTEMPTS && operation.failedClient) {`` `src/adapters/ssh/connection-lifecycle.mjs:136`) 그 클라이언트를 「퇴역」으로 표시해 이 요청은 `SSH_CHANNEL_OPEN_FAILED`로 끝내고, **다음 요청**이 `acquireSshConnection`(``export async function acquireSshConnection(registry, profile) {`` `src/adapters/ssh/connection-lifecycle.mjs:85`)에서 퇴역 클라이언트를 닫고 레지스트리에서 새 연결을 받는다. 퇴역한 클라이언트에 아직 채널이 열려 있거나 열리는 중이면 기다리지 않고 즉시 ``throw channelFailure(Error('SSH connection recovery waits for active channels'));`` (`src/adapters/ssh/connection-lifecycle.mjs:96`)로 거절한다. 퇴역 표시된 연결을 재획득 없이 쓰려 하면 즉시 ``if (state.retired || state.closing) throw channelFailure(Error('SSH connection requires a fresh acquisition'));`` (`src/adapters/ssh/connection-lifecycle.mjs:119`)이다. 이 두 즉시 거절은 입출력 없이 던져지므로 짧은 시간에 같은 코드로 반복될 수 있는 경로다(추정, 재현 안 함). feature-map은 이 파일의 「죽은 세션 사전 감지, 명령 재전송 없는 1회 재연결, 연결 실패·transport 실패 코드 분리」를 portal-ssh `SshSessionLifecycle`로 옮기고 D-0038을 거기서 고치도록 정했다(`java/docs/migration/feature-map.md:302`).
- **CR-32 연결 실패와 채널 실패의 코드 분리(2.x)**: 연결 획득 실패는 ``const connectFailure = error => executionFailure(error, { stage: 'ssh_connect', code: 'SSH_CONNECT_FAILED' });`` (`src/adapters/ssh/connection-lifecycle.mjs:8`), 채널 열기 실패는 ``const channelFailure = error => executionFailure(error, { stage: 'ssh_channel', code: 'SSH_CHANNEL_OPEN_FAILED' });`` (`src/adapters/ssh/connection-lifecycle.mjs:7`).
- **CR-33 ProxyJump 시체 연결 폐기**(vendor): CR-03 참조(``if (conn && profile.via && !conn.isConnected()) {`` `ssh/connection-registry.js:33`).
- **CR-34 대상 변경 보호(2.x)**: 요청 시작 시 프로필 JSON 스냅샷을 만들고 디스패치 직전에 현재 프로필과 연결 객체의 프로필이 스냅샷과 같은지 다시 확인한다(``const snapshot = configured ?? JSON.stringify(connection.profile);`` `src/adapters/ssh/vendor.mjs:51`). 다르면 `target_changed`로 거절한다. 3.0의 `SshProfile`은 불변 `record`이므로 같은 의미를 값 동등성으로 옮길 수 있다.

### 5.6 3.0 사례 초안 (연결 레지스트리·호스트 키)

호스트 키 사례는 순수 함수(`HostKeyVerifier.verify(host, port, fingerprint, store, mode, pin)`)로 직접 시험한다. 레지스트리·연결 사례는 가짜 연결 팩터리(성립/끊김/지연을 제어하는 테스트 더블)를 주입하는 동작 명세다(vendor에는 주입 지점이 없어 사례를 새로 쓴다). `FP1`=`SHA256:AAA`, `FP2`=`SHA256:BBB`, 호스트 `h`, 포트 22, 저장소 키 `h:22`. 모든 사례는 「미검증: 실행 안 함」이다.

| 사례 ID | 대상 | 입력 | 기대 결과 | 근거 위치 |
|---|---|---|---|---|
| VR-409 | CR-01 | 같은 프로필을 두 번 연속 `getOrCreate`(연결 유지) | 같은 연결 객체, 연결 시도 1회 | ssh/connection-registry.js:18 |
| VR-410 | CR-02 | 연결 중인 프로필을 동시에 세 번 `getOrCreate` | 모두 같은 결과, 연결 시도 1회 | ssh/connection-registry.js:21 |
| VR-411 | CR-03 | 일반 프로필 연결이 끊긴 뒤 `getOrCreate` | 같은 `SSHConnection` 객체가 새 클라이언트로 재연결 | ssh/connection-registry.js:55 |
| VR-412 | CR-03 | `via` 프로필 연결이 끊긴 뒤 `getOrCreate` | 이전 객체를 닫고 새 객체 생성, 우회 연결을 다시 만든 뒤 연결 | ssh/connection-registry.js:33 |
| VR-413 | CR-04 | 첫 연결이 실패한 뒤 서버가 복구되어 `getOrCreate` | 맵에서 지워졌으므로 새 시도가 성공(이전 실패 재생 없음) | ssh/connection-registry.js:59 |
| VR-414 | CR-05 | 프로필 `b`가 `via=a` | `a`를 먼저 `getOrCreate`하고 그 위에 `forwardOut('', 0, b.host, b.port)` | ssh/connection-registry.js:44 |
| VR-415 | CR-05 | 우회 채널 열기 실패(`boom`) | 오류 `ProxyJump via "a" failed: boom` | ssh/connection-registry.js:46 |
| VR-416 | CR-05 | `a`가 `b`의 `via` 대상이고 `a`가 유휴 | 유휴 정리가 `a`를 닫지 않음 | ssh/connection-registry.js:106 |
| VR-417 | CR-06 | 연결 중에 `ensureConnected` 두 번 | 같은 Promise | ssh/connection.js:165 |
| VR-418 | CR-07 | 프로필이 0개인 설정(로더를 우회한 객체) | 모든 `getOrCreate`가 「구성되지 않음」 오류로 거절 | ssh/connection-registry.js:87 |
| VR-419 | CR-08 | `connectionIdleReapMs=1000`, 연결 A(세션 0, 마지막 활동 2초 전), B(세션 1), C(`via` 대상, 유휴) | A만 닫고 맵에서 제거 | ssh/connection-registry.js:109 |
| VR-420 | CR-09 | 연결 둘을 `closeAll` | 둘 다 동시에 닫고 맵이 비어 있음, 한쪽 종료 오류가 다른 쪽을 막지 않음 | ssh/connection-registry.js:119 |
| VR-421 | CR-10 | 핸드셰이크가 20초 안에 안 끝남 | `SSH connection timeout`, 클라이언트 종료 | ssh/connection.js:217 |
| VR-422 | CR-11 | 연결 옵션 | readyTimeout 20초, keepalive 간격 15초, 무응답 허용 횟수 3 | ssh/connection.js:265 |
| VR-423 | CR-12 | 핸드셰이크 중 서버가 연결을 닫음 | `SSH connection closed during handshake`(`end`면 `ended`) | ssh/connection.js:246 |
| VR-424 | CR-12 | 핸드셰이크 오류 `ECONNREFUSED` | `SSH connection error: …ECONNREFUSED…` | ssh/connection.js:230 |
| VR-425 | CR-12 | 연결 성립 후 소켓 `close` | `isConnected()`가 거짓, 다음 `getOrCreate`는 재연결 | ssh/connection.js:239 |
| VR-426 | CR-13 | 연결 없이 `getClient` | `SSH connection not established` | ssh/connection.js:293 |
| VR-427 | CR-14 | 열기가 첫 시도 실패, 둘째 성공 | 결과 성공, 대기 150ms | ssh/channel-retry.js:10 |
| VR-428 | CR-14 | 열기가 3번 모두 실패 | 마지막 오류를 던짐, 대기 150ms·300ms(합계 450ms), 시도 3회 | ssh/channel-retry.js:14 |
| VR-429 | CR-14 | 열기가 오류가 아닌 값(`"x"`)을 던짐 | `Error("x")`로 감싸 던짐 | ssh/channel-retry.js:14 |
| VR-430 | CR-15 | vendor `exec`에 시간 한도 지정 없음, 프로필 `timeout=60000` | 60000ms (2.x 경로는 `BRIDGE_COMMAND_TIMEOUT_MS`, 기본 120000) | ssh/connection.js:312 |
| VR-431 | CR-16 | 프로필 `announceAgent` 생략 / `false` | 채널 환경 `{AI_AGENT: "ssh-mcp"}` / 없음 | ssh/connection.js:160 |
| VR-432 | CR-16 | 프로필 `workdir="/srv/app"`, 명령 `ls` | 실행 문자열 `cd '/srv/app' && ls` | ssh/connection.js:307 |
| VR-433 | CR-16 | `workdir="/it's"` | `cd '/it'\''s' && ls` | guard/sanitizer.js:175 |
| VR-434 | CR-16 | 프로필 `tty=true` | PTY `xterm-256color` 200×50 | ssh/connection.js:331 |
| VR-435 | CR-17 | `close` 호출 | 클라이언트 `end`, `isConnected()` 거짓 | ssh/connection.js:478 |
| VR-436 | CR-18 | 빈 바이트 | `SHA256:47DEQpj8HBSa+/TImW+5JCeuQeRkm5NMpJWZG3hSuFU` | ssh/host-key.js:15 |
| VR-437 | CR-18 | 임의 바이트의 SHA-256 base64 | 끝의 `=`는 최대 둘 제거, 접두 `SHA256:` | ssh/host-key.js:10 |
| VR-438 | CR-19 | 핀 FP1, 받은 FP1, 모드 `tofu`, 저장소 빔 | `true`, 저장소 `h:22 → FP1` | ssh/host-key.js:70 |
| VR-439 | CR-19 | 핀 FP1, 받은 FP2, 모드 `insecure` | 오류 `HOST_KEY_PIN_MISMATCH: the key presented by h:22 is not the pinned key.`, 저장소 변화 없음 | ssh/host-key.js:50 |
| VR-440 | CR-19 | 핀 FP1, 받은 FP1, 모드 `strict` | `true`, 저장소에 기록하지 않음 | ssh/host-key.js:70 |
| VR-441 | CR-19 | 핀 FP1, 받은 FP1, 모드 `tofu`, 저장소에 `h:22 → FP2` | `true`, 저장소 값 FP2 유지(채우기만) | ssh/host-key.js:70 |
| VR-442 | CR-19 | 핀 FP1, 받은 FP1, 모드 `tofu`, 저장소에 `h:22 → FP2`인 상태에서 핀 없는 같은 호스트의 다른 프로필이 FP1을 받음 | `HOST_KEY_MISMATCH` (핀이 저장소에 FP1을 쓰지 않았기 때문) | ssh/host-key.js:70 |
| VR-443 | CR-19 | 핀 `''`(빈 문자열) | 핀 없음으로 취급(참 거짓 검사) | ssh/host-key.js:45 |
| VR-444 | CR-20 | 핀 없음, `insecure`, 저장소 FP1, 받은 FP2 | `true`, 저장소 변화 없음 | ssh/host-key.js:74 |
| VR-445 | CR-21 | 핀 없음, `tofu`, 저장소 FP1, 받은 FP2 | 오류 `HOST_KEY_MISMATCH: the key presented by h:22 is not the one seen before.`, 본문에 `expected SHA256:AAA`·`received SHA256:BBB` | ssh/host-key.js:82 |
| VR-446 | CR-21 | 핀 없음, `tofu`, 저장소 FP1, 받은 FP1 | `true` | ssh/host-key.js:76 |
| VR-447 | CR-22 | 핀 없음, `strict`, 저장소 빔 | 오류 `HOST_KEY_UNKNOWN: No known key for h:22 and --hostKeyMode=strict is set.` | ssh/host-key.js:96 |
| VR-448 | CR-22 | 핀 없음, `tofu`, 저장소 빔 | `true`, 저장소 `h:22 → FP1` | ssh/host-key.js:99 |
| VR-449 | CR-22 | 핀 없음, 모드 `weird`(알 수 없는 값), 저장소 빔 | `true`, 저장소 기록(`tofu`처럼 동작) | ssh/host-key.js:99 |
| VR-450 | CR-22 | 핀 FP1 일치, 모드 `weird`, 저장소 빔 | `true`, 저장소는 기록하지 않음(핀 기록은 정확히 `tofu`일 때만) | ssh/host-key.js:70 |
| VR-451 | CR-23 | 모드를 주지 않고 레지스트리 생성 | 모드 `tofu` | ssh/connection-registry.js:11 |
| VR-452 | CR-24 | 협상 알고리즘 목록 | kex 7개, cipher 6개, serverHostKey 6개, hmac 4개가 위 순서와 동일 | ssh/algorithms.js:3 |
| VR-453 | CR-25 | (위 목록) | cipher 순서 `chacha20-poly1305@openssh.com` → `aes256-gcm@openssh.com` → `aes128-gcm@openssh.com` → `aes256-ctr` → `aes192-ctr` → `aes128-ctr` | ssh/algorithms.js:12 |
| VR-454 | CR-26 | (위 목록) | serverHostKey 첫 항목 `ssh-ed25519`, `ssh-rsa`(SHA-1)는 없음 | ssh/algorithms.js:20 |
| VR-455 | CR-27 | (위 목록) | hmac은 etm 두 개가 앞, `hmac-sha1`은 없음 | ssh/algorithms.js:28 |
| VR-456 | CR-28 | 첫 연결이 실패(서버 down) 뒤 서버 복구, 같은 `SSHConnection`에서 `ensureConnected` | 이전 실패를 재생하지 않고 새로 시도해 성공 | ssh/connection.js:203 |
| VR-457 | CR-29 | 소켓이 조용히 죽었고 아직 `close` 이벤트 전 | `isConnected()`는 참(이 구간의 요청은 채널 열기 단계에서 실패함을 확인하는 사례) | ssh/connection.js:289 |
| VR-458 | CR-30 | 재시도 중 연결이 죽음 | 시도마다 `ensureConnected`를 먼저 호출해 죽은 클라이언트를 재사용하지 않음 | ssh/connection.js:339 |
| VR-459 | CR-31 | 같은 클라이언트에서 채널 열기가 3번 거절 | 이 요청은 `SSH_CHANNEL_OPEN_FAILED`, 그 클라이언트는 퇴역 표시 | src/adapters/ssh/connection-lifecycle.mjs:136 |
| VR-460 | CR-31 | 퇴역 클라이언트에 열려 있는 채널이 있는 상태에서 다음 요청 | 기다리지 않고 즉시 `SSH_CHANNEL_OPEN_FAILED`(`recovery waits for active channels`) | src/adapters/ssh/connection-lifecycle.mjs:96 |
| VR-461 | CR-31 | 퇴역 클라이언트에 열린 채널이 없는 상태에서 다음 요청 | 그 클라이언트를 닫고 새 연결로 성공(원래 명령 재전송 없음) | src/adapters/ssh/connection-lifecycle.mjs:85 |
| VR-462 | CR-32 | 연결 획득 실패 / 채널 열기 실패 | 코드 `SSH_CONNECT_FAILED` / `SSH_CHANNEL_OPEN_FAILED`로 구분 | src/adapters/ssh/connection-lifecycle.mjs:8 |
| VR-463 | CR-33 | CR-03 사례와 동일 | VR-412와 동일 | ssh/connection-registry.js:33 |
| VR-464 | CR-34 | 요청 시작 후 프로필이 바뀐 뒤 디스패치 | `target_changed`로 거절 | src/adapters/ssh/vendor.mjs:51 |

## 6. test-server-mode (`src/application/test-server-mode.mjs`)

feature-map 메인 판정 C4가 요구한 「설정 키의 정확한 이름」은 다음 세 가지다(이 조사에서 `grep`·열기로 확인).

- **환경 설정 키**: `BRIDGE_TEST_SERVER_SECRET_REF`. 기본값 빈 문자열(``"BRIDGE_TEST_SERVER_SECRET_REF": "",`` `config/settings-contract.json:23`), 허용 키 목록에 있음(``"BRIDGE_SECRET_STORE_DIR", "BRIDGE_JEV_KEY_REF", "BRIDGE_TEST_SERVER_SECRET_REF",`` `config/settings-contract.json:37`).
- **파싱된 설정 속성**: `testServerSecretRef`. 문자열이 아니면 빈 문자열(``testServerSecretRef: typeof value('BRIDGE_TEST_SERVER_SECRET_REF') === 'string' ? value('BRIDGE_TEST_SERVER_SECRET_REF') : '',`` `src/adapters/config/settings.mjs:71`). 조립: ``const testServerMode = createTestServerMode({ reference: settings.testServerSecretRef, resolver });`` (`app.mjs:98`).
- **대상별 명령 정책 규칙 필드**: `testServer`(불리언, 선택). ``|| (rule.testServer !== undefined && typeof rule.testServer !== 'boolean')`` (`src/domain/command-policy.mjs:55`)이면 정책 거절(`Invalid command policy`). 허용 규칙 키 목록에 `testServer`가 있다(``'sourceExecutionContract', 'testServer', 'fallback', 'thresholds'`` `src/domain/command-policy.mjs:47` 안의 일부; 이 줄은 긴 한 줄이다).

의미: 운영자가 시크릿 저장소에 둔 「서버 시험 모드 비밀」이 현재 읽히고 형식에 맞을 때만 「시험 서버 능력」이 켜진다. 요청 인자나 관리자가 편집하는 설정만으로는 이 능력을 줄 수 없고, **매 확인마다 다시 해석한다**(시작 시 스냅샷이 비밀 폐기 뒤에도 남지 않도록).

- **TS-01 가용 판정**(`src/application/test-server-mode.mjs:8-15`): 다음을 모두 만족할 때만 참이고 어떤 예외도 거짓으로 삼킨다.
  - ``if (!reference) return false;`` (`src/application/test-server-mode.mjs:9`)
  - ``parseSecretReference(reference);`` (`src/application/test-server-mode.mjs:11`)
  - ``const value = await resolver.resolve(reference);`` (`src/application/test-server-mode.mjs:12`)
  - ``return typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);`` (`src/application/test-server-mode.mjs:13`) — 값은 소문자 16진 64자 문자열이어야 한다. 앞뒤 공백·개행·대문자는 거절된다.
  - ``} catch { return false; }`` (`src/application/test-server-mode.mjs:14`)
- **TS-02 참조 형식**: ``/^secret:\/\/([a-z][a-z0-9-]{0,31})\/([A-Za-z0-9][A-Za-z0-9_.-]{0,63})$/`` (`src/application/secret-service.mjs:7`). 제공자는 소문자로 시작하는 1~32자 `[a-z0-9-]`, 이름은 영숫자로 시작하는 1~64자 `[A-Za-z0-9_.-]`, 슬래시 하나로 구분. 맞지 않으면 `SecretError('invalid_reference')`.
- **TS-03 필수 검사**: ``async require() { if (!await available()) throw Error('Test server capability unavailable'); },`` (`src/application/test-server-mode.mjs:18`). 메시지는 고정이며 제공자 오류 세부를 숨긴다.
- **TS-04 소비 지점**(`app.mjs`, 의미 요약은 해당 줄을 열어 읽은 것): 규칙 `testServer === true`이면 파일 경로 정책이 시험 모드 가용성을 요구하고(``if (rule?.testServer !== true) return { bypassRoot: false };`` `app.mjs:146`, ``await testServerMode.require();`` `app.mjs:147`), 디스패치 직전에 다시 검사해 불가하면 `Test authority is unavailable`로 거절하고(``catch { dispatchRefusal('authority', 'policy_guard', 'Test authority is unavailable'); }`` `app.mjs:176`), 자동 결정은 `test_server_bypass`로 실행하며(``return rule?.testServer===true?{decision:'execute',reasonCode:'test_server_bypass',policyRevision:policy.revision,targetRevision:definition.revision}:undefined;`` `app.mjs:267`), 정책의 검토·저장은 `testServer` 규칙이 있으면 가용성을 요구한다(``if (policy?.targets?.some(rule => rule.testServer === true)) await testServerMode.require();`` `app.mjs:478`, 같은 줄이 `app.mjs:482`에 한 번 더). 상태 조회는 `testServerConfigured`와 `testServerActive`를 낸다(``const active = rule?.testServer === true && await testServerMode.available();`` `app.mjs:291`).
- 2.x 시험: `test/test-server-mode.test.mjs:5-22`가 TS-01~TS-03을 고정한다(아래 사례의 원본).

### 6.1 3.0 사례 초안 (test-server-mode)

대상은 `TestServerMode.available()` / `require()`(리졸버는 주입)이다. 모든 사례는 「미검증: 실행 안 함」이나 VR-465~468은 2.x 시험의 단언을 그대로 옮긴 것이다.

| 사례 ID | 대상 | 입력 | 기대 결과 | 근거 위치 |
|---|---|---|---|---|
| VR-465 | TS-01 | 참조가 `''`, 없음, `arbitrary`, `secret://local-file/../bad` (각각), 리졸버는 64자 값을 돌려줌 | `available()`이 거짓, `require()`가 `Test server capability unavailable`로 거절, 리졸버 호출 0회 | test/test-server-mode.test.mjs:8 |
| VR-466 | TS-01 | 참조 `secret://local-file/test-server`, 리졸버가 소문자 16진 64자(`a`×64) | `available()` 참 | test/test-server-mode.test.mjs:14 |
| VR-467 | TS-01 | 같은 참조, 리졸버 값이 `''`, `undefined`, `not-a-valid-marker`, `1`, `null` (각각) | 거짓, `require()` 거절 | test/test-server-mode.test.mjs:16 |
| VR-468 | TS-01·TS-03 | 리졸버가 `Error("private provider details")`를 던짐 | `available()` 거짓, `require()`의 메시지가 정확히 `Test server capability unavailable` (세부 비노출) | test/test-server-mode.test.mjs:22 |
| VR-469 | TS-01 | 리졸버 값이 대문자 16진 64자(`A`×64) / 소문자 63자 / 소문자 65자 (각각) | 거짓 | src/application/test-server-mode.mjs:13 |
| VR-470 | TS-01 | 리졸버 값이 소문자 16진 64자 + 개행 한 글자 | 거짓 (`$`가 아니라 문자열 끝 `\z`로 비교해야 함) | src/application/test-server-mode.mjs:13 |
| VR-471 | TS-01 | 값이 유효 → 시험 중 값을 다른 문자열로 바꿈 | 값 변경 직후 `available()`이 거짓 (캐시하지 않음, 호출 때마다 리졸버 호출) | src/application/test-server-mode.mjs:12 |
| VR-472 | TS-02 | 참조 `secret://local-file/test-server`, `secret://vault/test-server`, `secret://a/B.c_d-e` | 유효 | src/application/secret-service.mjs:7 |
| VR-473 | TS-02 | 참조 `secret://Local/x`(대문자 제공자), `secret://1a/x`, `secret://a/-x`, `secret://a/.x`, `secret://a/b/c`, `secret://a/x/`, `secret://a/x y`, 제공자 33자, 이름 65자 (각각) | 모두 무효(`invalid_reference`) | src/application/secret-service.mjs:7 |
| VR-474 | TS-03 | `require()` 성공 경로 | 예외 없이 반환 | src/application/test-server-mode.mjs:18 |
| VR-475 | 키 이름 | 환경 `BRIDGE_TEST_SERVER_SECRET_REF` 미설정 / 설정 | 속성 `testServerSecretRef`가 `""` / 설정 문자열 | src/adapters/config/settings.mjs:71 |
| VR-476 | 키 이름 | 명령 정책 규칙의 `testServer`가 `"yes"` / `true` / 생략 | `Invalid command policy` / 통과 / 통과 | src/domain/command-policy.mjs:55 |
| VR-477 | TS-04 | `testServer=true` 규칙을 가진 정책을 검토·저장, 시험 모드 불가 | `Test server capability unavailable`로 거절 | app.mjs:478 |
| VR-478 | TS-04 | `testServer=true` 규칙으로 승인된 작업이 디스패치되는데 그 사이 비밀이 폐기됨 | `Test authority is unavailable`로 거절 | app.mjs:176 |

## 7. 2.x 덮어쓰기 (vendor 규칙을 바꾸거나 보탠 곳)

2.x는 vendor 분류기·redactor·로더의 소스를 고치지 않는다. 대신 vendor 결과를 감싸서 바꾸거나 자체 규칙을 더한다. 아래가 이식 때 vendor 규칙과 함께 보존해야 하는 겹침이다.

- **OV-01 명령 입력 검증과 여러 줄 명령의 등급 하향 금지**(`src/domain/validation.mjs`): vendor `classifyCommand` 앞에서 입력을 검사하고, **줄바꿈이 있는 명령은 `read-only`를 `safe`로 올린다**(vendor는 `trim()`하므로 끝의 개행을 무시하고 전체가 읽기 전용이라 증명할 수 없기 때문, 원문 주석 `:18-19`).
  - ``const HIDDEN = /[\u0000-\u001f\u007f-\u009f\u061c\u200b\u200e\u200f\u2028-\u202e\u2060-\u2064\u2066-\u2069\ufeff]/;`` (`src/domain/validation.mjs:4`)
  - ``export const commandTextValid = command => utf8WithinLimit(command, COMMAND_MAX_BYTES)`` (`src/domain/validation.mjs:11`) ``&& Boolean(command.trim()) && !HIDDEN.test(command.replace(/\r\n|\n|\t/g, ''));`` (`src/domain/validation.mjs:12`): UTF-8 32768바이트 이하(``export const COMMAND_MAX_BYTES = 32 * 1024;`` `src/contracts/ports.mjs:7`, 정상 UTF-16 문자열만: `isWellFormed`, `src/contracts/ports.mjs:11-12`), 공백뿐이 아님, 탭·LF·CRLF 쌍을 뺀 제어·서식 문자 없음(외톨이 CR 거절).
  - ``if (!commandTextValid(command)) throw Error('Invalid command');`` (`src/domain/validation.mjs:16`)
  - ``const result = /[\r\n]/.test(command) && classified.class === 'read-only' ? { ...classified, class: 'safe' } : classified;`` (`src/domain/validation.mjs:20`)
  - ``if (safeOnly && result.class !== 'safe') throw Error('Only safe-class commands are supported');`` (`src/domain/validation.mjs:21`)
- **OV-02 Windows 대상의 분류 덮어쓰기**(`src/domain/target-platform.mjs:20-28`): 대상 플랫폼이 `windows`면 vendor 분류기를 **쓰지 않고** 자체 규칙을 쓴다. 입력 검증(``if (!commandTextValid(command)) throw Error('Invalid Windows command');`` `src/domain/target-platform.mjs:17`) 뒤, 개행이 없고 정확히 아래 두 모듈 한정 cmdlet 하나(대소문자 무시, 앞뒤 공백 허용)일 때만 `read-only`, 그 밖은 모두 `safe`다.
  - ``const readOnly = !/[\r\n]/.test(command) && /^(?:Microsoft\.PowerShell\.Utility\\Get-Date|Microsoft\.PowerShell\.Management\\Get-Location)$/i.test(command.trim());`` (`src/domain/target-platform.mjs:25`)
  - ``return { class: readOnly ? 'read-only' : 'safe' };`` (`src/domain/target-platform.mjs:26`)
- **OV-03 자동화 위험 사전 검사(`inspectCommand`)**(`src/domain/command-policy.mjs:74-84`): vendor 등급을 입력으로 쓰되 별도 보수적 규칙을 더한다. 이 함수의 이식 위치는 portal-app의 명령 자동화 정책이지만 vendor 등급의 의미(`safe`는 안전 증명이 아님)에 의존하므로 여기에 기록한다.
  - 실행 파일 이름: ``const executableName = command => /^\s*([A-Za-z0-9_][A-Za-z0-9_.+-]*)(?:\s|$)/.exec(command)?.[1] ?? null;`` (`src/domain/command-policy.mjs:15`)
  - 셸 문자 검사: ``const shell = /[;&|<>`$(){}\n\r\\*?\[\]~]/.test(command);`` (`src/domain/command-policy.mjs:77`) (vendor `SHELL_CONTROL_CHARS`보다 넓음: `\` `*` `?` `[` `]` `~` 추가)
  - `sudo` 한 가지 철자만 로컬에서 벗긴다: ``const evaluated = executable === 'sudo' ? command.replace(/^\s*sudo\s+(?:-n\s+)?/, '') : command;`` (`src/domain/command-policy.mjs:79`)
  - ``try { commandClass = classify(evaluated).class; } catch { commandClass = 'unknown'; }`` (`src/domain/command-policy.mjs:81`)
  - ``return { executable, sensitive, risky: sensitive || shell || !executable || commandClass !== 'read-only' };`` (`src/domain/command-policy.mjs:83`)
- **OV-04 민감 텍스트 판정(`credentialText`·`sensitiveText`)**(`src/domain/execution-context.mjs`): redactor와 별개의 입력 쪽 규칙이다. `secret://제공자/이름` 참조는 비밀 값이 아니므로 예외다.
  - ``const credentialMaterial = /-----BEGIN|\bBearer\s|(?:api[_-]?key|password|secret|token)\s*[=:]/gi;`` (`src/domain/execution-context.mjs:8`)
  - ``export const sensitiveText = value => credentialText(value) || /\/etc\/shadow|\.ssh\/id_|\/secrets(?:\/|\b)|\.env(?:\b|\/)/i.test(value);`` (`src/domain/execution-context.mjs:22`)
  - 예외: 일치가 정확히 `secret:`이고 앞 글자가 `[A-Za-z0-9_./:-]`가 아니며 뒤가 `secret://…` 참조 형식(``const secretReference = /^secret:\/\/[a-z][a-z0-9-]{0,31}\/[A-Za-z0-9][A-Za-z0-9_.-]{0,63}(?=$|[\s"'`,;)\]}])/;`` `src/domain/execution-context.mjs:10`)이면 그 일치는 건너뛴다(`:14-17`).
- **OV-05 거부 명령 매칭(`deniedCommand`)**(`src/domain/command-policy.mjs:98`): 정책의 `deniedCommands` 이름이 명령줄 이름 문법(`commandLineNames`)에 있거나 명령을 비이름 문자로 쪼갠 단어에 있으면 거부한다(인용된 언급도 걸림). Windows는 소문자 단어와 이름의 마지막 경로 요소로 비교한다(``const words = command.toLowerCase().split(/[^a-z0-9_.+-]+/);`` `src/domain/target-platform.mjs:41`).
  - ``export const deniedCommand = (command, rule) => Boolean(rule?.deniedCommands.some(name => commandLineNames(command).names.includes(name) || command.split(/[^A-Za-z0-9_.+-]+/).includes(name)));`` (`src/domain/command-policy.mjs:98`)
- **OV-06 이름 정책 문법**(`src/domain/command-line.mjs`, `src/domain/windows-command-line.mjs`): vendor 분류기와 별개로 2.x가 만든 「명령 이름만 보는」 문법(셸 평가기도 위험 분류기도 아님, `src/domain/command-line.mjs:3`). feature-map은 이를 portal-ssh `PosixCommandLineGrammar` 행으로 보냈으므로 이 문서의 vendor 규칙 범위 밖이다(세부는 읽지 않음: 미확인).
- **OV-07 `src/domain/safety.mjs`**: vendor 분류 규칙을 덮어쓰지 않는다. Jev 모델의 위험 평가 응답 검증(``/** Observation only: these values confer no execution authority. */`` `src/domain/safety.mjs:4`)이며 Jev 연구 삭제 결정(제어 요약의 part-a 판정)에 해당하는 쪽이다.
- **OV-08 연결 퇴역·재획득**(`src/adapters/ssh/connection-lifecycle.mjs`): CR-31·CR-32.
- **OV-09 명령 실행 옵션**(`src/adapters/ssh/vendor.mjs:89-104`): vendor `SSHConnection.exec` 대신 자체 감독기를 쓰고, 시간 한도는 `BRIDGE_COMMAND_TIMEOUT_MS`(기본 120000, 정수 1~2147483647, 아니면 `Invalid BRIDGE_COMMAND_TIMEOUT_MS`: ``if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 2_147_483_647) throw Error('Invalid BRIDGE_COMMAND_TIMEOUT_MS');`` `src/adapters/ssh/vendor.mjs:182`), 출력 한도는 프로필 `maxOutputBytes`(없으면 1048576, ``export const DEFAULT_OUTPUT_BYTES = 1024 * 1024;`` `src/adapters/ssh/execution-supervisor.mjs:5`)다. 기본 정지 유예는 ``export const DEFAULT_STOP_GRACE_MS = 5_000;`` (`src/adapters/ssh/execution-supervisor.mjs:4`).
- **OV-10 프로필 스냅샷 보호**: CR-34.
- **OV-11 Windows 대상의 프로필 제약**: 3.5절 끝.
- **OV-12 감사 기록의 redaction**(`src/adapters/audit/jsonl.mjs:30`): 명령은 해시와 redact된 문자열을 함께 기록한다(2절 호출 지점).

### 7.1 3.0 사례 초안 (2.x 덮어쓰기)

대상은 portal-domain의 명령 검증기·대상 플랫폼 분류·위험 사전 검사 객체(이름은 구현 담당이 정함)이며 vendor 분류기는 시험에서 실제 `CommandClassifier`를 쓴다. 모든 사례는 「미검증: 실행 안 함」이다.

| 사례 ID | 대상 | 입력 | 기대 결과 | 근거 위치 |
|---|---|---|---|---|
| VR-479 | OV-01 | `ls` | `read-only` | src/domain/validation.mjs:20 |
| VR-480 | OV-01 | `ls<LF>` (끝에 LF) | `safe` (vendor는 `read-only`, 2.x가 올림) | src/domain/validation.mjs:20 |
| VR-481 | OV-01 | `ls<LF>ls` | `safe` | src/domain/validation.mjs:20 |
| VR-482 | OV-01 | `rm -rf /tmp/x<LF>` | `destructive` (올리기만 함) | src/domain/validation.mjs:20 |
| VR-483 | OV-01 | `''`, `   `, `<LF>` (각각) | 오류 `Invalid command` | src/domain/validation.mjs:12 |
| VR-484 | OV-01 | `ls<TAB>-la`, `ls<CR><LF>pwd` (각각) | 허용(분류 진행) | src/domain/validation.mjs:12 |
| VR-485 | OV-01 | `ls<CR>` (외톨이 CR), `ls<U+0007>`, `ls<U+200B>`, `ls<U+2028>`, `<U+FEFF>ls` (각각) | 오류 `Invalid command` | src/domain/validation.mjs:4 |
| VR-486 | OV-01 | UTF-8로 정확히 32768바이트인 명령 / 32769바이트 | 허용 / 오류 `Invalid command` | src/contracts/ports.mjs:7 |
| VR-487 | OV-01 | 짝 없는 서로게이트가 든 문자열 | 오류 `Invalid command` | src/contracts/ports.mjs:11 |
| VR-488 | OV-01 | `rm -rf /tmp/x` 를 `safeOnly`로 검증 | 오류 `Only safe-class commands are supported` | src/domain/validation.mjs:21 |
| VR-489 | OV-02 | Windows 대상, `Microsoft.PowerShell.Utility\Get-Date` | `read-only` | src/domain/target-platform.mjs:25 |
| VR-490 | OV-02 | Windows 대상, `microsoft.powershell.management\get-location` (소문자), 앞뒤 공백 포함 | `read-only` | src/domain/target-platform.mjs:25 |
| VR-491 | OV-02 | Windows 대상, `Get-Date` / `Microsoft.PowerShell.Utility\Get-Date; calc` / `ls` | `safe` | src/domain/target-platform.mjs:26 |
| VR-492 | OV-02 | Windows 대상, `Microsoft.PowerShell.Utility\Get-Date<LF>` | `safe` | src/domain/target-platform.mjs:25 |
| VR-493 | OV-02 | Windows 대상, 빈 문자열 | 오류 `Invalid Windows command` | src/domain/target-platform.mjs:17 |
| VR-494 | OV-03 | `ls -la` | `risky=false`, executable `ls` | src/domain/command-policy.mjs:83 |
| VR-495 | OV-03 | `ls \| wc -l`, `ls *.txt`, `ls ~`, ``ls `pwd` ``, `ls a\b` (각각) | `risky=true` (셸 문자) | src/domain/command-policy.mjs:77 |
| VR-496 | OV-03 | `sudo -n ls`, `sudo ls` (각각) | `risky=false` (벗긴 `ls`가 `read-only`) | src/domain/command-policy.mjs:79 |
| VR-497 | OV-03 | `sudo -u root ls` | `risky=true` (`-u root`는 벗기지 않아 `-u root ls`가 `safe`) | src/domain/command-policy.mjs:79 |
| VR-498 | OV-03 | `cat /etc/shadow`, `echo password=x`, `cat ~/.ssh/id_rsa`, `cat .env` (각각) | `risky=true` (민감) | src/domain/command-policy.mjs:83 |
| VR-499 | OV-03 | (빈 문자열 근처) `   ` | executable `null`, `risky=true` | src/domain/command-policy.mjs:15 |
| VR-500 | OV-03 | 분류기가 예외를 던지도록 한 대체 분류기 | 등급 `unknown`, `risky=true` | src/domain/command-policy.mjs:81 |
| VR-501 | OV-04 | `-----BEGIN`, `Authorization: Bearer abc`, `api_key=1`, `api-key: 1`, `password = x`, `token:x`, `secret=` (각각) | `credentialText=true` | src/domain/execution-context.mjs:8 |
| VR-502 | OV-04 | `use secret://vault/key now` | `credentialText=false` (유효한 `secret://` 참조는 예외) | src/domain/execution-context.mjs:10 |
| VR-503 | OV-04 | `x-secret://vault/key`, `mysecret://vault/key`, `SECRET://vault/key` (각각) | `credentialText=true` (앞 글자가 예외 집합이거나 대소문자가 다름) | src/domain/execution-context.mjs:10 |
| VR-504 | OV-04 | `ls /secrets`, `cat /secrets/a`, `cat .env`, `cat .env/x` (각각) | `sensitiveText=true` | src/domain/execution-context.mjs:22 |
| VR-505 | OV-04 | `ls /secretsfoo`, `ls .environment` (각각) | `sensitiveText=false` | src/domain/execution-context.mjs:22 |
| VR-506 | OV-05 | 거부 목록 `["rm"]`, 명령 `echo rm` | 거부(인용·언급도 걸림) | src/domain/command-policy.mjs:98 |
| VR-507 | OV-05 | 거부 목록 `["rm"]`, 명령 `ls` | 거부 아님 | src/domain/command-policy.mjs:98 |
| VR-508 | OV-05 | Windows 대상, 거부 목록 `["C:\Tools\Del.exe"]`, 명령 `del.exe x` | 거부(소문자 비교, 이름의 마지막 요소) | src/domain/target-platform.mjs:41 |
| VR-509 | OV-07 | (해당 없음) | vendor 규칙을 덮어쓰는 동작 없음. `safety.mjs`는 이식 범위가 아니라 삭제 판정 대상 | src/domain/safety.mjs:4 |
| VR-510 | OV-09 | `BRIDGE_COMMAND_TIMEOUT_MS` 미설정 / `1` / `2147483647` | 120000 / 1 / 2147483647 | src/adapters/ssh/vendor.mjs:181 |
| VR-511 | OV-09 | `BRIDGE_COMMAND_TIMEOUT_MS` = `0`, `-1`, `2147483648`, `abc`, `1.5`, `` (빈 문자열) | 각각 오류 `Invalid BRIDGE_COMMAND_TIMEOUT_MS` | src/adapters/ssh/vendor.mjs:182 |
| VR-512 | OV-09 | 프로필 `maxOutputBytes` 생략 | 출력 한도 1048576 | src/adapters/ssh/execution-supervisor.mjs:5 |
| VR-513 | OV-11 | Windows 대상에 프로필 `workdir` 있음 / `tty=true` | 각각 거절(`Windows targets cannot use a POSIX profile workdir` / `Windows targets require non-TTY profiles`) | src/adapters/config/targets.mjs:67 |
| VR-514 | RK-05 | `éiptables -F` | `destructive` (`\b`는 ASCII 단어 경계라 `é` 뒤 `i` 앞에서 경계) | policy/classifier.js:640 |
| VR-515 | CL-N03 | `awk 'BEGIN{"date" \| getline; system("sudo id")}'` | `privileged` (awk가 낸 `commands` 두 개 `date`·`sudo id`가 각각 분류되어 최댓값) | policy/classifier.js:1927 |
| VR-516 | OV-06 | (참조용, 세부는 `PosixCommandLineGrammar` 담당) 명령줄 이름 추출 `ls -la` | 이름 `["ls"]`, 완전(complete) 참, sudo 사용 없음 | src/domain/command-line.mjs:3 |
| VR-517 | OV-06 | (참조용) 명령줄 이름 추출 `$S id` | 완전(complete) 거짓(동적 명령 이름) | src/domain/command-line.mjs:3 |
| VR-518 | OV-08 | CR-31 사례(VR-459~461)와 동일 | 동일 | src/adapters/ssh/connection-lifecycle.mjs:136 |
| VR-519 | OV-10 | CR-34 사례(VR-464)와 동일 | 동일 | src/adapters/ssh/vendor.mjs:51 |
| VR-520 | OV-12 | 감사 기록에 명령 `echo AKIAIOSFODNN7EXAMPLE` | `commandHash`는 원문의 해시, `command`는 `echo [REDACTED:aws-access-key:20]` | src/adapters/audit/jsonl.mjs:30 |

## 8. 이식 위험: JS 정규식·문자열과 Java의 차이

구현 담당은 아래 항목을 JUnit 사례로 고정한다(대응하는 사례 번호를 적었다). 이 절은 「vendor를 Java로 옮길 때 같은 입력이 다르게 나올 수 있는 곳」이다. Java 쪽 동작 설명은 JDK 문서로 이 조사에서 다시 확인하지 않은 일반 지식이며, 확정하지 못한 부분은 「추정」으로 표시한다.

- **RK-01 UTF-16 코드 단위 의미**: vendor의 모든 정규식은 `u` 플래그가 없어 `.`·`[^x]`·`{n,m}`이 코드 단위(UTF-16 16비트)를 센다. Java `Pattern`은 코드 포인트를 센다. 영향: 이모지 같은 보조 평면 글자가 든 PEM 본문의 `{0,65536}` 한도(RD-05), `[\s\S]`가 먹는 길이. 일반 입력에서는 차이가 없고 경계 사례(VR-292)에서만 다르다.
- **RK-02 `$`와 `\z`**: JS `$`(m 플래그 없음)는 입력의 맨 끝에서만 맞는다. Java `$`는 끝의 줄 종결자(`\n`, `\r\n`, `\r`, `\u0085`, `\u2028`, `\u2029`) 앞에서도 맞는다. 모든 `$`를 `\z`로 옮기거나 `matches()`를 쓴다. 영향 규칙: sort 생성 정규식의 `(?:=|$)`(CL-D02), `BARE_NUMERIC`(CL-P04), `WINDOWS_EXE_SUFFIX`(CL-I02), CL-F01의 `(\s|$)`, `arp`·`sort`의 `each`(RG-12), `/^-[A-Za-z]{2,3}$/`(CL-I04), `={0,2}$`(CR-18), `/\.pub$/`(EV-07), 2.x의 `/^[a-f0-9]{64}$/`(TS-01, VR-470), 비밀 참조 형식(TS-02). 사례: VR-470, VR-125 인근의 sort 사례.
- **RK-03 공백의 정의**: JS `\s`와 `String.prototype.trim`의 집합은 TAB, VT, FF, SP, NBSP(`U+00A0`), `U+1680`, `U+2000`–`U+200A`, `U+2028`, `U+2029`, `U+202F`, `U+205F`, `U+3000`, `U+FEFF`, LF, CR이다. Java `\s`는 기본 ASCII `[ \t\n\x0B\f\r]`뿐이고 `String.strip()`·`Character.isWhitespace`는 또 다른 집합이다(`U+0085`·`U+00A0`·`U+FEFF` 처리가 다름). 토크나이저(CL-T02)·`trim()`·`split(/\s+/)`(CL-A08)·모든 `\s` 정규식에 같은 명시 집합을 써야 한다. 사례: VR-025.
- **RK-04 `.`과 줄 종결자**: JS `.`는 `\n \r \u2028 \u2029`만 제외한다. Java `.`는 `\u0085`도 제외한다. `unquote`(CL-T09)의 `(.*)`는 `[^\n\r\u2028\u2029]*`로 써야 같아진다.
- **RK-05 `\b`**: JS `\b`는 항상 ASCII 단어 문자(`[A-Za-z0-9_]`) 기준이다. Java는 JDK 19부터 기본이 ASCII 기준으로 바뀐 것으로 알고 있으나(추정, 이 조사에서 JDK 문서를 다시 읽지 않음) `UNICODE_CHARACTER_CLASS`를 켜면 달라진다. 켜지 말고 VR-514로 확인한다.
- **RK-06 대소문자 접기**: JS `i` 플래그(`u` 없음)와 Java `CASE_INSENSITIVE`는 ASCII만 접는 점이 같다. `UNICODE_CASE`를 켜면 `K`(켈빈 기호)·`ſ`가 ASCII와 맞아 달라진다. 켜지 않는다. 문자열의 `toLowerCase`/`toUpperCase`는 반드시 `Locale.ROOT`(터키어 로케일의 `i`·`İ` 문제 방지, EV-01의 `ß` → `SS`는 `Locale.ROOT`에서도 같음).
- **RK-07 base64·UTF-16LE 해석(`decodedPowerShellCommand`)**: Node `Buffer.from(x, 'base64')`는 표준·URL 안전 알파벳을 모두 받고 알파벳 밖 글자는 건너뛰며 예외를 던지지 않는다(원문 주석 `classifier.js:1812-1817`도 이 점을 전제로 함). Java `Base64.getDecoder()`는 엄격해 예외를 던진다. `Base64.getMimeDecoder()`는 알파벳 밖 글자를 건너뛰나 URL 안전 글자(`-_`)는 처리하지 않는다. 그리고 UTF-16LE 디코딩에서 Node는 홀수 바이트를 버리고 짝 없는 서로게이트를 그대로 둔 채 문자열을 만들지만(추정, Node 동작은 이 tgz 밖), Java `new String(bytes, UTF_16LE)`는 잘못된 서로게이트·남는 바이트를 U+FFFD로 바꾼다. 그러면 `decoded.includes('\uFFFD')`(``return decoded.includes('�') || decoded.trim() === '' ? null : decoded;`` `policy/classifier.js:1830`)가 항상 참이 되어, 서로게이트가 섞인 페이로드는 안쪽 명령 분류를 건너뛴다(`privileged`가 `destructive`로 내려갈 수 있음). 해결은 바이트를 두 개씩 직접 `char`로 만들어(검증 없이) 문자열을 만드는 것이다. 사례: VR-101·VR-102와 보조 사례를 구현 담당이 서로게이트 포함 페이로드로 확장한다.
- **RK-08 엔트로피의 부동소수점**: JS는 `Math.log2(p)`, Java에는 `log2`가 없어 `Math.log(p) / Math.log(2)`를 써야 하며 마지막 비트가 다를 수 있다. 합은 Map 삽입(처음 나온) 순서대로 더하므로 `LinkedHashMap`을 쓴다. 임계값 4.5와 정확히 같은 값은 현실적으로 만들기 어려우니 경계 사례는 VR-306·308·309처럼 거리가 충분한 값으로 고정한다.
- **RK-09 치환 문자열**: JS는 콜백이 돌려준 문자열을 그대로 쓰지만 Java `Matcher.appendReplacement`·`replaceAll(Function)`은 반환값의 `$`·`\`를 해석한다. 이 redactor의 반환값에는 `$`·`\`가 없지만(`[REDACTED:…]` 또는 원래 일치 문자열 — 일치 문자열은 `[A-Za-z0-9+/=_-]`뿐) 방어로 `Matcher.quoteReplacement`를 쓴다.
- **RK-10 큰 한정자·역추적**: `[\s\S]{0,65536}?`(RD-05)는 BEGIN마다 최대 64KiB를 다시 훑는다(vendor가 한도를 둔 이유, `redactor.js:10-13`). Java도 같은 비용이므로 1MiB 입력에 BEGIN이 많은 경우의 시간 시험을 둔다. 분류기는 한때 정규식 역추적으로 1MiB 입력에 65초가 걸린 뒤 단어 기반 검사로 바꿨다는 설명이 있다(`classifier.js:597-619`): 포팅할 때 정규식을 다시 합치지 말고 단어 기반 구조를 유지하며, 같은 형태의 입력(`dd curl wget chown -R x ` 반복 64KiB)으로 시간 시험을 둔다. Java `Pattern`에서 깊은 재귀가 필요한 그룹 반복은 `StackOverflowError`가 될 수 있으므로 이 문서의 정규식에 중첩 반복을 만들지 않는다.
- **RK-11 sort 정규식은 생성물**: CL-D02의 정규식은 `SORT_LONG_OPTIONS`에서 계산한다. Java에서도 목록에서 생성하거나 위 계산 결과를 상수로 두고, 접두 `--c`(제외)·`--co`(포함)·`--o`(포함)·`--output`(포함)를 직접 시험한다(VR-123·VR-124).
- **RK-12 방언 두 번 분류와 캐시**: 백슬래시가 있으면 `posix`·`windows`를 둘 다 분류하고 높은 쪽을 택한다(CL-A01). `normalizeCommand`의 8개 캐시는 성능용이며 이식하지 않아도 된다. 공유 가변 상태를 만들지 않는다(스레드 안전).
- **RK-13 TOML 파서 차이**: `smol-toml`은 TOML 1.0을 파싱해 실수 `22.0`을 JS 숫자 22로 주고 zod가 정수로 받는다. Jackson 쪽은 설정에 따라 다르다. 동일 계약을 위해 전용 `ObjectMapper`(스프링 부트 기본 매퍼는 `FAIL_ON_UNKNOWN_PROPERTIES`가 꺼져 있음)에서 알 수 없는 키 거절(PF-08)을 켜고, 스칼라 강제 변환(`"true"` → 불리언, `22.5` → 22 절단)을 끈다. 큰 정수(2^53 초과)·`inf`·`nan`·BOM의 동작은 vendor에서 확인하지 못했다(미확인).
- **RK-14 정수 범위**: `commandMaxChars=0` → `Number.MAX_SAFE_INTEGER`(PF-23), `transferMaxBytes` 최대 2^53-1, `transferTimeoutMs` 최대 2^31-1이다. Java `int`로 받으면 넘친다. `long`을 쓰고 `transferTimeoutMs`는 `Duration`으로 바꿀 때 경계를 시험한다(VR-340~342).
- **RK-15 `~` 확장은 `HOME` 환경 변수만**: Java `user.home`과 다르다. Windows에서 `HOME`이 없으면 vendor는 현재 디렉터리 아래 `~`를 읽는다(EV-06, VR-387). 같은 행동을 유지할지 `user.home`으로 고칠지는 3.0 판정이며 고치면 문서화한다.
- **RK-16 권한 검사**: POSIX는 모드 `0o077`(그룹·기타) 거절이며 Java `Files.getPosixFilePermissions`로 옮길 수 있다. Windows는 vendor가 `icacls.exe`(외부 프로그램)와 SDDL 해석을 쓰는데, 이는 Java `AclFileAttributeView`로 대체할 수 있으므로 외부 프로그램을 두지 않는다. 판정 정책(`waived`)은 PF-05, 세부 계정 목록은 미확인.
- **RK-17 호스트 키 신뢰 범위**: vendor TOFU는 프로세스 메모리뿐이다(CR-18 앞 설명). 3.0이 `KnownHostsServerKeyVerifier`로 파일에 저장하면 재시작 뒤 첫 연결 정책이 달라진다. MINA의 지문 문자열 형식(`SHA256:`+base64, 패딩 여부)은 실측하지 못했다(미확인): CR-18의 형식(`=` 제거)에 맞춰 비교해야 한다.
- **RK-18 정수·부동 문자열 변환**: `String(lastError)`·`${...}` 메시지는 사례(VR-424 등)가 정확한 문구에 의존하지 않도록, 메시지 접두(`SSH connection error:`, `HOST_KEY_*:`)만 계약으로 삼는다.

## 9. 미확인 목록과 이유

- **U-01 vendor 단위 시험·실행 대조 없음**: tgz에는 컴파일된 `build/`만 있고 시험이 없다. Node·Python 실행이 금지되어 모든 「기대 결과」는 소스 추적값이다(전 사례 미검증).
- **U-02 zod 4 이슈 문구·`smol-toml` 오류 문구·큰 정수·BOM 처리**: 두 라이브러리 소스는 tgz 밖이다(PF-06·PF-07·RK-13).
- **U-03 Windows ACL 세부**: `config/sddl.js`와 `config/windows-acl.js`의 계정 판정표·메시지는 읽지 않았다(PF-05는 `waived`와 진입점만).
- **U-04 keepalive 감지 시간**: ssh2 내부 동작이 tgz 밖이다. 「약 45~60초」는 추정(CR-11).
- **U-05 D-0038 근본 원인**: 장부·재현 로그를 읽지 않았고 vendor를 실행하지 않았다. 세션 수명 관련 코드 위치만 기록했다(CR-28~CR-32). 「즉시 거절 경로가 0.07초에 맞는다」는 추정이다.
- **U-06 SFTP 전송 규칙(`ssh/sftp.js`)**: 이 작업의 1~6항에 없어 조사하지 않았다. 2.x 호출 인자(`maxBytes`, `idleTimeoutMs`, `overwrite: false`, `mode: 0o600`)의 위치만 기록한다(`src/adapters/ssh/vendor.mjs:414`, `:434`, `:437`). 3.0은 MINA SFTP로 대체하므로 필요하면 별도 조사.
- **U-07 세션·정책 엔진·도구 계층**: `ssh/session-manager.js`, `ssh/session.js`, `policy/engine.js`, `policy/quota.js`, `policy/remote-path.js`, `tools/*`, `guard/sanitizer.js`(셸 인용 함수 외), `audit/*`, `observability/*`는 2.x가 쓰지 않아 조사하지 않았다(2.x가 `ssh-mcp`를 import하는 곳은 `src/adapters/ssh/vendor.mjs`와 `src/adapters/desktop/local-process.mjs` 둘뿐임을 grep으로 확인: 후자는 `redactText`만).
- **U-08 2.x의 이름 정책 문법 세부**(`src/domain/command-line.mjs`, `src/domain/windows-command-line.mjs`): OV-06.
- **U-09 `@napi-rs/keyring` 설치 여부**: 2.x 배포물에서 확인하지 않았다(EV-09). 키체인 인증(`auth="keychain"`)을 3.0이 지원할지는 판정 필요.
- **U-10 `via` 순환·중복 이름의 동작**: 로드 시 검사 코드가 없다는 사실만 확인했다(PF-11).
- **U-11 Node 내장 동작**: `Buffer.from(…,'base64')`의 비표준 입력, `toString('utf16le')`의 서로게이트 처리(RK-07).
- **U-12 합성 동사**(`sftp:*`, `session:open`)는 2.x가 분류기에 보내지 않음을 `grep "sftp:" src app.mjs` 0건으로 확인했다. 이식 우선순위는 낮다(CL-S02).

## 10. 자체 점검 방법과 결과

- 규칙 수 대조: 분류기 소스에서 직접 센 값과 이 문서의 값이 같다. `READERS` 키 68(`any` 48·`getopt` 17·`exact` 3), 금지 정규식 9(`FORBIDDEN_PATTERNS`)·금지 규칙 13(정규식 9 + 단어 기반 4), 파괴적 패턴 1, `INTERPRETERS` 21, `PRIVILEGE_PREFIXES` 11, `EXEC_WRAPPERS` 14, `PREFIX_VALUE_FLAGS` 18, `SORT_LONG_OPTIONS` 30, `FORBIDDEN_INVOCATIONS` 5, `SYNTHETIC_CLASSES` 4, redactor `REGEX_PATTERNS` 7·`SENSITIVE_FIELDS` 10, awk `AWK_KEYWORDS` 15·`NON_FILE_TARGETS` 5·연산자 19. 점검 중 문서의 권한 접두 수(12 → 11)와 `SORT_LONG_OPTIONS` 수(29 → 30)가 틀린 것을 찾아 고쳤다.
- 근거 대조: 문서의 모든 「파일:줄」을 `tar -xzOf …`(vendor)와 파일 읽기(2.x)로 다시 열어 비교했다. 규칙·표 줄의 이중 백틱 원문 572개를 줄 범위의 원문 텍스트(공백 정규화)에 대해 일치 검사했고 569개가 일치, 3개는 원문이 아니라 설명용 계산값이라 일치하지 않는 것이 정상이다(sort 정규식 생성 형태와 계산 결과, 표기 규칙 예시). 사례 520개의 근거 위치는 모두 규칙 줄에서 일치 확인된 범위 안에 든다. 인용된 줄 번호가 파일 길이를 넘는 경우는 0건이다. 줄 번호만 적은 인용(`:N`)은 모두 열어 첫 줄 내용을 문서의 설명과 눈으로 대조했다. 점검 중 `vendor.mjs:50`→`:51`, `execution-context.mjs:11`→`:10`을 고쳤다.
- 점검하지 못한 것: 기대 결과(사례의 「기대 결과」 칸)는 실행으로 확인하지 못했다(Node 실행 금지). 소스 추적으로만 도출했다.

<!--END-->
