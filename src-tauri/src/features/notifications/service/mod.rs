mod adapters;
mod dispatcher;
mod http;
mod model;

pub use dispatcher::DispatcherHandle;
pub use model::{HookNotificationJob, TestSendResult, ThirdPartyTarget};

// 将显式测试发送委派给分发器，返回供应商接受结果，不仅是请求配置预检。
pub async fn test_send(target: ThirdPartyTarget) -> Result<TestSendResult, String> {
    dispatcher::test_send(target).await
}
