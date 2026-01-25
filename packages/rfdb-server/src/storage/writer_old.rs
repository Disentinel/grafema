//! Segment writer - запись графа в binary files

use std::path::Path;
use std::fs::{File, OpenOptions};
use std::io::{BufWriter, Write};
use crate::storage::{NodeRecord, EdgeRecord};
use crate::storage::segment::{SegmentHeader, MAGIC, FORMAT_VERSION};
use crate::error::Result;

/// Writer для записи сегментов на диск
pub struct SegmentWriter {
    path: std::path::PathBuf,
}

impl SegmentWriter {
    pub fn new<P: AsRef<Path>>(path: P) -> Self {
        Self {
            path: path.as_ref().to_path_buf(),
        }
    }

    /// Записать nodes segment в файл
    pub fn write_nodes(&self, nodes: &[NodeRecord]) -> Result<()> {
        let nodes_path = self.path.join("nodes.bin");
        let file = OpenOptions::new()
            .create(true)
            .write(true)
            .truncate(true)
            .open(&nodes_path)?;

        let mut writer = BufWriter::new(file);

        // Записываем header
        let header = SegmentHeader::new(
            nodes.len() as u64,
            0, // edges count (в другом файле)
            0, // string table offset (TODO)
        );

        self.write_header(&mut writer, &header)?;

        // Записываем колоночные массивы
        // 1. IDs
        for node in nodes {
            writer.write_all(&node.id.to_le_bytes())?;
        }

        // 2. Kinds
        for node in nodes {
            writer.write_all(&node.kind.to_le_bytes())?;
        }

        // 3. File IDs
        for node in nodes {
            writer.write_all(&node.file_id.to_le_bytes())?;
        }

        // 4. Name offsets
        for node in nodes {
            writer.write_all(&node.name_offset.to_le_bytes())?;
        }

        // 5. Deleted flags
        for node in nodes {
            writer.write_all(&[if node.deleted { 1 } else { 0 }])?;
        }

        writer.flush()?;

        tracing::info!("Written {} nodes to {:?}", nodes.len(), nodes_path);
        Ok(())
    }

    /// Записать edges segment в файл
    pub fn write_edges(&self, edges: &[EdgeRecord]) -> Result<()> {
        let edges_path = self.path.join("edges.bin");
        let file = OpenOptions::new()
            .create(true)
            .write(true)
            .truncate(true)
            .open(&edges_path)?;

        let mut writer = BufWriter::new(file);

        // Записываем header
        let header = SegmentHeader::new(
            0, // nodes count (в другом файле)
            edges.len() as u64,
            0, // string table offset (TODO)
        );

        self.write_header(&mut writer, &header)?;

        // Записываем колоночные массивы
        // 1. Source IDs
        for edge in edges {
            writer.write_all(&edge.src.to_le_bytes())?;
        }

        // 2. Destination IDs
        for edge in edges {
            writer.write_all(&edge.dst.to_le_bytes())?;
        }

        // 3. Edge types
        for edge in edges {
            writer.write_all(&edge.etype.to_le_bytes())?;
        }

        // 4. Deleted flags
        for edge in edges {
            writer.write_all(&[if edge.deleted { 1 } else { 0 }])?;
        }

        writer.flush()?;

        tracing::info!("Written {} edges to {:?}", edges.len(), edges_path);
        Ok(())
    }

    /// Записать header в writer
    fn write_header<W: Write>(&self, writer: &mut W, header: &SegmentHeader) -> Result<()> {
        writer.write_all(&header.magic)?;
        writer.write_all(&header.version.to_le_bytes())?;
        writer.write_all(&header.node_count.to_le_bytes())?;
        writer.write_all(&header.edge_count.to_le_bytes())?;
        writer.write_all(&header.string_table_offset.to_le_bytes())?;
        Ok(())
    }

    /// Записать метаданные графа (version, metadata)
    pub fn write_metadata(&self, metadata: &GraphMetadata) -> Result<()> {
        let meta_path = self.path.join("metadata.json");
        let file = File::create(meta_path)?;
        serde_json::to_writer_pretty(file, metadata)?;
        Ok(())
    }
}

/// Метаданные графа
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct GraphMetadata {
    pub version: String,
    pub node_count: usize,
    pub edge_count: usize,
    pub created_at: u64,
    pub updated_at: u64,
}

impl Default for GraphMetadata {
    fn default() -> Self {
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_secs();

        Self {
            version: "1.0".to_string(),
            node_count: 0,
            edge_count: 0,
            created_at: now,
            updated_at: now,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;
    use crate::storage::segment::NodesSegment;

    #[test]
    fn test_write_and_read_nodes() {
        let dir = TempDir::new().unwrap();
        let writer = SegmentWriter::new(dir.path());

        // Создаём тестовые ноды
        let nodes = vec![
            NodeRecord {
                id: 123,
                kind: 3,
                file_id: 1,
                name_offset: 10,
                version: "main".to_string(),
                exported: true,
                replaces: None,
                deleted: false,
            },
            NodeRecord {
                id: 456,
                kind: 4,
                file_id: 2,
                name_offset: 20,
                version: "main".to_string(),
                exported: false,
                replaces: None,
                deleted: false,
            },
        ];

        // Записываем
        writer.write_nodes(&nodes).unwrap();

        // Читаем обратно
        let segment = NodesSegment::open(&dir.path().join("nodes.bin")).unwrap();

        assert_eq!(segment.node_count(), 2);
        assert_eq!(segment.get_id(0), Some(123));
        assert_eq!(segment.get_id(1), Some(456));
        assert_eq!(segment.get_kind(0), Some(3));
        assert_eq!(segment.get_kind(1), Some(4));
        assert!(!segment.is_deleted(0));
        assert!(!segment.is_deleted(1));
    }
}
