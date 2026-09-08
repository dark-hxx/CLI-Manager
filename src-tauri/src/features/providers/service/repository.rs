mod catalog;
mod common;
mod documents;
mod dto;
mod failover;
mod keys;
mod support;

#[cfg(test)]
mod tests;

pub(crate) use catalog::{
    create_provider, delete_provider, duplicate_provider, get_provider, list_providers,
    reorder_providers, set_provider_enabled, update_provider,
};
pub(crate) use common::{get_common_config, set_common_config, validate_common_config};
pub(crate) use documents::{merge_common_into_settings, update_provider_document};
pub(crate) use dto::{
    CommonConfigDocument, CommonConfigSetInput, ProviderCard, ProviderCreateInput, ProviderDetail,
    ProviderDocumentUpdateInput, ProviderKeyCreateInput, ProviderKeySummary,
    ProviderKeyUpdateInput, ProviderUpdateInput,
};
pub(crate) use failover::{list_failover_providers, set_failover_queue};
pub(crate) use keys::{
    activate_key, create_key, delete_key, list_keys, reorder_keys, reveal_key, set_key_enabled,
    update_key,
};
pub(crate) use support::{
    meta_common_config_enabled, meta_enabled, normalize_app_type, parse_meta,
    project_key_into_settings, unix_timestamp_millis,
};
