//! The local credential provider (block/buzz `docs/local-credential-provider.md`):
//! a process the app launches for an agent, such as `buzz` run by a harness,
//! acts as that agent without its key. The key and sign-in session stay here.
//!
//! - A harness spawn gets a fresh 256-bit token in `BUZZ_CREDENTIAL_PROVIDER`,
//!   never written to disk. It acts for nobody until the runtime binds it to
//!   the agent the process serves, once; a spare process is bound when taken.
//! - The token dies with its process, and stops acting once its agent is
//!   deleted or the owner signs out or changes account: each request rechecks
//!   the agent's incarnation from binding time and the owner's retirements from
//!   issue time, on arrival and again before its result is returned.
//! - Every signature passes the contract's operation policy ([`policy`]).
//!   Sensitive kinds answer `approval_required` until an approval prompt exists.
//! - It binds only `127.0.0.1`. `Host` must name the bound address, a request
//!   that sends `Origin` (a web page) is refused, and nothing is logged.
//! - Windows has no transport in version 1, so no token is issued there.
mod advertise;
mod keychain;
mod owner;
mod pairing;
mod policy;
// No token is issued on Windows, so there is nothing to test there.
#[cfg(all(test, not(windows)))]
pub(crate) mod tests;

use crate::app_agents::AppAgentHost;
use crate::federated_identity::agent::Stamp;
use crate::federated_identity::FederatedIdentity;
use crate::host_mcp::header;
use crate::identity::IdentityHost;
use http_body_util::{BodyExt, Full, Limited};
use hyper::body::{Bytes, Incoming};
use hyper::header::{self as headers, HeaderName};
use hyper::{server::conn::http1, service::service_fn, Method, Request, Response, StatusCode};
use hyper_util::rt::{TokioIo, TokioTimer};
pub(crate) use pairing::Notice;
use pairing::Pairings;
use serde::Deserialize;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::convert::Infallible;
use std::sync::{Arc, Mutex, MutexGuard, PoisonError};
use std::time::Duration;
use tokio::net::TcpListener;
use tokio::sync::{OnceCell, Semaphore};
use tokio::time::Instant;
use zeroize::Zeroizing;

/// Set in a harness's environment: `{"url": …, "token": …}`.
pub(crate) const ENV: &str = "BUZZ_CREDENTIAL_PROVIDER";

/// A token this app was itself launched with belongs to another app's agent;
/// dropped before any thread starts, so no process it spawns inherits it.
pub(crate) fn drop_inherited() {
    std::env::remove_var(ENV);
}
const VERSION_HEADER: HeaderName = HeaderName::from_static("buzz-credential-provider");
const VERSIONS: [u32; 1] = [1];
const ENDPOINT: &str = "/v1";
const CONNECTIONS: usize = 32;
const HEAD_LIMIT: usize = 8192;
const HEAD_TIMEOUT: Duration = Duration::from_secs(5);
/// An agent event is at most 64 KiB of content and 256 tags of 4 KiB.
const BODY_LIMIT: usize = 2 * 1024 * 1024;
const BODY_TIMEOUT: Duration = Duration::from_secs(30);
/// Requests a token may make of each method at once, and how many it regains
/// each second.
const BURST: f64 = 120.0;
const REFILL: f64 = 20.0;
/// Evidence handed out stays valid at least this long, for the caller's request.
const EVIDENCE: Duration = Duration::from_secs(60);
const METHODS: [&str; 9] = [
    "describe",
    "get_public_key",
    "sign_event",
    "nip44_encrypt",
    "nip44_decrypt",
    "engram_d_tag",
    "federated_identity",
    "auth_tag",
    "pair",
];

