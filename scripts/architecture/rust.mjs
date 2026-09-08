import path from "node:path";

// Mask Rust comments and literals before collecting crate paths. Raw embedded scripts and
// nested block comments must not invent dependencies. Lifetimes are not string literals.
// 屏蔽 Rust 注释和字面量以免误报依赖，保留换行及生命周期语法。
export function maskRustNonCode(source) {
  let result = "", cursor = 0;
  // 用空格替换非换行字符，使被屏蔽片段的位置与行号保持稳定。
  const blank = text => text.replace(/[^\r\n]/g, " ");
  while (cursor < source.length) {
    const start = cursor;
    if (source.startsWith("//", cursor)) {
      const end = source.indexOf("\n", cursor);
      cursor = end < 0 ? source.length : end;
    } else if (source.startsWith("/*", cursor)) {
      cursor += 2;
      let depth = 1;
      while (cursor < source.length && depth) {
        if (source.startsWith("/*", cursor)) { depth++; cursor += 2; }
        else if (source.startsWith("*/", cursor)) { depth--; cursor += 2; }
        else cursor++;
      }
    } else {
      const raw = source[cursor] === "r" && /^r(#{0,255})"/.exec(source.slice(cursor));
      if (raw) {
        const closing = `"${raw[1]}`;
        const end = source.indexOf(closing, cursor + raw[0].length);
        cursor = end < 0 ? source.length : end + closing.length;
      } else if (source[cursor] === '"') {
        cursor++;
        while (cursor < source.length) {
          if (source[cursor] === "\\") { cursor += 2; continue; }
          if (source[cursor++] === '"') break;
        }
      } else {
        const character = source[cursor] === "'" && /^'(?:\\(?:[nrt0\\'"]|x[0-9a-fA-F]{2}|u\{[0-9a-fA-F_]+\})|[^'\\\r\n])'/u.exec(source.slice(cursor));
        if (character) cursor += character[0].length;
      }
    }
    if (cursor === start) { result += source[cursor++]; }
    else result += blank(source.slice(start, cursor));
  }
  return result;
}

// 在屏蔽后的代码中提取 crate 路径，展开分组 use 并去重。
export function rustReferences(source) {
  const tokens = maskRustNonCode(source).match(/[A-Za-z_]\w*|::|[{},;]/g) ?? [];
  const result = new Set();
  // 递归读取路径及花括号分组，保留已有前缀并跳过 self 路径段。
  function readPath(position, prefix) {
    const parts = [...prefix];
    let cursor = position;
    while (cursor < tokens.length) {
      const token = tokens[cursor];
      if (!/^[A-Za-z_]\w*$/.test(token) || token === "as") break;
      if (token !== "self") parts.push(token);
      cursor++;
      if (tokens[cursor] !== "::") break;
      cursor++;
      if (tokens[cursor] === "{") {
        cursor++;
        while (cursor < tokens.length && tokens[cursor] !== "}") {
          const next = readPath(cursor, parts);
          cursor = Math.max(cursor + 1, next);
          while (cursor < tokens.length && ![",", "}"].includes(tokens[cursor])) cursor++;
          if (tokens[cursor] === ",") cursor++;
        }
        return cursor + 1;
      }
    }
    if (parts.length > 1) result.add(parts.join("::"));
    return cursor;
  }
  for (let cursor = 0; cursor < tokens.length; cursor++) {
    if (tokens[cursor] === "crate" && tokens[cursor + 1] === "::") cursor = readPath(cursor, []) - 1;
  }
  return [...result];
}

// 从 path 模块声明建立兼容命名空间到物理文件的映射，并补应用入口。
export function rustFacadeRoutes(registry, source) {
  const prefix = registry.endsWith("commands/mod.rs") ? "crate::commands" : "crate";
  const routes = [];
  for (const match of source.matchAll(/#\[path\s*=\s*"([^"]+)"\]\s*(?:pub(?:\([^)]*\))?\s+)?mod\s+(\w+)\s*;/g)) {
    routes.push({ prefix: `${prefix}::${match[2]}`, target: path.posix.normalize(path.posix.join(path.posix.dirname(registry), match[1])) });
  }
  // App composition is intentionally not relocated and must remain visible to layer checks.
  if (prefix === "crate" && /\bmod app;/.test(maskRustNonCode(source))) {
    routes.push({ prefix: "crate::app", target: "src-tauri/src/app/mod.rs" });
  }
  // 按前缀长度降序排列，避免较短注册入口抢先匹配。
  return routes.sort((a,b) => b.prefix.length - a.prefix.length);
}

// 返回首个完全匹配或命名空间前缀匹配的 Rust 注册路由。
export function resolveRustFacade(specifier, routes) {
  // 匹配完整路径段边界，而非任意字符串前缀。
  return routes.find(route => specifier === route.prefix || specifier.startsWith(`${route.prefix}::`));
}
