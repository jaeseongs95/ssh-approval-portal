# 3.0.0 기반 사례표 (java/ 골격·기계 검사·시범 3종)

작성 기준: 시험을 만들기 전에 이 표를 먼저 쓴다(개발원칙 7.1). 열은 대상·입력·기대·판정이다. 「실행 결과」 열은 `./gradlew build` 실행 뒤에 채운다.
근거 열의 「공식」은 2026-11-12에 문서를 열어 확인한 원문이고, 「공식 근거 미확인」은 문서를 열지 못했거나 문서에 해당 문장이 없어 라이브러리 바이트코드·실행으로 확인한 것이다.

## 1. 골격(F)

| ID | 대상 | 입력 | 기대 | 판정 | 근거 |
|---|---|---|---|---|---|
| F-01 | Gradle 전체 빌드 | `./gradlew --no-daemon --max-workers=1 -Pportal.test.forks=1 build` | 종료 코드 0, javac 경고 0(`-Xlint:all -Werror`) | 로그에 `BUILD SUCCESSFUL`, `warning:` 0줄 | 개발원칙 7.4, 8.4 |
| F-02 | Gradle 래퍼 | `gradle/wrapper/gradle-wrapper.properties` | Gradle 9.9.0, `distributionSha256Sum`=`0b00b0ffe07c4d4789c12d4935a44a7057d55774b7540bd4a3f76f336deb177a`(선행 프로젝트가 쓰는 값) | 파일의 값과 문자열 일치 | Gradle 공식: Gradle Wrapper 문서(검증값 `distributionSha256Sum`) |
| F-03 | 시험 JVM 격리(`TestIsolationTest`) | 호스트 세션(Claude 등)이 환경 변수를 가진 채 시험 실행 | 시험 JVM의 환경 변수에 CLAUDE*·CODEX*·GEMINI*·ANTHROPIC*·OPENAI*·BRIDGE_*·PORTAL_*·AGS_*·AGENT_GOVERNANCE* 0개; `user.home`·`java.io.tmpdir`·HOME·USERPROFILE·APPDATA·LOCALAPPDATA·TEMP가 모듈 `build/isolated` 아래; `availableProcessors()`==1; 최대 힙 ≤ 512 MiB | 단언 | Gradle 공식: `Test.environment`, `Test.systemProperty`, `jvmArgs`, `maxHeapSize` (Test DSL) |
| F-04 | 모듈 구성 | `settings.gradle.kts` | 10개 모듈(domain, app, store, ssh, desktop, web, server, client, migrate, arch-checks) | 빌드가 10개를 구성 | 개발원칙 3.2 |
| F-05 | 줄 끝 규칙 | `java/.gitattributes` | `*.sh`·`gradlew`는 LF, `*.cmd`·`*.bat`는 CRLF | `git check-attr eol` 확인 | git 공식 gitattributes `eol` |

## 2. 기계 검사(A) — 모듈 `portal-arch-checks`

각 규칙은 (1) 일부러 어긴 fixture 클래스를 규칙이 모두 잡고 깨끗한 fixture는 잡지 않는다(`RuleFixturesTest`), (2) 제품 모듈 전체(`portal-*`의 `classes/java/main`, 소스, 빌드 파일)에는 위반 0이다(`ArchitectureRulesTest`)를 둘 다 시험한다. 규칙이 비어 있어서 통과하는 것(vacuous)을 막기 위해 (1)이 필요하다.