#[derive(Clone)]
pub(crate) struct CredentialService(Arc<Inner>);
struct Inner {
    agents: AppAgentHost,
    instance: String,
    endpoint: OnceCell<String>,
    /// By the SHA-256 of their token, so a lookup reveals nothing of it.
    callers: Mutex<HashMap<[u8; 32], Caller>>,
    /// Paired tools act as the human: its key and its NIP-FI session.
    identity: IdentityHost,
    session: FederatedIdentity,
    pairings: Pairings,
    /// Each paired token's rate, by its digest; only for this run.
    owner_budgets: Mutex<HashMap<[u8; 32], [Budget; METHODS.len() + 1]>>,
}
struct Caller {
    agent: Option<Bound>,
    /// The owner's retirements when it was issued; any later one revokes it,
    /// bound or not.
    retirements: u64,
    /// Its agent was deleted or its owner signed out: it never acts again.
    revoked: bool,
    /// One budget per method, and one shared by names it doesn't know, so a
    /// burst of one method never starves another.
    budgets: [Budget; METHODS.len() + 1],
}
#[derive(Clone, Copy)]
struct Budget {
    tokens: f64,
    at: Instant,
}
impl Caller {
    /// Whether any request has spent from its budgets.
    #[cfg(test)]
    fn spent(&self) -> bool {
        self.budgets.iter().any(|budget| budget.tokens < BURST)
    }
}
#[derive(Clone)]
struct Bound {
    pubkey: String,
    relay: String,
    owner: String,
    incarnation: Stamp,
}

/// One issued token, revoked when dropped: with the process it was issued to.
pub(crate) struct Issued {
    service: CredentialService,
    key: [u8; 32],
}
impl Issued {
    /// Stops it acting, for good, whoever still holds it.
    pub(crate) fn revoke(&self) {
        if let Some(caller) = self.service.callers().get_mut(&self.key) {
            caller.revoked = true;
        }
    }
}
impl Drop for Issued {
    fn drop(&mut self) {
        self.service.callers().remove(&self.key);
    }
}

