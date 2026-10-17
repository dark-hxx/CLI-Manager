//! 一行 Codex 紀錄裡的圖片：解析事件時算張數、讀圖片時取第幾張，兩邊依同一個順序。

use serde_json::Value;

/// 紀錄裡的一張圖片從哪裡讀。
#[derive(Debug, PartialEq, Eq)]
pub enum ImageSource {
    /// `data:image/...;base64,...`（貼上的圖、工具輸出的截圖）。
    Data(String),
    /// CLI 記下的檔案路徑（附加的本機圖片、查看的圖片）。
    File(String),
    /// 從 Tap-Code 上傳到專案 `.tap-code/uploads/` 的圖片（訊息裡放的是相對專案目錄的路徑）。
    Upload(String),
}

/// 上傳的檔案放在這裡；訊息裡的路徑可能帶 `@` 或 `./`。
const UPLOADS: &str = ".tap-code/uploads/";
const IMAGE_EXTENSIONS: [&str; 5] = [".png", ".jpg", ".jpeg", ".gif", ".webp"];

/// 一行紀錄裡的圖片，依固定的順序：解析事件時算張數、讀圖片時取第幾張，兩邊一致。
/// 你的訊息：貼上的圖、附加的檔案、上傳的圖；工具輸出：輸出裡的圖；查看圖片：那個檔案。
pub fn line_images(line: &Value) -> Vec<ImageSource> {
    let payload = &line["payload"];
    let mut found = Vec::new();
    let strings = |value: &Value| {
        value
            .as_array()
            .into_iter()
            .flatten()
            .filter_map(Value::as_str)
            .map(String::from)
            .collect::<Vec<_>>()
    };
    match (line["type"].as_str(), payload["type"].as_str()) {
        (Some("event_msg"), Some("user_message")) => {
            found.extend(
                strings(&payload["images"])
                    .into_iter()
                    .filter(|url| url.starts_with("data:"))
                    .map(ImageSource::Data),
            );
            found.extend(
                strings(&payload["local_images"])
                    .into_iter()
                    .map(ImageSource::File),
            );
            uploads(payload["message"].as_str().unwrap_or_default(), &mut found);
        }
        (Some("event_msg"), Some("item_completed")) => {
            let item = &payload["item"];
            match item["type"].as_str() {
                Some("UserMessage") => message_images(&item["content"], &mut found),
                Some("ImageView") => found.extend(
                    item["path"]
                        .as_str()
                        .map(|path| ImageSource::File(path.into())),
                ),
                _ => {}
            }
        }
        (Some("response_item"), Some("message")) if payload["role"] == "user" => {
            message_images(&payload["content"], &mut found)
        }
        (Some("response_item"), Some(kind)) if kind.ends_with("_output") => {
            let output = &payload["output"];
            let parts = output.as_array().or_else(|| output["content"].as_array());
            for part in parts.into_iter().flatten() {
                if part["type"]
                    .as_str()
                    .is_some_and(|kind| kind.contains("image"))
                {
                    found.extend(part_image(part));
                }
            }
        }
        _ => {}
    }
    found
}

/// 訊息內容裡的圖片：圖片片段，以及文字裡上傳的圖。
fn message_images(content: &Value, found: &mut Vec<ImageSource>) {
    for part in content.as_array().into_iter().flatten() {
        match part["type"].as_str() {
            Some("text" | "input_text") => {
                uploads(part["text"].as_str().unwrap_or_default(), found)
            }
            Some(kind) if kind.contains("image") => found.extend(part_image(part)),
            _ => {}
        }
    }
}

/// 一個圖片片段：資料網址（`image_url`、`url`）或檔案路徑（`path`）；網路上的圖不讀。
fn part_image(part: &Value) -> Option<ImageSource> {
    let url = part["image_url"]
        .as_str()
        .or_else(|| part["image_url"]["url"].as_str())
        .or_else(|| part["url"].as_str());
    match (url, part["path"].as_str()) {
        (Some(url), _) if url.starts_with("data:") => Some(ImageSource::Data(url.into())),
        (_, Some(path)) => Some(ImageSource::File(path.into())),
        _ => None,
    }
}

/// 文字裡上傳的圖片路徑（`.tap-code/uploads/…png`，可能帶 `@` 或 `./`）。
fn uploads(text: &str, found: &mut Vec<ImageSource>) {
    for word in text.split_whitespace() {
        if let Some(path) = upload_image(word) {
            found.push(ImageSource::Upload(path.into()));
        }
    }
}

/// 一個字是上傳的圖片路徑時，傳回相對專案目錄的路徑。
pub(super) fn upload_image(word: &str) -> Option<&str> {
    let word = word.trim_end_matches([',', '，', '。', ';', '；', ')', '）']);
    let path = word
        .strip_prefix('@')
        .unwrap_or(word)
        .trim_start_matches("./");
    let name = path.strip_prefix(UPLOADS)?;
    (!name.is_empty()
        && !name.contains('/')
        && IMAGE_EXTENSIONS
            .iter()
            .any(|extension| name.to_ascii_lowercase().ends_with(extension)))
    .then_some(path)
}

/// 訊息顯示用的文字：拿掉上傳的圖片路徑（改成縮圖），其他文字不動。
pub(super) fn strip_uploads(text: &str) -> String {
    if !text.contains(UPLOADS) {
        return text.to_string();
    }
    text.lines()
        .map(|line| {
            line.split(' ')
                .filter(|word| upload_image(word).is_none())
                .collect::<Vec<_>>()
                .join(" ")
                .trim_end()
                .to_string()
        })
        .collect::<Vec<_>>()
        .join("\n")
}