| ID | 규칙(개발원칙 절) | fixture 위반(모두 탐지) | 깨끗한 fixture | 제품 기대 |
|---|---|---|---|---|
| A-OUT | `System.out`/`System.err` 접근 0 (6) | `System.out.println`, `System.err.println` | Logger 사용 | 위반 0 |
| A-STACK | `Throwable.printStackTrace` 호출 0 (6) | `new Exception().printStackTrace()` | 예외를 로그에 넘김 | 위반 0 |
| A-VALUE | `@Value` 0: 필드·메서드·생성자 매개변수 (3.5, 2.2 범주 7) | 필드, setter, 생성자 매개변수 | `@ConfigurationProperties` record | 위반 0 |
| A-ENV | `System.getenv`·`getProperty`·`getProperties`, `Integer.getInteger`·`Long.getLong`·`Boolean.getBoolean` 0 (3.5) | 각각 | 없음 | 위반 0 |
| A-JSON | `new ObjectMapper`/`new JsonMapper`(Jackson 2·3)·`JsonMapper.builder()` 0, 예외 없음(개정 원칙: 설정은 `JsonMapperBuilderCustomizer`) (2.2 범주 2) | 세 가지 | 주입받은 매퍼 사용 | 위반 0 |
| A-STRING | `new String(String)`·`String.intern` 호출 0 (3.3, 체크 26) | 각각 | 없음 | 위반 0 |
| A-JDBC | `new JdbcTemplate`·`new NamedParameterJdbcTemplate`·`JdbcClient.create`·`DriverManager` 0 (4.1) | `new JdbcTemplate()`, `DriverManager.getConnection` | 없음 | 위반 0 |
| A-WEB | 컨트롤러 advice는 `ResponseEntityExceptionHandler`를 상속하고 제품에 하나뿐; `@ExceptionHandler`는 advice 안에만; `@RequestBody byte[]` 0; `@RestController`의 매핑 메서드가 `Map`·JSON 트리·`byte[]`를 반환하지 않음 (3.8, 체크 27) | 상속 안 한 advice, 컨트롤러 지역 핸들러, byte[] 본문, Map 응답 | 상속한 advice, record를 받고 돌려주는 컨트롤러 | 위반 0, advice 수 ≤ 1 |
| A-UTIL | 정적 메서드만 가진 클래스 0(`main` 제외) — 데이터만 든 타입을 바깥 static 도우미가 판정하는 구조 (3.0, 체크 32). 허용은 상수 홀더와 순수 값 계산뿐이며 허용 목록(`UTILITY_ALLOWED`)에 이유와 함께 적는다. 지금 목록은 비어 있다 | 정적 메서드만 있는 `StaticOnlyHelper`; 목록에 넣으면 통과(목록 인자 시험) | 상태와 동작이 한 타입인 `Counter`, record | 위반 0 |
| A-DIP | `BeanFactory`/`ApplicationContext.getBean` 호출 0 — 의존은 생성자 주입으로만 (3.0, 체크 34) | `context.getBean("x")` | 없음 | 위반 0 |
| A-ENCAP | public 필드는 final만 (3.0, 체크 32) | public 가변 필드 | public final 필드 | 위반 0 |
| A-LSP | `UnsupportedOperationException` 생성 0 — 미지원은 계약에 정한 결과로 (3.0, 체크 34) | 던지는 하위 타입 | 없음 | 위반 0 |
| A-TIME | `Clock` 아닌 인자의 `now(...)`(`Instant`·`LocalDate`·`LocalDateTime`·`LocalTime`·`ZonedDateTime`·`OffsetDateTime`·`OffsetTime`·`Year`·`YearMonth`·`MonthDay`) 0, `ZoneId.systemDefault`, `Clock.systemDefaultZone`, `TimeZone.getDefault`, `java.util.Date`, `Calendar` 0 (4.5) | `Instant.now()`, `LocalDate.now()`, `ZoneId.systemDefault()`, `new Date()`, `Calendar.getInstance()` | `Instant.now(clock)` | 위반 0 |
| A-OS | OS 판정 0: `os.name`을 소스에서 찾는 문자열 검사, `File.separator`·`separatorChar`·`pathSeparator`·`pathSeparatorChar` 접근 0 (1.1, 1.2) | `File.separator` 접근, 소스 파일에 `"os.name"` (임시 폴더) | 소스에 없음 | 위반 0 |
| A-THREAD | `new Thread`·`Thread` 상속·`Thread.ofVirtual/ofPlatform/startVirtualThread`·`Executors.*`·`ThreadPoolExecutor`·`ForkJoinPool`·`Timer` 생성 0 (2.2 범주 8) | 각각 | 없음 | 위반 0 |
| A-PROCESS | `ProcessBuilder`·`Runtime.exec` 사용은 허용 목록 클래스만. 목록은 지금 비어 있다(이후 portal-desktop의 xfreerdp3·Xvnc 실행 클래스만 추가) (1.4, 2.2 범주 6) | `new ProcessBuilder`, `Runtime.exec(String[])` | 허용 목록에 넣으면 통과(목록 인자 시험) | 위반 0 |
| A-DIR | 모듈 의존 방향: domain←app←(store, ssh, desktop, web)←server; client는 domain만; migrate는 store·domain만. 클래스 의존(ArchUnit)과 빌드 파일의 `project(":portal-…")` 둘 다 (3.2) | 허용되지 않은 방향의 fixture 클래스·임시 빌드 파일 | 허용된 방향 | 위반 0 |
| A-DOMAIN | `portal-domain`은 JDK·jackson-annotation·자기 패키지에만 의존 (3.2) | Spring을 쓰는 fixture | 순수 fixture | 위반 0 |
| A-LOMBOK | `lombok..` 의존 0, 소스 `import lombok`·빌드 파일 `lombok` 0 (8.2) | `lombok.Getter`(시험용 같은 이름 어노테이션) 붙인 클래스, 임시 빌드 파일 | 없음 | 위반 0 |
| A-REFLECT | `setAccessible`·`trySetAccessible` 호출 0, 빌드 파일에 `add-opens`·`enable-preview` 0 (8.1, 8.2) | `Field.setAccessible(true)`, 임시 빌드 파일 | 없음 | 위반 0 |
| A-OPTIONAL-SLOT | `Optional` 타입의 필드·record 구성요소·메서드/생성자 매개변수 0. 반환 타입은 허용 (개발원칙 3.3, 체크 35; 안티패턴 O1, 16절 1번). ArchUnit 1.5.1에는 record 구성요소 모델이 없어 구성요소는 컴파일러가 만드는 private 필드와 정규 생성자 매개변수로 잡는다 | `Optional` 필드(`OptionalField`), `Optional` 매개변수(`OptionalParameter`), `Optional` 구성요소 record(`OptionalComponent`) | `Optional`을 반환하는 `Clean.find` | 위반 0 |
| A-OPTIONAL-GET | `Optional.get()` 호출 0 (개발원칙 3.3, 체크 35; 안티패턴 O2, 16절 2번). 근거: JDK `Optional.get()` API Note 「The preferred alternative to this method is `orElseThrow()`.」 | `Optional.of("x").get()`(`GetsOptional`) | `orElseThrow()`를 쓰는 `Clean.require` | 위반 0 |
| A-CHARSET | 인자 없는 `String.getBytes()`, 문자셋 없는 `new String(byte[]…)`, 문자셋 없는 `InputStreamReader`·`OutputStreamWriter` 생성자 0 (안티패턴 Z2, 16절 15번). 문자셋 이름·`Charset`·`CharsetDecoder`·`CharsetEncoder` 인자가 있으면 통과 | `getBytes()`, `new String(bytes)`, `new String(bytes, 0, 1)`, `new InputStreamReader(in)`, `new OutputStreamWriter(out)` | `getBytes(UTF_8)`, `new String(bytes, UTF_8)`, `new String(bytes, 0, n, UTF_8)`, 문자셋을 준 Reader·Writer | 위반 0 |
| A-SLEEP | `Thread.sleep` 호출 0(모든 오버로드) — 완료를 알리는 API를 쓴다 (안티패턴 D3, 16절 14번) | `Thread.sleep(1L)`, `Thread.sleep(Duration)` | `CountDownLatch.await(1, SECONDS)`(`Clean.finished`) | 위반 0 |

