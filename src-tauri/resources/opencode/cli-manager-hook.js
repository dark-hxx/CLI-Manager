// __CLI_MANAGER_OPENCODE_HOOK__
// Managed by CLI-Manager. Reinstall from the Agent Capabilities panel.

const MARKER = "__CLI_MANAGER_OPENCODE_HOOK__";
const ROOT_SESSION_ID_PATTERN = /^ses_[A-Za-z0-9]+$/;
const SESSION_MAPPING_TTL_MS = 5 * 60 * 1000;
const MAX_TRACKED_SESSIONS = 1024;
const MAX_PARENT_DEPTH = 64;
const lastStatus = new Map();

// 提取去空白的非空字符串，其他类型返回空。
function nonEmpty(value) {
  const text = typeof value === "string" ? value.trim() : "";
  return text || null;
}

// 仅接受符合 OpenCode 根会话标识格式的字符串。
function validSessionId(value) {
  const text = nonEmpty(value);
  return text && ROOT_SESSION_ID_PATTERN.test(text) ? text : null;
}

// 检查对象自身字段，避免原型链成员被当作规范事件字段。
function hasOwn(object, key) {
  return Object.prototype.hasOwnProperty.call(object, key);
}

// 按最近写入顺序维护有界映射，淘汰时优先保留指定活动键。
function rememberBounded(map, key, value, keepKey = null) {
  if (map.has(key)) map.delete(key);
  map.set(key, value);
  while (map.size > MAX_TRACKED_SESSIONS) {
    const oldest = map.keys().next().value;
    if (oldest === undefined) break;
    if (oldest === keepKey && map.size > 1) {
      const preserved = map.get(oldest);
      map.delete(oldest);
      map.set(oldest, preserved);
      continue;
    }
    map.delete(oldest);
  }
}

// 按事件类型读取规范会话 ID，仅在字段缺失时使用兼容回退。
function sessionIdOf(event) {
  const properties = event?.properties ?? {};
  const type = nonEmpty(event?.type);
  if (type === "session.created" || type === "session.updated" || type === "session.deleted") {
    // sessionID is canonical. Compatibility fallback is allowed only when the
    // canonical field is absent, never when it is present but malformed.
    if (hasOwn(properties, "sessionID")) return validSessionId(properties.sessionID);
    return validSessionId(properties?.info?.id);
  }
  if (type === "session.status" || type === "session.idle" || type === "session.error") {
    return validSessionId(properties.sessionID);
  }
  return null;
}

// 从详情或顶层属性提取合法父会话标识。
function parentIdOf(event) {
  const properties = event?.properties ?? {};
  return validSessionId(properties?.info?.parentID)
    ?? validSessionId(properties?.parentID);
}

// 将受支持的会话生命周期和运行状态映射为桌面 Hook 事件。
function mappedEvent(event) {
  const type = nonEmpty(event?.type);
  if (type === "session.created") return "SessionStart";
  if (type === "session.idle") return "Stop";
  if (type === "session.error") return "StopFailure";
  if (type !== "session.status" && type !== "session.updated") return null;
  const status = nonEmpty(event?.properties?.status?.type)
    ?? nonEmpty(event?.properties?.status)
    ?? nonEmpty(event?.properties?.info?.status);
  if (status === "busy" || status === "running") return "UserPromptSubmit";
  if (status === "idle") return "Stop";
  if (status === "error" || status === "failed") return "StopFailure";
  return null;
}

class OpenCodeSessionIdentity {
  // 初始化父子映射、根映射、待解析子项和临时删除标记。
  constructor() {
    this.parentBySession = new Map();
    this.rootBySession = new Map();
    this.unresolvedChildren = new Map();
    this.tombstones = new Map();
    this.lastRootId = null;
  }

  // 检查临时删除标记，过期时移除并视为未标记。
  isTombstoned(id, now) {
    const expiresAt = this.tombstones.get(id);
    if (!expiresAt) return false;
    if (expiresAt <= now) {
      this.tombstones.delete(id);
      return false;
    }
    return true;
  }

  // 为会话登记有容量和有效期限制的防重绑定标记。
  rememberTombstone(id, now) {
    rememberBounded(this.tombstones, id, now + SESSION_MAPPING_TTL_MS);
  }

