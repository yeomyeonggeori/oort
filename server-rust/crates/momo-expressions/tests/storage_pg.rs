//! ADR-0218 §6. Real PG18, two tenants, actual NOBYPASSRLS runtime role.
//! DATABASE_URL=<dedicated DB> cargo test -p momo-expressions --test storage_pg -- --ignored
use momo_db::migrate::{default_migrations_dir, run_migrations, SeedMode};
use momo_db::sqlx::{
    self,
    postgres::{PgConnectOptions, PgPoolOptions},
    Row,
};
use momo_db::{with_tenant_tx, PgPool};
use momo_expressions::{self as e, Actor, Choice, Error, Metadata, Origin, Report};
use serde_json::{json, Value};
use std::sync::Once;
use uuid::Uuid;

async fn setup() -> (PgPool, PgPool, Actor, Actor, Actor) {
    let url = std::env::var("DATABASE_URL").expect("dedicated DATABASE_URL");
    static INIT: Once = Once::new();
    INIT.call_once(|| {
        run_migrations(&url, &default_migrations_dir(), SeedMode::None).unwrap();
        let psql = if std::path::Path::new("/opt/homebrew/opt/libpq/bin/psql").is_file() {
            "/opt/homebrew/opt/libpq/bin/psql"
        } else {
            "psql"
        };
        let s = std::process::Command::new(psql)
            .arg(&url)
            .args([
                "--no-psqlrc",
                "--quiet",
                "-v",
                "ON_ERROR_STOP=1",
                "--single-transaction",
                "-f",
            ])
            .arg(concat!(
                env!("CARGO_MANIFEST_DIR"),
                "/../../../infra/rust/sql/bootstrap_roles.sql"
            ))
            .output()
            .unwrap();
        assert!(
            s.status.success(),
            "bootstrap roles: {}",
            String::from_utf8_lossy(&s.stderr)
        );
    });
    let su = PgPoolOptions::new()
        .max_connections(12)
        .connect(&url)
        .await
        .unwrap();
    let options: PgConnectOptions = url.parse().unwrap();
    let api = PgPoolOptions::new()
        .max_connections(12)
        .connect_with(options.username("momo_app").password("momo_app_dev_pw"))
        .await
        .unwrap();
    let ws = workspace(&su).await;
    let ws2 = workspace(&su).await;
    let owner = person(&su, ws, "owner").await;
    let member = person(&su, ws, "member").await;
    let foreign = person(&su, ws2, "owner").await;
    (su, api, owner, member, foreign)
}
async fn workspace(su: &PgPool) -> Uuid {
    let id = Uuid::new_v4();
    sqlx::query("INSERT INTO workspace(id,slug,name) VALUES($1,$2,$2)")
        .bind(id)
        .bind(id.to_string())
        .execute(su)
        .await
        .unwrap();
    id
}
async fn person(su: &PgPool, ws: Uuid, role: &str) -> Actor {
    let id = Uuid::new_v4();
    sqlx::query(
        "INSERT INTO member(id,workspace_id,kind,display_name,handle) VALUES($1,$2,'human',$3,$3)",
    )
    .bind(id)
    .bind(ws)
    .bind(id.to_string())
    .execute(su)
    .await
    .unwrap();
    sqlx::query("INSERT INTO workspace_membership(workspace_id,member_id,role) VALUES($1,$2,$3::membership_role)").bind(ws).bind(id).bind(role).execute(su).await.unwrap();
    Actor {
        workspace: ws,
        member: id,
    }
}
fn pixels() -> e::media::Processed {
    let mut png = std::io::Cursor::new(Vec::new());
    image::DynamicImage::new_rgba8(8, 4)
        .write_to(&mut png, image::ImageFormat::Png)
        .unwrap();
    e::media::decode(
        &png.into_inner(),
        std::time::Instant::now() + std::time::Duration::from_secs(10),
    )
    .unwrap()
}
fn meta(name: &str) -> Metadata {
    Metadata {
        name: name.into(),
        display_name: "축하 그림".into(),
        tags: vec!["축하".into()],
        subject_member_id: None,
    }
}
async fn draft(api: &PgPool, a: Actor, name: &str) -> Value {
    e::create_draft(api, a, meta(name), Origin::upload(), Some(pixels()), None)
        .await
        .unwrap()
}
fn choice(d: &Value) -> Choice {
    Choice {
        draft_id: Uuid::parse_str(d["draftId"].as_str().unwrap()).unwrap(),
        revision: d["revision"].as_str().unwrap().into(),
        sha256: d["media"]["large"]["sha256"].as_str().unwrap().into(),
        kind: None,
    }
}
fn expression_id(v: &Value) -> Uuid {
    Uuid::parse_str(v["expression"]["id"].as_str().unwrap()).unwrap()
}

