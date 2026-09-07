mod adapters;
mod dispatcher;
mod http;
mod model;

pub use dispatcher::DispatcherHandle;
pub use model::{HookNotificationJob, TestSendResult, ThirdPartyTarget};

pub async fn test_send(target: ThirdPartyTarget) -> Result<TestSendResult, String> {
    dispatcher::test_send(target).await
}
