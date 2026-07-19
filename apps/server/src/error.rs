use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::Json;
use cli_manager_web_protocol::{ApiError, ApiErrorBody};

#[derive(Debug, thiserror::Error)]
pub enum AppError {
    #[error("{code}: {message}")]
    Api {
        status: StatusCode,
        code: &'static str,
        message: String,
    },
    #[error(transparent)]
    Sqlx(#[from] sqlx::Error),
    #[error(transparent)]
    Migration(#[from] sqlx::migrate::MigrateError),
    #[error(transparent)]
    Json(#[from] serde_json::Error),
    #[error("{0}")]
    Internal(String),
}

impl AppError {
    pub fn bad_request(code: &'static str, message: impl Into<String>) -> Self {
        Self::Api {
            status: StatusCode::BAD_REQUEST,
            code,
            message: message.into(),
        }
    }

    pub fn unauthorized() -> Self {
        Self::Api {
            status: StatusCode::UNAUTHORIZED,
            code: "unauthorized",
            message: "authentication required".to_string(),
        }
    }

    pub fn forbidden(code: &'static str, message: impl Into<String>) -> Self {
        Self::Api {
            status: StatusCode::FORBIDDEN,
            code,
            message: message.into(),
        }
    }

    pub fn not_found(code: &'static str, message: impl Into<String>) -> Self {
        Self::Api {
            status: StatusCode::NOT_FOUND,
            code,
            message: message.into(),
        }
    }

    pub fn conflict(code: &'static str, message: impl Into<String>) -> Self {
        Self::Api {
            status: StatusCode::CONFLICT,
            code,
            message: message.into(),
        }
    }
}

impl IntoResponse for AppError {
    fn into_response(self) -> Response {
        let (status, code, message) = match self {
            Self::Api {
                status,
                code,
                message,
            } => (status, code.to_string(), message),
            other => {
                tracing::error!(error = %other, "request failed");
                (
                    StatusCode::INTERNAL_SERVER_ERROR,
                    "internal_error".to_string(),
                    "internal server error".to_string(),
                )
            }
        };
        (
            status,
            Json(ApiErrorBody {
                error: ApiError { code, message },
            }),
        )
            .into_response()
    }
}
