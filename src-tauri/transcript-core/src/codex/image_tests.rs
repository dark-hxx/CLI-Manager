use super::{images::upload_image, *};
use serde_json::json;

fn parse_at(lines: &[(u64, Value)]) -> Vec<Value> {
    let mut parser = Parser::new(Some("/work/app".into()));
    let mut out = Vec::new();
    for (offset, line) in lines {
        parser.parse_line_at(*offset, line.to_string().as_bytes(), &mut out);
    }
    out.iter()
        .map(|event| serde_json::to_value(event).unwrap())
        .filter(|event| event["kind"] != "status")
        .collect()
}

#[test]
fn uploaded_images_become_thumbnails_instead_of_paths() {
    let events = parse_at(&[(
        120,
        json!({"timestamp":"2026-10-15T07:15:26.280Z","type":"event_msg","payload":{
            "type":"user_message",
            "message":"看看这个报错 .tap-code/uploads/截图-1a2b3c.png\n还有 @.tap-code/uploads/b-9f8e7d.JPG 和日志 .tap-code/uploads/run-1.log",
            "images":[],"local_images":[]
        }}),
    )]);
    assert_eq!(events[0]["uuid"], "@120");
    assert_eq!(events[0]["images"], 2);
    // 圖片路徑改成縮圖，不是圖片的上傳檔照樣留在文字裡。
    assert_eq!(
        events[0]["text"],
        "看看这个报错\n还有 和日志 .tap-code/uploads/run-1.log"
    );
}

#[test]
fn replies_citing_images_use_the_line_offset_as_uuid() {
    let events = parse_at(&[
        (
            40,
            json!({"timestamp":"2026-10-15T07:15:26.280Z","type":"event_msg","payload":{
                "type":"agent_message","message":"截圖在這：\n\n![首頁](docs/home.png)"
            }}),
        ),
        (
            90,
            json!({"timestamp":"2026-10-15T07:15:27.280Z","type":"event_msg","payload":{
                "type":"agent_message","message":"沒有圖的回覆"
            }}),
        ),
    ]);
    let replies: Vec<_> = events.iter().filter(|e| e["kind"] == "assistant").collect();
    assert_eq!(replies[0]["uuid"], "@40");
    assert_ne!(replies[1]["uuid"], "@90");
}

#[test]
fn line_images_keep_a_fixed_order() {
    let line = json!({"type":"event_msg","payload":{
        "type":"user_message",
        "message":"a .tap-code/uploads/x-1.png",
        "images":["data:image/png;base64,AAAA","https://example.com/remote.png"],
        "local_images":["/tmp/shot.png"]
    }});
    assert_eq!(
        line_images(&line),
        [
            ImageSource::Data("data:image/png;base64,AAAA".into()),
            ImageSource::File("/tmp/shot.png".into()),
            ImageSource::Upload(".tap-code/uploads/x-1.png".into()),
        ]
    );
    // 上傳路徑只認 uploads 目錄底下的單一檔案。
    assert!(upload_image(".tap-code/uploads/../../etc/x.png").is_none());
    assert!(upload_image(".tap-code/uploads/sub/x.png").is_none());
    let output = json!({"type":"response_item","payload":{
        "type":"custom_tool_call_output","call_id":"c1",
        "output":[{"type":"input_text","text":"截图"},{"type":"input_image","image_url":"data:image/jpeg;base64,BBBB"}]
    }});
    assert_eq!(
        line_images(&output),
        [ImageSource::Data("data:image/jpeg;base64,BBBB".into())]
    );
}
