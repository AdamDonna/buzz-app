use super::*;
use crate::federated_identity::testing;
use std::sync::atomic::Ordering;

const CLIENT: &str = "buzz-cli";

async fn pair_request(service: &CredentialService, params: &[&str]) -> (StatusCode, Value) {
    let body = json!({ "id": "p", "method": "pair", "params": params }).to_string();
    respond(service, None, Some(1), body.as_bytes()).await
}

/// The id of the request the page was asked about, once it was.
async fn asked(notices: &Arc<Mutex<Vec<Notice>>>) -> String {
    for _ in 0..200 {
        // The latest request still open.
        let open = {
            let notices = notices.lock().unwrap();
            let found = notices.iter().rev().find_map(|notice| match notice {
                Notice::Ask(request) => Some(request.id.clone()),
                _ => None,
            });
            let open = found.filter(|id| {
                !notices
                    .iter()
                    .any(|notice| matches!(notice, Notice::Closed(closed) if closed == id))
            });
            open
        };
        if let Some(id) = open {
            return id;
        }
        tokio::task::yield_now().await;
        tokio::time::sleep(Duration::from_millis(5)).await;
    }
    panic!("no pairing request reached the page");
}

/// Pairs and approves; the paired token.
async fn paired(fixture: &Fixture) -> String {
    let service = fixture.service.clone();
    let pairing = tokio::spawn(async move { pair_request(&service, &[CLIENT, RELAY]).await });
    let id = asked(&fixture.notices).await;
    fixture.service.0.pairings.answer(&id, true);
    let (status, reply) = pairing.await.unwrap();
    assert_eq!(status, StatusCode::OK, "{reply}");
    let result: Value = serde_json::from_str(reply["result"].as_str().unwrap()).unwrap();
    assert_eq!(result["relays"], json!([RELAY]));
    result["token"].as_str().unwrap().to_owned()
}

async fn human_pubkey() -> String {
    IdentityHost::fixture().viewer().await.unwrap()
}

#[tokio::test]
async fn an_approved_pairing_acts_as_the_human_on_its_relay() {
    let fixture = fixture();
    let token = paired(&fixture).await;
    let reply = ask(&fixture, &token, "describe", &[]).await;
    let described: Value = serde_json::from_str(reply.1["result"].as_str().unwrap()).unwrap();
    assert_eq!(described["role"], "owner");
    assert_eq!(described["pubkey"], human_pubkey().await);
    assert_eq!(described["relays"], json!([RELAY]));
    assert!(described.get("owner_pubkey").is_none());
    assert_eq!(ask(&fixture, &token, "auth_tag", &[]).await.1["result"], "");
}

#[tokio::test]
async fn only_the_digest_is_saved() {
    let fixture = fixture();
    let token = paired(&fixture).await;
    let saved = String::from_utf8(fixture.keychain.value.lock().unwrap().clone().unwrap()).unwrap();
    assert!(!saved.contains(&token));
    let digest: String = digest(&token).iter().map(|b| format!("{b:02x}")).collect();
    assert!(saved.contains(&digest));
}

#[tokio::test]
async fn a_declined_pairing_is_denied_and_saves_nothing() {
    let fixture = fixture();
    let service = fixture.service.clone();
    let pairing = tokio::spawn(async move { pair_request(&service, &[CLIENT, RELAY]).await });
    let id = asked(&fixture.notices).await;
    fixture.service.0.pairings.answer(&id, false);
    assert_eq!(
        error(&pairing.await.unwrap()),
        (StatusCode::FORBIDDEN, "denied")
    );
    assert!(fixture.keychain.value.lock().unwrap().is_none());
}

#[tokio::test(start_paused = true)]
async fn an_unanswered_pairing_needs_approval_and_closes_its_prompt() {
    let fixture = fixture();
    let reply = pair_request(&fixture.service, &[CLIENT, RELAY]).await;
    assert_eq!(error(&reply), (StatusCode::FORBIDDEN, "approval_required"));
    let id = fixture
        .notices
        .lock()
        .unwrap()
        .iter()
        .find_map(|notice| match notice {
            Notice::Ask(request) => Some(request.id.clone()),
            _ => None,
        })
        .unwrap();
    assert!(fixture
        .notices
        .lock()
        .unwrap()
        .iter()
        .any(|notice| matches!(notice, Notice::Closed(closed) if *closed == id)));
    // A late answer issues nothing.
    fixture.service.0.pairings.answer(&id, true);
    assert!(fixture.keychain.value.lock().unwrap().is_none());
}