impl CredentialService {
    pub(crate) fn new(
        agents: AppAgentHost,
        instance: String,
        identity: IdentityHost,
        session: FederatedIdentity,
        keychain: Arc<dyn keychain::Keychain>,
        notify: pairing::Notify,
    ) -> Self {
        Self(Arc::new(Inner {
            agents,
            instance,
            endpoint: OnceCell::new(),
            callers: Mutex::default(),
            identity,
            session,
            pairings: Pairings::new(keychain, notify),
            owner_budgets: Mutex::default(),
        }))
    }
    /// The OS keychain item this instance's pairings live in.
    /// `data` holds the marker for a revoke-all still owed.
    pub(crate) fn keychain(instance: &str, data: &std::path::Path) -> Arc<dyn keychain::Keychain> {
        #[cfg(not(test))]
        return Arc::new(keychain::Os(
            keychain::account(instance),
            data.join(format!("{}.revoke-owed", keychain::account(instance))),
        ));
        #[cfg(test)]
        {
            let _ = (instance, data);
            Arc::new(Arc::new(keychain::Memory::default()))
        }
    }
    fn callers(&self) -> MutexGuard<'_, HashMap<[u8; 32], Caller>> {
        self.0
            .callers
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
    }

    /// A new unbound token and the environment value that hands it to one
    /// process; none on Windows.
    pub(crate) async fn issue(&self) -> Result<Option<(Issued, Zeroizing<String>)>, String> {
        if cfg!(windows) {
            return Ok(None);
        }
        if self.0.agents.caller_closed() {
            return Err("Buzz has signed out for good".into());
        }
        let url = self
            .0
            .endpoint
            .get_or_try_init(|| self.listen())
            .await?
            .clone();
        let token = new_token()?;
        let key = digest(&token);
        self.callers().insert(
            key,
            Caller {
                agent: None,
                retirements: self.0.agents.caller_retirements(),
                revoked: false,
                budgets: full_budgets(),
            },
        );
        let env = Zeroizing::new(json!({ "url": url, "token": &*token }).to_string());
        Ok(Some((
            Issued {
                service: self.clone(),
                key,
            },
            env,
        )))
    }

    /// Lets `issued`, held by a process of `plugin`, act as this agent from
    /// now on. A token is bound once, and only to an agent of the plugin's own
    /// type, so no plugin can act as another's agents.
    pub(crate) async fn bind(
        &self,
        issued: &Issued,
        plugin: &str,
        pubkey: String,
        relay: String,
    ) -> Result<(), String> {
        let (agent, incarnation) = self.0.agents.caller_stamp(pubkey, relay).await?;
        if agent.agent_type.split_once('/').map(|(owner, _)| owner) != Some(plugin) {
            return Err("The agent is not of this plugin's type".into());
        }
        let mut callers = self.callers();
        let caller = callers
            .get_mut(&issued.key)
            .filter(|caller| !caller.revoked)
            .ok_or("The process has exited")?;
        // A spare issued before its owner signed out never acts.
        if !self
            .0
            .agents
            .caller_live(&agent.pubkey, &agent.relay, incarnation, caller.retirements)
        {
            caller.revoked = true;
            return Err("This Buzz credential was revoked".into());
        }
        match &caller.agent {
            Some(bound) if bound.pubkey == agent.pubkey && bound.relay == agent.relay => Ok(()),
            Some(_) => Err("The process already acts as another agent".into()),
            None => {
                caller.agent = Some(Bound {
                    pubkey: agent.pubkey,
                    relay: agent.relay,
                    owner: agent.owner,
                    incarnation,
                });
                Ok(())
            }
        }
    }

    /// Whether `issued` is bound and still acts as its agent: neither revoked,
    /// nor outlived by its agent's incarnation or its owner's retirements.
    pub(crate) fn acts(&self, issued: &Issued) -> bool {
        self.callers().get(&issued.key).is_some_and(|caller| {
            !caller.revoked
                && caller.agent.as_ref().is_some_and(|bound| {
                    self.0.agents.caller_live(
                        &bound.pubkey,
                        &bound.relay,
                        bound.incarnation,
                        caller.retirements,
                    )
                })
        })
    }

    /// Starts the listener now, not at the first agent spawn, and advertises
    /// it, so a command-line tool can pair with no agent running.
    pub(crate) async fn start(&self) -> Result<(), String> {
        if cfg!(windows) {
            return Ok(());
        }
        let url = self
            .0
            .endpoint
            .get_or_try_init(|| self.listen())
            .await?
            .clone();
        #[cfg(unix)]
        if let Some(home) = dirs::home_dir() {
            advertise::write(&home, &self.0.instance, &url)
                .map_err(|_| "Could not advertise the Buzz credential service")?;
        }
        Ok(())
    }
    /// Removes the advertisement, on quit.
    pub(crate) fn stop(&self) {
        if let Some(home) = dirs::home_dir() {
            advertise::remove(&home, &self.0.instance);
        }
    }
    /// Saves the revocation of every pairing promptly when the human signs
    /// out of NIP-FI or changes account. Requests fence on their own (see
    /// `Pairings::follow`); a restart under another human or account revokes
    /// them too, since each is bound to who approved it.
    pub(crate) fn watch_account(&self) {
        let service = self.clone();
        let mut changes = self.0.session.account_changes();
        tauri::async_runtime::spawn(async move {
            while changes.changed().await.is_ok() {
                service.0.pairings.follow(service.0.session.retirements());
                if let Err(error) = service.0.pairings.settled().await {
                    eprintln!("Paired tools were not revoked: {error}");
                }
            }
        });
    }
    /// Revokes every pairing, before Buzz signs out: from the call, and
    /// durably once the returned future succeeds.
    pub(crate) fn clear_pairings(
        &self,
    ) -> impl std::future::Future<Output = Result<(), String>> + '_ {
        self.0.pairings.clear()
    }

    async fn listen(&self) -> Result<String, String> {
        let listener = std::net::TcpListener::bind((std::net::Ipv4Addr::LOCALHOST, 0))
            .and_then(|listener| listener.set_nonblocking(true).map(|()| listener))
            .map_err(|_| "Could not start the Buzz credential service")?;
        let authority = format!(
            "127.0.0.1:{}",
            listener
                .local_addr()
                .map_err(|_| "Could not start the Buzz credential service")?
                .port()
        );
        let listener = TcpListener::from_std(listener)
            .map_err(|_| "Could not start the Buzz credential service")?;
        let url = format!("http://{authority}{ENDPOINT}");
        tauri::async_runtime::spawn(accept(listener, self.clone(), authority));
        Ok(url)
    }

    /// The caller `token` names and the agent it acts as, once it is bound,
    /// while it still acts.
    fn acting<'a>(
        &self,
        callers: &'a mut HashMap<[u8; 32], Caller>,
        token: &str,
    ) -> Result<(&'a mut Caller, Bound), Failure> {
        let caller = callers
            .get_mut(&digest(token))
            .filter(|caller| !caller.revoked)
            .ok_or(Failure::revoked())?;
        // A spare issued before its owner signed out, or before the identity
        // closed for good, is revoked, bound or not.
        if self.0.agents.caller_closed() || self.0.agents.caller_retirements() != caller.retirements
        {
            caller.revoked = true;
            return Err(Failure::revoked());
        }
        let Some(bound) = caller.agent.clone() else {
            return Err(Failure::new(
                "unavailable",
                "This process is not acting for an agent yet",
            ));
        };
        if !self.0.agents.caller_live(
            &bound.pubkey,
            &bound.relay,
            bound.incarnation,
            caller.retirements,
        ) {
            // An issued token lives in its process's entry; it just stops acting.
            caller.revoked = true;
            return Err(Failure::revoked());
        }
        Ok((caller, bound))
    }

    /// The caller `token` names, once it is bound and still acts, after one
    /// request of its rate.
    fn admit(&self, token: &str, method: &str) -> Result<Bound, Failure> {
        let mut callers = self.callers();
        let (caller, bound) = self.acting(&mut callers, token)?;
        spend(&mut caller.budgets, method)?;
        Ok(bound)
    }

    async fn call(
        &self,
        caller: &Bound,
        method: &str,
        params: &[String],
    ) -> Result<String, Failure> {
        let agents = &self.0.agents;
        let key = || agents.caller_key(caller.pubkey.clone(), caller.relay.clone());
        match (method, params) {
            ("describe", []) => Ok(json!({
                "instance": self.0.instance,
                "pubkey": caller.pubkey,
                "role": "agent",
                "owner_pubkey": caller.owner,
                "relays": [caller.relay],
                "methods": METHODS.iter().filter(|method| **method != "pair").collect::<Vec<_>>(),
            })
            .to_string()),
            ("get_public_key", []) => Ok(caller.pubkey.clone()),
            ("sign_event", [event]) => {
                let event = Unsigned::parse(event, &caller.pubkey)?;
                match policy::classify(
                    event.kind,
                    &event.tags,
                    event.created_at,
                    unix_now()?,
                    &caller.relay,
                ) {
                    policy::Verdict::Sign => {}
                    policy::Verdict::Approval => {
                        return Err(Failure::new(
                            "approval_required",
                            &format!("Kind {} needs your approval in Buzz", event.kind),
                        ))
                    }
                    policy::Verdict::Deny(reason) => return Err(Failure::new("denied", &reason)),
                }
                let (agent, key) = key().await.map_err(Failure::unavailable)?;
                let signed = agent
                    .sign_built(
                        &key,
                        event.kind,
                        event.content,
                        event.tags,
                        event.created_at,
                    )
                    .map_err(|error| Failure::new("invalid_request", &error))?;
                Ok(signed.to_string())
            }
            ("nip44_encrypt", [peer, plaintext]) => {
                let (_, key) = key().await.map_err(Failure::unavailable)?;
                key.nip44_encrypt(peer, plaintext)
                    .map_err(|error| Failure::new("invalid_request", &error))
            }
            ("nip44_decrypt", [peer, payload]) => {
                let (_, key) = key().await.map_err(Failure::unavailable)?;
                key.nip44_decrypt(peer, payload)
                    .map(|plaintext| plaintext.to_string())
                    .map_err(|error| Failure::new("invalid_request", &error))
            }
            ("engram_d_tag", [peer, slug]) => {
                let (_, key) = key().await.map_err(Failure::unavailable)?;
                key.memory_d_tag(peer, slug)
                    .map_err(|error| Failure::new("invalid_request", &error))
            }
            ("federated_identity", [relay]) => {
                if !policy::same_relay(relay, &caller.relay) {
                    return Err(Failure::new(
                        "denied",
                        "This token does not act on that relay",
                    ));
                }
                let (_, _, admission) = agents
                    .signer_at(
                        caller.pubkey.clone(),
                        caller.relay.clone(),
                        caller.incarnation,
                        EVIDENCE,
                    )
                    .await
                    .map_err(Failure::unavailable)?;
                admission.dispatch().map_err(Failure::unavailable)?;
                // The contract's result is the assertion itself; the caller adds `Bearer `.
                Ok(admission.assertion().unwrap_or_default().to_owned())
            }
            ("auth_tag", []) => {
                let (agent, _) = key().await.map_err(Failure::unavailable)?;
                Ok(agent.auth)
            }
            (method, _) if METHODS.contains(&method) && method != "pair" => Err(Failure::new(
                "invalid_request",
                &format!("Wrong parameters for {method}"),
            )),
            (method, _) => Err(Failure::new(
                "unknown_method",
                &format!("{method} is not supported"),
            )),
        }
    }
}

