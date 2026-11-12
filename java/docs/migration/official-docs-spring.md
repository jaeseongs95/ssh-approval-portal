# 공식 문서 조사: ssh-approval-portal 3.0.0 Java 전환 설계 전제 (Spring Boot 4.1 / Spring AI 2.0 / MCP / Spring Security 7)

조사일 2026-11-12. 읽기 전용 조사이며 코드는 실행하지 않았다. 근거는 웹 공식 문서(docs.spring.io, modelcontextprotocol.io, h2database.com, freedesktop.org, developers.cloudflare.com)와 공식 저장소(github.com/modelcontextprotocol/*, github.com/spring-projects/*)뿐이다. 공식 저장소 소스를 근거로 쓴 곳은 「공식 저장소」로 표시했다.

방법 한계(사실): 문서는 WebFetch(요약 모델 경유)로 읽었다. 인용 문장은 반환된 원문을 그대로 옮겼으나 요약 단계에서 생략·축약됐을 수 있다. 코드에 옮기기 전에 URL 앵커에서 한 번 더 대조하기를 권한다.

판본 요약(직접 확인)
- Spring Boot 4.1.2 (docs.spring.io 「Stable」 표시), Spring Framework 7.0.10, Spring Security 7.1.2, Spring Data Relational 4.1.2, Spring AI 2.0.2.
- Spring AI 2.0.2의 MCP Java SDK는 2.1.0이다(공식 저장소 `spring-ai` v2.0.2 `pom.xml`: `<mcp.sdk.version>2.1.0</mcp.sdk.version>`, `<spring-boot.version>4.1.2</spring-boot.version>`).
- MCP 명세의 현재(Current) 판은 2026-07-28이다(https://modelcontextprotocol.io/specification/versioning). MCP Java SDK v2.1.0의 `ProtocolVersions`는 2024-11-05, 2025-03-26, 2025-06-18, 2025-11-25까지다(공식 저장소 `ProtocolVersions.java`).

---

## 계획 전제와 어긋나거나 보강이 필요한 것 (먼저 읽을 것)

| # | 계획 문장(「구조」·단계) | 공식 근거 | 판정 |
|---|---|---|---|
| A | 「portal-store … ANSI 마이그레이션 `V{n}__*.sql` + 이력 표 + `ResourceDatabasePopulator`」 | Boot 문서는 `V<VERSION>__<NAME>.sql` 형식·이력 관리를 Flyway가 이미 제공하고 `spring-boot-starter-flyway`가 「In-memory and file-based databases」를 지원한다고 쓴다(Q5-3). `schema.sql`/`data.sql`을 Flyway와 함께 쓰는 것은 「not recommended and support will be removed in a future release」. `ResourceDatabasePopulator`는 Spring Framework Javadoc에는 있으나 Boot 문서의 마이그레이션 안내에는 없다. | 이력 표를 손으로 짜는 설계는 개발원칙 2.1(공식 문서 → 라이브러리 순)과 충돌 소지가 있다. Flyway를 쓰거나, 쓰지 않는 이유를 이 문서의 인용과 함께 남겨야 한다. 결정은 메인. |
| B | 「H2 기본 … `spring.sql.init.*`」(단계 2: 스키마 초기화) | Boot 문서: 「By default, SQL database initialization is only performed when using an embedded in-memory database.」 Boot 소스: H2는 `url.contains(":h2:mem")`일 때만 embedded로 판정(공식 저장소). | H2 **파일** URL(`jdbc:h2:file:…`)은 기본 모드(`embedded`)에서 초기화되지 않는다. `spring.sql.init.mode=always`가 필요하다(Q5-1). |
| C | 「Spring AI MCP … Contract 2.0 기준본대로」 + 에이전트 호스트 3종 | MCP 현재 판 2026-07-28은 initialize 핸드셰이크 대신 요청마다 `_meta`의 protocolVersion을 싣는 무상태 프로토콜이고 결과에 `resultType`이 필수다. 그러나 Spring AI 2.0.2가 쓰는 MCP Java SDK 2.1.0은 2025-11-25까지만 선언한다. | 이 SDK로는 2025-11-25 이하 판 서버가 된다. 호스트(Claude Code·Codex·Antigravity)가 어느 판을 협상하는지는 이 조사 범위 밖이라 **미확인**. 1단계 시범에서 실측. |
| D | 「MCP bearer … Spring Security」 | Spring AI의 MCP 보안 문서는 「part of the spring-ai-community/mcp-security project … not officially endorsed yet」, 「WIP」, WebMVC 전용, JWT 전용(opaque 불가)이라고 쓴다(Q2-8). | `mcp-server-security`(커뮤니티)는 공식 지원이 아니다. 계획의 「token/Access JWT/OIDC JWT, MCP bearer」는 Spring Security 본체 기능(Q4)으로 구성하는 쪽이 공식 범위다. 고정 bearer 토큰 전용 공식 안내는 찾지 못했다(Q4-4). |
| E | 「포트 두 개는 부모 컨텍스트 + 자식 웹 컨텍스트 2개」 | `SpringApplicationBuilder` parent/child는 공식(Q1-a). 그러나 「Web components must be contained within the child context, and the same Environment is used for both parent and child contexts」. 웹 자식 둘이 서로 다른 `server.port`를 갖는 예는 공식 문서에서 찾지 못했다. Spring AI MCP 전송 빈이 자식 컨텍스트에서 동작하는지에 대한 공식 안내도 찾지 못했다. | 계획대로 1단계 실측으로 확정해야 하는 항목이다. 공식으로 확인된 대안은 `TomcatServletWebServerFactory.addAdditionalConnectors`(Q1-b)이나, 커넥터(포트)별로 경로를 제한하는 공식 방법은 찾지 못했다. |
| F | 「`BRIDGE_MCP_TOKEN` 등이 그대로 바인딩된다」 | 참조 문서 규칙: 점→밑줄, **대시 제거**, 대문자(`spring.main.log-startup-info` → `SPRING_MAIN_LOGSTARTUPINFO`). 즉 문서상 `bridge.mcp-token`의 환경 변수 이름은 `BRIDGE_MCPTOKEN`이다. 공식 저장소 `SystemEnvironmentPropertyMapper.map`은 `SYSTEM_ENVIRONMENT`와 `LEGACY_SYSTEM_ENVIRONMENT`(대시를 밑줄로 치환) 두 형식을 모두 후보로 만든다. | `BRIDGE_MCP_TOKEN`이 `bridge.mcp-token`에 붙는 근거는 **소스뿐**이고 참조 문서에는 없다(Q7-2). 시험으로 고정하고, 문서상 형식(`BRIDGE_MCPTOKEN`)과 다름을 기록해 둘 것. |
| G | 「환경 편집 … 앱이 정해진 종료 코드로 끝나면 systemd `Restart=`가 다시 띄운다」 | Boot 문서의 systemd 예는 `Restart=`를 쓰지 않고 `SuccessExitStatus=143`만 있다. `Restart=`의 의미는 systemd 문서에 있다(Q6 보충). `on-failure`는 비정상 종료 코드에서 재시작하고, 종료 코드 0은 재시작하지 않는다. | 설정 변경용 종료 코드는 0이 아니어야 `on-failure`로 재시작된다. 또는 `RestartForceExitStatus=`를 쓴다. |
| H | 「패키징: Gradle로 `bootJar`와 jlink 런타임」 | Boot 4.1.2 Gradle 플러그인 문서와 효율적 배포 문서에 jlink 안내는 없다(Q8). | 공식 안내 없음. jlink는 JDK 도구이며 Boot 문서 범위 밖이다. 이 부분의 근거는 JDK 문서에서 따로 찾아야 한다(이번 조사 범위 밖). |

계획과 일치하는 것: `spring-ai-starter-mcp-server-webmvc` + `protocol=STREAMABLE`, `@ConfigurationProperties` record 바인딩(`@DefaultValue`, `@Valid`), `ProblemDetail`(`spring.mvc.problemdetails.enabled`), `ExitCodeGenerator`·`SpringApplication.exit`, Spring Data JDBC enum 이름 매핑, 다중 `SecurityFilterChain` + `JwtIssuerAuthenticationManagerResolver`, MCP Apps(`ui://`, `text/html;profile=mcp-app`, `_meta.ui.resourceUri`).

---

## Q1. 서로 다른 두 포트에 서로 다른 엔드포인트 집합

### (a) SpringApplicationBuilder parent/child 웹 컨텍스트
- 결론: 공식 문서에 부모/자식 컨텍스트 계층 API가 있다. 단, 웹 구성요소는 자식에 있어야 하고 Environment는 공유된다고 제한한다. 자식 웹 컨텍스트마다 다른 `server.port`를 주는 공식 예제는 **찾지 못함**. 권장 여부에 대한 문장도 없다.
- 원문:
  > If you need to build an `ApplicationContext` hierarchy (multiple contexts with a parent/child relationship) or if you prefer using a fluent builder API, you can use the `SpringApplicationBuilder`.

  > There are some restrictions when creating an `ApplicationContext` hierarchy. For example, Web components **must** be contained within the child context, and the same `Environment` is used for both parent and child contexts. See the `SpringApplicationBuilder` API documentation for full details.
- Javadoc(`SpringApplicationBuilder`): `child(Class<?>...)` 「Create a child application with the provided sources. Default args and environment are copied down into the child, but everything else is a clean sheet.」, `sibling(Class<?>...)` 「Create a sibling application (one with the same parent).」
- URL: https://docs.spring.io/spring-boot/reference/features/spring-application.html#features.spring-application.fluent-builder-api , https://docs.spring.io/spring-boot/api/java/org/springframework/boot/builder/SpringApplicationBuilder.html
- 판본: Boot 4.1.2

### (b) 추가 Tomcat Connector + WebServerFactoryCustomizer
- 결론: 공식 how-to에 `addAdditionalConnectors` 예제가 있다(포트 8081 추가). 같은 컨텍스트·같은 서블릿이 두 포트를 함께 서비스하는 방식이며, 포트별 엔드포인트 제한 방법은 문서에 **없다**. 권장/비권장 언급 없음.
- 원문:
  > You can add an `Connector` to the `TomcatServletWebServerFactory`, which can allow multiple connectors, including HTTP and HTTPS connectors, as shown in the following example:
  ```java
  @Bean
  public WebServerFactoryCustomizer<TomcatServletWebServerFactory> connectorCustomizer() {
  	return (tomcat) -> tomcat.addAdditionalConnectors(createConnector());
  }
  private Connector createConnector() {
  	Connector connector = new Connector("org.apache.coyote.http11.Http11NioProtocol");
  	connector.setPort(8081);
  	return connector;
  }
  ```
- `WebServerFactoryCustomizer` 일반 설명(원문): 「If you need to programmatically configure your embedded servlet container, you can register a Spring bean that implements the WebServerFactoryCustomizer interface.」
- URL: https://docs.spring.io/spring-boot/how-to/webserver.html#howto.webserver.enable-multiple-connectors.tomcat , https://docs.spring.io/spring-boot/reference/web/servlet.html#web.servlet.embedded-container.customizing.programmatic
- 판본: Boot 4.1.2

### (c) management.server.port
- 결론: 공식 기능이나 **Actuator 관리 엔드포인트용**이다. 애플리케이션 엔드포인트 집합을 다른 포트에 내는 용도라는 문장은 없다(「The words "child" and "management context" do not appear」 — 해당 페이지 전문 검색 결과). 임의 컨트롤러를 이 포트에 올릴 수 있는지는 **공식 문서에서 찾지 못함**.
- 원문:
  > If, however, your application runs inside your own data center, you may prefer to expose endpoints by using a different HTTP port.
  > You can set the `management.server.port` property to change the HTTP port, as the following example shows: `management.server.port=8081`
  > If `management.server.port` is configured, `management.endpoints.web.base-path` is relative to `management.server.base-path`.
- URL: https://docs.spring.io/spring-boot/reference/actuator/monitoring.html#actuator.monitoring.customizing-management-server-port
- 판본: Boot 4.1.2
- 보충(포트 기본): `server.port`는 `SERVER_PORT` 환경 변수로 줄 수 있다(https://docs.spring.io/spring-boot/how-to/webserver.html#howto.webserver.change-port).

---

## Q2. Spring AI MCP Server 2.0.x (webmvc starter)

판본: Spring AI 2.0.2. SDK는 MCP Java SDK 2.1.0(위 pom).

1. Streamable HTTP 설정 키
   - 결론: `spring.ai.mcp.server.protocol=STREAMABLE`, 엔드포인트는 `spring.ai.mcp.server.streamable-http.mcp-endpoint`(기본 `/mcp`), `keep-alive-interval`(기본 null=끔), `disallow-delete`(기본 false).
   - 원문: 「Use the `spring-ai-starter-mcp-server-webmvc` dependency … and set the `spring.ai.mcp.server.protocol` property to `STREAMABLE`.」 표: `mcp-endpoint | Custom MCP endpoint path | /mcp`.
   - URL: https://docs.spring.io/spring-ai/reference/api/mcp/mcp-streamable-http-server-boot-starter-docs.html#_streamable_http_properties , #_common_properties
   - 주의: 같은 페이지의 예제 주석은 `spring-ai-starter-mcp-server-streamable-webmvc`로 적혀 있고 본문 의존성 이름과 다르다(문서 불일치). 본문의 `spring-ai-starter-mcp-server-webmvc`가 개요 페이지 표와도 일치한다.

2. 도구 등록 방식
   - 결론: (i) `@McpTool` 어노테이션(자동 스캔, `spring.ai.mcp.server.annotation-scanner.enabled` 기본 true), (ii) `ToolCallbackProvider`/`ToolCallback` 빈, (iii) 저수준 `List<McpServerFeatures.SyncToolSpecification>` 빈, 세 가지 모두 공식 문서에 있다. 이름이 같으면 먼저 나온 것이 쓰인다.
   - 원문(`#_tools`): 「or using the low-level API: `@Bean public List<McpServerFeatures.SyncToolSpecification> myTools(...)`」, 「Tools are de-duplicated by name, with the first occurrence of each tool name being used.」 `@McpTool` 예: 「@McpTool(name = "add", description = "Add two numbers together")」.
   - URL: https://docs.spring.io/spring-ai/reference/api/mcp/mcp-stdio-sse-server-boot-starter-docs.html#_tools , https://docs.spring.io/spring-ai/reference/api/mcp/mcp-server-boot-starter-docs.html#_mcp_server_annotations , https://docs.spring.io/spring-ai/reference/api/mcp/mcp-annotations-server.html#_mcptool
   - 주의: `type=SYNC`이면 동기 메서드만 등록된다(`#_syncasync_server_api_options`).

3. 입력 JSON Schema를 직접 문자열로 줄 수 있는가
   - 결론: Spring AI 문서에는 직접 지정 방법이 **없다**(`@McpTool`은 「automatic JSON schema generation」). 단 MCP Java SDK(공식 저장소, v2.1.0 `McpSchema.java`)에 `Tool.Builder.inputSchema(McpJsonMapper jsonMapper, String inputSchema)`와 `inputSchema(Map<String,Object>)`가 있다. 따라서 `SyncToolSpecification` 빈 + 이 빌더로 문자열 스키마를 줄 수 있다(공식 저장소 소스 근거, 공식 문서 문장은 아님).
   - 원문(소스): `public Builder inputSchema(Map<String, Object> inputSchema)`, `public Builder inputSchema(McpJsonMapper jsonMapper, String inputSchema)`, `@Deprecated public Builder inputSchema(JsonSchema inputSchema)`. `Tool` record의 `inputSchema` 필드는 v2.1.0에서 `Map<String, Object>`다(v1.1.5에서는 `JsonSchema`).
   - 동적 스키마: `@McpTool` 메서드가 `CallToolRequest`를 받으면 임의 인자를 받는다(`#_dynamic_schema_support`). 입력 스키마를 정하는 것은 아니다.
   - URL: https://github.com/modelcontextprotocol/java-sdk/blob/v2.1.0/mcp-core/src/main/java/io/modelcontextprotocol/spec/McpSchema.java

4. 도구 `_meta`·annotations·outputSchema
   - 결론: 지원. `@McpTool`에 `annotations`(@McpAnnotations: title, readOnlyHint, destructiveHint, idempotentHint, openWorldHint), `generateOutputSchema`(기본 false), `metaProvider`(「supplies data for the `_meta` field in the tool declaration」)가 있다. 저수준에서는 `Tool` record가 `outputSchema`, `annotations`, `_meta`(`@JsonProperty("_meta") Map<String,Object> meta`)를 가진다.
   - 원문: `generateOutputSchema` 「If `true`, automatically generates a JSON output schema for non-primitive return types.」, `metaProvider` 「Class implementing `MetaProvider` that supplies data for the `_meta` field in the tool declaration.」
   - URL: https://docs.spring.io/spring-ai/reference/api/mcp/mcp-annotations-server.html#_annotation_attributes , #_tool_annotations_hints

5. `CallToolResult`의 structuredContent
   - 결론: SDK 레벨에서 지원(공식 저장소 소스): `CallToolResult(content, isError, structuredContent, _meta)`, `Builder.structuredContent(Object)`, `Builder.structuredContent(McpJsonMapper, String)`. Spring AI 문서의 `@McpTool` 쪽은 `CallToolResult` 반환 예(`addTextContent`)만 있고 structuredContent 처리 설명은 **찾지 못함**.
   - 원문(소스): `public record CallToolResult( @JsonProperty("content") List<Content> content, @JsonProperty("isError") Boolean isError, @JsonProperty("structuredContent") Object structuredContent, @JsonProperty("_meta") Map<String, Object> meta) implements Result`
   - URL: 위 소스 URL, https://docs.spring.io/spring-ai/reference/api/mcp/mcp-annotations-server.html#_dynamic_schema_support

6. 리소스(uri·mimeType) 등록
   - 결론: `@McpResource(uri, name, title, description, mimeType, metaProvider, annotations)`(`mimeType` 기본 `"text/plain"`)와 `List<McpServerFeatures.SyncResourceSpecification>` 빈, 둘 다 공식. `Resource` record는 `uri`, `name`, `title`, `description`, `mimeType`, `size`, `annotations`, `_meta`를 가진다(소스).
   - 원문: `mimeType | "text/plain" | The MIME type of the resource content.` / `@Bean public List<McpServerFeatures.SyncResourceSpecification> myResources(...)`
   - URL: https://docs.spring.io/spring-ai/reference/api/mcp/mcp-annotations-server.html#_mcpresource , https://docs.spring.io/spring-ai/reference/api/mcp/mcp-stdio-sse-server-boot-starter-docs.html#_resources
   - MCP Apps용 `ui://` 리소스와 `text/html;profile=mcp-app` 설정이 Spring AI 문서에 예로 나온 곳은 **찾지 못함**(`mimeType` 속성에 임의 문자열이 가능한지는 소스 미확인).

7. 서버 instructions
   - 결론: `spring.ai.mcp.server.instructions`(기본 null). `InitializeResult`에 `instructions` 필드(소스).
   - 원문: 표 「`instructions` | Optional instructions for client interaction | `null`」, 예제 `instructions: "This streamable server provides real-time notifications"`.
   - URL: https://docs.spring.io/spring-ai/reference/api/mcp/mcp-streamable-http-server-boot-starter-docs.html#_common_properties

8. 인증(Spring Security 연동) 공식 안내
   - 결론: 공식 참조 문서에 「MCP Security (WIP)」 페이지가 있으나 **커뮤니티 모듈**이다. WebMVC 전용, SSE 미지원, 불투명 토큰 미지원, API key 지원.
   - 원문: 「This module is part of the spring-ai-community/mcp-security project. This is a community-driven project and is not officially endorsed yet by Spring AI or the MCP project.」 / 「This module is compatible with Spring WebMVC-based servers only.」 / 「Opaque tokens are not supported. Use JWT.」 / 「This is still work in progress. The documentation and APIs may change in future releases.」
   - Spring Security 버전 요구는 이 페이지에 없다(미확인).
   - HTTP 헤더를 도구로 넘기는 공식 방법: `TransportContextExtractor`/`WebMvcStreamableServerTransportProvider.builder().contextExtractor(...)`, 도구에서 `McpSyncRequestContext.transportContext()` (https://docs.spring.io/spring-ai/reference/api/mcp/mcp-server-boot-starter-docs.html#_adding_data_to_mcptransportcontext).
   - SDK 문서 보안 주의(원문): 「HTTP transports do not validate the `Origin` or `Host` headers by default.」 (https://java.sdk.modelcontextprotocol.io/latest/server/#http-transport-security) — 계획의 Origin/Host 검증은 앱 몫이다.
   - URL: https://docs.spring.io/spring-ai/reference/api/mcp/mcp-security.html#_overview , #_known_limitations

기타 확인: Spring AI 2.0 개요는 「Spring AI 2.0 requires **MCP Java SDK 1.0.0** (RC1 or later)」라고 쓰는데 BOM(`pom.xml`)은 2.1.0이다(문서와 BOM 차이, https://docs.spring.io/spring-ai/reference/api/mcp/mcp-overview.html#_mcp_sdk_version_requirement). `mcp-spring-webmvc`는 SDK가 아니라 Spring AI 2.0+ 아티팩트(그룹 `org.springframework.ai`)다(https://github.com/modelcontextprotocol/java-sdk README).

---

## Q3. MCP 명세

### 3-1. tools/list의 inputSchema·outputSchema, structuredContent + content text 권고
- 결론: 2025-06-18, 2025-11-25, 2026-07-28 세 판 모두 같은 권고 문장이 있다. `outputSchema`를 주면 서버는 conforming한 structuredContent를 MUST 제공한다. 입력 스키마 기본 방언은 2020-12이고 인자 없는 도구는 `{ "type": "object", "additionalProperties": false }`가 Recommended다(2025-11-25 이후).
- 원문(모든 판 동일):
  > For backwards compatibility, a tool that returns structured content SHOULD also return the serialized JSON in a TextContent block.
  > If an output schema is provided: Servers **MUST** provide structured results that conform to this schema. Clients **SHOULD** validate structured results against this schema.
- 2025-11-25 원문:
  > `inputSchema`: JSON Schema defining expected parameters … Defaults to 2020-12 if no `$schema` field is present … **MUST** be a valid JSON Schema object (not `null`) … `{ "type": "object", "additionalProperties": false }` - **Recommended**: explicitly accepts only empty objects
- 2026-07-28 변경점: `structuredContent`가 객체 외 임의 JSON 값 가능(「This can be any JSON value (object, array, string, number, boolean, or null)」), 결과에 `resultType` 필수, `x-mcp-header` 신설, 도구 목록은 「MUST NOT vary per-connection」.
- URL: https://modelcontextprotocol.io/specification/2025-06-18/server/tools#structured-content , https://modelcontextprotocol.io/specification/2025-11-25/server/tools#structured-content , https://modelcontextprotocol.io/specification/2026-07-28/server/tools#structured-content , #output-schema , #tool
- 판본: 2025-06-18, 2025-11-25, 2026-07-28(Current)

### 3-2. `_meta` 규칙
- 결론: `_meta`는 MCP가 클라이언트·서버의 추가 메타데이터용으로 둔 일반 필드다. 키는 선택적 접두어 + 이름. 두 번째 라벨이 `modelcontextprotocol` 또는 `mcp`인 접두어는 MCP 예약이다. Tool 데이터 타입 목록(tools 페이지)에는 `_meta`가 별도 항목으로 나열되지 않는다.
- 원문(2025-11-25):
  > The `_meta` property/parameter is reserved by MCP to allow clients and servers to attach additional metadata to their interactions.
  > Any prefix where the second label is `modelcontextprotocol` or `mcp` is **reserved** for MCP use. … `com.example.mcp/` is NOT reserved, as the second label is `example`.
- 2026-07-28에는 `io.modelcontextprotocol/protocolVersion` 등 요청별 예약 키가 추가되고 「Official extensions define additional `_meta` keys under the `io.modelcontextprotocol/` prefix, and third-party extensions use their own vendor prefix.」
- URL: https://modelcontextprotocol.io/specification/2025-11-25/basic/index#meta , https://modelcontextprotocol.io/specification/2026-07-28/basic/index#meta
- 주의: 계획·계약 기준본이 자체 `_meta` 키를 쓴다면 위 접두어 규칙(`io.modelcontextprotocol/`, `…mcp/` 예약)에 걸리는지 확인해야 한다(기준본 내용은 이 조사에서 읽지 않음, 미확인).

### 3-3. 리소스 / instructions (보강)
- 리소스: `uri`, `name`, `title`, `description`, `mimeType`, `size`, `icons`(2025-11-25). 읽기 응답 `contents[{uri, mimeType, text|blob}]`. https://modelcontextprotocol.io/specification/2025-11-25/server/resources#data-types
- instructions: 초기화 응답의 `"instructions": "Optional instructions for the client"`. https://modelcontextprotocol.io/specification/2025-11-25/basic/lifecycle#initialization (2026-07-28은 initialize 대신 `server/discover`를 쓰므로 위치가 바뀌었는지는 이번에 읽지 않음, 미확인).

### 3-4. MCP Apps 확장
- 결론: 공식 명세는 ext-apps 저장소 `specification/2026-01-26/apps.mdx`(SEP-1865, 상태 「Stable (2026-01-26)」). 확장 식별자 `io.modelcontextprotocol/ui`. 공식 안내 페이지는 modelcontextprotocol.io/extensions/apps/overview다.
- 원문:
  > This extension is identified as: `io.modelcontextprotocol/ui`
  > MUST use the `ui://` URI scheme to distinguish UI resources from other
  > `mimeType` MUST be `text/html;profile=mcp-app` (other types reserved for future extensions)
  > Tools are associated with UI resources through the `_meta.ui` field: `resourceUri?: string;` (URI of UI resource for rendering tool results) … `visibility` Default: ["model", "app"]
  > Host MUST use `resources/read` to fetch the referenced resource URI
  > The flat `_meta["ui/resourceUri"]` format is deprecated. Use `_meta.ui.resourceUri` instead.
  > Clients advertise MCP Apps support in the initialize request using the extension identifier `io.modelcontextprotocol/ui`: `"capabilities": {"extensions": {"io.modelcontextprotocol/ui": {"mimeTypes": ["text/html;profile=mcp-app"]}}}`
  - 리소스 `_meta.ui`: `csp`, `permissions`, `domain`, `prefersBorder`(「Empty or omitted = no external connections (secure default)」).
- URL: https://github.com/modelcontextprotocol/ext-apps/blob/main/specification/2026-01-26/apps.mdx (공식 저장소), https://modelcontextprotocol.io/extensions/apps/overview
- 주의: 이 명세 안의 예시 `protocolVersion`은 "2024-11-05"로 적혀 있다(명세 본문 그대로). 2026-07-28 판에서 확장 협상 방식(initialize 부재)이 어떻게 적용되는지는 이번에 읽지 않음, 미확인.

---

## Q4. Spring Security 7.1.2: 한 앱에서 경로별 다른 인증

판본: Spring Security 7.1.2, Boot 4.1.2.

1. 다중 SecurityFilterChain (경로별 분리)
   - 결론: 공식. `SecurityFilterChain` 빈을 여러 개 두고 `@Order`와 `securityMatcher`로 나눈다. 어느 체인에도 안 맞는 요청은 보호되지 않는다는 점에 주의.
   - 원문: 「The key is to register multiple `SecurityFilterChain` `@Bean`s.」 / 「The `http.securityMatcher()` states that this `HttpSecurity` is applicable only to URLs that begin with `/api/`.」 / 「If no filter chain matches a particular request, the request is **not protected** by Spring Security.」
   - Boot 쪽: 「add a bean of type `SecurityFilterChain` (doing so does not disable the `UserDetailsService` configuration)」.
   - URL: https://docs.spring.io/spring-security/reference/servlet/configuration/java.html#_multiple_httpsecurity_instances , #_choosing_securitymatcher_or_requestmatchers , https://docs.spring.io/spring-boot/reference/web/spring-security.html#web.security.spring-mvc

2. (a) Cloudflare Access JWT (팀 도메인 certs JWKS, aud 검사)
   - Cloudflare 공식 문서: 토큰은 「`Cf-Access-Jwt-Assertion` request header」에 오고, 공개키는 「https://<your-team-name>.cloudflareaccess.com/cdn-cgi/access/certs」, 「The `aud` claim in the token payload specifies which application the JWT is valid for.」, 키는 6주마다 회전하며 「Validate tokens using the external endpoint rather than saving the public key as a hard-coded value.」 URL: https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/authorization-cookie/validating-json/
   - Spring Security 쪽 구성요소(공식): `NimbusJwtDecoder.withJwkSetUri(jwkSetUri).build()`(`#oauth2resourceserver-jwt-decoder-bean`), `JwtClaimValidator<List<String>>(AUD, aud -> aud.contains("messaging"))`와 `DelegatingOAuth2TokenValidator`(`#oauth2resourceserver-jwt-validation-custom`), 속성 `spring.security.oauth2.resourceserver.jwt.audiences`(`#_supplying_audiences`), 기본 신뢰 알고리즘은 RS256(`#oauth2resourceserver-jwt-decoder-algorithm`: 「By default, `NimbusJwtDecoder`, and hence Resource Server, will only trust and verify tokens using `RS256`.」).
   - 헤더 위치: Spring 기본은 `Authorization: Bearer`. 다른 헤더를 읽는 공식 방법은 `BearerTokenResolver` 빈(`DefaultBearerTokenResolver.setBearerTokenHeaderName`)이며 「in circumstances where a provider is using both a custom header and value, you can use `HeaderBearerTokenResolver` instead」(https://docs.spring.io/spring-security/reference/servlet/oauth2/resource-server/bearer-tokens.html#oauth2resourceserver-bearertoken-resolver). Cloudflare 헤더에 접두어가 없으므로 후자가 해당하는지는 **API 문서로 미확인**(해당 클래스 Javadoc은 읽지 않음).
   - 판정: 공식 구성요소로 가능. Cloudflare 전용 안내는 Spring 쪽에는 없다(Cloudflare 문서에는 Spring 예제가 없음).

3. (b) 일반 OIDC 발급자 JWKS
   - 원문: 「Resource Server will default to verifying the `iss` claim as well as the `exp` and `nbf` timestamp claims.」(`#oauth2resourceserver-jwt-validation`) / `issuer-uri` + `jwk-set-uri` 동시 지정 시 「We still specify the `issuer-uri` so that Resource Server still validates the `iss` claim on incoming JWTs.」 / 시계 오차 「By default, Resource Server configures a clock skew of 60 seconds.」
   - 체인별 디코더: `oauth2ResourceServer(o -> o.jwt(j -> j.jwkSetUri(...)))` 및 `jwt.decoder(myCustomDecoder())` 「will completely replace any Boot auto configuration of `JwtDecoder`」(`#oauth2resourceserver-jwt-jwkseturi-dsl`, `#oauth2resourceserver-jwt-decoder-dsl`). 따라서 체인마다 다른 디코더를 DSL로 줄 수 있다.
   - 여러 발급자 한 체인: 「`JwtIssuerAuthenticationManagerResolver.fromTrustedIssuers("https://idp.example.org/issuerOne", "https://idp.example.org/issuerTwo")`」 + `.oauth2ResourceServer(o -> o.authenticationManagerResolver(...))`, 발급자 엔드포인트는 지연 로딩(`#_resolving_the_tenant_by_claim`). 「The issuer should be one that the code can verify from a trusted source like a list of allowed issuers.」(`#_dynamic_tenants`)
   - URL: https://docs.spring.io/spring-security/reference/servlet/oauth2/resource-server/jwt.html , https://docs.spring.io/spring-security/reference/servlet/oauth2/resource-server/multitenancy.html

4. (c) 고정 bearer 토큰(관리자 토큰·MCP 토큰)
   - 결론: 정적 토큰 전용 공식 안내는 **공식 문서에서 찾지 못함**(찾아본 곳: resource-server/jwt.html, opaque-token.html, bearer-tokens.html, multitenancy.html). 가장 가까운 공식 확장점은 (i) 사용자 구현 `OpaqueTokenIntrospector` 빈(「exposing a `OpaqueTokenIntrospector` `@Bean` has the same effect as `introspector()`」, `#oauth2resourceserver-opaque-introspector-bean`)과 (ii) 요청 시점에 분기하는 `AuthenticationManagerResolver<HttpServletRequest>`(예제에서 「The implementation of `useJwt(HttpServletRequest)` will likely depend on custom request material like the path.」, `#oauth2reourceserver-opaqueandjwt`)다. 후자는 JWT와 opaque를 경로로 나누는 공식 예제이며, 고정 토큰을 `OpaqueTokenIntrospector`로 구현하는 것은 문서의 직접 예제가 아니라 확장점 응용이다.
   - URL: https://docs.spring.io/spring-security/reference/servlet/oauth2/resource-server/opaque-token.html#oauth2resourceserver-opaque-introspector-bean , https://docs.spring.io/spring-security/reference/servlet/oauth2/resource-server/multitenancy.html#oauth2reourceserver-opaqueandjwt

---

## Q5. Spring Data JDBC + 내장 H2 파일 DB

### 5-1. DataSource 자동 설정, 스키마 초기화
- 결론: Boot가 `DataSource`·풀(HikariCP)을 자동 설정한다. 스크립트 초기화 기본값은 `optional:classpath*:schema.sql`/`data.sql`이고, 기본 모드는 **내장 인메모리 DB일 때만** 실행한다. H2 파일 DB는 `spring.sql.init.mode=always`가 필요하다(공식 저장소 소스 근거, 아래).
- 원문:
  > Spring Boot will auto-configure Spring Data's JDBC repositories when the necessary dependencies are on the classpath. (#data.sql.jdbc)
  > We prefer HikariCP for its performance and concurrency. If HikariCP is available, we always choose it. (#data.sql.datasource.connection-pool)
  > By default, it loads schema scripts from `optional:classpath*:schema.sql` and data scripts from `optional:classpath*:data.sql`. The locations … can be customized using `spring.sql.init.schema-locations` and `spring.sql.init.data-locations` respectively.
  > By default, SQL database initialization is only performed when using an embedded in-memory database. To always initialize an SQL database, irrespective of its type, set `spring.sql.init.mode` to `always`. … By default, Spring Boot enables the fail-fast feature of its script-based database initializer.
  > If, for whatever reason, you do configure the connection URL for an embedded database, take care to ensure that the database's automatic shutdown is disabled. If you use H2, you should use `DB_CLOSE_ON_EXIT=FALSE` to do so. (#data.sql.datasource.embedded)
- `DatabaseInitializationMode`(Javadoc): `EMBEDDED` 「Only initialize an embedded database.」, `ALWAYS`, `NEVER`.
- 소스(공식 저장소, v4.1.2 `EmbeddedDatabaseConnection`): H2 상수 `H2("jdbc:h2:mem:%s;DB_CLOSE_DELAY=-1;DB_CLOSE_ON_EXIT=FALSE")`, 판정 `case H2 -> url.contains(":h2:mem");`. 참조 문서에는 H2 파일 URL이 embedded인지에 대한 문장이 없다.
- URL: https://docs.spring.io/spring-boot/how-to/data-initialization.html#howto.data-initialization.using-basic-sql-scripts , https://docs.spring.io/spring-boot/reference/data/sql.html#data.sql.datasource.embedded , https://docs.spring.io/spring-boot/api/java/org/springframework/boot/sql/init/DatabaseInitializationMode.html , https://github.com/spring-projects/spring-boot (v4.1.2 `module/spring-boot-jdbc/.../EmbeddedDatabaseConnection.java`)

### 5-2. DataSourceScriptDatabaseInitializer / ResourceDatabasePopulator
- `DataSourceScriptDatabaseInitializer`(Boot Javadoc): 「`InitializingBean` that performs `DataSource` initialization using schema (DDL) and data (DML) scripts.」 생성자 `DataSourceScriptDatabaseInitializer(DataSource, DatabaseInitializationSettings)`. Boot 참조 문서 how-to에서는 초기화 빈 탐지 목록에만 등장(`#howto.data-initialization.dependencies.initializer-detection`).
- `ResourceDatabasePopulator`(Spring Framework 7.0.10 Javadoc): 「Populates, initializes, or cleans up a database using SQL scripts defined in external resources.」 `execute(DataSource)`. Spring Framework 참조 문서의 「Initializing a DataSource」 페이지에는 이 클래스 설명이 **없고**(`DataSourceInitializer`는 XML 맥락에서 한 문장), Boot 문서에도 없다.
- URL: https://docs.spring.io/spring-boot/api/java/org/springframework/boot/jdbc/init/DataSourceScriptDatabaseInitializer.html , https://docs.spring.io/spring-framework/docs/current/javadoc-api/org/springframework/jdbc/datasource/init/ResourceDatabasePopulator.html

### 5-3. 마이그레이션 도구 (계획 A와 관련)
- 원문:
  > Spring Boot supports two higher-level migration tools: Flyway and Liquibase.
  > In-memory and file-based databases are supported by the `spring-boot-starter-flyway` starter.
  > Typically, migrations are scripts in the form `V<VERSION>__<NAME>.sql` … By default, they are in a directory called `classpath:db/migration`, but you can modify that location by setting `spring.flyway.locations`.
  > Migrations can also be written in Java. Flyway will be auto-configured with any beans that implement `JavaMigration`.
  > If you are using a higher-level database migration tool, like Flyway or Liquibase, you should use them alone to create and initialize the schema. Using the basic `schema.sql` and `data.sql` scripts alongside Flyway or Liquibase is not recommended and support will be removed in a future release.
- URL: https://docs.spring.io/spring-boot/how-to/data-initialization.html#howto.data-initialization.migration-tool.flyway
- Flyway가 개발원칙 4.3(ANSI SQL·DBMS 중립)과 어떻게 맞는지는 이번에 읽지 않음, 미확인.

### 5-4. H2 파일 URL 형식 (H2 공식)
- 원문(Database URL Overview, Embedded (local) connection): `jdbc:h2:[file:][<path>]<databaseName>`, `jdbc:h2:~/test`, `jdbc:h2:file:/data/sample`, `jdbc:h2:file:C:/data/sample (Windows only)`. 부가: `;DB_CLOSE_ON_EXIT=FALSE`(`#do_not_close_on_exit`), `;AUTO_SERVER=TRUE`(`#auto_mixed_mode`, 「Multiple processes can access the same database」), `;IFEXISTS=TRUE`(`#database_only_if_exists`).
- URL: https://www.h2database.com/html/features.html#embedded_databases
- 판본: H2 문서 현행판(버전 표기는 읽지 못함, 미확인).
- Boot 문서는 H2 콘솔만 설명하고(`spring-boot-h2console`, 개발용) `jdbc:h2:file` 문장은 **찾지 못함**(https://docs.spring.io/spring-boot/reference/data/sql.html).

### 5-5. enum 매핑 (Spring Data JDBC)
- 원문: 「Enums get mapped to their names.」 (Supported Types in Your Entity). CHECK 제약에 대한 언급은 이 페이지에 **없다**. 다른 방식으로 저장하려면 사용자 정의 컨버터를 등록한다(「Types for which you registered suitable custom converters.」).
- URL: https://docs.spring.io/spring-data/relational/reference/jdbc/mapping.html#jdbc.entity-persistence.types
- 판본: Spring Data Relational 4.1.2

---

## Q6. 설정 변경 뒤 정해진 종료 코드로 끝내기

- 결론: 공식 방법이 있다. `ExitCodeGenerator` 빈(또는 `SpringApplication.exit(ctx, generators...)`의 인자)과 `System.exit(SpringApplication.exit(...))`. 예외가 `ExitCodeGenerator`를 구현해도 되고, `ExitCodeExceptionMapper`는 예외→코드 매핑 전략 인터페이스(Javadoc). 참조 문서 페이지에는 `ExitCodeExceptionMapper`가 **나오지 않는다**(Javadoc에만 있음).
- 원문:
  > In addition, beans may implement the `ExitCodeGenerator` interface if they wish to return a specific exit code when `SpringApplication.exit()` is called. This exit code can then be passed to `System.exit()` to return it as a status code
  ```java
  @Bean public ExitCodeGenerator exitCodeGenerator() { return () -> 42; }
  public static void main(String[] args) { System.exit(SpringApplication.exit(SpringApplication.run(MyApplication.class, args))); }
  ```
  > If there is more than one `ExitCodeGenerator`, the first non-zero exit code that is generated is used.
  > `SpringApplication.exit(ApplicationContext, ExitCodeGenerator...)`: Static helper that can be used to exit a SpringApplication and obtain a code indicating success (0) or otherwise. … Applies the specified ExitCodeGenerators in addition to any Spring beans that implement ExitCodeGenerator.
  > `ExitCodeExceptionMapper`: Strategy interface that can be used to provide a mapping between exceptions and exit codes.
- 계획 G 보충(systemd): `Restart=` 「If set to `on-failure`, the service will be restarted when the process exits with a non-zero exit code,」 「If set to `no` (the default), the service will not be restarted.」 `RestartForceExitStatus=` 「will force automatic service restarts, regardless of the restart setting configured with `Restart=`.」 Boot의 systemd 예에는 `Restart=`가 없다.
- URL: https://docs.spring.io/spring-boot/reference/features/spring-application.html#features.spring-application.application-exit , https://docs.spring.io/spring-boot/api/java/org/springframework/boot/SpringApplication.html , https://docs.spring.io/spring-boot/api/java/org/springframework/boot/ExitCodeExceptionMapper.html , https://www.freedesktop.org/software/systemd/man/latest/systemd.service.html#Restart= , https://docs.spring.io/spring-boot/how-to/deployment/installing.html#howto.deployment.installing.system-d
- 판본: Boot 4.1.2, systemd 현행 매뉴얼(번호 미확인)
- 미확인: 웹 서버 요청 처리 스레드 안에서 종료할 때의 권장 방식(별도 스레드에서 호출해야 하는지)은 읽은 문서에 없다.

---

## Q7. ProblemDetail, @ConfigurationProperties record, relaxed binding, 환경 변수 JSON

### 7-1. ProblemDetail / RFC 9457
- 원문: 「As of Spring Framework 6.0, RFC 9457 Problem Details is supported. Spring MVC can produce custom error messages with the `application/problem+json` media type」 / 「This support can be enabled by setting `spring.mvc.problemdetails.enabled` to `true`.」
- URL: https://docs.spring.io/spring-boot/reference/web/servlet.html#web.servlet.spring-mvc.error-handling
- 판본: Boot 4.1.2 (RFC 9457 링크는 Spring Framework 7.0 문서를 가리킴)
- 미확인: 개발원칙 3.8의 `ResponseEntityExceptionHandler` 상속 동작은 개발원칙 10.2가 이미 미확인으로 적었고 이번에도 읽지 않았다.

### 7-2. record 바인딩, @DefaultValue, @Valid, relaxed binding
- record: 「Constructor binding can be used with records. Unless your record has multiple constructors, there is no need to use `@ConstructorBinding`.」 / 「To use constructor binding the class must be compiled with `-parameters`. This will happen automatically if you use Spring Boot's Gradle plugin」 (`#features.external-config.typesafe-configuration-properties.constructor-binding`)
- `@DefaultValue`: 「Default values can be specified using `@DefaultValue` on constructor parameters and record components.」 (`…constructor-binding.default-values`)
- `@Valid`: 「To cascade validation to nested properties the associated field must be annotated with `@Valid`.」 (`…typesafe-configuration-properties.validation`)
- 스캔: 「To use configuration property scanning, add the `@ConfigurationPropertiesScan` annotation to your application.」 (`…enabling-annotated-types`)
- 변환기: 「custom converters (with bean definitions annotated as `@ConfigurationPropertiesBinding`)」, 「the method should be `static`」 (`…typesafe-configuration-properties.conversion`) — 계획의 `BRIDGE_TARGETS` 변환기에 해당.
- relaxed binding 환경 변수 규칙(원문, `…relaxed-binding.environment-variables`):
  > To convert a property name in the canonical-form to an environment variable name you can follow these rules: Replace dots (`.`) with underscores (`_`). Remove any dashes (`-`). Convert to uppercase. For example, the configuration property `spring.main.log-startup-info` would be an environment variable named `SPRING_MAIN_LOGSTARTUPINFO`.
  > To bind to a List, the element number should be surrounded with underscores in the variable name. For example, the configuration property `my.service[0].other` would use an environment variable named `MY_SERVICE_0_OTHER`.
- `BRIDGE_MCP_TOKEN` → `bridge.mcp-token`: 참조 문서의 규칙으로는 `BRIDGE_MCPTOKEN`이다. 공식 저장소 소스는 다음과 같다(v4.1.2 `SystemEnvironmentPropertyMapper.map`): 후보 이름 4개를 `ToStringFormat.SYSTEM_ENVIRONMENT`(대시 제거)와 `LEGACY_SYSTEM_ENVIRONMENT`(대시를 밑줄로 치환) 형식으로 만든다. 따라서 `bridge.mcp-token`에는 `BRIDGE_MCPTOKEN`과 `BRIDGE_MCP_TOKEN`이 모두 매핑된다. 이는 소스 근거이며 참조 문서에는 적혀 있지 않다(계획 F).
  - 클래스 Javadoc(소스): 「Names are mapped by removing invalid characters, converting to lower case and replacing "_" with ".". For example, "SERVER_PORT" is mapped to "server.port".」
  - `ConfigurationPropertyName` Javadoc: 「The "-" is used purely for formatting, i.e. "foo-bar" and "foobar" are considered equivalent.」
- URL: https://docs.spring.io/spring-boot/reference/features/external-config.html#features.external-config.typesafe-configuration-properties.relaxed-binding.environment-variables , https://docs.spring.io/spring-boot/api/java/org/springframework/boot/context/properties/source/ConfigurationPropertyName.html , https://github.com/spring-projects/spring-boot (v4.1.2 `core/spring-boot/.../SystemEnvironmentPropertyMapper.java`)

### 7-3. 환경 변수에 든 JSON을 목록 속성으로
- 결론: 공식 방법 세 가지가 문서에 있다.
  1. `SPRING_APPLICATION_JSON`/`spring.application.json`: JSON을 파싱해 Environment에 넣는다(`#features.external-config.application-json`). 원문: 「When your application starts, any `spring.application.json` or `SPRING_APPLICATION_JSON` properties will be parsed and added to the `Environment`.」 예: `SPRING_APPLICATION_JSON='{"my":{"name":"test"}}' java -jar myapp.jar` → `my.name=test`. 주의 원문: 「the JSON cannot override properties from lower order property sources with a `null` value.」 우선순위는 OS 환경 변수(5)와 시스템 속성(6) 뒤, 명령행 인자(11) 앞의 10번이다. 즉 **환경 변수 `BRIDGE_TARGETS`의 값 자체가 JSON 문자열일 때 그것을 목록으로 푸는 기능이 아니라**, JSON 전체가 속성 트리를 정의한다.
  2. `spring.config.import=env:MY_CONFIGURATION`: 환경 변수 하나에 properties 또는 yaml 형식 전체 설정을 넣어 불러온다(`#features.external-config.files.env-variables`). 원문: 「You can even store whole configurations in properties or yaml format in (multiline) environment variables and load them using the `env:` prefix.」 JSON이 아니라 properties/yaml이다(JSON은 YAML의 부분집합이라는 점은 이 문서에서 확인하지 않음, 미확인).
  3. 문자열 값을 `@ConfigurationPropertiesBinding` 변환기로 record 목록으로 바꾸는 방법(계획의 현재 안). 표 3에서 목록은 「Standard list syntax using `[ ]` or comma-separated values」(properties/YAML/시스템 속성)이고 환경 변수는 「Numeric values surrounded by underscores」다. 환경 변수 문자열을 JSON 배열로 직접 바인딩하는 문장은 **찾지 못함**.
- URL: https://docs.spring.io/spring-boot/reference/features/external-config.html#features.external-config.application-json , #features.external-config.files.env-variables , #features.external-config.typesafe-configuration-properties.relaxed-binding
- 판본: Boot 4.1.2

---

## Q8. Boot Gradle 플러그인으로 jlink 런타임 만들기

- 결론: **공식 안내 없음**. 공식 문서에서 찾지 못함.
- 확인 범위(전부 Boot 4.1.2, jlink 언급 0건):
  - https://docs.spring.io/spring-boot/gradle-plugin/index.html 소개문: 「It allows you to package executable jar or war archives, run Spring Boot applications, and use the dependency management provided by `spring-boot-dependencies`.」 하위 페이지: Getting Started, Managing Dependencies, Packaging Executable Archives, Packaging OCI Images, Publishing your Application, Running your Application with Gradle, Ahead-of-Time Processing, Integrating with Actuator, Reacting to Other Plugins.
  - https://docs.spring.io/spring-boot/gradle-plugin/packaging.html : 「Executable jars can be built using the `bootJar` task.」, 계층 jar. 「jlink」/런타임 이미지 언급 없음.
  - https://docs.spring.io/spring-boot/reference/packaging/efficient.html : `java -Djarmode=tools -jar my-app.jar extract`, AOT 캐시·CDS만.
  - https://docs.spring.io/spring-boot/reference/packaging/container-images/dockerfiles.html : 베이스 이미지는 `bellsoft/liberica-openjre-debian:25-cds`를 예로 쓸 뿐 jlink 없음.
  - 웹 검색(docs.spring.io, spring.io 한정) 결과에도 jlink 문서 없음. 검색에서 나온 것은 `bootBuildImage`(Cloud Native Buildpacks)뿐이다.
- 부수 확인: `java -Djarmode=tools -jar app.jar extract`는 jar를 풀어 `java -jar my-app/my-app.jar`로 실행하는 공식 절차다(https://docs.spring.io/spring-boot/reference/packaging/efficient.html#packaging.efficient.unpacking). jlink 이미지가 이 구조와 맞는지는 문서에 없음.

---

## 확인하지 못한 것 (요약)

1. Q1: 자식 웹 컨텍스트마다 다른 `server.port`를 주는 공식 예제, 포트(커넥터)별 경로 제한의 공식 방법, `management.server.port`에 임의 컨트롤러를 올릴 수 있는지. Spring AI MCP 전송 빈(`RouterFunction` 기반 추정)이 자식 컨텍스트에서 동작하는지.
2. Q2: `@McpTool` 반환의 `structuredContent` 처리 설명, 입력 스키마 직접 지정의 Spring AI 문서 근거(SDK 소스에서만 확인), `@McpResource` `mimeType`에 `text/html;profile=mcp-app` 같은 값을 쓰는 예, `mcp-server-security`의 Spring Security 7 호환 판본.
3. Q3: 호스트 3종(Claude Code, Codex, Antigravity)이 협상하는 MCP 판, 2026-07-28 판에서 `instructions`·MCP Apps 협상 위치, 계약 기준본의 `_meta` 키가 예약 접두어와 겹치는지.
4. Q4: 고정 bearer 토큰 전용 공식 안내, Cloudflare 헤더(`Cf-Access-Jwt-Assertion`)에 `HeaderBearerTokenResolver`를 쓰는 정확한 API(Javadoc 미확인), Cloudflare `aud`가 배열이라는 점과 `JwtClaimValidator` 조합(Cloudflare 페이지에서 `aud` 형식은 읽지 않음).
5. Q5: Flyway와 개발원칙 4.3(ANSI·DBMS 중립)의 정합, H2 문서 버전, H2 파일 URL에 대한 Boot 문서 문장.
6. Q6: 요청 스레드에서 종료를 시작할 때의 공식 권장 방식, 참조 문서상 `ExitCodeExceptionMapper` 설명.
7. Q8: jlink의 JDK 공식 문서(범위 밖).
8. 실행 시험은 하지 않았다(REPRO 불허). 모든 항목은 문서·소스 읽기 결과이며 동작 검증이 아니다.

## 참고 URL (읽은 페이지)
- https://docs.spring.io/spring-boot/reference/features/spring-application.html
- https://docs.spring.io/spring-boot/reference/features/external-config.html
- https://docs.spring.io/spring-boot/reference/web/servlet.html
- https://docs.spring.io/spring-boot/reference/web/spring-security.html
- https://docs.spring.io/spring-boot/reference/actuator/monitoring.html
- https://docs.spring.io/spring-boot/reference/data/sql.html
- https://docs.spring.io/spring-boot/reference/packaging/efficient.html
- https://docs.spring.io/spring-boot/reference/packaging/container-images/dockerfiles.html
- https://docs.spring.io/spring-boot/how-to/webserver.html
- https://docs.spring.io/spring-boot/how-to/data-initialization.html
- https://docs.spring.io/spring-boot/how-to/deployment/installing.html
- https://docs.spring.io/spring-boot/gradle-plugin/index.html , /packaging.html
- https://docs.spring.io/spring-boot/api/java/org/springframework/boot/ (SpringApplication, ExitCodeExceptionMapper, builder/SpringApplicationBuilder, jdbc/EmbeddedDatabaseConnection, jdbc/init/DataSourceScriptDatabaseInitializer, sql/init/DatabaseInitializationMode, sql/init/DatabaseInitializationSettings, context/properties/source/ConfigurationPropertyName)
- https://docs.spring.io/spring-framework/reference/data-access/jdbc/embedded-database-support.html , /initializing-datasource.html , Javadoc ResourceDatabasePopulator
- https://docs.spring.io/spring-data/relational/reference/jdbc/mapping.html
- https://docs.spring.io/spring-security/reference/servlet/configuration/java.html
- https://docs.spring.io/spring-security/reference/servlet/oauth2/resource-server/jwt.html , /multitenancy.html , /opaque-token.html , /bearer-tokens.html
- https://docs.spring.io/spring-ai/reference/api/mcp/mcp-overview.html , mcp-streamable-http-server-boot-starter-docs.html , mcp-server-boot-starter-docs.html , mcp-stdio-sse-server-boot-starter-docs.html , mcp-annotations-server.html , mcp-annotations-special-params.html , mcp-helpers.html , mcp-security.html
- https://modelcontextprotocol.io/specification/versioning , /2025-06-18/server/tools , /2025-11-25/server/tools , /2025-11-25/server/resources , /2025-11-25/basic/index , /2025-11-25/basic/lifecycle , /2026-07-28/server/tools , /2026-07-28/basic/index
- https://modelcontextprotocol.io/extensions/apps/overview
- https://java.sdk.modelcontextprotocol.io/latest/server/ (일부 404였던 modelcontextprotocol.io/sdk/java/mcp-server는 제외)
- 공식 저장소: github.com/modelcontextprotocol/java-sdk (v2.1.0 `McpSchema.java`, `ProtocolVersions.java`, README), github.com/modelcontextprotocol/ext-apps (`specification/2026-01-26/apps.mdx`), github.com/spring-projects/spring-ai (v2.0.2 `pom.xml`), github.com/spring-projects/spring-boot (v4.1.2 `EmbeddedDatabaseConnection.java`, `SystemEnvironmentPropertyMapper.java`, `ConfigurationPropertyName.java`)
- https://www.h2database.com/html/features.html
- https://www.freedesktop.org/software/systemd/man/latest/systemd.service.html
- https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/authorization-cookie/validating-json/
- 404였던 URL: https://modelcontextprotocol.io/sdk/java/mcp-server , spring-ai v2.0.2 `McpServerProperties.java`(경로 추정 오류), https://docs.spring.io/spring-boot/reference/packaging/installing.html
