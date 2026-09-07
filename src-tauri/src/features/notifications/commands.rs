use crate::third_party_notification::{self, TestSendResult, ThirdPartyTarget};

#[tauri::command]
pub async fn third_party_notification_test_send(
    target: ThirdPartyTarget,
) -> Result<TestSendResult, String> {
    third_party_notification::test_send(target).await
}