/// Spends one request of `method` from `budgets`.
fn spend(budgets: &mut [Budget; METHODS.len() + 1], method: &str) -> Result<(), Failure> {
    let budget = &mut budgets[METHODS
        .iter()
        .position(|known| *known == method)
        .unwrap_or(METHODS.len())];
    let now = Instant::now();
    budget.tokens =
        (budget.tokens + now.duration_since(budget.at).as_secs_f64() * REFILL).min(BURST);
    budget.at = now;
    if budget.tokens < 1.0 {
        let wait = ((1.0 - budget.tokens) / REFILL).ceil().max(1.0) as u64;
        return Err(Failure {
            code: "rate_limited",
            message: "Too many requests".into(),
            retry_after: Some(wait),
        });
    }
    budget.tokens -= 1.0;
    Ok(())
}

fn full_budgets() -> [Budget; METHODS.len() + 1] {
    [Budget {
        tokens: BURST,
        at: Instant::now(),
    }; METHODS.len() + 1]
}

/// A fresh 256-bit token, base64url.
fn new_token() -> Result<Zeroizing<String>, String> {
    let mut secret = Zeroizing::new([0u8; 32]);
    getrandom::fill(secret.as_mut()).map_err(|_| "Could not issue a Buzz credential")?;
    use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
    Ok(Zeroizing::new(URL_SAFE_NO_PAD.encode(secret.as_ref())))
}

