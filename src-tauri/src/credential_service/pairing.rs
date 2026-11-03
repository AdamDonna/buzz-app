//! `pair`: a command-line tool asks to act as the human; the human approves
//! it in Buzz. Only each token's SHA-256 is kept, in the OS keychain, bound
//! to the human, store account and NIP-FI account that approved it.
use super::keychain::Keychain;
use super::{digest, unix_now, Failure};
use serde::{Deserialize, Serialize};
use std::collections::VecDeque;
use std::sync::{Arc, Mutex, MutexGuard, PoisonError};
use std::time::Duration;
use tokio::sync::oneshot;
use tokio::time::Instant;

/// How long a request waits for the human.
pub(crate) const APPROVAL: Duration = Duration::from_secs(120);
/// A paired token unused this long is revoked.
pub(crate) const DISUSE: u64 = 30 * 24 * 60 * 60;
/// `last_used` reaches the keychain at most this often.
const TOUCH_EVERY: u64 = 10 * 60;
/// Requests allowed per window.
const PAIRS: usize = 3;
const PAIR_WINDOW: Duration = Duration::from_secs(10 * 60);

/// Who approved a pairing. A pairing acts only while all three still hold.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub(crate) struct Approver {
    pub(crate) pubkey: String,
    pub(crate) store_account: String,
    pub(crate) fi_account: Option<String>,
}

#[derive(Clone, Serialize, Deserialize)]
pub(crate) struct Record {
    pub(crate) id: String,
    /// Hex SHA-256 of the token.
    digest: String,
    pub(crate) client: String,
    pub(crate) relay: String,
    pub(crate) created: u64,
    pub(crate) last_used: u64,
    approved_by: Approver,
}

/// One row of the paired-tools list.
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Listed {
    id: String,
    client: String,
    relay: String,
    created: u64,
    last_used: u64,
    expires: u64,
}

/// What the page is told.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Request {
    pub(crate) id: String,
    pub(crate) client: String,
    pub(crate) relay: String,
    pub(crate) process: Option<String>,
    pub(crate) expires_in: u64,
}
#[derive(Clone, Debug)]
pub(crate) enum Notice {
    /// Ask the human.
    Ask(Request),
    /// The request with this id is over: answered, expired or abandoned.
    Closed(String),
    /// The list changed.
    Changed,
}
pub(crate) type Notify = Arc<dyn Fn(Notice) + Send + Sync>;

/// The human a pairing acts as, as far as it is known yet.
pub(crate) enum Human {
    /// Settled and signed in to Buzz.
    Ready(Approver),
    /// No human identity here: no pairing acts.
    Absent,
    /// Still loading (identity or NIP-FI restore): ask again shortly.
    Pending,
}

pub(crate) struct Pairings {
    keychain: Arc<dyn Keychain>,
    notify: Notify,
    /// Serializes keychain writes; each writes the then-current records.
    write: tokio::sync::Mutex<()>,
    state: Mutex<State>,
}
#[derive(Default)]
struct State {
    /// `None` until read; a failed read admits nothing.
    records: Option<Result<Vec<Record>, String>>,
    /// When `last_used` last reached the keychain.
    flushed: u64,
    pending: Option<(String, oneshot::Sender<bool>)>,
    asked: VecDeque<Instant>,
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}

