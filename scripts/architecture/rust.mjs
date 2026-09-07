import path from "node:path";

// Mask Rust comments and literals before collecting crate paths. Raw embedded scripts and
// nested block comments must not invent dependencies. Lifetimes are not string literals.
export function maskRustNonCode(source) {
  let result = "", cursor = 0;
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

export function rustReferences(source) {
  const tokens = maskRustNonCode(source).match(/[A-Za-z_]\w*|::|[{},;]/g) ?? [];
  const result = new Set();
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
  return routes.sort((a,b) => b.prefix.length - a.prefix.length);
}

export function resolveRustFacade(specifier, routes) {
  return routes.find(route => specifier === route.prefix || specifier.startsWith(`${route.prefix}::`));
}