#[tokio::test]
#[ignore = "real PG; security-nightly workspace ignored pass"]
async fn tenant_force_fk_pins_rights_reports_and_transaction_sabotage() {
    let (su, api, owner, member, foreign) = setup().await;
    let role: (bool, bool) =
        sqlx::query_as("SELECT rolsuper,rolbypassrls FROM pg_roles WHERE rolname=current_user")
            .fetch_one(&api)
            .await
            .unwrap();
    assert_eq!(role, (false, false));
    for t in [
        "expression_catalog",
        "expression",
        "expression_image",
        "expression_draft",
        "expression_draft_image",
        "expression_report",
        // ADR-0218 G3.6 (#4820 C1b): what the assembler built, held for an hour.
        "expression_assembly",
        "expression_assembly_image",
    ] {
        let row=sqlx::query("SELECT relrowsecurity,relforcerowsecurity,EXISTS(SELECT 1 FROM pg_policy WHERE polrelid=c.oid AND polname='ws_isolation') AS policy FROM pg_class c WHERE c.oid=$1::regclass").bind(t).fetch_one(&api).await.unwrap();
        assert!(
            row.get::<bool, _>("relrowsecurity")
                && row.get::<bool, _>("relforcerowsecurity")
                && row.get::<bool, _>("policy")
        );
    }
    let d = draft(&api, owner, "security_party").await;
    let c = choice(&d);
    let mut bad = c.clone();
    bad.sha256 = "0".repeat(64);
    assert!(matches!(
        e::activate(&api, owner, bad).await,
        Err(Error::Stale)
    ));
    assert!(matches!(
        e::get_draft(&api, member, c.draft_id).await,
        Err(Error::NotFound)
    ));
    assert!(matches!(
        e::get_draft(&api, foreign, c.draft_id).await,
        Err(Error::NotFound)
    ));
    let result = e::activate(&api, owner, c.clone()).await.unwrap();
    let id = expression_id(&result);
    assert_eq!(e::activate(&api, owner, c).await.unwrap(), result);
    assert!(matches!(
        e::get_draft(&api, owner, id).await,
        Err(Error::NotFound)
    ));
    let count: i64 =
        sqlx::query_scalar("SELECT count(*) FROM expression_draft_image WHERE draft_id=$1")
            .bind(id)
            .fetch_one(&su)
            .await
            .unwrap();
    assert_eq!(count, 0);
    let foreign_count = with_tenant_tx(&api, foreign.workspace, move |conn| {
        Box::pin(async move {
            Ok::<i64, momo_db::DbError>(
                sqlx::query_scalar("SELECT count(*) FROM expression")
                    .fetch_one(conn)
                    .await?,
            )
        })
    })
    .await
    .unwrap();
    assert_eq!(foreign_count, 0);
    // A real row (rather than an empty INSERT ... SELECT) must hit each FK.
    let image = pixels().small;
    let fk=with_tenant_tx(&api,foreign.workspace,move|conn|Box::pin(async move {
        sqlx::query("INSERT INTO expression_image(workspace_id,expression_id,variant,mime,bytes,sha256,width,height,frame_count,duration_ms) VALUES($1,$2,'small','image/png',$3,$4,8,4,1,0)")
            .bind(foreign.workspace).bind(id).bind(image.data).bind(image.info.sha256).execute(conn).await?;
        Ok::<_,momo_db::DbError>(())
    })).await;
    assert!(
        fk.is_err(),
        "cross-tenant image FK must reject an inserted row"
    );
    let fk=with_tenant_tx(&api,foreign.workspace,move|conn|Box::pin(async move {
        sqlx::query("INSERT INTO expression(workspace_id,name,display_name,tags,subject_member_id,origin,created_by,version) VALUES($1,'cross_face','face','[]',$2,'{}',$3,1)")
            .bind(foreign.workspace).bind(owner.member).bind(foreign.member).execute(conn).await?;Ok::<_,momo_db::DbError>(())
    })).await;
    assert!(fk.is_err());
    assert!(matches!(
        e::image(
            &api,
            foreign,
            id,
            "small".into(),
            result["expression"]["media"]["small"]["sha256"]
                .as_str()
                .unwrap()
                .into(),
            false
        )
        .await,
        Err(Error::NotFound)
    ));
    assert!(matches!(
        e::image(&api, owner, id, "large".into(), "0".repeat(64), false).await,
        Err(Error::NotFound)
    ));
    assert!(matches!(
        e::mutate(&api, member, id, None, None).await,
        Err(Error::Role)
    ));
    let mut face = meta("subject_face");
    face.subject_member_id = Some(member.member);
    assert!(matches!(
        e::create_draft(
            &api,
            owner,
            face.clone(),
            Origin::upload(),
            Some(pixels()),
            None
        )
        .await,
        Err(Error::Role)
    ));
    let face = e::create_draft(&api, member, face, Origin::upload(), Some(pixels()), None)
        .await
        .unwrap();
    e::set_policy(&api, owner, "admins".into()).await.unwrap();
    assert!(matches!(
        e::activate(&api, member, choice(&face)).await,
        Err(Error::Role)
    ));
    e::set_policy(&api, owner, "members".into()).await.unwrap();
    // A draft does not retain authority after its creator leaves the roster.
    sqlx::query("DELETE FROM workspace_membership WHERE workspace_id=$1 AND member_id=$2")
        .bind(member.workspace)
        .bind(member.member)
        .execute(&su)
        .await
        .unwrap();
    assert!(matches!(
        e::activate(&api, member, choice(&face)).await,
        Err(Error::NotFound)
    ));
    sqlx::query(
        "INSERT INTO workspace_membership(workspace_id,member_id,role) VALUES($1,$2,'member')",
    )
    .bind(member.workspace)
    .bind(member.member)
    .execute(&su)
    .await
    .unwrap();
    // Fail the outbox statement: a report MUST roll back its row + hidden state
    // + version + audit. Sabotage uses a scoped canary predicate, no other data.
    let before: i64 =
        sqlx::query_scalar("SELECT version FROM expression_catalog WHERE workspace_id=$1")
            .bind(owner.workspace)
            .fetch_one(&su)
            .await
            .unwrap();
    sqlx::query(&format!("CREATE OR REPLACE FUNCTION expression_test_outbox_fail() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.workspace_id='{}'::uuid AND NEW.payload->'data'->>'type'='expression.changed' THEN RAISE EXCEPTION 'expression canary failure'; END IF; RETURN NEW; END $$", owner.workspace)).execute(&su).await.unwrap();
    sqlx::query("CREATE TRIGGER expression_test_outbox_fail BEFORE INSERT ON outbox FOR EACH ROW EXECUTE FUNCTION expression_test_outbox_fail()").execute(&su).await.unwrap();
    let failed = e::mutate(
        &api,
        member,
        id,
        None,
        Some(Report {
            reason: "face".into(),
            detail: Some("private report".into()),
        }),
    )
    .await;
    sqlx::query("DROP TRIGGER expression_test_outbox_fail ON outbox")
        .execute(&su)
        .await
        .unwrap();
    sqlx::query("DROP FUNCTION expression_test_outbox_fail()")
        .execute(&su)
        .await
        .unwrap();
    assert!(failed.is_err());
    let after: i64 =
        sqlx::query_scalar("SELECT version FROM expression_catalog WHERE workspace_id=$1")
            .bind(owner.workspace)
            .fetch_one(&su)
            .await
            .unwrap();
    assert_eq!(before, after);
    let reports: i64 =
        sqlx::query_scalar("SELECT count(*) FROM expression_report WHERE expression_id=$1")
            .bind(id)
            .fetch_one(&su)
            .await
            .unwrap();
    assert_eq!(reports, 0);
    let hidden = e::mutate(
        &api,
        member,
        id,
        None,
        Some(Report {
            reason: "face".into(),
            detail: Some("private report".into()),
        }),
    )
    .await
    .unwrap();
    assert_eq!(hidden["expression"]["status"], "hidden");
    assert!(hidden["expression"]["media"].is_null());
    let delta = e::list(&api, owner, Some(before.to_string()))
        .await
        .unwrap();
    assert_eq!(delta["reset"], false);
    assert_eq!(delta["items"].as_array().unwrap().len(), 1);
    assert_eq!(delta["items"][0]["status"], "hidden");
    let audit: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM audit_log WHERE workspace_id=$1 AND action='expression.hidden'",
    )
    .bind(owner.workspace)
    .fetch_one(&su)
    .await
    .unwrap();
    assert_eq!(
        audit, 1,
        "the failed hide must leave no audit; the committed hide must leave one"
    );
    let visible = e::transaction(&api, member, |conn| {
        Box::pin(async move {
            Ok(
                sqlx::query_scalar::<_, i64>("SELECT count(*) FROM expression_report")
                    .fetch_one(conn)
                    .await?,
            )
        })
    })
    .await
    .unwrap();
    assert_eq!(visible, 0);
    let visible = e::transaction(&api, owner, |conn| {
        Box::pin(async move {
            Ok(
                sqlx::query_scalar::<_, i64>("SELECT count(*) FROM expression_report")
                    .fetch_one(conn)
                    .await?,
            )
        })
    })
    .await
    .unwrap();
    assert_eq!(visible, 1);
    // A held assembly (ADR-0218 G3.6), so its two tables are populated as well: a foreign
    // read of an empty table would prove nothing.
    let held_agent = Uuid::new_v4();
    let held_id = Uuid::new_v4();
    sqlx::query(
        "INSERT INTO member(id,workspace_id,kind,display_name,handle) VALUES($1,$2,'agent',$3,$3)",
    )
    .bind(held_agent)
    .bind(owner.workspace)
    .bind(held_agent.to_string())
    .execute(&su)
    .await
    .unwrap();
    sqlx::query("INSERT INTO expression_assembly(workspace_id,id,agent_member_id,requester_member_id,prompt) VALUES($1,$2,$3,$4,'p')")
        .bind(owner.workspace)
        .bind(held_id)
        .bind(held_agent)
        .bind(owner.member)
        .execute(&su)
        .await
        .unwrap();
    sqlx::query("INSERT INTO expression_assembly_image(workspace_id,assembly_id,candidate_index,motion,variant,mime,bytes,sha256,width,height,frame_count,duration_ms) SELECT $1,$2,0,'bounce','large','image/gif',b,encode(sha256(b),'hex'),8,8,2,100 FROM (SELECT '\\x474946'::bytea AS b) fixture")
        .bind(owner.workspace)
        .bind(held_id)
        .execute(&su)
        .await
        .unwrap();
    // Every new tenant table has populated source rows at this point. Omit the
    // workspace predicate deliberately so only the real runtime RLS can hide them.
    for table in [
        "expression_catalog",
        "expression",
        "expression_image",
        "expression_draft",
        "expression_draft_image",
        "expression_report",
        "expression_assembly",
        "expression_assembly_image",
    ] {
        let sql = format!("SELECT count(*) FROM {table}");
        let count = e::transaction(&api, foreign, move |conn| {
            Box::pin(async move { Ok(sqlx::query_scalar::<_, i64>(&sql).fetch_one(conn).await?) })
        })
        .await
        .unwrap();
        assert_eq!(count, 0, "foreign RLS read leaked {table}");
    }
    let blocked_write = e::transaction(&api, owner, move |conn| {
        Box::pin(async move {
            sqlx::query("INSERT INTO expression_catalog(workspace_id) VALUES($1)")
                .bind(foreign.workspace)
                .execute(conn)
                .await?;
            Ok(())
        })
    })
    .await;
    assert!(
        blocked_write.is_err(),
        "WITH CHECK must reject another tenant's catalog"
    );
    assert!(matches!(
        e::image(&api, owner, id, "large".into(), choice(&d).sha256, false).await,
        Err(Error::NotFound)
    ));
    let outbox: Value = sqlx::query_scalar(
        "SELECT payload FROM outbox WHERE workspace_id=$1 AND payload->'data'->>'version'=$2",
    )
    .bind(owner.workspace)
    .bind(hidden["version"].as_str().unwrap())
    .fetch_one(&su)
    .await
    .unwrap();
    assert_eq!(outbox["data"]["type"], "expression.changed");
    assert!(!outbox.to_string().contains("private report"));
    assert!(!outbox.to_string().contains("bytes"));
    let deleted = e::mutate(&api, owner, id, None, None).await.unwrap();
    assert_eq!(deleted["expression"]["status"], "deleted");
    let delta = e::list(
        &api,
        owner,
        Some(hidden["version"].as_str().unwrap().into()),
    )
    .await
    .unwrap();
    assert_eq!(delta["items"][0]["status"], "deleted");
    assert_eq!(
        e::mutate(
            &api,
            member,
            id,
            None,
            Some(Report {
                reason: "other".into(),
                detail: None
            })
        )
        .await
        .unwrap()["expression"]["status"],
        "deleted"
    );
    let again = draft(&api, owner, "security_party").await;
    assert!(matches!(
        e::activate(&api, owner, choice(&again)).await,
        Err(Error::NameReserved)
    ));
}