시험 코드의 보정(2a06896 뒤, 개발원칙 9절·안티패턴 16절 기준): (1) Spring 시험의 필드 `@Autowired`·`@LocalServerPort`를 `@Autowired` 생성자 매개변수로 바꿨다(안티패턴 SP1; `McpContractSpikeTest`, `NullInclusionSpikeTest`). (2) 가변 static 상태를 `@TestInstance(PER_CLASS)`와 인스턴스 필드로 바꿨다(안티패턴 S2; `ArchitectureRulesTest`, `RuleFixturesTest`, `PortsSpikeTest`). (3) 값이 둘 다 변수인 비교를 `Objects.equals`로 바꿨다(개발원칙 3.3; `McpContractSpikeTest`, `ArchitectureRulesTest`, `PortalRules`). (4) 판정: 시험 하니스(`ArchitectureRulesTest`, `TestIsolationTest`)의 `System.getProperty`·`System.getenv`는 Spring이 아닌 JUnit 시험이 Gradle `systemProperty`·시험 JVM 환경을 읽는 자리라 허용한다. 제품 코드에는 A-ENV가 그대로 적용된다.

### 2.1 기계로 잡을 수 없는 항목: 검토 판정

아래는 ArchUnit·소스 검사로 판정할 수 없어 diff 검토자가 개정 개발원칙 9절 체크리스트에 대해 「예/아니오」로 판정한다. 시범 코드에 대한 판정은 완료 보고에 적었다.