#[tokio::test(start_paused = true)]
async fn one_request_waits_at_a_time_and_three_per_window() {
    let fixture = fixture();
    let service = fixture.service.clone();
    let first = tokio::spawn(async move { pair_request(&service, &[CLIENT, RELAY]).await });
    let id = asked(&fixture.notices).await;
    let second = pair_request(&fixture.service, &[CLIENT, RELAY]).await;
    assert_eq!(
        error(&second),
        (StatusCode::TOO_MANY_REQUESTS, "rate_limited")
    );
    fixture.service.0.pairings.answer(&id, false);
    first.await.unwrap();
    for _ in 0..2 {
        let reply = pair_request(&fixture.service, &[CLIENT, RELAY]).await;
        assert_eq!(error(&reply).1, "approval_required");
    }
    let fourth = pair_request(&fixture.service, &[CLIENT, RELAY]).await;
    assert_eq!(
        error(&fourth),
        (StatusCode::TOO_MANY_REQUESTS, "rate_limited")
    );
    assert!(fourth.1["retry_after"].as_u64().is_some());
}

#[tokio::test]
async fn bad_pairing_parameters_never_reach_the_page() {
    let fixture = fixture();
    for params in [
        &["", RELAY][..],
        &[CLIENT, "https://relay.example"],
        &[CLIENT],
    ] {
        let reply = pair_request(&fixture.service, params).await;
        assert_eq!(error(&reply).1, "invalid_request", "{params:?}");
    }
    assert!(fixture.notices.lock().unwrap().is_empty());
}

#[tokio::test]
async fn a_pairing_survives_a_restart_once_the_session_restores() {
    let mut fixture = fixture();
    let session = testing::restoring();
    session.finish_restore_for_test();
    fixture.service = service_over(
        &fixture.host,
        &session,
        &fixture.keychain,
        &fixture.notices,
        IdentityHost::fixture(),
    );
    let token = paired(&fixture).await;
    // A new run: same keychain, a session still restoring at launch.
    let session = testing::restoring();
    let restarted = service_over(
        &fixture.host,
        &session,
        &fixture.keychain,
        &fixture.notices,
        IdentityHost::fixture(),
    );
    fixture.service = restarted;
    let early = ask(&fixture, &token, "get_public_key", &[]).await;
    assert_eq!(
        error(&early),
        (StatusCode::SERVICE_UNAVAILABLE, "unavailable")
    );
    assert!(
        fixture.keychain.value.lock().unwrap().is_some(),
        "kept while restoring"
    );
    session.finish_restore_for_test();
    let reply = ask(&fixture, &token, "get_public_key", &[]).await;
    assert_eq!(reply.1["result"], human_pubkey().await);
}

#[tokio::test]
async fn a_pairing_under_another_human_is_revoked_and_deleted() {
    let mut fixture = fixture();
    let token = paired(&fixture).await;
    fixture.service = service_over(
        &fixture.host,
        &fixture.identity,
        &fixture.keychain,
        &fixture.notices,
        IdentityHost::fixture_without_key(true),
    );
    let reply = ask(&fixture, &token, "get_public_key", &[]).await;
    assert_eq!(error(&reply), (StatusCode::UNAUTHORIZED, "revoked"));
    assert!(fixture.keychain.value.lock().unwrap().is_none());
}

#[tokio::test]
async fn revoking_and_clearing_stop_a_pairing() {
    let fixture = fixture();
    let first = paired(&fixture).await;
    let second = paired(&fixture).await;
    let listed = fixture.service.0.pairings.list().await.unwrap();
    assert_eq!(listed.len(), 2);
    let id = serde_json::to_value(&listed[0]).unwrap()["id"]
        .as_str()
        .unwrap()
        .to_owned();
    fixture.service.0.pairings.revoke(&id).await.unwrap();
    assert_eq!(
        error(&ask(&fixture, &first, "get_public_key", &[]).await).1,
        "revoked"
    );
    assert_eq!(
        ask(&fixture, &second, "get_public_key", &[]).await.0,
        StatusCode::OK
    );
    fixture.service.clear_pairings().await.unwrap();
    assert_eq!(
        error(&ask(&fixture, &second, "get_public_key", &[]).await).1,
        "revoked"
    );
    assert!(fixture.keychain.value.lock().unwrap().is_none());
}