#[tokio::test]
#[ignore = "real PG; security-nightly workspace ignored pass"]
async fn quota_name_replacement_races_snapshot_delta_ttl_and_immutable_storage() {
    let (su, api, owner, member, _) = setup().await;
    let (a, b) = tokio::join!(
        draft(&api, owner, "racing_name"),
        draft(&api, member, "racing_name")
    );
    let (a, b) = tokio::join!(
        e::activate(&api, owner, choice(&a)),
        e::activate(&api, member, choice(&b))
    );
    assert_eq!(usize::from(a.is_ok()) + usize::from(b.is_ok()), 1);
    assert!(matches!(a, Err(Error::NameReserved)) || matches!(b, Err(Error::NameReserved)));
    let d = draft(&api, owner, "replace_pin").await;
    let c = choice(&d);
    let mut replacement = pixels();
    replacement.large.data.push(0); // invalid hash rejected by DB
    assert!(e::replace_draft(&api, owner, c.draft_id, replacement)
        .await
        .is_err());
    let replaced = e::replace_draft(&api, owner, c.draft_id, pixels())
        .await
        .unwrap();
    assert!(matches!(
        e::activate(&api, owner, c).await,
        Err(Error::Stale)
    ));
    let c = choice(&replaced);
    let (a, b) = tokio::join!(
        e::replace_draft(&api, owner, c.draft_id, pixels()),
        e::activate(&api, owner, c.clone())
    );
    assert!(
        (a.is_ok() && matches!(b, Err(Error::Stale)))
            || (matches!(a, Err(Error::NotFound)) && b.is_ok())
    );
    if let Ok(replaced) = a {
        assert!(matches!(
            e::activate(&api, owner, c.clone()).await,
            Err(Error::Stale)
        ));
        e::activate(&api, owner, choice(&replaced)).await.unwrap();
    }
    let full = e::list(&api, owner, None).await.unwrap();
    assert_eq!(full["reset"], true);
    assert!(full["baseVersion"].is_null());
    let v = full["version"].as_str().unwrap().to_owned();
    assert_eq!(
        e::list(&api, owner, Some(v.clone())).await.unwrap()["items"],
        json!([])
    );
    e::set_policy(&api, owner, "admins".into()).await.unwrap();
    let delta = e::list(&api, owner, Some(v.clone())).await.unwrap();
    assert_eq!(delta["reset"], false);
    assert_eq!(delta["baseVersion"], v);
    assert_eq!(delta["addPolicy"], "admins");
    e::set_policy(&api, owner, "members".into()).await.unwrap();
    let d = draft(&api, owner, "expired_bytes").await;
    let id = choice(&d).draft_id;
    // Expiry is immutable to runtime SQL, so the clock fixture temporarily
    // disables ONLY its own identity trigger, then restores it before testing.
    let mut clock_fixture = su.begin().await.unwrap();
    sqlx::query("ALTER TABLE expression_draft DISABLE TRIGGER expression_draft_identity")
        .execute(&mut *clock_fixture)
        .await
        .unwrap();
    sqlx::query("UPDATE expression_draft SET expires_at=clock_timestamp()-interval '1 second' WHERE workspace_id=$1 AND id=$2").bind(owner.workspace).bind(id).execute(&mut *clock_fixture).await.unwrap();
    sqlx::query("ALTER TABLE expression_draft ENABLE TRIGGER expression_draft_identity")
        .execute(&mut *clock_fixture)
        .await
        .unwrap();
    clock_fixture.commit().await.unwrap();
    assert!(matches!(
        e::get_draft(&api, owner, id).await,
        Err(Error::Expired)
    ));
    assert!(e::sweep_expired(&su, &api).await.unwrap() >= 3);
    let count: i64 =
        sqlx::query_scalar("SELECT count(*) FROM expression_draft_image WHERE draft_id=$1")
            .bind(id)
            .fetch_one(&su)
            .await
            .unwrap();
    assert_eq!(count, 0);
    let receipts:i64=sqlx::query_scalar("SELECT count(*) FROM expression_draft WHERE workspace_id=$1 AND state='activated' AND receipt IS NOT NULL").bind(owner.workspace).fetch_one(&su).await.unwrap();
    assert_eq!(receipts, 2);
    assert!(matches!(e::sweep_expired(&su, &su).await, Err(Error::Role)));
    // Immutability backstops reject byte/identity swaps on the real API role.
    let id = Uuid::parse_str(full["items"][0]["id"].as_str().unwrap()).unwrap();
    assert!(e::transaction(&api,owner,move|conn|Box::pin(async move {sqlx::query("UPDATE expression_image SET width=width+1 WHERE workspace_id=$1 AND expression_id=$2").bind(owner.workspace).bind(id).execute(conn).await?;Ok(())})).await.is_err());
    assert!(
        e::transaction(&api, owner, move |conn| Box::pin(async move {
            sqlx::query("UPDATE expression SET name='renamed' WHERE workspace_id=$1 AND id=$2")
                .bind(owner.workspace)
                .bind(id)
                .execute(conn)
                .await?;
            Ok(())
        }))
        .await
        .is_err()
    );
    // Fill the remaining quota with compact SQL fixtures. Names stay unique,
    // all faces/creators and every write are on the NOBYPASSRLS tenant role.
    e::transaction(&api,owner,move|conn|Box::pin(async move {
        sqlx::query("INSERT INTO expression(workspace_id,name,display_name,tags,origin,created_by,version) SELECT $1,'quota_'||n,'quota','[]','{\"kind\":\"upload\",\"sourceUrl\":null,\"prompt\":null}'::jsonb,$2,n+10 FROM generate_series(1,997) n").bind(owner.workspace).bind(owner.member).execute(conn).await?;Ok(())
    })).await.unwrap();
    e::transaction(&api,owner,move|conn|Box::pin(async move {
        sqlx::query("INSERT INTO expression_image(workspace_id,expression_id,variant,mime,bytes,sha256,width,height,frame_count,duration_ms) SELECT e.workspace_id,e.id,i.variant,i.mime,i.bytes,i.sha256,i.width,i.height,i.frame_count,i.duration_ms FROM expression e CROSS JOIN expression_image i WHERE e.workspace_id=$1 AND e.name LIKE 'quota_%' AND i.workspace_id=$1 AND i.expression_id=$2")
            .bind(owner.workspace).bind(id).execute(&mut *conn).await?;
        sqlx::query("UPDATE expression_catalog SET version=1008 WHERE workspace_id=$1").bind(owner.workspace).execute(conn).await?;
        Ok(())
    })).await.unwrap();
    let (a, b) = tokio::join!(
        draft(&api, owner, "quota_race_a"),
        draft(&api, member, "quota_race_b")
    );
    let (a, b) = tokio::join!(
        e::activate(&api, owner, choice(&a)),
        e::activate(&api, member, choice(&b))
    );
    assert_eq!(usize::from(a.is_ok()) + usize::from(b.is_ok()), 1);
    assert!(matches!(a, Err(Error::Quota)) || matches!(b, Err(Error::Quota)));
    let count: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM expression WHERE workspace_id=$1 AND status<>'deleted'",
    )
    .bind(owner.workspace)
    .fetch_one(&su)
    .await
    .unwrap();
    assert_eq!(count, 1000);
    e::mutate(
        &api,
        member,
        id,
        None,
        Some(Report {
            reason: "other".into(),
            detail: None,
        }),
    )
    .await
    .unwrap();
    let waiting = draft(&api, owner, "quota_after_hide").await;
    assert!(
        matches!(
            e::activate(&api, owner, choice(&waiting)).await,
            Err(Error::Quota)
        ),
        "hidden entries still use quota"
    );
    e::mutate(&api, owner, id, None, None).await.unwrap();
    e::activate(&api, owner, choice(&waiting)).await.unwrap();
    let overflow = e::list(&api, owner, Some("0".into())).await.unwrap();
    assert_eq!(
        overflow["reset"], true,
        "more than 1000 delta rows must become a full snapshot"
    );
    assert!(overflow["baseVersion"].is_null());
    assert_eq!(overflow["items"].as_array().unwrap().len(), 1000);
    assert!(overflow["items"]
        .as_array()
        .unwrap()
        .iter()
        .all(|item| item["status"] == "active"));
}

