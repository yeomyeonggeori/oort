//! Which credential a command uses, and how a login session's access half is kept alive.
//!
//! The credential is, in order: `OORT_TOKEN` (never stored, never refreshed — `whoami` says
//! `source: env`), else the profile `current.json` points at. A login session's access half is
//! refreshed **under the store lock**: the lock is taken, the store is read again, and if another
//! process already rotated the pair that result is used instead of presenting the old refresh
//! half a second time (the server reads a repeated refresh as theft and ends the whole session).

use reqwest::blocking::RequestBuilder;

use crate::api::{network_error, parse_json, read_reply, Api, Reply, TokenResponse};
use crate::error::{CliError, Kind};
use crate::output::now_ms;
use crate::secret::{parse_envelope, EnvelopeKind, Secret};
use crate::store::{Credential, Form, StorageKind, Store};

/// The built-in public OAuth client of this CLI.
pub const CLIENT_ID: &str = "oort-cli";

/// The settings of one invocation.
pub struct Ctx {
    pub env: crate::Env,
    pub json: bool,
    pub server: Option<String>,
    pub workspace: Option<String>,
}

impl Ctx {
    pub fn store(&self) -> Result<Store, CliError> {
        Store::locate(
            self.env.xdg_config_home.as_deref(),
            self.env.home.as_deref(),
        )
    }

    /// `--server`, else `OORT_SERVER`.
    pub fn requested_server(&self) -> Option<&str> {
        self.server.as_deref().or(self.env.server.as_deref())
    }

    /// `--workspace`, else `OORT_WORKSPACE`.
    pub fn requested_workspace(&self) -> Option<&str> {
        self.workspace.as_deref().or(self.env.workspace.as_deref())
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Source {
    Env,
    Stored(StorageKind),
}

impl Source {
    pub fn label(self) -> &'static str {
        match self {
            Source::Env => "env",
            Source::Stored(_) => "stored",
        }
    }

    pub fn storage(self) -> Option<StorageKind> {
        match self {
            Source::Env => None,
            Source::Stored(kind) => Some(kind),
        }
    }
}

/// A resolved credential plus the client that talks to its server.
pub struct Active {
    api: Api,
    pub server: String,
    pub workspace_id: String,
    pub source: Source,
    stored: Option<Credential>,
    token: Secret,
}

/// A login session's token response, checked and turned into what is saved: both halves must be
/// envelopes of the right kind for the same workspace, and the expiry must be sane.
pub fn credential_from_response(
    server: &str,
    token_endpoint: &str,
    response: TokenResponse,
    expected_workspace: Option<&str>,
) -> Result<Credential, CliError> {
    let bad = || {
        CliError::new(
            Kind::Server,
            "bad_response",
            "서버가 준 토큰 모양이 올바르지 않아요. 서버 버전을 확인해 주세요.",
        )
    };
    let access = parse_envelope(response.access_token.expose())
        .filter(|envelope| envelope.kind == EnvelopeKind::Access)
        .ok_or_else(bad)?;
    let refresh_secret = response.refresh_token.ok_or_else(bad)?;
    let refresh = parse_envelope(refresh_secret.expose())
        .filter(|envelope| envelope.kind == EnvelopeKind::Refresh)
        .ok_or_else(bad)?;
    let workspace_id = access.workspace_id.to_string();
    if refresh.workspace_id != access.workspace_id
        || response
            .workspace_id
            .as_deref()
            .is_some_and(|reported| reported != workspace_id)
        || expected_workspace.is_some_and(|expected| expected != workspace_id)
        || !(1..=86_400).contains(&response.expires_in)
    {
        return Err(bad());
    }
    Ok(Credential {
        v: Credential::VERSION,
        server: server.to_string(),
        workspace_id,
        form: Form::Session,
        access: response.access_token,
        refresh: Some(refresh_secret),
        access_expires_at_ms: Some(now_ms() + response.expires_in * 1000),
        token_endpoint: Some(token_endpoint.to_string()),
        saved_at_ms: now_ms(),
    })
}

impl Active {
    pub fn resolve(ctx: &Ctx) -> Result<Active, CliError> {
        if let Some(token) = &ctx.env.token {
            let envelope = parse_envelope(token.expose())
                .filter(|envelope| envelope.kind == EnvelopeKind::Access)
                .ok_or_else(|| {
                    CliError::usage(
                        "invalid_token_env",
                        "OORT_TOKEN이 oort 카드 토큰(momo_dev_v1…) 모양이 아니에요.",
                    )
                })?;
            let server = ctx.requested_server().ok_or_else(|| {
                CliError::usage(
                    "server_required",
                    "OORT_TOKEN을 쓰려면 서버 주소가 필요해요(--server 또는 OORT_SERVER).",
                )
            })?;
            let origin = crate::api::parse_server(server)?;
            let workspace_id = envelope.workspace_id.to_string();
            if ctx
                .requested_workspace()
                .is_some_and(|requested| requested != workspace_id)
            {
                return Err(CliError::usage(
                    "workspace_mismatch",
                    "OORT_TOKEN의 워크스페이스와 --workspace가 달라요.",
                ));
            }
            return Ok(Active {
                api: Api::new(&origin)?,
                server: origin,
                workspace_id,
                source: Source::Env,
                stored: None,
                token: token.clone(),
            });
        }

        let store = ctx.store()?;
        let current = store.current()?.ok_or_else(CliError::login_required)?;
        if let Some(server) = ctx.requested_server() {
            if crate::api::parse_server(server)? != current.server {
                return Err(CliError::new(
                    Kind::LoginRequired,
                    "login_required",
                    "그 서버로 로그인한 기록이 없어요. `oort login --server …`을 해 주세요.",
                ));
            }
        }
        if ctx
            .requested_workspace()
            .is_some_and(|requested| requested != current.workspace_id)
        {
            return Err(CliError::new(
                Kind::LoginRequired,
                "login_required",
                "그 워크스페이스로 로그인한 기록이 없어요.",
            ));
        }
        let credential = store
            .backend(current.storage)?
            .load(&current.key())?
            .ok_or_else(CliError::login_required)?;
        Ok(Active {
            api: Api::new(&current.server)?,
            server: current.server.clone(),
            workspace_id: current.workspace_id.clone(),
            source: Source::Stored(current.storage),
            token: credential.access.clone(),
            stored: Some(credential),
        })
    }

