//! PG seeding for the permission-leak fixture (plan §8.1).
//!
//! Follows the conventions of `approval_pg.rs`: a superuser pool inserts the
//! tenant skeleton (workspace, members, channels, memberships) bypassing RLS,
//! and every message goes through `send_message_in_tx` on the NOBYPASSRLS
//! `momo_app` pool inside `with_tenant_tx`, so `channel_seq` and the outbox row
//! are produced by the real spine (AGENTS.md invariant).

use std::collections::HashMap;

use momo_db::{with_tenant_tx, PgPool};
use momo_messaging::{send_message_in_tx, NewMessage};
use uuid::Uuid;

use super::corpus::{Channel, Corpus, Who};
use super::harness::Mutation;

pub struct Seeded {
    pub workspace_id: Uuid,
    pub member: HashMap<Who, Uuid>,
    pub channel: HashMap<Channel, Uuid>,
    pub message: HashMap<String, Uuid>,
}

pub async fn seed(su: &PgPool, app: &PgPool, corpus: &Corpus) -> Seeded {
    let workspace_id = Uuid::new_v4();
    sqlx::query("INSERT INTO workspace (id, slug, name) VALUES ($1, $2, $2)")
        .bind(workspace_id)
        .bind(format!("memeval-{}", workspace_id.simple()))
        .execute(su)
        .await
        .expect("seed workspace");

    let mut member = HashMap::new();
    for who in Who::ALL {
        let id = Uuid::new_v4();
        let agentish = matches!(who, Who::Agent | Who::Bot);
        sqlx::query(
            "INSERT INTO member (id, workspace_id, kind, display_name, handle) \
             VALUES ($1, $2, $3::member_kind, $4, $4)",
        )
        .bind(id)
        .bind(workspace_id)
        .bind(if agentish { "agent" } else { "human" })
        .bind(who.handle())
        .execute(su)
        .await
        .expect("seed member");
        if agentish {
            sqlx::query(
                "INSERT INTO agent (member_id, workspace_id, model, base_url) \
                 VALUES ($1, $2, 'hermes-agent', 'https://gateway.invalid/v1')",
            )
            .bind(id)
            .bind(workspace_id)
            .execute(su)
            .await
            .expect("seed agent");
        }
        member.insert(who, id);
    }

    let mut channel = HashMap::new();
    for ch in Channel::ALL {
        let id = Uuid::new_v4();
        let dm_key = (ch == Channel::DmXAgent).then(|| format!("memeval-{}", id.simple()));
        sqlx::query(
            "INSERT INTO channel (id, workspace_id, kind, name, dm_key) \
             VALUES ($1, $2, $3::channel_kind, $4, $5)",
        )
        .bind(id)
        .bind(workspace_id)
        .bind(ch.kind())
        .bind((ch != Channel::DmXAgent).then(|| ch.label()))
        .bind(dm_key)
        .execute(su)
        .await
        .expect("seed channel");
        sqlx::query(
            "INSERT INTO channel_seq (channel_id, workspace_id, last_seq) VALUES ($1, $2, 0)",
        )
        .bind(id)
        .bind(workspace_id)
        .execute(su)
        .await
        .expect("seed channel_seq");
        for who in ch.members() {
            sqlx::query(
                "INSERT INTO membership (workspace_id, channel_id, member_id) VALUES ($1, $2, $3)",
            )
            .bind(workspace_id)
            .bind(id)
            .bind(member[who])
            .execute(su)
            .await
            .expect("seed membership");
        }
        channel.insert(ch, id);
    }

    let mut message: HashMap<String, Uuid> = HashMap::new();
    for m in &corpus.messages {
        let mut input = NewMessage::text(channel[&m.channel], member[&m.author], m.body.clone());
        input.root_id = m.root.as_ref().map(|r| message[r]);
        let sent = with_tenant_tx(app, workspace_id, move |conn| {
            Box::pin(async move { send_message_in_tx(conn, workspace_id, input).await })
        })
        .await
        .expect("send corpus message through the spine");
        message.insert(m.key.clone(), sent.message.id);
    }
    Seeded {
        workspace_id,
        member,
        channel,
        message,
    }
}

/// Source-side change used by the leak cases (departure / deletion).
pub async fn apply_mutation(su: &PgPool, s: &Seeded, m: &Mutation) {
    match m {
        Mutation::Leave(who, ch) => {
            sqlx::query(
                "UPDATE membership SET left_at = now() WHERE channel_id = $1 AND member_id = $2",
            )
            .bind(s.channel[ch])
            .bind(s.member[who])
            .execute(su)
            .await
            .expect("set left_at");
        }
        Mutation::Delete(key) => {
            sqlx::query(
                "UPDATE message SET state = 'deleted', deleted_at = now(), body = NULL WHERE id = $1",
            )
            .bind(s.message[key])
            .execute(su)
            .await
            .expect("delete message");
        }
    }
}