| 체크 | 내용 | 기계로 못 잡는 이유 |
|---|---|---|
| 21 | 모든 `catch`가 로그 후 종료·원인 달린 변환·재던짐 중 하나, 넓은 catch는 경계만, 이중 로그 금지 | `catch` 본문의 의미는 바이트코드에서 구분되지 않는다(`printStackTrace`·`System.out`만 A-OUT·A-STACK이 잡는다) |
| 26 | `==`·`변수.equals("상수")` 비교 금지 | 바이트코드의 참조 비교는 문자열인지 구분되지 않는다(`new String`·`intern`만 A-STRING이 잡는다) |
| 27 | 응답을 `Map.of`로 만들기·오류 본문 도우미 | 메서드 안의 `Map.of` 호출은 응답 본문인지 알 수 없다(반환 타입만 A-WEB이 잡는다) |
| 28 | 필터는 디스패처 앞 관심사만, 거절 본문을 직접 쓰지 않음 | 의미 판단 |
| 30 | 벤더 경계: 벤더 다른 기능은 공통 계층의 벤더 중립 interface 뒤 어댑터 빈 | 벤더 이름 분기는 문자열·의미 판단(모듈 방향만 A-DIR이 잡는다) |
| 31 | 우리 클래스는 `@Component` 등으로 스캔, `@Bean`·`new` 조립은 어노테이션을 붙일 수 없는 외부 객체이거나 설정값마다 여러 개일 때만, 이유를 주석에 | 「이유가 주석에 있는가」는 의미 판단. 시범 코드의 `@Bean`은 모두 이유 주석을 달았다 |
| 33 (solid-design) | 클래스당 변경 이유 하나(SRP), 변화 축은 구현 클래스를 더해서(OCP), 닫힌 집합은 sealed·완전 switch | 책임의 개수는 의미 판단 |
| 34 (DIP·OCP·LSP·ISP, Spring 대응표) | 구현을 `new`로 만들지 않고 생성자 주입; 확장 지점은 interface 구현 빈 + `List<인터페이스>` 주입; 프로파일·시험에서 같은 interface의 다른 빈으로 바꿔도 의미 동일; 주입 타입은 소비자가 쓰는 interface만큼 좁게 | 「구현을 new로 만든다」는 값 객체·외부 라이브러리 객체와 구분할 수 없다(`getBean`만 A-DIP이 잡는다) |
| 34 (solid-design) | interface는 소비자 역할 단위로 좁게, 변화 축(SSH 전송·저장·시각·호스트 hook·인증·외부 I/O) 경계에만, 내부 클래스마다 interface 금지, 상속보다 조합 | 「어느 경계인가」는 의미 판단. UnsupportedOperationException만 A-LSP가 잡는다 |
| 32 일부 | 불변 record의 불변식을 compact constructor에서 검사 | 어떤 record가 불변식을 가져야 하는지는 의미 판단(시범 `ContractEnvelope`·`Limits`가 그렇게 했다) |
| 35 일부 | `isPresent()` 뒤 `get()`, `orElse(null)`, `Optional.empty()`로 없음·미지원·미확인·실패를 뭉치기 | 기계 검사 불가, 검토 항목: 두 호출이 짝인지·`orElse`의 인자가 null인지·`empty`의 뜻은 바이트코드로 가를 수 없다(A-OPTIONAL-SLOT·A-OPTIONAL-GET은 슬롯과 `get()`만 잡는다) |
| 35 일부 | 컬렉션 요소가 `Optional`인 경우(`List<Optional<T>>`) | 기계 검사 불가, 검토 항목: A-OPTIONAL-SLOT은 필드·매개변수의 원시 타입만 본다(제네릭 인자는 보지 않는다) |
| 안티패턴 Z2·D3 | A-CHARSET·A-SLEEP이 포함하지 않는 API: `FileReader`·`FileWriter`·`PrintWriter`·`Scanner(InputStream)`·`ByteArrayOutputStream.toString()`의 기본 문자셋, `toLowerCase()`·`String.format`의 기본 로캘, `LockSupport.parkNanos`·`TimeUnit.sleep`·빈 본문 바쁜 대기 | 기계 검사 불가, 검토 항목: 이번 규칙의 범위 밖이다(필요하면 규칙을 더하되 fixture로 증명한다) |

## 3. 시범 (a) — MCP 서버가 Contract 2.0 모양을 낼 수 있는가 (`portal-web`, `McpContractSpikeTest`)

시험은 `@SpringBootTest(webEnvironment = RANDOM_PORT)`로 Spring AI MCP 서버(webmvc, `spring.ai.mcp.server.protocol=STREAMABLE`, 경로 `/mcp`)를 실제로 띄우고, `RestClient`로 실제 HTTP JSON-RPC를 보낸다(mock 없음). 도구 두 개(`targets`, `submit`)는 `List<SyncToolSpecification>` 빈, 리소스 하나는 `List<SyncResourceSpecification>` 빈으로 등록한다. `inputSchema`는 `src/adapters/mcp/public-contract.mjs`(v2.4.2, 77~83행)의 `publicInputSchemas.targets`·`submit` Zod 정의를 옮긴 JSON Schema 문자열이다: `additionalProperties:false`, `pattern`(`^[a-f0-9]{64}$` 등), `minLength`/`maxLength`, `enum`, `maxItems`, `required`. 정본은 `src/test/resources/contract-spike/*.json`이다.