    pub fn api(&self) -> &Api {
        &self.api
    }

    /// When the stored access half lapses (a login session only; a card's own expiry is the
    /// server's to say, in `whoami`).
    pub fn stored_expiry_ms(&self) -> Option<i64> {
        self.stored
            .as_ref()
            .filter(|credential| credential.form == Form::Session)
            .and_then(|credential| credential.access_expires_at_ms)
    }

    pub fn form(&self) -> Option<Form> {
        self.stored.as_ref().map(|credential| credential.form)
    }

    pub fn workspace_path(&self, rest: &str) -> String {
        format!("/v1/workspaces/{}{rest}", self.workspace_id)
    }

    /// The access half to present now (refreshed first if it is about to lapse).
    pub fn fresh_token(&mut self, ctx: &Ctx) -> Result<Secret, CliError> {
        self.ensure_fresh(ctx)?;
        Ok(self.token.clone())
    }

    fn ensure_fresh(&mut self, ctx: &Ctx) -> Result<(), CliError> {
        let stale = self
            .stored
            .as_ref()
            .filter(|credential| credential.access_is_stale(now_ms()))
            .map(|credential| credential.access.clone());
        match stale {
            Some(stale) => self.refresh(ctx, &stale),
            None => Ok(()),
        }
    }

    /// Send one request with the current token. A `401` on a login session earns exactly one
    /// refresh and one more try (the clock, or another process, may have outrun our expiry).
    pub fn send(
        &mut self,
        ctx: &Ctx,
        build: &dyn Fn(&Api, &Secret) -> RequestBuilder,
    ) -> Result<Reply, CliError> {
        self.ensure_fresh(ctx)?;
        let reply = self.send_once(build)?;
        if reply.status == 401 && self.form() == Some(Form::Session) {
            let stale = self.token.clone();
            self.refresh(ctx, &stale)?;
            return self.send_once(build);
        }
        Ok(reply)
    }