/// The draft row's `origin` exactly as stored.
async fn origin_of(su: &PgPool, ws: Uuid, id: Uuid) -> Value {
    sqlx::query_scalar("SELECT origin FROM expression_draft WHERE workspace_id=$1 AND id=$2")
        .bind(ws)
        .bind(id)
        .fetch_one(su)
        .await
        .unwrap()
}

async fn state_of(su: &PgPool, ws: Uuid, id: Uuid) -> String {
    sqlx::query_scalar("SELECT state FROM expression_draft WHERE workspace_id=$1 AND id=$2")
        .bind(ws)
        .bind(id)
        .fetch_one(su)
        .await
        .unwrap()
}

fn id_of(d: &Value) -> Uuid {
    choice(d).draft_id
}

/// #4900 (ADR-0218 D2, migration 167): an expired draft stays as a record but no longer holds the
/// words an agent wrote into it. The TTL sweep blanks `origin.prompt` (JSON null) in the very
/// statement that expires the row; everything else about the origin stays. And the immutability
/// trigger lets `origin` move in that one way only: a draft that is still live cannot be blanked, and
/// an expiry that changes anything else about the row or the origin is refused.
#[tokio::test]
#[ignore = "real PG; security-nightly workspace ignored pass"]
async fn an_expired_draft_keeps_its_record_but_not_the_agents_words() {
    let (su, api, owner, member, _foreign) = setup().await;
    let made = |who: Actor, name: &'static str, origin: Origin| {
        let api = api.clone();
        async move {
            e::create_draft(&api, who, meta(name), origin, Some(pixels()), None)
                .await
                .unwrap()
        }
    };
    // Words, no words, and a draft that is still live.
    let old = made(owner, "words_old", Origin::photo("cutout").unwrap()).await;
    let plain = made(member, "no_words", Origin::upload()).await;
    let live = made(owner, "words_live", Origin::photo("caricature").unwrap()).await;
    let (old, plain, live) = (id_of(&old), id_of(&plain), id_of(&live));
    let ws = owner.workspace;
    let before_old = origin_of(&su, ws, old).await;
    let before_plain = origin_of(&su, ws, plain).await;
    assert!(
        before_old["prompt"].as_str().is_some_and(|p| !p.is_empty()),
        "control: the draft carries words before it expires: {before_old}"
    );
    assert_eq!(before_old["kind"], "generated");

    // The clock fixture (as above): backdate two drafts' own expiry, nothing else.
    let mut clock = su.begin().await.unwrap();
    sqlx::query("ALTER TABLE expression_draft DISABLE TRIGGER expression_draft_identity")
        .execute(&mut *clock)
        .await
        .unwrap();
    sqlx::query("UPDATE expression_draft SET expires_at=clock_timestamp()-interval '1 second' WHERE workspace_id=$1 AND id = ANY($2)")
        .bind(ws)
        .bind(vec![old, plain])
        .execute(&mut *clock)
        .await
        .unwrap();
    sqlx::query("ALTER TABLE expression_draft ENABLE TRIGGER expression_draft_identity")
        .execute(&mut *clock)
        .await
        .unwrap();
    clock.commit().await.unwrap();
    e::sweep_expired(&su, &api).await.unwrap();

    // The record stays, the words do not, and nothing else of the origin moved.
    assert_eq!(state_of(&su, ws, old).await, "expired");
    let mut expected = before_old.clone();
    expected["prompt"] = Value::Null;
    assert_eq!(
        origin_of(&su, ws, old).await,
        expected,
        "only the prompt was blanked"
    );
    assert_eq!(state_of(&su, ws, plain).await, "expired");
    assert_eq!(
        origin_of(&su, ws, plain).await,
        before_plain,
        "a draft with no words is untouched"
    );
    assert_eq!(state_of(&su, ws, live).await, "ready");
    assert!(
        origin_of(&su, ws, live).await["prompt"].is_string(),
        "a live draft keeps its words"
    );

    // The trigger: `origin` moves only into "prompt blanked, state expired", on the real API role.
    let attempt = |sql: &'static str| {
        let api = api.clone();
        async move {
            e::transaction(&api, owner, move |conn| {
                Box::pin(async move {
                    sqlx::query(sql)
                        .bind(owner.workspace)
                        .bind(live)
                        .execute(conn)
                        .await?;
                    Ok(())
                })
            })
            .await
        }
    };
    for (label, sql) in [
        (
            "blanking a live draft",
            "UPDATE expression_draft SET origin=jsonb_set(origin,'{prompt}','null'::jsonb) WHERE workspace_id=$1 AND id=$2",
        ),
        (
            "expiring it while changing the kind too",
            "UPDATE expression_draft SET state='expired',code=NULL,origin=jsonb_set(jsonb_set(origin,'{prompt}','null'::jsonb),'{kind}','\"upload\"'::jsonb) WHERE workspace_id=$1 AND id=$2",
        ),
        (
            "expiring it with a rewritten prompt",
            "UPDATE expression_draft SET state='expired',code=NULL,origin=jsonb_set(origin,'{prompt}','\"another\"'::jsonb) WHERE workspace_id=$1 AND id=$2",
        ),
        (
            "expiring it while changing its name too",
            "UPDATE expression_draft SET state='expired',code=NULL,display_name='x',origin=jsonb_set(origin,'{prompt}','null'::jsonb) WHERE workspace_id=$1 AND id=$2",
        ),
        (
            "rewriting the prompt of a live draft",
            "UPDATE expression_draft SET origin=jsonb_set(origin,'{prompt}','\"another\"'::jsonb) WHERE workspace_id=$1 AND id=$2",
        ),
    ] {
        assert!(attempt(sql).await.is_err(), "{label} is refused");
        assert_eq!(state_of(&su, ws, live).await, "ready", "{label}: unchanged");
    }
    assert!(
        origin_of(&su, ws, live).await["prompt"].is_string(),
        "none of the refused statements changed the words"
    );
    // And the one allowed shape is allowed (it is the sweep's own statement).
    attempt("UPDATE expression_draft SET state='expired',code=NULL,origin=jsonb_set(origin,'{prompt}','null'::jsonb) WHERE workspace_id=$1 AND id=$2")
        .await
        .expect("expiring with the prompt blanked is the allowed change");
    assert_eq!(state_of(&su, ws, live).await, "expired");
    assert!(origin_of(&su, ws, live).await["prompt"].is_null());
}