fn digest(token: &str) -> [u8; 32] {
    Sha256::digest(token.as_bytes()).into()
}

fn unix_now() -> Result<u64, Failure> {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|now| now.as_secs())
        .map_err(|_| Failure::new("unavailable", "System clock is unavailable"))
}

/// The unsigned event `sign_event` carries.
struct Unsigned {
    kind: u16,
    tags: Vec<Vec<String>>,
    content: String,
    created_at: u64,
}
impl Unsigned {
    fn parse(text: &str, identity: &str) -> Result<Self, Failure> {
        #[derive(Deserialize)]
        struct Event {
            kind: u16,
            tags: Vec<Vec<String>>,
            content: String,
            created_at: u64,
            pubkey: Option<String>,
        }
        let event: Event = serde_json::from_str(text)
            .map_err(|_| Failure::new("invalid_request", "Invalid unsigned event"))?;
        if event.pubkey.is_some_and(|pubkey| pubkey != identity) {
            return Err(Failure::new("denied", "The event names another identity"));
        }
        Ok(Self {
            kind: event.kind,
            tags: event.tags,
            content: event.content,
            created_at: event.created_at,
        })
    }
}

#[derive(Debug)]
struct Failure {
    code: &'static str,
    message: String,
    retry_after: Option<u64>,
}
impl Failure {
    fn new(code: &'static str, message: &str) -> Self {
        Self {
            code,
            message: message.into(),
            retry_after: None,
        }
    }
    fn revoked() -> Self {
        Self::new("revoked", "This Buzz credential was revoked")
    }
    fn unavailable(message: String) -> Self {
        Self::new("unavailable", &message)
    }
    fn status(&self) -> StatusCode {
        match self.code {
            "approval_required" | "denied" => StatusCode::FORBIDDEN,
            "rate_limited" => StatusCode::TOO_MANY_REQUESTS,
            "revoked" => StatusCode::UNAUTHORIZED,
            "unavailable" => StatusCode::SERVICE_UNAVAILABLE,
            _ => StatusCode::BAD_REQUEST,
        }
    }
}

async fn accept(listener: TcpListener, service: CredentialService, authority: String) {
    let connections = Arc::new(Semaphore::new(CONNECTIONS));
    let authority: Arc<str> = authority.into();
    loop {
        let Ok(permit) = connections.clone().acquire_owned().await else {
            return;
        };
        let Ok((socket, _)) = listener.accept().await else {
            drop(permit);
            tokio::time::sleep(Duration::from_millis(100)).await;
            continue;
        };
        let (service, authority) = (service.clone(), authority.clone());
        tauri::async_runtime::spawn(async move {
            let _ = http1::Builder::new()
                .timer(TokioTimer::new())
                .header_read_timeout(HEAD_TIMEOUT)
                .max_buf_size(HEAD_LIMIT)
                .keep_alive(false)
                .serve_connection(
                    TokioIo::new(socket),
                    service_fn(|request| answer(&service, &authority, request)),
                )
                .await;
            drop(permit);
        });
    }
}