  // 清理过期待解析项和删除标记，并将各映射压回容量限制。
  prune(now) {
    for (const [id, expiresAt] of this.tombstones) {
      if (expiresAt <= now) this.tombstones.delete(id);
    }
    for (const [id, entry] of this.unresolvedChildren) {
      if (entry.expiresAt <= now) this.unresolvedChildren.delete(id);
    }
    while (this.parentBySession.size > MAX_TRACKED_SESSIONS) {
      const oldest = this.parentBySession.keys().next().value;
      if (oldest === undefined) break;
      this.parentBySession.delete(oldest);
      this.rootBySession.delete(oldest);
      this.unresolvedChildren.delete(oldest);
    }
    while (this.rootBySession.size > MAX_TRACKED_SESSIONS) {
      const oldest = this.rootBySession.keys().next().value;
      if (oldest === undefined) break;
      if (oldest === this.lastRootId && this.rootBySession.size > 1) {
        const activeRoot = this.rootBySession.get(oldest);
        this.rootBySession.delete(oldest);
        this.rootBySession.set(oldest, activeRoot);
        continue;
      }
      this.rootBySession.delete(oldest);
    }
    while (this.unresolvedChildren.size > MAX_TRACKED_SESSIONS) {
      const oldest = this.unresolvedChildren.keys().next().value;
      if (oldest === undefined) break;
      this.unresolvedChildren.delete(oldest);
    }
    while (this.tombstones.size > MAX_TRACKED_SESSIONS) {
      const oldest = this.tombstones.keys().next().value;
      if (oldest === undefined) break;
      this.tombstones.delete(oldest);
    }
  }

  // 沿父链查找已知根并缓存经过路径，遇环或深度上限返回空。
  rootFor(id) {
    const path = [];
    const seen = new Set();
    let current = id;
    for (let depth = 0; depth <= MAX_PARENT_DEPTH; depth += 1) {
      if (seen.has(current)) return null;
      seen.add(current);
      path.push(current);
      const knownRoot = this.rootBySession.get(current);
      if (knownRoot) {
        for (const sessionId of path) rememberBounded(this.rootBySession, sessionId, knownRoot, this.lastRootId);
        return knownRoot;
      }
      const parent = this.parentBySession.get(current);
      if (!parent) return null;
      current = parent;
    }
    return null;
  }

  // 在深度限制内重绑后代到已知根，同时防止后代被误提升为根。
  rebindDescendants(parentId, rootId, now) {
    const seen = new Set([parentId]);
    const queue = [{ id: parentId, depth: 0 }];
    while (queue.length > 0) {
      const current = queue.shift();
      if (!current || current.depth >= MAX_PARENT_DEPTH) continue;
      for (const [childId, childParentId] of this.parentBySession) {
        if (childParentId !== current.id || seen.has(childId)) continue;
        seen.add(childId);
        rememberBounded(this.rootBySession, childId, rootId, this.lastRootId);
        this.unresolvedChildren.delete(childId);
        this.rememberTombstone(childId, now);
        queue.push({ id: childId, depth: current.depth + 1 });
      }
    }
  }

  // 按创建、更新及当前根状态决定是否发布，拒绝标记项和旧根抢占。
  observeRootCandidate(id, type, now) {
    // Deletions and confirmed child mappings leave a temporary tombstone so
    // delayed parent-less updates can never promote them back into root IDs.
    if (this.isTombstoned(id, now)) return { publish: false, rootId: null };

    const knownRoot = this.rootBySession.get(id);
    if (knownRoot && knownRoot !== id) return { publish: false, rootId: knownRoot };

    if (type === "session.created") {
      rememberBounded(this.rootBySession, id, id, id);
      this.lastRootId = id;
      this.rebindDescendants(id, id, now);
      this.prune(now);
      return { publish: true, rootId: id };
    }

    // An updated event may establish a root only when there is no active root
    // and the session has never been seen as a child or a deleted session.
    if (type === "session.updated" && !this.lastRootId && !this.parentBySession.has(id) && !knownRoot) {
      rememberBounded(this.rootBySession, id, id, id);
      this.lastRootId = id;
      this.rebindDescendants(id, id, now);
      this.prune(now);
      return { publish: true, rootId: id };
    }

    // Once a later root becomes active, late status/idle/error events for an
    // older root must not rebind the terminal tab back to that stale ID.
    return { publish: knownRoot === id && this.lastRootId === id, rootId: knownRoot ?? null };
  }

