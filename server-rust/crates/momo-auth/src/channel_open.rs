//! ADR-0224 D13 (#5870): the one judgment of whether a channel is open to people, and whether it
//! is open to one requester (a person or an agent).
//!
//! * **open to people** — a live public channel listed in channel browse (`browse_listed`).
//! * **open to a requester** — open to people, or the requester is a live member of it.
//!
//! Every agent-side rule that used to say 「a public channel is enough」 reads one of these two
//! (the team AI's room scope and channel-name list, an agent's channel lookup by name, the hosted
//! connection's channel grant and confirm, the OAuth consent). The three channel conditions are
//! written together here and nowhere else.
//!
//! The SQL builders take an alias and a bind placeholder that are **compile-time literals**
//! (`&'static str`): no request value is ever spliced into the statement.

use sqlx::PgConnection;
use uuid::Uuid;

/// SQL predicate over the channel row `alias`: the channel is open to people.
pub fn channel_open_to_people_sql(alias: &'static str) -> String {
    format!("({alias}.kind = 'public' AND {alias}.archived_at IS NULL AND {alias}.browse_listed)")
}

/// SQL predicate over the channel row `alias`: the channel is open to the member bound at
/// `member_param` (for example `"$3"`) — open to people, or that member is in it.
pub fn channel_open_to_member_sql(alias: &'static str, member_param: &'static str) -> String {
    format!(
        "({people} OR EXISTS (SELECT 1 FROM membership open_to \
            WHERE open_to.workspace_id = {alias}.workspace_id AND open_to.channel_id = {alias}.id \
              AND open_to.member_id = {member_param} AND open_to.left_at IS NULL))",
        people = channel_open_to_people_sql(alias),
    )
}

/// Whether channel `channel_id` of `workspace_id` is open to `member_id`
/// ([`channel_open_to_member_sql`]). A channel that does not exist is not open.
pub async fn channel_is_open_to_member_in_tx(
    conn: &mut PgConnection,
    workspace_id: Uuid,
    channel_id: Uuid,
    member_id: Uuid,
) -> Result<bool, sqlx::Error> {
    let sql = format!(
        "SELECT EXISTS (SELECT 1 FROM channel c WHERE c.workspace_id = $1 AND c.id = $2 AND {})",
        channel_open_to_member_sql("c", "$3"),
    );
    sqlx::query_scalar(&sql)
        .bind(workspace_id)
        .bind(channel_id)
        .bind(member_id)
        .fetch_one(&mut *conn)
        .await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_people_judgment_names_all_three_conditions_on_the_given_row() {
        let sql = channel_open_to_people_sql("c");
        assert!(sql.contains("c.kind = 'public'"));
        assert!(sql.contains("c.archived_at IS NULL"));
        assert!(sql.contains("c.browse_listed"));
    }

    #[test]
    fn the_member_judgment_is_the_people_judgment_or_a_live_membership() {
        let sql = channel_open_to_member_sql("ch", "$4");
        assert!(sql.starts_with(&format!("({} OR EXISTS", channel_open_to_people_sql("ch"))));
        assert!(sql.contains("open_to.member_id = $4"));
        assert!(sql.contains("open_to.left_at IS NULL"));
        assert!(sql.contains("open_to.channel_id = ch.id"));
    }
}