    fn send_once(
        &self,
        build: &dyn Fn(&Api, &Secret) -> RequestBuilder,
    ) -> Result<Reply, CliError> {
        let response = build(&self.api, &self.token)
            .send()
            .map_err(|error| network_error(&error))?;
        read_reply(response)
    }

    pub fn get(
        &mut self,
        ctx: &Ctx,
        path: &str,
        query: &[(&str, String)],
    ) -> Result<Reply, CliError> {
        let url = self.api.url(path);
        let query: Vec<(String, String)> = query
            .iter()
            .map(|(key, value)| ((*key).to_string(), value.clone()))
            .collect();
        self.send(ctx, &|api, token| {
            api.client()
                .get(&url)
                .query(&query)
                .bearer_auth(token.expose())
        })
    }

    pub fn post_json(
        &mut self,
        ctx: &Ctx,
        path: &str,
        body: &serde_json::Value,
    ) -> Result<Reply, CliError> {
        let url = self.api.url(path);
        self.send(ctx, &|api, token| {
            api.client()
                .post(&url)
                .bearer_auth(token.expose())
                .json(body)
        })
    }

    pub fn delete(&mut self, ctx: &Ctx, path: &str) -> Result<Reply, CliError> {
        let url = self.api.url(path);
        self.send(ctx, &|api, token| {
            api.client().delete(&url).bearer_auth(token.expose())
        })
    }

    fn adopt(&mut self, credential: Credential) {
        self.token = credential.access.clone();
        self.stored = Some(credential);
    }

    /// Rotate the pair under the store lock (module docs).
    fn refresh(&mut self, ctx: &Ctx, stale: &Secret) -> Result<(), CliError> {
        let Some(current) = self.stored.clone() else {
            return Err(CliError::login_required());
        };
        if current.form != Form::Session {
            return Err(CliError::login_required());
        }
        let Source::Stored(kind) = self.source else {
            return Err(CliError::login_required());
        };
        let store = ctx.store()?;
        let _lock = store.lock()?;
        let backend = store.backend(kind)?;
        let key = current.key();

        // The second look: someone may have rotated while we waited for the lock.
        let latest = backend.load(&key)?.ok_or_else(CliError::login_required)?;
        if latest.access != *stale && !latest.access_is_stale(now_ms()) {
            self.adopt(latest);
            return Ok(());
        }
        let refresh = latest
            .refresh
            .clone()
            .ok_or_else(CliError::login_required)?;
        let endpoint = latest
            .token_endpoint
            .clone()
            .ok_or_else(CliError::login_required)?;
        if !self.api.same_origin(&endpoint) {
            return Err(CliError::failure(
                "token_endpoint_origin",
                "저장된 토큰 주소가 서버와 달라서 쓰지 않아요. `oort login`으로 다시 로그인해 주세요.",
            ));
        }
        let response = self
            .api
            .client()
            .post(&endpoint)
            .form(&[
                ("grant_type", "refresh_token"),
                ("refresh_token", refresh.expose()),
                ("client_id", CLIENT_ID),
            ])
            .send()
            .map_err(|error| network_error(&error))?;
        let reply = read_reply(response)?;
        if reply.status == 400 || reply.status == 401 {
            return Err(CliError::new(
                Kind::LoginRequired,
                "login_expired",
                "로그인이 끝났어요(오래 안 썼거나 다른 곳에서 끝났어요). `oort login`으로 다시 로그인해 주세요.",
            )
            .with_status(reply.status));
        }
        let response: TokenResponse = parse_json(&reply)?;
        let next = credential_from_response(
            &latest.server,
            &endpoint,
            response,
            Some(&latest.workspace_id),
        )?;
        // The server has rotated: the old refresh half is dead. If the new pair cannot be kept,
        // the only honest thing left is to say so.
        backend.save(&key, &next).map_err(|error| {
            CliError::failure(
                "refresh_not_saved",
                format!(
                    "새 토큰을 저장하지 못했어요({}). `oort login`으로 다시 로그인해 주세요.",
                    error.message
                ),
            )
        })?;
        self.adopt(next);
        Ok(())
    }
}
