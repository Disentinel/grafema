//! Minimal RFDB unix socket client.
//! Protocol: [4-byte length BE][MessagePack payload]

use std::collections::HashMap;
use std::io::{Read, Write};
use std::os::unix::net::UnixStream;
use serde::Deserialize;
use anyhow::Result;

pub struct RfdbClient {
    stream: UnixStream,
    request_id: u64,
}

#[derive(Deserialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct WireNode {
    pub id: String,
    pub node_type: Option<String>,
    pub name: Option<String>,
    pub file: Option<String>,
    pub exported: Option<bool>,
    pub metadata: Option<serde_json::Value>,
}

#[derive(Deserialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct WireEdge {
    pub src: String,
    pub dst: String,
    pub edge_type: Option<String>,
}

impl RfdbClient {
    pub fn connect(socket_path: &str) -> Result<Self> {
        let stream = UnixStream::connect(socket_path)?;
        stream.set_read_timeout(Some(std::time::Duration::from_secs(300)))?;
        let mut client = Self { stream, request_id: 0 };

        // Hello handshake
        let _resp = client.send_raw(serde_json::json!({
            "cmd": "hello",
            "protocolVersion": 2,
            "clientId": "gui-server"
        }))?;
        tracing::info!("Connected to RFDB");

        Ok(client)
    }

    fn send_raw(&mut self, cmd: serde_json::Value) -> Result<serde_json::Value> {
        self.request_id += 1;
        let mut envelope = cmd.as_object().cloned().unwrap_or_default();
        envelope.insert("requestId".to_string(), serde_json::json!(self.request_id.to_string()));

        let payload = rmp_serde::to_vec_named(&envelope)?;
        let len = payload.len() as u32;
        self.stream.write_all(&len.to_be_bytes())?;
        self.stream.write_all(&payload)?;
        self.stream.flush()?;

        // Read response
        let mut len_buf = [0u8; 4];
        self.stream.read_exact(&mut len_buf)?;
        let resp_len = u32::from_be_bytes(len_buf) as usize;

        let mut resp_buf = vec![0u8; resp_len];
        self.stream.read_exact(&mut resp_buf)?;

        let resp: serde_json::Value = rmp_serde::from_slice(&resp_buf)?;
        if let Some(err) = resp.get("error").and_then(|v| v.as_str()) {
            anyhow::bail!("RFDB error: {}", err);
        }
        Ok(resp)
    }

    /// Get all nodes via QueryNodes with empty filter
    pub fn get_all_nodes(&mut self) -> Result<Vec<WireNode>> {
        let resp = self.send_raw(serde_json::json!({
            "cmd": "queryNodes",
            "query": {}
        }))?;

        let nodes: Vec<WireNode> = resp.get("nodes")
            .and_then(|v| v.as_array())
            .map(|arr| {
                arr.iter()
                    .filter_map(|v| serde_json::from_value::<WireNode>(v.clone()).ok())
                    .collect()
            })
            .unwrap_or_default();

        Ok(nodes)
    }

    /// Get all edges
    pub fn get_all_edges(&mut self) -> Result<Vec<WireEdge>> {
        let resp = self.send_raw(serde_json::json!({
            "cmd": "getAllEdges"
        }))?;

        let edges: Vec<WireEdge> = resp.get("edges")
            .and_then(|v| v.as_array())
            .map(|arr| {
                arr.iter()
                    .filter_map(|v| serde_json::from_value::<WireEdge>(v.clone()).ok())
                    .collect()
            })
            .unwrap_or_default();

        Ok(edges)
    }

    /// Get node count
    pub fn node_count(&mut self) -> Result<usize> {
        let resp = self.send_raw(serde_json::json!({"cmd": "nodeCount"}))?;
        Ok(resp.get("count").and_then(|v| v.as_u64()).unwrap_or(0) as usize)
    }

    /// Get edge count
    pub fn edge_count(&mut self) -> Result<usize> {
        let resp = self.send_raw(serde_json::json!({"cmd": "edgeCount"}))?;
        Ok(resp.get("count").and_then(|v| v.as_u64()).unwrap_or(0) as usize)
    }

    /// Count nodes by type
    pub fn count_nodes_by_type(&mut self) -> Result<HashMap<String, usize>> {
        let resp = self.send_raw(serde_json::json!({"cmd": "countNodesByType"}))?;
        let counts = resp.get("counts")
            .and_then(|v| v.as_object())
            .map(|obj| obj.iter().map(|(k, v)| (k.clone(), v.as_u64().unwrap_or(0) as usize)).collect())
            .unwrap_or_default();
        Ok(counts)
    }

    /// Count edges by type
    pub fn count_edges_by_type(&mut self) -> Result<HashMap<String, usize>> {
        let resp = self.send_raw(serde_json::json!({"cmd": "countEdgesByType"}))?;
        let counts = resp.get("counts")
            .and_then(|v| v.as_object())
            .map(|obj| obj.iter().map(|(k, v)| (k.clone(), v.as_u64().unwrap_or(0) as usize)).collect())
            .unwrap_or_default();
        Ok(counts)
    }

    /// Get single node by ID
    pub fn get_node(&mut self, id: &str) -> Result<Option<WireNode>> {
        let resp = self.send_raw(serde_json::json!({
            "cmd": "getNode",
            "id": id,
        }))?;
        if let Some(node_val) = resp.get("node") {
            if node_val.is_null() { return Ok(None); }
            return Ok(serde_json::from_value::<WireNode>(node_val.clone()).ok());
        }
        Ok(None)
    }
}
