//! Harness-owned loopback forwarders. Transform plugins never own listeners or
//! response streams, and never receive upstream authentication headers.
use crate::{with_manager, PluginManager};
use futures_util::TryStreamExt;
use http_body_util::{combinators::UnsyncBoxBody, BodyExt, Full, Limited, StreamBody};
use hyper::{
    body::{Bytes, Frame, Incoming},
    header,
    server::conn::http1,
    service::service_fn,
    Request, Response, StatusCode,
};
use hyper_util::rt::{TokioIo, TokioTimer};
use serde::Serialize;
use std::{
    collections::HashMap,
    convert::Infallible,
    sync::{Arc, Mutex, MutexGuard, PoisonError},
    time::Duration,
};
use tauri::ipc::Channel;
use tokio::{
    net::TcpListener,
    sync::{oneshot, Semaphore},
};
use tokio_util::sync::CancellationToken;

const LIMIT: usize = 64 * 1024 * 1024;
type Body = UnsyncBoxBody<Bytes, Box<dyn std::error::Error + Send + Sync>>;
#[derive(Clone, Serialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub(crate) enum Event {
    Request {
        request: u64,
        path: String,
        body: String,
    },
    Closed,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Info {
    handle: u64,
    url: String,
}
#[derive(Default)]
struct Pending {
    next: u64,
    replies: HashMap<u64, oneshot::Sender<Result<String, String>>>,
}
struct Shared {
    authority: String,
    prefix: String,
    upstream: String,
    client: reqwest::Client,
    events: Channel<Event>,
    stop: CancellationToken,
    pending: Mutex<Pending>,
}
impl Shared {
    fn pending(&self) -> MutexGuard<'_, Pending> {
        self.pending.lock().unwrap_or_else(PoisonError::into_inner)
    }
}
#[derive(Default)]
struct Registry {
    page: u64,
    next: u64,
    entries: HashMap<u64, (String, Arc<Shared>)>,
}
#[derive(Clone, Default)]
pub(crate) struct ModelProxies(Arc<Mutex<Registry>>);
impl ModelProxies {
    fn registry(&self) -> MutexGuard<'_, Registry> {
        self.0.lock().unwrap_or_else(PoisonError::into_inner)
    }
    pub(crate) fn stop_all(&self) {
        let mut registry = self.registry();
        registry.page += 1;
        for (_, shared) in registry.entries.values() {
            shared.stop.cancel();
        }
    }
    fn owned(&self, id: &str, handle: u64) -> Result<Arc<Shared>, String> {
        self.registry()
            .entries
            .get(&handle)
            .filter(|(owner, _)| owner == id)
            .map(|(_, shared)| shared.clone())
            .ok_or_else(|| "No such model proxy".into())
    }
    fn serve(
        &self,
        page: u64,
        id: String,
        upstream: String,
        events: Channel<Event>,
    ) -> Result<Info, String> {
        let upstream = url::Url::parse(&upstream).map_err(|_| "Invalid model upstream")?;
        if !matches!(upstream.scheme(), "https" | "http")
            || upstream.host_str().is_none()
            || !upstream.username().is_empty()
            || upstream.password().is_some()
            || upstream.query().is_some()
            || upstream.fragment().is_some()
        {
            return Err("Invalid model upstream".into());
        }
        let client = reqwest::Client::builder()
            .redirect(reqwest::redirect::Policy::none())
            .connect_timeout(Duration::from_secs(30))
            .build()
            .map_err(|e| e.to_string())?;
        let listener = std::net::TcpListener::bind("127.0.0.1:0").map_err(|e| e.to_string())?;
        listener.set_nonblocking(true).map_err(|e| e.to_string())?;
        let authority = listener
            .local_addr()
            .map_err(|e| e.to_string())?
            .to_string();
        let prefix = format!("/{}", uuid::Uuid::new_v4().simple());
        let url = format!("http://{authority}{prefix}");
        let shared = Arc::new(Shared {
            authority,
            prefix,
            upstream: upstream.to_string().trim_end_matches('/').to_owned(),
            client,
            events,
            stop: CancellationToken::new(),
            pending: Mutex::default(),
        });
        let handle = {
            let mut registry = self.registry();
            if registry.page != page {
                return Err("The page reloaded".into());
            }
            if registry.entries.len() >= 64 {
                return Err("Too many model proxies".into());
            }
            let handle = registry.next;
            registry.next += 1;
            registry.entries.insert(handle, (id, shared.clone()));
            handle
        };
        let state = self.clone();
        tauri::async_runtime::spawn(async move {
            accept(listener, shared.clone()).await;
            shared.pending().replies.clear();
            state.registry().entries.remove(&handle);
            let _ = shared.events.send(Event::Closed);
        });
        Ok(Info { handle, url })
    }
}
async fn accept(listener: std::net::TcpListener, shared: Arc<Shared>) {
    let Ok(listener) = TcpListener::from_std(listener) else {
        return;
    };
    let permits = Arc::new(Semaphore::new(32));
    loop {
        let accepted = tokio::select! {
            accepted = async {
                let permit = permits.clone().acquire_owned().await.ok()?;
                Some((permit, listener.accept().await))
            } => accepted,
            () = shared.stop.cancelled() => return,
        };
        let Some((permit, Ok((socket, _)))) = accepted else {
            return;
        };
        let shared = shared.clone();
        tauri::async_runtime::spawn(async move {
            let connection = http1::Builder::new()
                .timer(TokioTimer::new())
                .header_read_timeout(Duration::from_secs(10))
                .max_buf_size(32768)
                .keep_alive(false)
                .serve_connection(
                    TokioIo::new(socket),
                    service_fn(|request| answer(&shared, request)),
                );
            tokio::select! { _ = connection => {}, () = shared.stop.cancelled() => {} }
            drop(permit);
        });
    }
}
fn failure(status: StatusCode) -> Response<Body> {
    let mut response = Response::new(
        Full::new(Bytes::new())
            .map_err(|never| match never {})
            .boxed_unsync(),
    );
    *response.status_mut() = status;
    response
}
fn hop(name: &header::HeaderName, headers: &header::HeaderMap) -> bool {
    matches!(
        name.as_str(),
        "connection"
            | "keep-alive"
            | "proxy-authenticate"
            | "proxy-authorization"
            | "te"
            | "trailer"
            | "transfer-encoding"
            | "upgrade"
            | "host"
            | "content-length"
    ) || headers
        .get_all(header::CONNECTION)
        .iter()
        .filter_map(|v| v.to_str().ok())
        .flat_map(|v| v.split(','))
        .any(|v| v.trim().eq_ignore_ascii_case(name.as_str()))
}
async fn answer(shared: &Shared, request: Request<Incoming>) -> Result<Response<Body>, Infallible> {
    Ok(match forward(shared, request).await {
        Ok(response) => response,
        Err(status) => failure(status),
    })
}
async fn transform(shared: &Shared, path: String, body: String) -> Result<String, StatusCode> {
    struct Waiting<'a>(&'a Shared, u64);
    impl Drop for Waiting<'_> {
        fn drop(&mut self) {
            self.0.pending().replies.remove(&self.1);
        }
    }
    let (tx, rx) = oneshot::channel();
    let request = {
        let mut p = shared.pending();
        let n = p.next;
        p.next += 1;
        p.replies.insert(n, tx);
        n
    };
    let _waiting = Waiting(shared, request);
    shared
        .events
        .send(Event::Request {
            request,
            path,
            body,
        })
        .map_err(|_| StatusCode::SERVICE_UNAVAILABLE)?;
    match tokio::time::timeout(Duration::from_secs(30), rx).await {
        Ok(Ok(Ok(body))) if body.len() <= LIMIT => Ok(body),
        _ => Err(StatusCode::BAD_GATEWAY),
    }
}
async fn forward(
    shared: &Shared,
    request: Request<Incoming>,
) -> Result<Response<Body>, StatusCode> {
    if request
        .headers()
        .get(header::HOST)
        .and_then(|v| v.to_str().ok())
        != Some(&shared.authority)
        || request.headers().contains_key(header::ORIGIN)
    {
        return Err(StatusCode::NOT_FOUND);
    }
    let path = request
        .uri()
        .path_and_query()
        .map(|v| v.as_str())
        .unwrap_or("/");
    let path = path
        .strip_prefix(&shared.prefix)
        .filter(|v| v.starts_with('/'))
        .ok_or(StatusCode::NOT_FOUND)?
        .to_owned();
    if !matches!(
        *request.method(),
        hyper::Method::POST | hyper::Method::GET | hyper::Method::HEAD
    ) {
        return Err(StatusCode::METHOD_NOT_ALLOWED);
    }
    let (parts, incoming) = request.into_parts();
    let body = tokio::time::timeout(
        Duration::from_secs(30),
        Limited::new(incoming, LIMIT).collect(),
    )
    .await
    .map_err(|_| StatusCode::REQUEST_TIMEOUT)?
    .map_err(|_| StatusCode::PAYLOAD_TOO_LARGE)?
    .to_bytes();
    let body = if parts.method == hyper::Method::POST
        && parts
            .headers
            .get(header::CONTENT_TYPE)
            .and_then(|v| v.to_str().ok())
            .is_some_and(|v| {
                v.split(';')
                    .next()
                    .is_some_and(|v| v.trim().eq_ignore_ascii_case("application/json"))
            }) {
        Bytes::from(
            transform(
                shared,
                path.clone(),
                String::from_utf8(body.to_vec()).map_err(|_| StatusCode::BAD_REQUEST)?,
            )
            .await?,
        )
    } else {
        body
    };
    // Concatenation, never URL::join: a request path cannot replace the upstream authority.
    let mut outbound = shared
        .client
        .request(parts.method, format!("{}{path}", shared.upstream))
        .body(body);
    for (name, value) in &parts.headers {
        if !hop(name, &parts.headers) {
            outbound = outbound.header(name, value);
        }
    }
    let upstream = outbound.send().await.map_err(|_| StatusCode::BAD_GATEWAY)?;
    let status = upstream.status();
    let headers = upstream.headers().clone();
    let stream = upstream
        .bytes_stream()
        .map_ok(Frame::data)
        .map_err(|e| -> Box<dyn std::error::Error + Send + Sync> { Box::new(e) });
    let mut response = Response::new(BodyExt::boxed_unsync(StreamBody::new(stream)));
    *response.status_mut() = status;
    for (name, value) in &headers {
        if !hop(name, &headers) {
            response.headers_mut().append(name, value.clone());
        }
    }
    Ok(response)
}

