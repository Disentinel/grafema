//! ML model for computing node name embeddings.
//!
//! Uses all-MiniLM-L6-v2 via candle (pure Rust ML framework).
//! Model weights cached via hf-hub after first download.
//!
//! The model produces 384-dimensional embeddings from short text strings.
//! We prepend the node type to the name for context: "CLASS HeartbeatService".

use std::path::{Path, PathBuf};

use candle_core::{Device, Tensor};
use candle_nn::VarBuilder;
use candle_transformers::models::bert::{BertModel, Config as BertConfig, DTYPE};
use hf_hub::{api::sync::Api, Repo, RepoType};
use tokenizers::Tokenizer;

/// Embedding dimension for all-MiniLM-L6-v2.
pub const EMBEDDING_DIM: usize = 384;

/// HuggingFace model ID.
const MODEL_ID: &str = "sentence-transformers/all-MiniLM-L6-v2";

/// Max batch size for inference.
const MAX_BATCH_SIZE: usize = 256;

/// Format a node for embedding: "{TYPE} {name}"
pub fn format_node_text(node_type: &str, name: &str) -> String {
    if node_type.is_empty() {
        name.to_string()
    } else {
        format!("{} {}", node_type, name)
    }
}

/// Wraps the candle sentence transformer model.
pub struct EmbeddingModel {
    cache_dir: PathBuf,
    model: Option<BertModel>,
    tokenizer: Option<Tokenizer>,
    device: Device,
}

impl EmbeddingModel {
    /// Create wrapper. Model NOT loaded yet (lazy).
    pub fn new(cache_dir: &Path) -> Self {
        Self {
            cache_dir: cache_dir.to_path_buf(),
            model: None,
            tokenizer: None,
            device: Device::Cpu,
        }
    }

    pub fn is_loaded(&self) -> bool {
        self.model.is_some() && self.tokenizer.is_some()
    }

    /// Check if model files exist in the hf-hub cache.
    pub fn is_cached(&self) -> bool {
        // hf-hub caches to ~/.cache/huggingface/hub by default,
        // or HF_HOME if set. We just check if Api can find cached files.
        let api = match Api::new() {
            Ok(a) => a,
            Err(_) => return false,
        };
        let repo = api.repo(Repo::new(MODEL_ID.to_string(), RepoType::Model));
        // If model.safetensors is cached, the model is available offline
        repo.get("model.safetensors").is_ok()
    }

    /// Load the model from cache or download on first use.
    pub fn load(&mut self) -> Result<(), ModelError> {
        // Set HF_HOME to our cache dir so models go to ~/.grafema/models/
        if self.cache_dir.exists() {
            std::env::set_var("HF_HOME", &self.cache_dir);
        }

        let api = Api::new().map_err(|e| ModelError::DownloadFailed(e.to_string()))?;
        let repo = api.repo(Repo::new(MODEL_ID.to_string(), RepoType::Model));

        // Download/cache model files
        let config_path = repo
            .get("config.json")
            .map_err(|e| ModelError::DownloadFailed(format!("config.json: {}", e)))?;
        let tokenizer_path = repo
            .get("tokenizer.json")
            .map_err(|e| ModelError::DownloadFailed(format!("tokenizer.json: {}", e)))?;
        let weights_path = repo
            .get("model.safetensors")
            .map_err(|e| ModelError::DownloadFailed(format!("model.safetensors: {}", e)))?;

        // Load config
        let config_data = std::fs::read_to_string(&config_path)
            .map_err(|e| ModelError::InferenceFailed(format!("read config: {}", e)))?;
        let config: BertConfig = serde_json::from_str(&config_data)
            .map_err(|e| ModelError::InferenceFailed(format!("parse config: {}", e)))?;

        // Load tokenizer
        let tokenizer = Tokenizer::from_file(&tokenizer_path)
            .map_err(|e| ModelError::InferenceFailed(format!("load tokenizer: {}", e)))?;

        // Load model weights
        let vb = unsafe {
            VarBuilder::from_mmaped_safetensors(&[weights_path], DTYPE, &self.device)
                .map_err(|e| ModelError::InferenceFailed(format!("load weights: {}", e)))?
        };
        let model = BertModel::load(vb, &config)
            .map_err(|e| ModelError::InferenceFailed(format!("build model: {}", e)))?;

        self.model = Some(model);
        self.tokenizer = Some(tokenizer);

        tracing::info!("Embedding model loaded: {} ({}D)", MODEL_ID, EMBEDDING_DIM);
        Ok(())
    }

    /// Compute embeddings for a batch of strings.
    ///
    /// Returns one 384-dim vector per input string.
    /// Processes in sub-batches of MAX_BATCH_SIZE for memory efficiency.
    pub fn embed(&self, texts: &[&str]) -> Result<Vec<Vec<f32>>, ModelError> {
        let model = self.model.as_ref().ok_or(ModelError::NotLoaded)?;
        let tokenizer = self.tokenizer.as_ref().ok_or(ModelError::NotLoaded)?;

        if texts.is_empty() {
            return Ok(vec![]);
        }

        let mut all_embeddings = Vec::with_capacity(texts.len());

        for chunk in texts.chunks(MAX_BATCH_SIZE) {
            let embeddings = self
                .embed_batch(model, tokenizer, chunk)
                .map_err(|e| ModelError::InferenceFailed(e.to_string()))?;
            all_embeddings.extend(embeddings);
        }

        Ok(all_embeddings)
    }