impl Pairings {
    pub(crate) fn new(keychain: Arc<dyn Keychain>, notify: Notify) -> Self {
        Self {
            keychain,
            notify,
            write: tokio::sync::Mutex::new(()),
            state: Mutex::default(),
        }
    }
    fn state(&self) -> MutexGuard<'_, State> {
        self.state.lock().unwrap_or_else(PoisonError::into_inner)
    }

    /// The records, read once; a failed read is retried on the next call.
    async fn loaded(&self) -> Result<Vec<Record>, String> {
        let _write = self.write.lock().await;
        self.loaded_locked().await
    }
    async fn loaded_locked(&self) -> Result<Vec<Record>, String> {
        if let Some(Ok(records)) = &self.state().records {
            return Ok(records.clone());
        }
        let keychain = self.keychain.clone();
        let read = tokio::task::spawn_blocking(move || keychain.read())
            .await
            .unwrap_or_else(|_| Err("Paired tools could not be read".into()))
            .and_then(|value| match value {
                None => Ok(Vec::new()),
                Some(bytes) => serde_json::from_slice::<Vec<Record>>(&bytes)
                    .map_err(|_| "Saved paired tools are unreadable".into()),
            });
        self.state().records = Some(read.clone());
        read
    }

    /// Applies `change` to the current records and saves them durably; the
    /// in-memory records change only once the keychain has.
    async fn mutate<T>(&self, change: impl FnOnce(&mut Vec<Record>) -> T) -> Result<T, String> {
        let _write = self.write.lock().await;
        let mut records = self.loaded_locked().await?;
        let out = change(&mut records);
        let value = (!records.is_empty())
            .then(|| serde_json::to_vec(&records))
            .transpose()
            .map_err(|_| "Paired tools could not be saved")?;
        let keychain = self.keychain.clone();
        tokio::task::spawn_blocking(move || keychain.write(value.as_deref()))
            .await
            .unwrap_or_else(|_| Err("Paired tools could not be saved".into()))?;
        let mut state = self.state();
        state.records = Some(Ok(records));
        state.flushed = unix_now().unwrap_or(0);
        drop(state);
        (self.notify)(Notice::Changed);
        Ok(out)
    }

    /// The pairing `token` names, if it still acts as `human`: an expired
    /// one, or one approved by anyone else, is deleted and answers `revoked`.
    pub(crate) async fn admit(&self, token: &str, human: Human) -> Result<Record, Failure> {
        let key = hex(&digest(token));
        let records = self.loaded().await.map_err(Failure::unavailable)?;
        let record = records
            .into_iter()
            .find(|record| record.digest == key)
            .ok_or_else(Failure::revoked)?;
        let now = unix_now()?;
        let acts = match &human {
            Human::Pending => {
                return Err(Failure::new(
                    "unavailable",
                    "Buzz is still starting; retry shortly",
                ))
            }
            Human::Absent => false,
            Human::Ready(approver) => *approver == record.approved_by,
        };
        if !acts || now.saturating_sub(record.last_used) > DISUSE {
            self.mutate(|records| records.retain(|r| r.id != record.id))
                .await
                .map_err(Failure::unavailable)?;
            return Err(Failure::revoked());
        }
        self.touch(&record.id, now).await;
        Ok(record)
    }

    /// Whether the pairing still exists, for a result about to be returned.
    pub(crate) fn holds(&self, id: &str) -> bool {
        matches!(&self.state().records, Some(Ok(records)) if records.iter().any(|r| r.id == id))
    }

    /// Records a use; it is saved with the next write, or now if the last
    /// save is older than [`TOUCH_EVERY`]. A lost save only expires it sooner.
    async fn touch(&self, id: &str, now: u64) {
        let due = {
            let mut state = self.state();
            if let Some(Ok(records)) = &mut state.records {
                if let Some(record) = records.iter_mut().find(|r| r.id == id) {
                    record.last_used = now;
                }
            }
            now.saturating_sub(state.flushed) >= TOUCH_EVERY
        };
        if due {
            let _ = self.mutate(|_| ()).await;
        }
    }

    /// Asks the human to approve `client` acting as them on `relay`; on
    /// approval saves the new token's digest, then returns the token.
    /// `human` is asked once now and again once approved, so an account
    /// change while the prompt is open issues nothing.
    pub(crate) async fn pair<F, Fut>(
        &self,
        client: &str,
        relay: &str,
        process: Option<String>,
        human: F,
    ) -> Result<(String, Approver), Failure>
    where
        F: Fn() -> Fut,
        Fut: std::future::Future<Output = Human>,
    {
        let valid_client =
            (1..=64).contains(&client.chars().count()) && !client.chars().any(char::is_control);
        let valid_relay = url::Url::parse(relay)
            .is_ok_and(|url| matches!(url.scheme(), "ws" | "wss") && url.host().is_some());
        if !valid_client || !valid_relay {
            return Err(Failure::new("invalid_request", "Invalid pairing request"));
        }
        let approver = match human().await {
            Human::Ready(approver) => approver,
            Human::Absent => return Err(Failure::new("denied", "Set up Buzz first")),
            Human::Pending => {
                return Err(Failure::new(
                    "unavailable",
                    "Buzz is still starting; retry shortly",
                ))
            }
        };
        self.loaded().await.map_err(Failure::unavailable)?;
        let id = uuid::Uuid::new_v4().to_string();
        let answer = {
            let mut state = self.state();
            let now = Instant::now();
            while state
                .asked
                .front()
                .is_some_and(|at| now.duration_since(*at) >= PAIR_WINDOW)
            {
                state.asked.pop_front();
            }
            let wait = if state.pending.is_some() {
                Some(APPROVAL)
            } else if state.asked.len() >= PAIRS {
                state
                    .asked
                    .front()
                    .map(|at| PAIR_WINDOW - now.duration_since(*at))
            } else {
                None
            };
            if let Some(wait) = wait {
                return Err(Failure {
                    code: "rate_limited",
                    message: "Another pairing request is waiting or too many were made".into(),
                    retry_after: Some(wait.as_secs().max(1)),
                });
            }
            let (send, answer) = oneshot::channel();
            state.pending = Some((id.clone(), send));
            state.asked.push_back(now);
            answer
        };
        // Whatever ends the wait, even the caller hanging up, closes the prompt.
        let _closing = Closing(self, id.clone());
        (self.notify)(Notice::Ask(Request {
            id: id.clone(),
            client: client.into(),
            relay: relay.into(),
            process,
            expires_in: APPROVAL.as_secs(),
        }));
        match tokio::time::timeout(APPROVAL, answer).await {
            Ok(Ok(true)) => {}
            Ok(_) => return Err(Failure::new("denied", "Pairing was declined in Buzz")),
            Err(_) => {
                return Err(Failure::new(
                    "approval_required",
                    "Nobody approved the pairing in Buzz in time",
                ))
            }
        }
        match human().await {
            Human::Ready(now) if now == approver => {}
            _ => return Err(Failure::new("denied", "Your Buzz account changed")),
        }
        let token =
            super::new_token().map_err(|_| Failure::new("unavailable", "Could not pair"))?;
        let now = unix_now()?;
        let record = Record {
            id,
            digest: hex(&digest(&token)),
            client: client.into(),
            relay: relay.into(),
            created: now,
            last_used: now,
            approved_by: approver.clone(),
        };
        self.mutate(|records| records.push(record))
            .await
            .map_err(Failure::unavailable)?;
        Ok((token.to_string(), approver))
    }

    /// The human's answer to request `id`; a stale id does nothing.
    pub(crate) fn answer(&self, id: &str, approve: bool) {
        let pending = {
            let mut state = self.state();
            match &state.pending {
                Some((current, _)) if current == id => state.pending.take(),
                _ => None,
            }
        };
        if let Some((_, send)) = pending {
            let _ = send.send(approve);
        }
    }

    pub(crate) async fn list(&self) -> Result<Vec<Listed>, String> {
        Ok(self
            .loaded()
            .await?
            .into_iter()
            .map(|record| Listed {
                expires: record.last_used + DISUSE,
                id: record.id,
                client: record.client,
                relay: record.relay,
                created: record.created,
                last_used: record.last_used,
            })
            .collect())
    }

    /// Revokes one pairing, once its deletion is saved.
    pub(crate) async fn revoke(&self, id: &str) -> Result<(), String> {
        self.mutate(|records| records.retain(|record| record.id != id))
            .await
    }

    /// Revokes every pairing, on sign-out or a change of account.
    pub(crate) async fn clear(&self) -> Result<(), String> {
        let pending = self.state().pending.take();
        drop(pending);
        self.mutate(Vec::clear).await
    }
}

struct Closing<'a>(&'a Pairings, String);
impl Drop for Closing<'_> {
    fn drop(&mut self) {
        let mut state = self.0.state();
        if state.pending.as_ref().is_some_and(|(id, _)| *id == self.1) {
            state.pending = None;
        }
        drop(state);
        (self.0.notify)(Notice::Closed(self.1.clone()));
    }
}