/// #4900: drafts that expired before migration 167 still hold their words; the migration blanks them
/// once, through the one change the trigger allows on an expired row, and applying it again is
/// harmless. (The file is applied here the way the runner applies it: one transaction.)
#[tokio::test]
#[ignore = "real PG; security-nightly workspace ignored pass"]
async fn migration_167_blanks_the_words_of_drafts_that_expired_before_it() {
    let (su, api, owner, _member, _foreign) = setup().await;
    let ws = owner.workspace;
    let draft = e::create_draft(
        &api,
        owner,
        meta("expired_before"),
        Origin::photo("cutout").unwrap(),
        Some(pixels()),
        None,
    )
    .await
    .unwrap();
    let id = id_of(&draft);
    let before = origin_of(&su, ws, id).await;
    // Expired the way it was before 167: the state changed, the origin was left alone.
    let mut old_way = su.begin().await.unwrap();
    sqlx::query("ALTER TABLE expression_draft DISABLE TRIGGER expression_draft_identity")
        .execute(&mut *old_way)
        .await
        .unwrap();
    sqlx::query(
        "UPDATE expression_draft SET state='expired',code=NULL WHERE workspace_id=$1 AND id=$2",
    )
    .bind(ws)
    .bind(id)
    .execute(&mut *old_way)
    .await
    .unwrap();
    sqlx::query("ALTER TABLE expression_draft ENABLE TRIGGER expression_draft_identity")
        .execute(&mut *old_way)
        .await
        .unwrap();
    old_way.commit().await.unwrap();
    assert_eq!(state_of(&su, ws, id).await, "expired");
    assert!(
        origin_of(&su, ws, id).await["prompt"].is_string(),
        "control: an old expired draft still holds its words"
    );
    let migration =
        include_str!("../../../../server/Migrations/167_expression_draft_expiry_blanks_prompt.sql");
    for _ in 0..2 {
        let mut tx = su.begin().await.unwrap();
        sqlx::raw_sql(migration).execute(&mut *tx).await.unwrap();
        tx.commit().await.unwrap();
        let mut expected = before.clone();
        expected["prompt"] = Value::Null;
        assert_eq!(origin_of(&su, ws, id).await, expected);
        assert_eq!(state_of(&su, ws, id).await, "expired");
    }
}