#[tokio::test]
async fn a_pairing_unused_past_its_disuse_period_is_revoked() {
    let fixture = fixture();
    let token = paired(&fixture).await;
    let mut saved: Vec<Value> =
        serde_json::from_slice(fixture.keychain.value.lock().unwrap().as_ref().unwrap()).unwrap();
    saved[0]["last_used"] = json!(now() - super::super::pairing::DISUSE - 1);
    *fixture.keychain.value.lock().unwrap() = Some(serde_json::to_vec(&saved).unwrap());
    let restarted = Fixture {
        service: service_over(
            &fixture.host,
            &fixture.identity,
            &fixture.keychain,
            &fixture.notices,
            IdentityHost::fixture(),
        ),
        ..fixture
    };
    let reply = ask(&restarted, &token, "get_public_key", &[]).await;
    assert_eq!(error(&reply).1, "revoked");
    assert!(restarted.keychain.value.lock().unwrap().is_none());
}

#[tokio::test]
async fn a_keychain_failure_issues_nothing_and_keeps_rows() {
    let fixture = fixture();
    let token = paired(&fixture).await;
    fixture.keychain.fail_write.store(true, Ordering::SeqCst);
    let service = fixture.service.clone();
    let pairing = tokio::spawn(async move { pair_request(&service, &[CLIENT, RELAY]).await });
    let id = loop {
        let ids: Vec<String> = fixture
            .notices
            .lock()
            .unwrap()
            .iter()
            .filter_map(|n| match n {
                Notice::Ask(request) => Some(request.id.clone()),
                _ => None,
            })
            .collect();
        if ids.len() == 2 {
            break ids[1].clone();
        }
        tokio::time::sleep(Duration::from_millis(5)).await;
    };
    fixture.service.0.pairings.answer(&id, true);
    let reply = pairing.await.unwrap();
    assert_eq!(error(&reply).1, "unavailable");
    assert!(reply.1["result"].as_str().unwrap().is_empty());
    let listed = fixture.service.0.pairings.list().await.unwrap();
    let id = serde_json::to_value(&listed[0]).unwrap()["id"]
        .as_str()
        .unwrap()
        .to_owned();
    assert!(fixture.service.0.pairings.revoke(&id).await.is_err());
    assert_eq!(
        ask(&fixture, &token, "get_public_key", &[]).await.0,
        StatusCode::OK
    );
}

#[tokio::test]
async fn an_unreadable_keychain_admits_no_pairing() {
    let mut fixture = fixture();
    let token = paired(&fixture).await;
    fixture.keychain.fail_read.store(true, Ordering::SeqCst);
    fixture.service = service_over(
        &fixture.host,
        &fixture.identity,
        &fixture.keychain,
        &fixture.notices,
        IdentityHost::fixture(),
    );
    let reply = ask(&fixture, &token, "get_public_key", &[]).await;
    assert_eq!(error(&reply).1, "unavailable");
    assert!(fixture.service.0.pairings.list().await.is_err());
}

#[tokio::test]
async fn a_paired_token_signs_only_what_the_policy_allows() {
    let fixture = fixture();
    let token = paired(&fixture).await;
    let ordinary = unsigned(9, json!([]), now());
    let reply = ask(&fixture, &token, "sign_event", &[&ordinary]).await;
    let signed: Value = serde_json::from_str(reply.1["result"].as_str().unwrap()).unwrap();
    assert_eq!(signed["pubkey"], human_pubkey().await);
    let profile = unsigned(0, json!([]), now());
    let reply = ask(&fixture, &token, "sign_event", &[&profile]).await;
    assert_eq!(error(&reply).1, "approval_required");
}

#[tokio::test]
async fn the_listener_and_its_advertisement_start_without_agents() {
    let fixture = fixture();
    let home = tempfile::tempdir().unwrap();
    let url = fixture
        .service
        .0
        .endpoint
        .get_or_try_init(|| fixture.service.listen())
        .await
        .unwrap()
        .clone();
    super::super::advertise::write(home.path(), "xyz.block.buzz.test", &url).unwrap();
    let file = super::super::advertise::path(home.path(), "xyz.block.buzz.test");
    use std::os::unix::fs::PermissionsExt;
    assert_eq!(
        std::fs::metadata(&file).unwrap().permissions().mode() & 0o777,
        0o600
    );
    assert_eq!(
        std::fs::metadata(file.parent().unwrap())
            .unwrap()
            .permissions()
            .mode()
            & 0o777,
        0o700
    );
    let body: Value = serde_json::from_slice(&std::fs::read(&file).unwrap()).unwrap();
    assert_eq!(
        body,
        json!({ "instance": "xyz.block.buzz.test", "url": url })
    );
    super::super::advertise::remove(home.path(), "xyz.block.buzz.test");
    assert!(!file.exists());
}