/// Starts a model endpoint only for a plugin declaring host.modelEndpoint.
#[tauri::command]
pub(crate) async fn plugin_model_proxy_serve(
    manager: tauri::State<'_, PluginManager>,
    servers: tauri::State<'_, ModelProxies>,
    id: String,
    revision: String,
    upstream: String,
    on_event: Channel<Event>,
) -> Result<Info, String> {
    let page = servers.registry().page;
    let owner = id.clone();
    with_manager(manager, move |manager| {
        if !manager.host_grants(&id, &revision)?.model_endpoint {
            return Err("Model endpoints are not declared".into());
        }
        Ok(())
    })
    .await?;
    let upstream = if upstream == "anthropic" {
        std::env::var("ANTHROPIC_BASE_URL").unwrap_or_else(|_| "https://api.anthropic.com".into())
    } else if upstream == "chatgpt" {
        "https://chatgpt.com/backend-api/codex".into()
    } else if upstream == "openai" {
        std::env::var("OPENAI_BASE_URL").unwrap_or_else(|_| "https://api.openai.com/v1".into())
    } else {
        upstream
    };
    servers.serve(page, owner, upstream, on_event)
}
#[tauri::command]
pub(crate) fn plugin_model_proxy_reply(
    servers: tauri::State<'_, ModelProxies>,
    id: String,
    handle: u64,
    request: u64,
    body: Option<String>,
) -> Result<(), String> {
    if body.as_ref().is_some_and(|v| v.len() > LIMIT) {
        return Err("Model request is too large".into());
    }
    let shared = servers.owned(&id, handle)?;
    let tx = shared
        .pending()
        .replies
        .remove(&request)
        .ok_or("Request is no longer waiting")?;
    tx.send(body.ok_or_else(|| "Model proxy callback failed".into()))
        .map_err(|_| "Request is no longer waiting".into())
}
#[tauri::command]
pub(crate) fn plugin_model_proxy_close(
    servers: tauri::State<'_, ModelProxies>,
    id: String,
    handle: u64,
) -> Result<(), String> {
    servers.owned(&id, handle)?.stop.cancel();
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use tauri::ipc::InvokeResponseBody;
    use tokio::sync::mpsc;

    fn events() -> (Channel<Event>, mpsc::UnboundedReceiver<serde_json::Value>) {
        let (tx, rx) = mpsc::unbounded_channel();
        (
            Channel::new(move |body| {
                if let InvokeResponseBody::Json(json) = body {
                    let _ = tx.send(serde_json::from_str(&json).unwrap());
                }
                Ok(())
            }),
            rx,
        )
    }
    #[tokio::test]
    async fn forwards_transformed_requests_and_streams_without_credentials_in_callbacks() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let upstream = tokio::spawn(async move {
            let (socket, _) = listener.accept().await.unwrap();
            http1::Builder::new()
                .serve_connection(
                    TokioIo::new(socket),
                    service_fn(|req: Request<Incoming>| async move {
                        assert_eq!(req.uri(), "/original/v1/messages?beta=1");
                        assert_eq!(
                            req.headers()[header::AUTHORIZATION],
                            "Bearer original-secret"
                        );
                        assert!(!req.headers().contains_key("x-hop"));
                        assert_eq!(
                            req.into_body().collect().await.unwrap().to_bytes(),
                            "trimmed"
                        );
                        let (tx, rx) = mpsc::channel::<Result<Frame<Bytes>, Infallible>>(2);
                        tokio::spawn(async move {
                            tx.send(Ok(Frame::data(Bytes::from_static(b"first"))))
                                .await
                                .unwrap();
                            tx.send(Ok(Frame::data(Bytes::from_static(b"second"))))
                                .await
                                .unwrap();
                        });
                        let stream = futures_util::stream::unfold(rx, |mut rx| async {
                            rx.recv().await.map(|v| (v, rx))
                        });
                        Ok::<_, Infallible>(Response::new(StreamBody::new(stream)))
                    }),
                )
                .await
                .unwrap();
        });
        let servers = ModelProxies::default();
        let (channel, mut rx) = events();
        let info = servers
            .serve(
                0,
                "harness".into(),
                format!("http://{address}/original"),
                channel,
            )
            .unwrap();
        let client = reqwest::Client::new();
        let request = client
            .post(format!("{}/v1/messages?beta=1", info.url))
            .header(header::AUTHORIZATION, "Bearer original-secret")
            .header(header::CONTENT_TYPE, "application/json")
            .header(header::CONNECTION, "x-hop")
            .header("x-hop", "remove")
            .body("original")
            .send();
        let call = tokio::spawn(request);
        let event = rx.recv().await.unwrap();
        assert_eq!(event["path"], "/v1/messages?beta=1");
        assert_eq!(event["body"], "original");
        assert!(!event.to_string().contains("original-secret"));
        let shared = servers.owned("harness", info.handle).unwrap();
        let tx = shared
            .pending()
            .replies
            .remove(&event["request"].as_u64().unwrap())
            .unwrap();
        tx.send(Ok("trimmed".into())).unwrap();
        assert_eq!(
            call.await.unwrap().unwrap().text().await.unwrap(),
            "firstsecond"
        );
        upstream.await.unwrap();
        servers.stop_all();
    }
    #[tokio::test]
    async fn rejects_browser_requests_wrong_authority_and_failed_transforms() {
        let servers = ModelProxies::default();
        let (channel, mut rx) = events();
        let info = servers
            .serve(0, "harness".into(), "http://127.0.0.1:1".into(), channel)
            .unwrap();
        let client = reqwest::Client::new();
        let url = format!("{}/responses", info.url);
        assert_eq!(
            client
                .get(&url)
                .header(header::ORIGIN, "https://example.test")
                .send()
                .await
                .unwrap()
                .status(),
            StatusCode::NOT_FOUND
        );
        assert_eq!(
            client
                .get(&url)
                .header(header::HOST, "example.test")
                .send()
                .await
                .unwrap()
                .status(),
            StatusCode::NOT_FOUND
        );
        assert_eq!(
            client
                .get(info.url.replace(
                    &servers.owned("harness", info.handle).unwrap().prefix,
                    "/wrong"
                ))
                .send()
                .await
                .unwrap()
                .status(),
            StatusCode::NOT_FOUND
        );
        let call = tokio::spawn(
            client
                .post(&url)
                .header(header::CONTENT_TYPE, "application/json")
                .body("{}")
                .send(),
        );
        let event = rx.recv().await.unwrap();
        servers
            .owned("harness", info.handle)
            .unwrap()
            .pending()
            .replies
            .remove(&event["request"].as_u64().unwrap())
            .unwrap()
            .send(Err("failed".into()))
            .unwrap();
        assert_eq!(
            call.await.unwrap().unwrap().status(),
            StatusCode::BAD_GATEWAY
        );
        assert!(servers.owned("other", info.handle).is_err());
        servers.stop_all();
        assert!(servers
            .serve(0, "harness".into(), "http://127.0.0.1:1".into(), events().0)
            .is_err());
    }
}