// ---- ADR-0218 증보 4 §10 (#4961): the kind of a registration ----------------------------------

fn still_of(width: u32, height: u32) -> e::media::Processed {
    let mut png = std::io::Cursor::new(Vec::new());
    image::DynamicImage::new_rgba8(width, height)
        .write_to(&mut png, image::ImageFormat::Png)
        .unwrap();
    e::media::decode(
        &png.into_inner(),
        std::time::Instant::now() + std::time::Duration::from_secs(10),
    )
    .unwrap()
}
fn animated(frames: u8) -> e::media::Processed {
    let mut bytes = Vec::new();
    {
        let mut encoder = image::codecs::gif::GifEncoder::new_with_speed(&mut bytes, 30);
        encoder
            .set_repeat(image::codecs::gif::Repeat::Infinite)
            .unwrap();
        for n in 0..frames {
            encoder
                .encode_frame(image::Frame::from_parts(
                    image::RgbaImage::from_pixel(8, 8, image::Rgba([20 + n * 40, 200, 50, 255])),
                    0,
                    0,
                    image::Delay::from_numer_denom_ms(80, 1),
                ))
                .unwrap();
        }
    }
    let processed = e::media::decode(
        &bytes,
        std::time::Instant::now() + std::time::Duration::from_secs(10),
    )
    .unwrap();
    assert!(
        processed.large.info.frame_count > 1,
        "control: the picture of this test moves"
    );
    processed
}
/// Make a draft of `media` and register it, saying `kind` or nothing (an older client). Returns the
/// receipt.
async fn register(
    api: &PgPool,
    who: Actor,
    name: &str,
    media: e::media::Processed,
    kind: Option<e::Kind>,
) -> Value {
    let d = e::create_draft(api, who, meta(name), Origin::upload(), Some(media), None)
        .await
        .unwrap();
    let mut picked = choice(&d);
    picked.kind = kind;
    e::activate(api, who, picked).await.unwrap()
}
fn kind_of(receipt: &Value) -> &str {
    receipt["expression"]["kind"]
        .as_str()
        .expect("kind on the wire")
}