    /// Compute a single embedding.
    pub fn embed_one(&self, text: &str) -> Result<Vec<f32>, ModelError> {
        let results = self.embed(&[text])?;
        results
            .into_iter()
            .next()
            .ok_or(ModelError::InferenceFailed("Empty result".to_string()))
    }

    /// Internal: embed a single batch (up to MAX_BATCH_SIZE).
    fn embed_batch(
        &self,
        model: &BertModel,
        tokenizer: &Tokenizer,
        texts: &[&str],
    ) -> candle_core::Result<Vec<Vec<f32>>> {
        // Tokenize all texts
        let encodings = tokenizer
            .encode_batch(texts.to_vec(), true)
            .map_err(|e| candle_core::Error::Msg(format!("tokenize: {}", e)))?;

        // Find max length for padding
        let max_len = encodings.iter().map(|e| e.get_ids().len()).max().unwrap_or(0);

        // Build padded token_ids and attention_mask tensors
        let mut all_token_ids = Vec::with_capacity(texts.len() * max_len);
        let mut all_attention_mask = Vec::with_capacity(texts.len() * max_len);
        let mut all_type_ids = Vec::with_capacity(texts.len() * max_len);

        for encoding in &encodings {
            let ids = encoding.get_ids();
            let mask = encoding.get_attention_mask();
            let type_ids = encoding.get_type_ids();
            let pad_len = max_len - ids.len();

            all_token_ids.extend_from_slice(ids);
            all_token_ids.extend(std::iter::repeat(0u32).take(pad_len));

            all_attention_mask.extend_from_slice(mask);
            all_attention_mask.extend(std::iter::repeat(0u32).take(pad_len));

            all_type_ids.extend_from_slice(type_ids);
            all_type_ids.extend(std::iter::repeat(0u32).take(pad_len));
        }

        let batch_size = texts.len();
        let token_ids =
            Tensor::from_vec(all_token_ids, (batch_size, max_len), &self.device)?;
        let attention_mask =
            Tensor::from_vec(all_attention_mask.clone(), (batch_size, max_len), &self.device)?;
        let type_ids =
            Tensor::from_vec(all_type_ids, (batch_size, max_len), &self.device)?;

        // Forward pass
        let output = model.forward(&token_ids, &type_ids, Some(&attention_mask))?;

        // Mean pooling with attention mask
        let attention_mask_f = Tensor::from_vec(
            all_attention_mask.iter().map(|&v| v as f32).collect::<Vec<_>>(),
            (batch_size, max_len),
            &self.device,
        )?;

        // Expand mask to hidden dim: (batch, seq_len) → (batch, seq_len, 1) → broadcast
        let mask_expanded = attention_mask_f.unsqueeze(2)?; // (batch, seq, 1)
        let masked = output.broadcast_mul(&mask_expanded)?;
        let summed = masked.sum(1)?; // (batch, hidden)
        let mask_sum = mask_expanded.sum(1)?.clamp(1e-9, f64::MAX)?; // (batch, 1)
        let pooled = summed.broadcast_div(&mask_sum)?; // (batch, hidden)

        // L2 normalize
        let norms = pooled.sqr()?.sum_keepdim(1)?.sqrt()?;
        let normalized = pooled.broadcast_div(&norms)?;

        // Convert to Vec<Vec<f32>>
        let mut results = Vec::with_capacity(batch_size);
        for i in 0..batch_size {
            let embedding = normalized.get(i)?.to_vec1::<f32>()?;
            results.push(embedding);
        }

        Ok(results)
    }
}

#[derive(Debug)]
pub enum ModelError {
    NotLoaded,
    DownloadFailed(String),
    InferenceFailed(String),
}

impl std::fmt::Display for ModelError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::NotLoaded => write!(f, "Model not loaded"),
            Self::DownloadFailed(e) => write!(f, "Download failed: {}", e),
            Self::InferenceFailed(e) => write!(f, "Inference failed: {}", e),
        }
    }
}

impl std::error::Error for ModelError {}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_format_node_text_with_type() {
        assert_eq!(
            format_node_text("CLASS", "HeartbeatService"),
            "CLASS HeartbeatService"
        );
    }

    #[test]
    fn test_format_node_text_empty_type() {
        assert_eq!(format_node_text("", "HeartbeatService"), "HeartbeatService");
    }

    #[test]
    fn test_format_node_text_function() {
        assert_eq!(
            format_node_text("FUNCTION", "getUserById"),
            "FUNCTION getUserById"
        );
    }

    #[test]
    fn test_model_not_loaded() {
        let model = EmbeddingModel::new(Path::new("/tmp/test-models"));
        assert!(!model.is_loaded());
        let result = model.embed(&["test"]);
        assert!(result.is_err());
    }

    #[test]
    fn test_embed_empty_input() {
        // A loaded model with empty input should return empty vec
        // We can't test this without the model, so test the not-loaded case
        let model = EmbeddingModel::new(Path::new("/tmp/test-models"));
        let result = model.embed(&[]);
        // Not loaded error takes precedence
        assert!(result.is_err());
    }
}
