//! BYOK provider presets for the AI 연결 surface (#2872).
//!
//! A preset is a **starting point** for the operator's form — a known base URL
//! and the wire format it speaks — never a second storage path: the operator
//! still saves an ordinary `provider_link` row through `PUT /v1/provider/link`,
//! the base URL still passes [`crate::validated_base_url`], and the key is still
//! sealed. Nothing here is a credential.
//!
//! Base URLs are the providers' documented API roots (runtime-unverified — no
//! call to any of them is made by this repo's tests):
//!
//! | id | wire | base URL | path the worker appends |
//! |---|---|---|---|
//! | `openai` | chat/completions | `https://api.openai.com/v1` | `/chat/completions` |
//! | `anthropic` | Anthropic Messages | `https://api.anthropic.com/v1` | `/messages` |
//! | `xai` | chat/completions | `https://api.x.ai/v1` | `/chat/completions` |
//! | `openrouter` | chat/completions | `https://openrouter.ai/api/v1` | `/chat/completions` |

use serde::Serialize;

/// The request/response format a key-based link speaks. The wire is chosen by
/// the sealed credential kind (`LinkCredential::AnthropicKey` ⇒ Anthropic);
/// this enum is the form-level name for that choice.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum ProviderFormat {
    /// OpenAI-compatible `POST {base}/chat/completions` (every legacy link).
    Openai,
    /// Anthropic Messages `POST {base}/messages`, `x-api-key` header.
    Anthropic,
}

impl ProviderFormat {
    pub fn as_str(self) -> &'static str {
        match self {
            ProviderFormat::Openai => "openai",
            ProviderFormat::Anthropic => "anthropic",
        }
    }

    /// `None`/blank ⇒ `openai`, the format every existing client sends
    /// implicitly. An unknown value is `None` so the route answers 400 rather
    /// than guessing a wire.
    pub fn from_label(raw: Option<&str>) -> Option<ProviderFormat> {
        match raw.map(str::trim).filter(|value| !value.is_empty()) {
            None => Some(ProviderFormat::Openai),
            Some(value) => match value.to_ascii_lowercase().as_str() {
                "openai" => Some(ProviderFormat::Openai),
                "anthropic" => Some(ProviderFormat::Anthropic),
                _ => None,
            },
        }
    }
}

/// One preset row, serialized as-is into the link response.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderPreset {
    pub id: &'static str,
    pub label: &'static str,
    pub base_url: &'static str,
    pub format: ProviderFormat,
}

pub const PROVIDER_PRESETS: [ProviderPreset; 4] = [
    ProviderPreset {
        id: "openai",
        label: "OpenAI",
        base_url: "https://api.openai.com/v1",
        format: ProviderFormat::Openai,
    },
    ProviderPreset {
        id: "anthropic",
        label: "Anthropic (Claude)",
        base_url: "https://api.anthropic.com/v1",
        format: ProviderFormat::Anthropic,
    },
    ProviderPreset {
        id: "xai",
        label: "xAI (Grok)",
        base_url: "https://api.x.ai/v1",
        format: ProviderFormat::Openai,
    },
    ProviderPreset {
        id: "openrouter",
        label: "OpenRouter",
        base_url: "https://openrouter.ai/api/v1",
        format: ProviderFormat::Openai,
    },
];

#[cfg(test)]
mod tests {
    use super::*;

    /// A preset the write gate refuses would be a button that cannot be saved.
    #[test]
    fn every_preset_passes_the_write_gate_unchanged() {
        for preset in PROVIDER_PRESETS {
            assert_eq!(
                crate::validated_base_url(preset.base_url, "production", false).expect(preset.id),
                preset.base_url,
                "{} must already be in stored (normalised) form",
                preset.id
            );
        }
        let ids: Vec<_> = PROVIDER_PRESETS.iter().map(|preset| preset.id).collect();
        assert_eq!(ids, ["openai", "anthropic", "xai", "openrouter"]);
    }

    #[test]
    fn the_format_label_defaults_to_openai_and_refuses_the_unknown() {
        assert_eq!(
            ProviderFormat::from_label(None),
            Some(ProviderFormat::Openai)
        );
        assert_eq!(
            ProviderFormat::from_label(Some(" ")),
            Some(ProviderFormat::Openai)
        );
        assert_eq!(
            ProviderFormat::from_label(Some("Anthropic")),
            Some(ProviderFormat::Anthropic)
        );
        assert_eq!(ProviderFormat::from_label(Some("gemini")), None);
        assert_eq!(
            serde_json::to_value(PROVIDER_PRESETS[1]).unwrap(),
            serde_json::json!({
                "id": "anthropic",
                "label": "Anthropic (Claude)",
                "baseUrl": "https://api.anthropic.com/v1",
                "format": "anthropic",
            })
        );
    }
}
