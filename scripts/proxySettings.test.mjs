import assert from "node:assert/strict";
import { after, test } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";

const output = await mkdtemp(join(tmpdir(), "cli-proxy-settings-"));
after(() => rm(output, { recursive: true, force: true }));
const file = join(output, "proxySettings.mjs");

await build({
  entryPoints: ["./src/shared/lib/proxySettings.ts"],
  bundle: true,
  platform: "node",
  format: "esm",
  outfile: file,
  logLevel: "silent",
});

const proxy = await import(pathToFileURL(file).href);

test("validateProxyUrl accepts valid http/https/socks5 schemes and rejects malformed or unsupported ones", () => {
  assert.deepEqual(proxy.validateProxyUrl("  http://127.0.0.1:7897/  "), {
    ok: true,
    normalized: "http://127.0.0.1:7897",
  });
  assert.deepEqual(proxy.validateProxyUrl("socks5://127.0.0.1:1080"), {
    ok: true,
    normalized: "socks5://127.0.0.1:1080",
  });
  assert.deepEqual(proxy.validateProxyUrl("socks5h://user:pass@[::1]:7897"), {
    ok: true,
    normalized: "socks5h://user:pass@[::1]:7897",
  });
  assert.equal(proxy.validateProxyUrl("").code, "proxy_url_empty");
  assert.equal(proxy.validateProxyUrl("http://127.0.0.1:7897 bad").code, "proxy_url_invalid");
  assert.equal(proxy.validateProxyUrl("ftp://127.0.0.1:21").code, "proxy_scheme_unsupported");
  assert.equal(proxy.validateProxyUrl("http://").code, "proxy_url_invalid");
});

test("mergeNoProxy preserves user hosts and always includes local loopback protection", () => {
  assert.equal(proxy.mergeNoProxy(""), "localhost,127.0.0.1,::1");
  assert.equal(
    proxy.mergeNoProxy("LOCALHOST, .corp.local; 10.0.0.0/8\n127.0.0.1"),
    "localhost,127.0.0.1,::1,.corp.local,10.0.0.0/8",
  );
});

test("stripProxyUrlCredentials and sanitizeProjectProxyConfigForBackup redact user:pass credentials", () => {
  assert.equal(
    proxy.stripProxyUrlCredentials("http://alice:secret@127.0.0.1:7897"),
    "http://127.0.0.1:7897",
  );
  const rawProject = proxy.serializeProjectProxyConfig({
    mode: "custom",
    url: "http://alice:secret@127.0.0.1:7897",
    noProxy: ".internal",
  });
  const sanitized = proxy.parseProjectProxyConfig(proxy.sanitizeProjectProxyConfigForBackup(rawProject));
  assert.deepEqual(sanitized, {
    mode: "custom",
    url: "http://127.0.0.1:7897",
    noProxy: ".internal",
  });
});

test("resolveEffectiveProxy enforces Project > Agent > Global and explicit direct overrides", () => {
  const settings = proxy.normalizeProxySettings({
    globalEnabled: true,
    globalUrl: "http://127.0.0.1:7890",
    globalNoProxy: ".global.local",
    agents: {
      claude: { mode: "custom", url: "http://127.0.0.1:7891", noProxy: ".claude.local" },
      codex: { mode: "direct", url: "", noProxy: "" },
    },
  });

  // Global fallback when project and agent inherit
  assert.deepEqual(
    proxy.resolveEffectiveProxy({
      project: { cli_tool: "pi", startup_cmd: "", environment_type: "local", proxy_config: "" },
      settings,
    }),
    {
      kind: "proxy",
      source: "global",
      url: "http://127.0.0.1:7890",
      noProxy: "localhost,127.0.0.1,::1,.global.local",
    },
  );

  // Agent custom overrides Global
  assert.deepEqual(
    proxy.resolveEffectiveProxy({
      project: { cli_tool: "claude", startup_cmd: "", environment_type: "local", proxy_config: "" },
      settings,
    }),
    {
      kind: "proxy",
      source: "agent",
      agentId: "claude",
      url: "http://127.0.0.1:7891",
      noProxy: "localhost,127.0.0.1,::1,.claude.local",
    },
  );

  // Agent direct overrides Global
  assert.deepEqual(
    proxy.resolveEffectiveProxy({
      project: { cli_tool: "codex", startup_cmd: "", environment_type: "local", proxy_config: "" },
      settings,
    }),
    {
      kind: "direct",
      source: "agent",
      agentId: "codex",
    },
  );

  // Project custom overrides Agent direct
  assert.deepEqual(
    proxy.resolveEffectiveProxy({
      project: {
        cli_tool: "codex",
        startup_cmd: "",
        environment_type: "local",
        proxy_config: proxy.serializeProjectProxyConfig({
          mode: "custom",
          url: "socks5://127.0.0.1:1080",
          noProxy: "",
        }),
      },
      settings,
    }),
    {
      kind: "proxy",
      source: "project",
      url: "socks5://127.0.0.1:1080",
      noProxy: "localhost,127.0.0.1,::1",
    },
  );

  // Project direct overrides Agent custom & Global
  assert.deepEqual(
    proxy.resolveEffectiveProxy({
      project: {
        cli_tool: "claude",
        startup_cmd: "",
        environment_type: "local",
        proxy_config: proxy.serializeProjectProxyConfig({ mode: "direct", url: "", noProxy: "" }),
      },
      settings,
    }),
    {
      kind: "direct",
      source: "project",
    },
  );
});