/// A sign-out the keychain refuses to save, after which the same account
/// returns: the pairing stays revoked in this run and the next, and its
/// rows go once the keychain works.
#[tokio::test]
async fn a_failed_revoke_all_keeps_pairings_revoked_until_it_is_saved() {
    let mut fixture = fixture();
    let token = paired(&fixture).await;
    fixture.keychain.fail_write.store(true, Ordering::SeqCst);
    assert!(fixture.service.clear_pairings().await.is_err());
    fixture.identity.same_account_again_for_test();
    let reply = ask(&fixture, &token, "get_public_key", &[]).await;
    assert_eq!(error(&reply).1, "unavailable");
    assert!(fixture.keychain.value.lock().unwrap().is_some());

    // The next run, under the same human and account, still owes it.
    fixture.service = service_over(
        &fixture.host,
        &fixture.identity,
        &fixture.keychain,
        &fixture.notices,
        IdentityHost::fixture(),
    );
    let reply = ask(&fixture, &token, "get_public_key", &[]).await;
    assert_eq!(error(&reply).1, "unavailable");
    fixture.keychain.fail_write.store(false, Ordering::SeqCst);
    let reply = ask(&fixture, &token, "get_public_key", &[]).await;
    assert_eq!(error(&reply).1, "revoked");
    assert!(fixture.keychain.value.lock().unwrap().is_none());
    assert!(!fixture.keychain.owed.load(Ordering::SeqCst));
}

/// The session's retirement count fences a request on its own, with no
/// watcher: a sign-out and the same account returning revokes.
#[tokio::test]
async fn a_sign_out_revokes_even_when_the_same_account_returns() {
    let fixture = fixture();
    let token = paired(&fixture).await;
    fixture.identity.same_account_again_for_test();
    let reply = ask(&fixture, &token, "get_public_key", &[]).await;
    assert_eq!(error(&reply).1, "revoked");
    assert!(fixture.keychain.value.lock().unwrap().is_none());
}

/// Approved, then a revoke-all begins while its record is being saved: the
/// revoke-all removes it and the token is never returned.
#[tokio::test(flavor = "multi_thread")]
async fn an_approval_saved_during_a_revoke_all_returns_no_token() {
    let fixture = fixture();
    let (entered, entered_rx) = std::sync::mpsc::channel();
    let (release, release_rx) = std::sync::mpsc::channel();
    *fixture.keychain.gate.lock().unwrap() = Some(super::super::keychain::Gate {
        entered,
        release: release_rx,
    });
    let service = fixture.service.clone();
    let pairing = tokio::spawn(async move { pair_request(&service, &[CLIENT, RELAY]).await });
    let id = asked(&fixture.notices).await;
    fixture.service.0.pairings.answer(&id, true);
    tokio::task::spawn_blocking(move || entered_rx.recv().unwrap())
        .await
        .unwrap();
    // Fences at the call; its save waits behind the approval's.
    let clearing = fixture.service.clear_pairings();
    release.send(()).unwrap();
    let reply = pairing.await.unwrap();
    assert_eq!(error(&reply).1, "denied");
    assert!(reply.1["result"].is_null() || reply.1["result"].as_str().unwrap().is_empty());
    clearing.await.unwrap();
    assert!(fixture.keychain.value.lock().unwrap().is_none());
}

/// Approved after a revoke-all has been saved: nothing is saved.
#[tokio::test]
async fn an_approval_after_a_revoke_all_saves_nothing() {
    let fixture = fixture();
    let service = fixture.service.clone();
    let pairing = tokio::spawn(async move { pair_request(&service, &[CLIENT, RELAY]).await });
    let id = asked(&fixture.notices).await;
    fixture.service.clear_pairings().await.unwrap();
    fixture.service.0.pairings.answer(&id, true);
    assert_eq!(error(&pairing.await.unwrap()).1, "denied");
    assert!(fixture.keychain.value.lock().unwrap().is_none());
}
