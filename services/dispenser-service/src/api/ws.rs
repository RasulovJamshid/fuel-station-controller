use axum::extract::ws::{Message, WebSocket};
use site_config::Protocol;

use crate::api::routes::AppState;
use types::WsEvent;

fn protocol_str(p: &Protocol) -> String {
    serde_json::to_value(p)
        .ok()
        .and_then(|v| v.as_str().map(|s| s.to_string()))
        .unwrap_or_else(|| format!("{p:?}"))
}

pub async fn ws_upgrade(mut socket: WebSocket, st: AppState) {
    let mut rx = st.events.subscribe();
    let (site_name, fp_count, protocol) = {
        let cfg = st.cfg.read().await;
        (
            cfg.site.name.clone(),
            cfg.active_positions().len(),
            protocol_str(&cfg.connection.protocol),
        )
    };
    let hello = WsEvent::Connected {
        site_name,
        fp_count,
        protocol,
    };
    let hello = serde_json::to_string(&hello).unwrap_or_default();
    let _ = socket.send(Message::Text(hello)).await;
    loop {
        tokio::select! {
            incoming = socket.recv() => {
                match incoming {
                    Some(Ok(Message::Close(_))) | None => break,
                    Some(Ok(Message::Ping(p))) => {
                        let _ = socket.send(Message::Pong(p)).await;
                    }
                    Some(Err(_)) => break,
                    _ => {}
                }
            }
            ev = rx.recv() => {
                match ev {
                    Ok(ev) => {
                        let json = match serde_json::to_string(&ev) {
                            Ok(s) => s,
                            Err(_) => continue,
                        };
                        if socket.send(Message::Text(json)).await.is_err() {
                            break;
                        }
                    }
                    Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) => continue,
                    Err(_) => break,
                }
            }
        }
    }
}