test("resolveEffectiveProxy never inherits local Global/Agent proxy on SSH projects", () => {
  const settings = proxy.normalizeProxySettings({
    globalEnabled: true,
    globalUrl: "http://127.0.0.1:7890",
    globalNoProxy: "",
    agents: {
      claude: { mode: "custom", url: "http://127.0.0.1:7891", noProxy: "" },
    },
  });

  assert.deepEqual(
    proxy.resolveEffectiveProxy({
      project: { cli_tool: "claude", startup_cmd: "", environment_type: "ssh", proxy_config: "" },
      settings,
    }),
    { kind: "none", source: "none" },
  );

  assert.deepEqual(
    proxy.resolveEffectiveProxy({
      project: {
        cli_tool: "claude",
        startup_cmd: "",
        environment_type: "ssh",
        proxy_config: proxy.serializeProjectProxyConfig({
          mode: "custom",
          url: "http://proxy.corp:8080",
          noProxy: ".corp",
        }),
      },
      settings,
    }),
    {
      kind: "proxy",
      source: "project",
      url: "http://proxy.corp:8080",
      noProxy: "localhost,127.0.0.1,::1,.corp",
    },
  );
});

test("applyProxyToEnvVars respects explicit env_vars, case-sensitivity, and direct unset sentinels", () => {
  const plan = {
    kind: "proxy",
    source: "global",
    url: "http://127.0.0.1:7897",
    noProxy: "localhost,127.0.0.1,::1",
  };

  // Explicit env_vars (even lowercase) wins over injected proxy
  const withOverride = proxy.applyProxyToEnvVars(
    { https_proxy: "http://127.0.0.1:9999", FOO: "bar" },
    plan,
    { caseSensitivePlatform: true },
  );
  assert.equal(withOverride.https_proxy, "http://127.0.0.1:9999");
  assert.equal(withOverride.HTTPS_PROXY, undefined);
  assert.equal(withOverride.HTTP_PROXY, "http://127.0.0.1:7897");
  assert.equal(withOverride.http_proxy, "http://127.0.0.1:7897");
  assert.equal(withOverride.ALL_PROXY, "http://127.0.0.1:7897");
  assert.equal(withOverride.NO_PROXY, "localhost,127.0.0.1,::1");

  // Windows non-case-sensitive omits duplicate lowercase keys
  const windowsEnv = proxy.applyProxyToEnvVars(undefined, plan, { caseSensitivePlatform: false });
  assert.equal(windowsEnv.HTTP_PROXY, "http://127.0.0.1:7897");
  assert.equal(windowsEnv.http_proxy, undefined);

  // Direct mode sets empty sentinels for proxy vars unless explicitly overridden
  const directEnv = proxy.applyProxyToEnvVars(
    { HTTP_PROXY: "http://keep-explicit:8080" },
    { kind: "direct", source: "project" },
    { caseSensitivePlatform: true },
  );
  assert.equal(directEnv.HTTP_PROXY, "http://keep-explicit:8080");
  assert.equal(directEnv.http_proxy, undefined);
  assert.equal(directEnv.HTTPS_PROXY, "");
  assert.equal(directEnv.https_proxy, "");
  assert.equal(directEnv.ALL_PROXY, "");
  assert.equal(directEnv.NO_PROXY, "");
});

