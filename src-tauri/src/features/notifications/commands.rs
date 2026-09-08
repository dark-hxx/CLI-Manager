use crate::third_party_notification::{self, TestSendResult, ThirdPartyTarget};

#[tauri::command]
// 暴露指定目标的真实测试通知发送入口；结果由通知服务统一构造。
pub async fn third_party_notification_test_send(
    target: ThirdPartyTarget,
) -> Result<TestSendResult, String> {
    third_party_notification::test_send(target).await
}