| ID | 대상 | 입력 | 기대 | 판정 | 근거 |
|---|---|---|---|---|---|
| P-01 | `initialize` | POST `/mcp`, `Accept: application/json, text/event-stream`, 프로토콜 판 | 200, `result.capabilities`에 tools·resources, 응답 헤더 `Mcp-Session-Id` | 단언 | MCP 명세 2025-06-18 Transports: 「The client MUST include an Accept header, listing both application/json and text/event-stream」「A server … MAY assign a session ID … in an Mcp-Session-Id header」. https://modelcontextprotocol.io/specification/2025-06-18/basic/transports |
| P-02 | `tools/list` 개수·이름 | 세션 헤더, `notifications/initialized` 뒤 | 도구 이름 정확히 `targets`, `submit` | 단언 | MCP 명세 Tools: https://modelcontextprotocol.io/specification/2025-06-18/server/tools |
| P-03 | `inputSchema` 동등 | `tools/list` 응답의 각 `inputSchema` | 넣은 JSON 파일과 JSON 동등(키 순서 무관, 값 전부 동일) | `JsonNode.equals` | Spring AI 문서는 스키마 지정 방법을 적지 않음(공식 근거 미확인); 낮은 수준 API `McpServerFeatures.SyncToolSpecification`은 문서 확인: https://docs.spring.io/spring-ai/reference/api/mcp/mcp-streamable-http-server-boot-starter-docs.html 「or using the low-level API: @Bean public List<McpServerFeatures.SyncToolSpecification> myTools」 |
| P-04 | 원문 제약 보존 | `submit.inputSchema` | `additionalProperties:false`; `operationKey.pattern`가 `^[A-Za-z0-9_.:-]{16,128}(?![\s\S])` 원문; `kind.enum`=[command,source,download]; `argv.maxItems`=16; `argv.items.maxLength`=512; `command.maxLength`=32768; `source.maxLength`=16384; `context.maxLength`=8192; `required`=[kind, operationKey] | 개별 단언 | public-contract.mjs 7~14, 77~83행 |
| P-05 | 도구 `_meta` | `tools/list`의 `targets`(또는 submit) 항목 | `_meta`가 넣은 `{ui:{resourceUri:"ui://ssh-approval/card-test.html", visibility:["model","app"]}}`와 동일 | 단언 | MCP Apps 명세: 「URI of UI resource for rendering tool results」(`_meta.ui.resourceUri`), 「`visibility` defaults to ["model", "app"] if omitted」 https://github.com/modelcontextprotocol/ext-apps/blob/main/specification/2026-01-26/apps.mdx . Tool `_meta` 전달은 Spring AI 문서에 없음(공식 근거 미확인), MCP Java SDK 2.1.0 `McpSchema.Tool.Builder.meta(Map)`로 확인 |
| P-06 | `resources/list` | `resources/list` | 항목 uri `ui://ssh-approval/card-test.html`, `mimeType`가 정확히 `text/html;profile=mcp-app` | 단언 | MCP Apps 명세: 「MUST use the ui:// URI scheme」「`mimeType` MUST be `text/html;profile=mcp-app`」. Spring AI 문서: 「Automatic resource specification through Spring beans: @Bean public List<McpServerFeatures.SyncResourceSpecification>」 |
| P-07 | `resources/read` | 같은 uri | `contents[0].mimeType` 동일, `text`가 등록한 HTML 바이트와 동일, `contents[0]._meta.ui`가 넣은 값(`prefersBorder`, `csp`)과 동일 | 단언 | MCP Apps 명세 `_meta.ui`(csp, prefersBorder) |
| P-08 | `tools/call targets` | 인자 `{}` | `result.structuredContent`와 `result.content[0].text`가 둘 다 있고 `content[0].text`를 JSON으로 읽으면 `structuredContent`와 JSON 동등; `isError`가 참이 아님 | 단언 | MCP 명세 Tools: 「a tool that returns structured content SHOULD also return the serialized JSON in a TextContent block」 |
| P-09 | `tools/call submit` 검증 | 스키마에 없는 필드를 넣은 인자 | 서버가 거절하는지(오류 응답 또는 `isError`) 관찰해 기록. 기대는 거절. 거절하지 않으면 서버 쪽 검증이 없는 것이므로 어댑터가 직접 검증해야 한다고 보고 | 관찰 기록(통과·실패 모두 근거와 함께 기재) | 공식 근거 미확인(SDK 동작을 실행으로 확인) |

추가 사례(첫 실행에서 드러난 것):

| ID | 대상 | 입력 | 기대 | 판정 | 근거 |
|---|---|---|---|---|---|
| P-10 | 구조화 결과의 null 처리(`NullInclusionSpikeTest`, 별도 패키지) | `@JsonInclude` 없는 record(`b`=null)를 `structuredContent`로, 같은 값을 Boot `JsonMapper`로 쓴 문자열을 텍스트로 싣는 도구를 `tools/call` | 실제 응답에서 `content[0].text`는 `{"a":"x","b":null}`, `structuredContent`에는 `b`가 없다. 그래서 계약 record는 `@JsonInclude(ALWAYS)`를 단다(첫 실행의 P-08 실패 원인: `structuredContent`에는 `error`·`defaultTarget`이 빠지고 `content[0].text`에는 `null`로 있었다) | 단언 | 공식 근거 미확인(실행으로 확인). 어느 매퍼가 null을 빼는지는 이번에 특정하지 못했다(Spring AI `McpServerJsonMapperAutoConfiguration`의 매퍼는 NON_NULL 기본 포함으로 만들어지지만 이 컨텍스트에는 그 이름의 빈이 없고, `McpJsonDefaults` 매퍼는 null을 쓴다). 효과(wire)만 확정 |

## 4. 시범 (b) — 두 포트를 부모+자식 컨텍스트로 나누는 방식 (`portal-server`, `PortsSpikeTest`)

`SpringApplicationBuilder`로 부모(비웹 `ApplicationContext`, 공유 빈 `SharedCounter`) + 자식 웹 컨텍스트 둘(MCP용: Spring AI MCP 자동 설정 + `/api`가 없는 컨트롤러; 관리자용: `/api/x`, MCP 자동 설정 끔)을 `server.port=0`으로 띄운다.