  // 登记父子关系并尝试解析根；子事件始终不直接发布。
  observeChild(id, parentId, now) {
    if (id === parentId) return { publish: false, rootId: null };
    rememberBounded(this.parentBySession, id, parentId);
    this.rememberTombstone(id, now);
    const rootId = this.rootFor(parentId);
    if (!rootId || this.isTombstoned(rootId, now)) {
      rememberBounded(this.unresolvedChildren, id, { parentId, expiresAt: now + SESSION_MAPPING_TTL_MS });
      this.prune(now);
      return { publish: false, rootId: null };
    }
    rememberBounded(this.rootBySession, id, rootId, this.lastRootId);
    this.unresolvedChildren.delete(id);
    this.rebindDescendants(id, rootId, now);
    this.prune(now);
    return { publish: false, rootId };
  }

  // 清理缓存后按删除、子会话或根候选处理事件身份。
  observe(event, now = Date.now()) {
    this.prune(now);
    const type = nonEmpty(event?.type);
    const id = sessionIdOf(event);
    if (!id) return { publish: false, rootId: null };
    if (type === "session.deleted") return this.delete(id, now);

    const parentId = parentIdOf(event);
    if (parentId) return this.observeChild(id, parentId, now);
    return this.observeRootCandidate(id, type, now);
  }

  // 以有界广度遍历收集当前父链映射中的后代及自身。
  descendantIds(id) {
    const result = new Set([id]);
    const queue = [{ id, depth: 0 }];
    while (queue.length > 0) {
      const current = queue.shift();
      if (!current || current.depth >= MAX_PARENT_DEPTH) continue;
      for (const [childId, parentId] of this.parentBySession) {
        if (parentId !== current.id || result.has(childId)) continue;
        result.add(childId);
        queue.push({ id: childId, depth: current.depth + 1 });
      }
    }
    return result;
  }

  // 移除会话及已知后代映射和状态，并留下临时防复活标记。
  delete(id, now) {
    const rootId = this.rootFor(id) ?? id;
    const affectedIds = this.descendantIds(id);
    // Root deletion also invalidates every already-resolved descendant even if
    // a prior capacity eviction removed its parent link.
    if (rootId === id) {
      for (const [sessionId, sessionRootId] of this.rootBySession) {
        if (sessionRootId === id) affectedIds.add(sessionId);
      }
    }
    for (const sessionId of affectedIds) {
      this.rememberTombstone(sessionId, now);
      this.rootBySession.delete(sessionId);
      this.parentBySession.delete(sessionId);
      this.unresolvedChildren.delete(sessionId);
      lastStatus.delete(sessionId);
    }
    if (rootId === id && this.lastRootId === id) this.lastRootId = null;
    this.prune(now);
    return { publish: false, rootId: null };
  }
}

// 创建插件实例使用的独立会话身份跟踪器。
export function createOpenCodeSessionIdentity() {
  return new OpenCodeSessionIdentity();
}

// 检查回调环境并先记录去重状态，再尝试发送本地 Hook；发送失败不抛出。
async function post(event, sessionId) {
  const tabId = nonEmpty(process.env.CLI_MANAGER_TAB_ID);
  const port = nonEmpty(process.env.CLI_MANAGER_NOTIFY_PORT);
  const token = nonEmpty(process.env.CLI_MANAGER_NOTIFY_TOKEN);
  if (!tabId || !port || !token || !sessionId) return;
  const dedupKey = `${sessionId}:${event}`;
  if (lastStatus.get(sessionId) === dedupKey) return;
  rememberBounded(lastStatus, sessionId, dedupKey);
  try {
    await fetch(`http://127.0.0.1:${port}/api/claude-hook`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        tabId,
        source: "opencode",
        event,
        sessionId,
        cwd: process.cwd(),
        timestamp: new Date().toISOString(),
      }),
    });
  } catch {
    // Session telemetry must never interrupt OpenCode.
  }
}

// 为插件实例创建身份跟踪器并返回生命周期事件处理器。
export const CliManagerSessionBridge = async () => {
  const identity = createOpenCodeSessionIdentity();
  return {
    // 仅将当前可发布根会话的受支持状态转发到本地通知端点。
    event: async (input) => {
      const event = input?.event ?? input;
      const resolution = identity.observe(event);
      if (!resolution.publish) return;
      const mapped = mappedEvent(event);
      if (mapped) await post(mapped, resolution.rootId);
    },
  };
};

void MARKER;
