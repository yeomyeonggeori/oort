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
