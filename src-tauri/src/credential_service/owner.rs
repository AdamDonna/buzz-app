//! Paired tools: `pair`, and requests made with a paired token, which act as
//! the human under the same operation policy as an agent's.
use super::pairing::{Approver, Human, Record};
use super::{digest, METHODS};
use super::{full_budgets, policy, spend, unix_now, CredentialService, Failure, Unsigned};
use crate::identity::EventTemplate;
use serde_json::json;

impl CredentialService {
    /// The human paired tools act as, once the key and NIP-FI are settled.
    pub(super) async fn human(&self) -> Human {
        if self.0.agents.caller_closed() {
            return Human::Absent;
        }
        let pubkey = match self.0.identity.saved_viewer().await {
            Ok(Some(pubkey)) => pubkey,
            Ok(None) => return Human::Absent,
            Err(_) => return Human::Pending,
        };
        match self.0.session.pairing_account() {
            Some((store_account, fi_account)) => Human::Ready(Approver {
                pubkey,
                store_account,
                fi_account,
            }),
            None => Human::Pending,
        }
    }

    pub(super) async fn pair(&self, params: &[String]) -> Result<String, Failure> {
        let [client, relay] = params else {
            return Err(Failure::new("invalid_request", "Wrong parameters for pair"));
        };
        let (token, approver) = self
            .0
            .pairings
            .pair(client, relay, None, || self.human())
            .await?;
        Ok(json!({
            "token": token,
            "instance": self.0.instance,
            "pubkey": approver.pubkey,
            "relays": [relay],
        })
        .to_string())
    }

    pub(super) async fn owner_request(
        &self,
        token: &str,
        method: &str,
        params: &[String],
    ) -> Result<String, Failure> {
        let record = self.0.pairings.admit(token, self.human().await).await?;
        {
            let mut budgets = self
                .0
                .owner_budgets
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner);
            spend(
                budgets.entry(digest(token)).or_insert_with(full_budgets),
                method,
            )?;
        }
        let pubkey = match self.human().await {
            Human::Ready(approver) => approver.pubkey,
            _ => return Err(Failure::revoked()),
        };
        let result = self.owner_call(&record, &pubkey, method, params).await;
        // Revoked, or the human changed, while it ran: whatever it made stays here.
        let still = matches!(self.human().await, Human::Ready(now) if now.pubkey == pubkey);
        if !still || !self.0.pairings.holds(&record.id) {
            return Err(Failure::revoked());
        }
        result
    }

    async fn owner_call(
        &self,
        record: &Record,
        pubkey: &str,
        method: &str,
        params: &[String],
    ) -> Result<String, Failure> {
        let identity = &self.0.identity;
        // The human key, lent to one purpose-bound operation.
        async fn with_secret<T: Send + 'static>(
            identity: &crate::identity::IdentityHost,
            action: impl FnOnce(&buzz_agent_controller::Secret) -> Result<T, String> + Send + 'static,
        ) -> Result<T, Failure> {
            identity
                .with_key(move |key, viewer| {
                    let hex: zeroize::Zeroizing<String> =
                        zeroize::Zeroizing::new(key.iter().map(|b| format!("{b:02x}")).collect());
                    action(&buzz_agent_controller::Secret::parse(&hex, viewer)?)
                })
                .await
                .map_err(|error| Failure::new("invalid_request", &error))
        }
        match (method, params) {
            ("describe", []) => Ok(json!({
                "instance": self.0.instance,
                "pubkey": pubkey,
                "role": "owner",
                "relays": [record.relay],
                "methods": METHODS.iter().filter(|method| **method != "pair").collect::<Vec<_>>(),
            })
            .to_string()),
            ("get_public_key", []) => Ok(pubkey.to_owned()),
            ("sign_event", [event]) => {
                let event = Unsigned::parse(event, pubkey)?;
                match policy::classify(
                    event.kind,
                    &event.tags,
                    event.created_at,
                    unix_now()?,
                    &record.relay,
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
                identity
                    .sign(EventTemplate {
                        created_at: event.created_at,
                        kind: event.kind,
                        tags: event.tags,
                        content: event.content,
                    })
                    .await
                    .map(|signed| signed.to_string())
                    .map_err(|error| Failure::new("invalid_request", &error))
            }
            ("nip44_encrypt", [peer, plaintext]) => {
                let (peer, plaintext) = (peer.clone(), plaintext.clone());
                with_secret(identity, move |key| key.nip44_encrypt(&peer, &plaintext)).await
            }
            ("nip44_decrypt", [peer, payload]) => {
                let (peer, payload) = (peer.clone(), payload.clone());
                with_secret(identity, move |key| {
                    key.nip44_decrypt(&peer, &payload)
                        .map(|text| text.to_string())
                })
                .await
            }
            ("engram_d_tag", [peer, slug]) => {
                let (peer, slug) = (peer.clone(), slug.clone());
                with_secret(identity, move |key| key.memory_d_tag(&peer, &slug)).await
            }
            ("federated_identity", [relay]) => {
                if !policy::same_relay(relay, &record.relay) {
                    return Err(Failure::new(
                        "denied",
                        "This token does not act on that relay",
                    ));
                }
                let url = url::Url::parse(relay)
                    .map_err(|_| Failure::new("invalid_request", "Invalid relay URL"))?;
                let authorization = self
                    .0
                    .session
                    .assertion_for_relay(identity, &url)
                    .await
                    .map_err(Failure::unavailable)?;
                // The contract's result is the assertion itself; the caller adds `Bearer `.
                Ok(authorization
                    .header()
                    .and_then(|header| header.strip_prefix("Bearer "))
                    .unwrap_or_default()
                    .to_owned())
            }
            // An owner's events carry no NIP-OA tag.
            ("auth_tag", []) => Ok(String::new()),
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