test("parseProxyUrlToParts, buildProxyUrlFromParts, and tryParsePastedProxyUrl handle structured fields and auth", () => {
  const built = proxy.buildProxyUrlFromParts({
    scheme: "socks5",
    host: "disp.oxylabs.io",
    port: "8001",
    username: "disp_77e98910",
    password: "p@ss:word/1%",
  });
  assert.equal(built.ok, true);
  assert.equal(
    built.url,
    "socks5://disp_77e98910:p%40ss%3Aword%2F1%25@disp.oxylabs.io:8001",
  );

  assert.deepEqual(proxy.parseProxyUrlToParts(built.url), {
    scheme: "socks5",
    host: "disp.oxylabs.io",
    port: "8001",
    username: "disp_77e98910",
    password: "p@ss:word/1%",
  });

  const ipv6 = proxy.buildProxyUrlFromParts({
    scheme: "http",
    host: "::1",
    port: "7897",
    username: "",
    password: "",
  });
  assert.deepEqual(ipv6, { ok: true, url: "http://[::1]:7897" });
  assert.deepEqual(proxy.parseProxyUrlToParts(ipv6.url), {
    scheme: "http",
    host: "::1",
    port: "7897",
    username: "",
    password: "",
  });

  assert.equal(
    proxy.buildProxyUrlFromParts({
      scheme: "http",
      host: "",
      port: "7897",
      username: "",
      password: "",
    }).code,
    "proxy_host_missing",
  );
  assert.equal(
    proxy.buildProxyUrlFromParts({
      scheme: "http",
      host: "127.0.0.1",
      port: "70000",
      username: "",
      password: "",
    }).code,
    "proxy_port_invalid",
  );
  assert.equal(
    proxy.buildProxyUrlFromParts({
      scheme: "http",
      host: "127.0.0.1",
      port: "",
      username: "",
      password: "",
    }).code,
    "proxy_port_invalid",
  );

  assert.deepEqual(
    proxy.tryParsePastedProxyUrl("https://alice:pw@127.0.0.1:8443"),
    {
      scheme: "https",
      host: "127.0.0.1",
      port: "8443",
      username: "alice",
      password: "pw",
    },
  );
  assert.equal(proxy.tryParsePastedProxyUrl("127.0.0.1"), null);
});

test("collectProxyCopySources filters excluded/non-custom sources, reads drafts, and redacts displayUrl", () => {
  const settings = proxy.normalizeProxySettings({
    globalEnabled: false,
    globalUrl: "http://127.0.0.1:7897",
    globalNoProxy: ".corp.local",
    agents: {
      claude: { mode: "custom", url: "socks5://alice:s3cr3t@127.0.0.1:1080", noProxy: ".claude.local" },
      codex: { mode: "direct", url: "", noProxy: "" },
      pi: { mode: "inherit", url: "", noProxy: "" },
    },
  });
  const agents = [
    { id: "claude", label: "Claude Code", command: "claude" },
    { id: "codex", label: "Codex CLI", command: "codex" },
    { id: "pi", label: "Pi Coding Agent", command: "pi" },
    { id: "agy", label: "Antigravity CLI", command: "agy" },
  ];

  // Exclude claude -> returns global + valid custom draft for agy, skipping direct/inherit/invalid draft
  const agyDraftParts = {
    scheme: "socks5h",
    host: "proxy.example.com",
    port: "8001",
    username: "u1",
    password: "p1",
  };
  const sourcesForPi = proxy.collectProxyCopySources({
    settings,
    agents,
    globalLabel: "Global Proxy",
    excludeId: "claude",
    agentDrafts: {
      agy: { mode: "custom", parts: agyDraftParts, noProxy: " .agy.internal " },
      codex: {
        mode: "custom",
        parts: { scheme: "http", host: "", port: "7890", username: "", password: "" },
        noProxy: "",
      },
    },
  });

  assert.equal(sourcesForPi.length, 2);
  assert.deepEqual(
    sourcesForPi.map((s) => ({ id: s.id, kind: s.kind, displayUrl: s.displayUrl, hasAuth: s.hasAuth, noProxy: s.noProxy })),
    [
      {
        id: "global",
        kind: "global",
        displayUrl: "http://127.0.0.1:7897",
        hasAuth: false,
        noProxy: ".corp.local",
      },
      {
        id: "agy",
        kind: "agent",
        displayUrl: "socks5h://proxy.example.com:8001",
        hasAuth: true,
        noProxy: ".agy.internal",
      },
    ],
  );
  // Cloned parts keep credentials and do not alias caller object
  assert.deepEqual(sourcesForPi[1].parts, agyDraftParts);
  assert.notEqual(sourcesForPi[1].parts, agyDraftParts);

  // Exclude global -> only saved claude custom rule remains
  const sourcesForGlobal = proxy.collectProxyCopySources({
    settings,
    agents,
    globalLabel: "Global Proxy",
    excludeId: "global",
  });
  assert.equal(sourcesForGlobal.length, 1);
  assert.equal(sourcesForGlobal[0].id, "claude");
  assert.equal(sourcesForGlobal[0].displayUrl, "socks5://127.0.0.1:1080");
  assert.equal(sourcesForGlobal[0].hasAuth, true);
  assert.equal(sourcesForGlobal[0].parts.username, "alice");
  assert.equal(sourcesForGlobal[0].parts.password, "s3cr3t");

  // globalDraft overrides saved globalUrl when valid
  const sourcesWithGlobalDraft = proxy.collectProxyCopySources({
    settings,
    agents,
    globalLabel: "Global Proxy",
    excludeId: "claude",
    globalDraft: {
      parts: { scheme: "https", host: "10.0.0.2", port: "8443", username: "", password: "" },
      noProxy: "10.0.0.0/8",
    },
  });
  assert.equal(sourcesWithGlobalDraft[0].displayUrl, "https://10.0.0.2:8443");
  assert.equal(sourcesWithGlobalDraft[0].noProxy, "10.0.0.0/8");
});
