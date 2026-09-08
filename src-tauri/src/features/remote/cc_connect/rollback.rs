use super::{
    delete_credential, get_credential, set_credential, write_file_atomically_if_changed,
    CcConnectPlatform, FEISHU_APP_ID_ACCOUNT, FEISHU_APP_SECRET_ACCOUNT, TELEGRAM_TOKEN_ACCOUNT,
    WECOM_BOT_ID_ACCOUNT, WECOM_BOT_SECRET_ACCOUNT, WEIXIN_TOKEN_ACCOUNT,
};
use std::fs::{self};
use std::path::PathBuf;

pub(super) struct CredentialSnapshot {
    pub(super) entries: Vec<(&'static str, Option<String>)>,
}

impl CredentialSnapshot {
    // 读取指定平台或全部平台的凭据作为内存快照。
    pub(super) fn capture(platform: Option<CcConnectPlatform>) -> Result<Self, String> {
        let accounts: Vec<&'static str> = match platform {
            Some(CcConnectPlatform::Telegram) => vec![TELEGRAM_TOKEN_ACCOUNT],
            Some(CcConnectPlatform::Feishu) => {
                vec![FEISHU_APP_ID_ACCOUNT, FEISHU_APP_SECRET_ACCOUNT]
            }
            Some(CcConnectPlatform::Weixin) => vec![WEIXIN_TOKEN_ACCOUNT],
            Some(CcConnectPlatform::Wecom) => {
                vec![WECOM_BOT_ID_ACCOUNT, WECOM_BOT_SECRET_ACCOUNT]
            }
            None => vec![
                TELEGRAM_TOKEN_ACCOUNT,
                FEISHU_APP_ID_ACCOUNT,
                FEISHU_APP_SECRET_ACCOUNT,
                WEIXIN_TOKEN_ACCOUNT,
                WECOM_BOT_ID_ACCOUNT,
                WECOM_BOT_SECRET_ACCOUNT,
            ],
        };
        let mut entries = Vec::with_capacity(accounts.len());
        for account in accounts {
            entries.push((account, get_credential(account)?));
        }
        Ok(Self { entries })
    }

    // 恢复每个凭据并汇总全部恢复失败信息。
    pub(super) fn restore(&self) -> Result<(), String> {
        let mut errors = Vec::new();
        for (account, value) in &self.entries {
            if let Err(err) = restore_credential(account, value.as_deref()) {
                errors.push(err);
            }
        }
        if errors.is_empty() {
            Ok(())
        } else {
            Err(errors.join("; "))
        }
    }
}

// 恢复原有凭据值，原先不存在则删除当前凭据。
pub(super) fn restore_credential(account: &str, value: Option<&str>) -> Result<(), String> {
    match value {
        Some(value) => set_credential(account, value),
        None => delete_credential(account),
    }
}

pub(super) struct FileSnapshot {
    pub(super) path: PathBuf,
    pub(super) contents: Option<Vec<u8>>,
    pub(super) label: &'static str,
}

impl FileSnapshot {
    // 读取文件原始字节，区分不存在和其他读取错误。
    pub(super) fn capture(path: PathBuf, label: &'static str) -> Result<Self, String> {
        let contents = match fs::read(&path) {
            Ok(contents) => Some(contents),
            Err(err) if err.kind() == std::io::ErrorKind::NotFound => None,
            Err(err) => return Err(format!("snapshot {label} failed: {err}")),
        };
        Ok(Self {
            path,
            contents,
            label,
        })
    }

    // 恢复原文件字节，原先不存在则删除新增文件。
    pub(super) fn restore(&self) -> Result<(), String> {
        if let Some(contents) = self.contents.as_deref() {
            write_file_atomically_if_changed(&self.path, contents, self.label)
        } else {
            match fs::remove_file(&self.path) {
                Ok(()) => Ok(()),
                Err(err) if err.kind() == std::io::ErrorKind::NotFound => Ok(()),
                Err(err) => Err(format!("remove rolled back {} failed: {err}", self.label)),
            }
        }
    }
}