/// §10 J3: the person's word is what is stored, in both directions against the recommendation; with
/// no word (an older client) the server applies J4 to the stored large picture at the edge of the
/// rule; and the list says the same thing the receipt did.
#[tokio::test]
#[ignore = "real PG; security-nightly workspace ignored pass"]
async fn a_registration_records_the_chosen_kind_or_the_recommended_one() {
    let (_su, api, owner, _member, foreign) = setup().await;
    let cases: Vec<(&str, e::media::Processed, Option<e::Kind>, &str)> = vec![
        // The person's word beats the recommendation, both ways.
        (
            "kind_word_sticker",
            still_of(8, 4),
            Some(e::Kind::Sticker),
            "sticker",
        ),
        (
            "kind_word_emoji",
            animated(3),
            Some(e::Kind::Emoji),
            "emoji",
        ),
        // Nothing said: J4 on the large picture, on both sides of every flip.
        ("kind_auto_small_still", still_of(8, 4), None, "emoji"),
        ("kind_auto_edge_still", still_of(128, 128), None, "emoji"),
        ("kind_auto_past_edge_w", still_of(129, 64), None, "sticker"),
        ("kind_auto_past_edge_h", still_of(64, 129), None, "sticker"),
        ("kind_auto_small_moving", animated(2), None, "sticker"),
    ];
    let mut expected = Vec::new();
    for (name, media, said, want) in cases {
        let receipt = register(&api, owner, name, media, said).await;
        assert_eq!(kind_of(&receipt), want, "{name}");
        expected.push((name, want));
    }
    let listed = e::list(&api, owner, None).await.unwrap();
    let items = listed["items"].as_array().unwrap();
    assert_eq!(items.len(), expected.len());
    for (name, want) in &expected {
        let item = items
            .iter()
            .find(|item| item["name"] == *name)
            .unwrap_or_else(|| panic!("{name} is listed"));
        assert_eq!(item["kind"], *want, "{name} in the list");
    }
    // The same retry of one Choice returns the first receipt, whatever kind it now says.
    let d = e::create_draft(
        &api,
        owner,
        meta("kind_retry"),
        Origin::upload(),
        Some(still_of(8, 4)),
        None,
    )
    .await
    .unwrap();
    let mut first = choice(&d);
    first.kind = Some(e::Kind::Emoji);
    let receipt = e::activate(&api, owner, first.clone()).await.unwrap();
    first.kind = Some(e::Kind::Sticker);
    assert_eq!(e::activate(&api, owner, first).await.unwrap(), receipt);
    assert_eq!(kind_of(&receipt), "emoji");
    // Another tenant sees none of it.
    let theirs = e::list(&api, foreign, None).await.unwrap();
    assert!(theirs["items"].as_array().unwrap().is_empty());
}