| ID | 대상 | 입력 | 기대 | 판정 | 근거 |
|---|---|---|---|---|---|
| Q-01 | 기동 | 부모 + 자식 둘 | 컨텍스트 3개 기동, 자식 두 개의 실제 포트가 0이 아니고 서로 다름 | 단언 | Boot 공식: 「If you need to build an ApplicationContext hierarchy (multiple contexts with a parent/child relationship) … you can use the SpringApplicationBuilder.」「Web components must be contained within the child context, and the same Environment is used for both parent and child contexts.」 https://docs.spring.io/spring-boot/reference/features/spring-application.html |
| Q-02 | MCP 포트 경로 | MCP 포트로 POST `/mcp`(initialize), GET `/api/x` | `/mcp` 200, `/api/x` 404 | 실제 HTTP | 같음 |
| Q-03 | 관리자 포트 경로 | 관리자 포트로 GET `/api/x`, POST·GET `/mcp` | `/api/x` 200(본문 확인), `/mcp` 404 | 실제 HTTP | 같음. 관리자 자식에서 MCP 서버를 끄는 속성은 `spring.ai.mcp.server.enabled`(Spring AI 문서 표) |
| Q-04 | 부모 빈 공유 | 부모의 `SharedCounter` | 두 자식 모두 같은 인스턴스(동일성), MCP 포트의 요청이 올린 값을 관리자 포트의 요청이 읽음 | 동일성 + 실제 HTTP | Spring Framework: 자식 컨텍스트는 부모 빈을 본다(`ApplicationContext` 계층) — 공식 근거 미확인(문서 원문은 열지 않음), 실행으로 확인 |
| Q-05 | 종료 | 부모 close | 두 포트 모두 연결 거절 | 단언 | 공식 근거 미확인, 실행으로 확인 |
| Q-06 | 대안 검토(문서) | — | Boot의 다른 표준 방식: (1) 한 컨텍스트에 추가 Tomcat 커넥터(`addAdditionalConnectors`), (2) `management.server.port`. 둘이 더 단순한지 판단 | 문서 근거로 판단, (1)은 Q-07로 실측 | Boot how-to: 「You can add an Connector to the TomcatServletWebServerFactory, which can allow multiple connectors」(예: 포트 8081 커넥터)이나 같은 DispatcherServlet·같은 경로 집합을 두 포트가 공유하고 포트별 경로 제한 방법은 문서에 없다. Actuator: 「You can set the management.server.port property to change the HTTP port」는 actuator 엔드포인트용(임의 컨트롤러를 올릴 수 있다는 문장 없음). official-docs-spring.md Q1(b)(c). https://docs.spring.io/spring-boot/how-to/webserver.html , https://docs.spring.io/spring-boot/reference/actuator/monitoring.html |
| Q-07 | 대안 실측: 한 컨텍스트 + 추가 커넥터 + 포트별 경로 제한 필터. `ConnectorsSpikeTest`(추가 커넥터 방식 시범)는 채택하지 않아 메인 판정으로 삭제했다(근거: 커밋 8321134 이력). 아래 판정 기록은 삭제 전 실행 결과로 남긴다 | MCP 포트·관리자 포트로 `/mcp`, `/api/x` | MCP 포트: `/mcp` 200, `/api/x` 404. 관리자 포트: `/api/x` 200, `/mcp`(POST·GET) 404. 판정 기준은 Q-02·Q-03과 같다 | 실제 HTTP | 같음. 경로 제한 필터(`request.getLocalPort()`)는 공식 근거 미확인(서블릿 API) |

## 5. 시범 (c) — MINA SSHD 클라이언트로 exec·SFTP·TOFU (`portal-ssh`, `SshSpikeTest`)

시험 안에서 MINA `SshServer`(포트 0, 임시 호스트 키는 메모리 키, 임시 루트의 `VirtualFileSystemFactory`, 비밀번호 인증, `SftpSubsystemFactory`, 실제 셸 없이 `CommandFactory`가 명령을 처리)를 띄운다. 클라이언트는 `SshClient`다. 외부 네트워크·실제 SSH 서버 접속은 없다.