async fn answer(
    service: &CredentialService,
    authority: &str,
    request: Request<Incoming>,
) -> Result<Response<Full<Bytes>>, Infallible> {
    let response = Response::builder().header(headers::CACHE_CONTROL, "no-store");
    // Not a caller of this service: nothing more is said.
    if header(&request, headers::HOST) != Some(authority)
        || request.headers().contains_key(headers::ORIGIN)
        || request.uri().path() != ENDPOINT
    {
        return Ok(response
            .status(StatusCode::NOT_FOUND)
            .body(Full::default())
            .unwrap_or_default());
    }
    if request.method() != Method::POST {
        return Ok(response
            .status(StatusCode::METHOD_NOT_ALLOWED)
            .header(headers::ALLOW, "POST")
            .body(Full::default())
            .unwrap_or_default());
    }
    let token = header(&request, headers::AUTHORIZATION)
        .and_then(|value| value.strip_prefix("Bearer "))
        .map(str::to_owned);
    let version = header(&request, VERSION_HEADER).and_then(|value| value.trim().parse().ok());
    let body = Limited::new(request.into_body(), BODY_LIMIT).collect();
    let body = match tokio::time::timeout(BODY_TIMEOUT, body).await {
        Ok(Ok(body)) => body.to_bytes(),
        _ => Bytes::new(),
    };
    let (status, reply) = respond(service, token.as_deref(), version, &body).await;
    Ok(response
        .status(status)
        .header(headers::CONTENT_TYPE, "application/json")
        .body(Full::new(reply.to_string().into()))
        .unwrap_or_default())
}

/// The envelope answering one request body from the holder of `token`.
async fn respond(
    service: &CredentialService,
    token: Option<&str>,
    version: Option<u32>,
    body: &[u8],
) -> (StatusCode, Value) {
    #[derive(Deserialize)]
    struct Message {
        id: String,
        method: String,
        #[serde(default)]
        params: Vec<String>,
    }
    let message = serde_json::from_slice::<Message>(body);
    let id = message
        .as_ref()
        .map_or("", |message| &message.id)
        .to_owned();
    let result = async {
        if !version.is_some_and(|version| VERSIONS.contains(&version)) {
            return Err(Failure::new(
                "unsupported_version",
                "Use a version this Buzz supports",
            ));
        }
        let message = message.map_err(|_| Failure::new("invalid_request", "Invalid request"))?;
        if message.method == "pair" {
            return service.pair(&message.params).await;
        }
        let token = token.ok_or(Failure::revoked())?;
        if !service.callers().contains_key(&digest(token)) {
            return service
                .owner_request(token, &message.method, &message.params)
                .await;
        }
        let caller = service.admit(token, &message.method)?;
        let result = service
            .call(&caller, &message.method, &message.params)
            .await;
        // Its process may have exited, or its agent or owner been retired,
        // while the key was read: then it is revoked, whatever it made.
        service.acting(&mut service.callers(), token)?;
        result
    }
    .await;
    match result {
        Ok(result) => (StatusCode::OK, json!({ "id": id, "result": result })),
        Err(failure) => {
            let mut reply = json!({
                "id": id,
                "result": "",
                "error": failure.code,
                "message": failure.message,
            });
            if let Some(wait) = failure.retry_after {
                reply["retry_after"] = wait.into();
            }
            if failure.code == "unsupported_version" {
                reply["versions"] = json!(VERSIONS);
            }
            (failure.status(), reply)
        }
    }
}

#[tauri::command]
pub(crate) fn credential_pair_answer(
    service: tauri::State<'_, CredentialService>,
    id: String,
    approve: bool,
) {
    service.0.pairings.answer(&id, approve);
}

#[tauri::command]
pub(crate) async fn credential_pairings_list(
    service: tauri::State<'_, CredentialService>,
) -> Result<Vec<pairing::Listed>, String> {
    service.0.pairings.list().await
}

#[tauri::command]
pub(crate) async fn credential_pairing_revoke(
    service: tauri::State<'_, CredentialService>,
    id: String,
) -> Result<(), String> {
    service.0.pairings.revoke(&id).await
}
