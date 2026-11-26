//! 仅编辑一个顶层 Hook。第三方命令的字节、顺序、未知值与数值精度均原样保留。
use serde::de::DeserializeOwned;
use serde::de::IgnoredAny;
use serde_json::{Deserializer, Value};
use std::{collections::HashSet, ops::Range};

pub(super) struct Document<'a> {
    bytes: &'a [u8],
    pairs: Vec<Range<usize>>,
    close: usize,
    owner: Option<(usize, Range<usize>)>,
}

// 复用 serde JSON 的语法、转义及深度限制；byte_offset 只用于已成功解析的单个值。
fn token<T: DeserializeOwned>(bytes: &[u8], index: &mut usize) -> Option<T> {
    let mut iter = Deserializer::from_slice(bytes.get(*index..)?).into_iter::<T>();
    let value = iter.next()?.ok()?;
    *index += iter.byte_offset();
    Some(value)
}

fn space(bytes: &[u8], i: &mut usize) {
    while bytes
        .get(*i)
        .is_some_and(|c| matches!(c, b' ' | b'\r' | b'\n' | b'\t'))
    {
        *i += 1;
    }
}

impl<'a> Document<'a> {
    // 重复的顶层名称具有歧义，即使转义后才相同也拒绝更改；允许可选前导 UTF-8 BOM。
    pub(super) fn parse(bytes: &'a [u8]) -> Option<Self> {
        let bytes = bytes.strip_prefix(b"\xEF\xBB\xBF").unwrap_or(bytes);
        let mut i = 0;
        space(bytes, &mut i);
        if bytes.get(i) != Some(&b'{') {
            return None;
        }
        i += 1;
        space(bytes, &mut i);
        let mut names = HashSet::new();
        let mut pairs = Vec::new();
        let mut owner = None;
        if bytes.get(i) != Some(&b'}') {
            loop {
                let start = i;
                let name = token::<String>(bytes, &mut i)?;
                space(bytes, &mut i);
                if !names.insert(name.clone()) || bytes.get(i) != Some(&b':') {
                    return None;
                }
                i += 1;
                space(bytes, &mut i);
                let value_start = i;
                token::<IgnoredAny>(bytes, &mut i)?;
                // IgnoredAny 跳过值而不构建树；整个文档的完整 JSON 语法在返回前校验。
                if name == super::OWNER {
                    owner = Some((pairs.len(), value_start..i));
                }
                pairs.push(start..i);
                space(bytes, &mut i);
                match bytes.get(i) {
                    Some(b'}') => break,
                    Some(b',') => {
                        i += 1;
                        space(bytes, &mut i);
                    }
                    _ => return None,
                }
            }
        }
        let close = i;
        i += 1;
        space(bytes, &mut i);
        if i != bytes.len() || serde_json::from_slice::<Value>(bytes).is_err() {
            return None;
        }
        Some(Self {
            bytes,
            pairs,
            close,
            owner,
        })
    }

    // serde_json::Value 对重复键取最后一个；先用命名字段检查当前命名空间，避免因此删掉第三方命令。
    pub(super) fn owned(&self) -> Option<Value> {
        #[derive(serde::Deserialize)]
        #[serde(deny_unknown_fields)]
        #[allow(dead_code)]
        struct Handler {
            r#type: Option<IgnoredAny>,
            command: IgnoredAny,
            timeout: Option<IgnoredAny>,
        }
        #[derive(serde::Deserialize)]
        #[serde(rename_all = "PascalCase", deny_unknown_fields)]
        #[allow(dead_code)]
        struct Definition {
            #[serde(rename = "enabled")]
            enabled: Option<bool>,
            session_start: Option<Vec<Handler>>,
            pre_invocation: Option<Vec<Handler>>,
            stop: Option<Vec<Handler>>,
        }
        self.owner.as_ref().map(|(_, r)| {
            let bytes = &self.bytes[r.clone()];
            if serde_json::from_slice::<Definition>(bytes).is_err() {
                Value::Null
            } else {
                serde_json::from_slice(bytes).unwrap_or(Value::Null)
            }
        })
    }

    pub(super) fn replace(&self, value: Option<&Value>) -> Result<Vec<u8>, String> {
        let data = value
            .map(serde_json::to_vec_pretty)
            .transpose()
            .map_err(|_| "antigravity_hook_invalid")?;
        let (range, insertion) = match (&self.owner, data) {
            (Some((_, r)), Some(data)) => (r.clone(), data),
            (None, Some(data)) => {
                let mut insertion = if self.pairs.is_empty() {
                    b"\n  ".to_vec()
                } else {
                    b",\n  ".to_vec()
                };
                insertion.extend(format!("\"{}\": ", super::OWNER).bytes());
                insertion.extend(data);
                insertion.push(b'\n');
                let at = self.pairs.last().map_or(self.close, |r| r.end);
                (at..at, insertion)
            }
            (Some((n, _)), None) => {
                let own = &self.pairs[*n];
                let range = if let Some(next) = self.pairs.get(n + 1) {
                    own.start..next.start
                } else if *n > 0 {
                    self.pairs[*n - 1].end..own.end
                } else {
                    own.clone()
                };
                (range, Vec::new())
            }
            (None, None) => return Ok(self.bytes.to_vec()),
        };
        let mut bytes = self.bytes[..range.start].to_vec();
        bytes.extend(insertion);
        bytes.extend_from_slice(&self.bytes[range.end..]);
        Ok(bytes)
    }
}