| ID | 대상 | 입력 | 기대 | 판정 | 근거 |
|---|---|---|---|---|---|
| S-01 | exec 정상 | 명령 `echo hello`(CommandFactory가 stdout에 `hello\n`, 종료 코드 0) | stdout `hello\n`, stderr 빈, 종료 코드 0 | 단언 | MINA 문서: ClientSession `executeRemoteCommand` 등 — https://github.com/apache/mina-sshd/blob/master/docs/client-setup.md 「one can use several of the available ClientSession#executeRemoteCommand overloaded methods」 |
| S-02 | exec stderr·종료 코드 | 명령 `fail 3`(stderr `boom\n`, 종료 코드 3) | stdout 빈, stderr `boom\n`, 종료 코드 3 | 단언 | `ChannelExec` 사용(같은 문서) |
| S-03 | exec 시간 한도 | 명령 `hang`(서버는 채널이 닫힐 때까지 끝내지 않음), 한도 1초 | `waitFor(CLOSED, 1s)`가 `TIMEOUT`을 돌려줌 → 클라이언트가 채널을 닫음 → 서버 쪽 명령의 `destroy()`가 호출됨(채널 종료가 서버에 전달) | 단언(서버 측 래치) | 문서는 `waitFor(EnumSet.of(ClientChannelEvent.CLOSED), 0L)`(0은 무한 대기)만 보임, `TIMEOUT`은 문서에 없음 → 공식 근거 미확인, 실행으로 확인 |
| S-04 | SFTP 업로드 | 1 MiB 무작위 바이트를 `/up/a.bin` | 서버 임시 루트의 파일 바이트가 입력과 같음 | 단언 | MINA: `SftpClient` — 공식 문서 페이지 미열람(공식 근거 미확인) |
| S-05 | SFTP 다운로드 | 같은 파일 | 받은 바이트가 입력과 같음 | 단언 | 같음 |
| S-06 | 임시 파일→rename 교체, 확장 광고 | 기존 `/b.txt`("old"), `/b.txt.tmp`("new") 업로드 뒤 `rename(…, CopyMode.Overwrite)`; 서버가 광고하는 SFTP 확장 목록 | 결과 `b.txt`=="new", `.tmp` 없음. 시험 서버(MINA)의 광고 확장에 `posix-rename@openssh.com`이 없다(문서: 「posix-rename@openssh.com - only client side」) — 있는지 없는지를 단언하고 실제 값을 6절에 기록 | 단언 + 관찰 | MINA docs/sftp.md(official-docs-platform.md Q1 SFTP 절 인용). rename 동작 자체는 공식 근거 미확인 |
| S-07 | TOFU 처음 본 키·같은 키 | 빈 known_hosts(`DefaultKnownHostsServerKeyVerifier`, 위임=`AcceptAllServerKeyVerifier`)로 접속, 다시 접속 | 첫 접속 성공 + known_hosts에 줄 1개(ecdsa-sha2-nistp256); 두 번째 접속 성공 + 파일 그대로 | 단언 | MINA docs/client-setup.md: 「KnownHostsServerKeyVerifier … validate the server key」, 기본 검증기는 모두 수락(official-docs-platform.md Q1 TOFU 절). `DefaultKnownHostsServerKeyVerifier`는 그 하위 클래스(바이트코드로 확인); 동작 계약은 소스 근거(KnownHostsServerKeyVerifier.java `acceptUnknownHostKey` 「by default invokes the delegate」) |
| S-08 | TOFU 바뀐 키 | 같은 포트에서 호스트 키만 바꾼 서버로 접속 | 접속 거절(`IOException`), known_hosts 변경 없음 | 단언 | 소스 근거: `getModifiedServerKeyAcceptor` 「If null then assumed to reject such a modification」(official-docs-platform.md Q1 TOFU 절) |
| S-09 | 인증 | 틀린 비밀번호 | 인증 실패(`IOException`) | 단언 | `PasswordAuthenticator`: 「PasswordAuthenticator for password based authentication」 https://github.com/apache/mina-sshd/blob/master/docs/server-setup.md |

## 6. 실행 결과

명령: `./gradlew --no-daemon --console=plain --max-workers=1 -Pportal.test.forks=1 build` → `BUILD SUCCESSFUL`, 종료 코드 0. 로그 `D:/codex/build/tools/runs/ssh-portal-v300-found.log`.
시험 72건(8321134·2a06896), skipped 0, failures 0, errors 0(`*/build/test-results/test/*.xml`: ArchitectureRulesTest 21, RuleFixturesTest 23, TestIsolationTest 3, McpContractSpikeTest 9, NullInclusionSpikeTest 1, PortsSpikeTest 5, ConnectorsSpikeTest 1, SshSpikeTest 9).
보정 뒤(생성자 주입·PER_CLASS·`Objects.equals`·`ConnectorsSpikeTest` 삭제·A-OPTIONAL-SLOT/GET·A-CHARSET·A-SLEEP 추가): `BUILD SUCCESSFUL in 41s`, 종료 코드 0, 시험 79건, skipped 0, failures 0, errors 0, 출력의 warning·deprecat 0줄(메인 실행). 클래스별 `@Test` 수: ArchitectureRulesTest 25(+4), RuleFixturesTest 27(+4), TestIsolationTest 3, McpContractSpikeTest 9, NullInclusionSpikeTest 1, PortsSpikeTest 5, SshSpikeTest 9, ConnectorsSpikeTest 삭제(−1). 72 − 1 + 8 = 79. javac 경고: `compileJava`·`compileTestJava` 20개 작업을 `--rerun-tasks`로 다시 돌려 `warning:` 0줄(`…-recompile.log`).

관찰 값과 발견:

| 항목 | 결과 |
|---|---|
| P-01 initialize | `protocolVersion` 2025-06-18을 요청하면 2025-06-18, 2025-11-25를 요청하면 2025-11-25를 돌려준다(SDK 2.1.0 선언 범위와 일치). 세션 헤더 `Mcp-Session-Id` 발급, 응답은 SSE(`data:` 줄) 또는 JSON 어느 쪽이든 시험 클라이언트가 읽는다 |
| P-03 inputSchema | `Tool.builder(name, McpJsonMapper, String)`로 JSON Schema 문자열을 그대로 줄 수 있다. wire의 `inputSchema`는 넣은 JSON과 JSON 동등이고 `$schema`(draft-07)·`additionalProperties:false`·`pattern`(`(?![\s\S])` 포함)·길이·`enum`·`maxItems`가 그대로 나간다. `Tool.builder()`·`Resource.builder()`·`ReadResourceResult(List)` 등 인자 없는 형태는 SDK 2.1.0에서 deprecated라 `-Werror` 아래에서는 쓸 수 없다(인자 있는 `builder(...)` 사용) |
| P-05 `_meta` | 도구 `_meta`(`ui.resourceUri`, `visibility`)가 그대로 나가고, `_meta`를 주지 않은 도구는 키를 보내지 않는다 |
| P-06·P-07 리소스 | `ui://ssh-approval/card-test.html`, `mimeType`는 `text/html;profile=mcp-app` 그대로, `resources/read`의 내용·`contents[0]._meta.ui`(csp·prefersBorder)도 그대로 |
| P-08 결과 | `structuredContent`와 `content[0].text`가 같은 JSON. **첫 실행은 실패했다**: 계약 봉투의 `error:null`·`defaultTarget:null`이 `structuredContent`에서 빠졌다(P-10). 계약 record에 `@JsonInclude(ALWAYS)`를 달아 고쳤다. 달지 않으면 호스트가 `structuredContent`로 읽을 때 Contract 2.0의 명시적 null 키가 사라진다 |
| P-09 서버 쪽 검증 | 스키마에 없는 필드와 짧은 `operationKey`(pattern 위반)를 서버가 거절한다(`isError` 또는 JSON-RPC 오류). 즉 입력 스키마가 광고만이 아니라 호출 전에 검증으로도 쓰인다 |
| Q-01..05 | 부모(비웹) + 자식 웹 컨텍스트 둘이 서로 다른 포트에서 기동. MCP 포트: `/mcp` 200, `/api/x` 404. 관리자 포트: `/api/x` 200, `/mcp` 404(POST·GET). 부모 빈(`SharedCounter`, auto-configured `DataSource`)을 두 자식이 같은 인스턴스로 공유하고 자식이 자기 `dataSource`를 만들지 않는다. 부모를 닫으면 두 포트 모두 닫힌다. 조건: 부모에 `spring.ai.mcp.server.enabled=false`, 관리자 자식에 `false`, MCP 자식에만 `true`(MCP 자동 설정이 관리자 자식에서 꺼져 있어야 관리자 포트에 `/mcp`가 없다) |
| Q-07 | 한 컨텍스트 + 추가 Tomcat 커넥터 + 포트별 경로 제한 필터(`getLocalPort()`)로도 같은 판정 기준을 만족했다(8321134의 `ConnectorsSpikeTest` 실행 결과). 이 시범은 채택하지 않아 메인 판정으로 삭제했다(근거: 커밋 8321134 이력). 판정 기록은 남긴다 |
| Q 비교 | 자식 컨텍스트 방식은 필터·포트 번호 비교 없이 경로 집합이 컨텍스트로 갈라지고(경로 제한이 구조), 인프라 빈은 부모에서 공유된다. 커넥터 방식은 코드가 더 적지만 경로 제한을 포트 번호 비교 필터로 직접 짜야 하고 두 포트가 같은 DispatcherServlet·같은 보안 설정을 공유한다(인증 방식을 포트별로 다르게 둘 때 불리). 공식 문서는 어느 쪽도 권장하지 않는다(official-docs-spring.md Q1). 계획은 자식 컨텍스트 방식 유지가 타당하다고 본다. 이 판단은 메인 몫 |
| S-01..05 | exec stdout·stderr·종료 코드(0, 3), 시간 한도 초과 시 `waitFor`가 `TIMEOUT`을 돌려주고 `close(false)` 뒤 서버 명령의 `destroy()`가 호출됨, SFTP 1 MiB 업로드·300 KB 다운로드가 바이트 동일 |
| S-06 | MINA 2.20.1 SFTP 서버가 `posix-rename@openssh.com`을 광고한다(문서 docs/sftp.md는 「only client side」로 적었으나 서버 광고는 시험으로 관찰). `rename(…, CopyMode.Overwrite)`로 기존 파일 교체 성공, 임시 파일 사라짐. Windows OpenSSH 서버(sftp-server)가 광고하는지는 이 시험으로 알 수 없다(미검증) |
| S-07..09 | `DefaultKnownHostsServerKeyVerifier`(위임=모두 수락): 첫 키 기록(줄 1개, ecdsa-sha2-nistp256), 같은 키 재접속 성공·파일 불변, 같은 포트에서 키가 바뀐 서버는 거절·파일 불변, 틀린 비밀번호는 인증 실패 |

미검증: Windows OpenSSH 서버·Linux OpenSSH 서버에 대한 exec·SFTP(이번 시험 서버는 MINA 자신이다), direct-tcpip, ProxyJump, 호스트 간 세션 재연결, Spring Security·인증, jlink·설치 스크립트.