/// §10 J5: the column has its own default (an INSERT that does not know the column — an older binary
/// during a rolling deploy — reads as a sticker, not as the recommendation), a closed list the database
/// enforces by itself, and no change after INSERT (the identity trigger of 158, untouched).
#[tokio::test]
#[ignore = "real PG; security-nightly workspace ignored pass"]
async fn the_kind_column_defaults_to_sticker_is_closed_and_cannot_change_after_insert() {
    let (su, api, owner, _member, _foreign) = setup().await;
    // A small still registered as an emoji: the row an older binary would have written has no kind.
    let receipt = register(&api, owner, "kind_source", pixels(), Some(e::Kind::Emoji)).await;
    let source = expression_id(&receipt);
    let legacy = Uuid::new_v4();
    let ws = owner.workspace;
    sqlx::query("INSERT INTO expression(workspace_id,id,name,display_name,tags,subject_member_id,origin,created_by,version,origin_source_attachment_id) SELECT workspace_id,$3,'kind_legacy',display_name,tags,subject_member_id,origin,created_by,version+100,origin_source_attachment_id FROM expression WHERE workspace_id=$1 AND id=$2")
        .bind(ws).bind(source).bind(legacy).execute(&su).await.unwrap();
    sqlx::query("INSERT INTO expression_image(workspace_id,expression_id,variant,mime,bytes,sha256,width,height,frame_count,duration_ms) SELECT workspace_id,$3,variant,mime,bytes,sha256,width,height,frame_count,duration_ms FROM expression_image WHERE workspace_id=$1 AND expression_id=$2")
        .bind(ws).bind(source).bind(legacy).execute(&su).await.unwrap();
    let stored: String = sqlx::query_scalar("SELECT kind FROM expression WHERE id=$1")
        .bind(legacy)
        .fetch_one(&su)
        .await
        .unwrap();
    assert_eq!(stored, "sticker", "the column default");
    let listed = e::list(&api, owner, None).await.unwrap();
    let kinds: Vec<(String, String)> = listed["items"]
        .as_array()
        .unwrap()
        .iter()
        .map(|item| {
            (
                item["name"].as_str().unwrap().into(),
                item["kind"].as_str().unwrap().into(),
            )
        })
        .collect();
    assert!(
        kinds.contains(&("kind_legacy".into(), "sticker".into()))
            && kinds.contains(&("kind_source".into(), "emoji".into())),
        "an older row reads as a sticker although its picture is an emoji-sized still: {kinds:?}"
    );
    // The closed list is the database's own rule: not even a superuser writes another value.
    let refused = sqlx::query("INSERT INTO expression(workspace_id,name,display_name,tags,origin,created_by,version,kind) VALUES($1,'kind_huge','x','[]','{}',$2,500,'huge')")
        .bind(ws).bind(owner.member).execute(&su).await.unwrap_err();
    let refused = refused.as_database_error().expect("a database refusal");
    assert_eq!(refused.code().as_deref(), Some("23514"));
    assert_eq!(refused.constraint(), Some("expression_kind_ck"));
    // No change after INSERT, and the control: the columns that may change still can.
    let edit = sqlx::query("UPDATE expression SET kind='emoji' WHERE workspace_id=$1 AND id=$2")
        .bind(ws)
        .bind(legacy)
        .execute(&su)
        .await
        .unwrap_err();
    assert_eq!(
        edit.as_database_error().unwrap().code().as_deref(),
        Some("23514")
    );
    sqlx::query("UPDATE expression SET display_name='바뀐 이름' WHERE workspace_id=$1 AND id=$2")
        .bind(ws)
        .bind(legacy)
        .execute(&su)
        .await
        .expect("control: a display name still changes");
    let after: String = sqlx::query_scalar("SELECT kind FROM expression WHERE id=$1")
        .bind(legacy)
        .fetch_one(&su)
        .await
        .unwrap();
    assert_eq!(after, "sticker");
}
