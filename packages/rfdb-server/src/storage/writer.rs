//! Segment writer - запись графа в binary files

use std::path::Path;
use std::fs::{File, OpenOptions};
use std::io::{BufWriter, Write, Seek};
use std::collections::HashMap;
use crate::storage::{NodeRecord, EdgeRecord};
use crate::storage::segment::{SegmentHeader, MAGIC, FORMAT_VERSION};
use crate::storage::string_table::StringTable;
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

        // Построить StringTable из типов нод, имен, путей файлов, версий и metadata
        let mut string_table = StringTable::new();
        let mut type_map: HashMap<String, u32> = HashMap::new();
        let mut file_map: HashMap<String, u32> = HashMap::new();
        let mut name_map: HashMap<String, u32> = HashMap::new();
        let mut version_map: HashMap<String, u32> = HashMap::new();
        let mut metadata_map: HashMap<String, u32> = HashMap::new();

        // Debug: count nodes with metadata
        let nodes_with_metadata = nodes.iter().filter(|n| n.metadata.is_some()).count();
        eprintln!("[WRITER] Received {} nodes, {} have metadata", nodes.len(), nodes_with_metadata);

        // Собрать уникальные строки
        for node in nodes {
            // Add node_type to string table
            if let Some(ref node_type) = node.node_type {
                if !type_map.contains_key(node_type) {
                    let offset = string_table.add(node_type);
                    type_map.insert(node_type.clone(), offset);
                }
            }
            if let Some(ref file) = node.file {
                if !file_map.contains_key(file) {
                    let id = string_table.add(file);
                    file_map.insert(file.clone(), id);
                }
            }
            if let Some(ref name) = node.name {
                if !name_map.contains_key(name) {
                    let offset = string_table.add(name);
                    name_map.insert(name.clone(), offset);
                }
            }
            // Add version to string table
            if !version_map.contains_key(&node.version) {
                let offset = string_table.add(&node.version);
                version_map.insert(node.version.clone(), offset);
            }
            // Add metadata to string table
            if let Some(ref metadata) = node.metadata {
                if !metadata_map.contains_key(metadata) {
                    let offset = string_table.add(metadata);
                    metadata_map.insert(metadata.clone(), offset);
                }
            }
        }

        eprintln!("[WRITER] StringTable has {} unique node types, {} unique metadata strings",
            type_map.len(), metadata_map.len());

        // Создать массивы type_offsets, file_ids, name_offsets, version_offsets, metadata_offsets, exported
        let mut type_offsets = Vec::with_capacity(nodes.len());
        let mut file_ids = Vec::with_capacity(nodes.len());
        let mut name_offsets = Vec::with_capacity(nodes.len());
        let mut version_offsets = Vec::with_capacity(nodes.len());
        let mut metadata_offsets = Vec::with_capacity(nodes.len());
        let mut exported_flags = Vec::with_capacity(nodes.len());

        for node in nodes {
            let type_offset = node.node_type.as_ref()
                .and_then(|t| type_map.get(t).copied())
                .unwrap_or(0);
            // +1 чтобы 0 означал "нет значения" (sentinel)
            let file_id = node.file.as_ref()
                .and_then(|f| file_map.get(f).copied())
                .map(|x| x + 1)  // +1: 0 reserved for None
                .unwrap_or(0);
            let name_offset = node.name.as_ref()
                .and_then(|n| name_map.get(n).copied())
                .map(|x| x + 1)  // +1: 0 reserved for None
                .unwrap_or(0);
            let version_offset = version_map.get(&node.version).copied().unwrap_or(0);
            let metadata_offset = node.metadata.as_ref()
                .and_then(|m| metadata_map.get(m).copied())
                .unwrap_or(0);

            type_offsets.push(type_offset);
            file_ids.push(file_id);
            name_offsets.push(name_offset);
            version_offsets.push(version_offset);
            metadata_offsets.push(metadata_offset);
            exported_flags.push(node.exported);
        }

        // Записываем header (пока с нулевым string_table_offset, обновим позже)
        let header_offset = writer.stream_position()? as u64;
        let mut header = SegmentHeader::new(
            nodes.len() as u64,
            0, // edges count (в другом файле)
            0, // string table offset (заполним после записи колонок)
        );

        self.write_header(&mut writer, &header)?;

        // Записываем колоночные массивы
        // 1. IDs
        for node in nodes {
            writer.write_all(&node.id.to_le_bytes())?;
        }

        // 2. Type offsets (u32 offsets в StringTable, было kinds u16)
        for &type_offset in &type_offsets {
            writer.write_all(&type_offset.to_le_bytes())?;
        }

        // 3. File IDs
        for &file_id in &file_ids {
            writer.write_all(&file_id.to_le_bytes())?;
        }

        // 4. Name offsets
        for &name_offset in &name_offsets {
            writer.write_all(&name_offset.to_le_bytes())?;
        }

        // 5. Version offsets (NEW)
        for &version_offset in &version_offsets {
            writer.write_all(&version_offset.to_le_bytes())?;
        }

        // 6. Exported flags (NEW)
        for &exported in &exported_flags {
            writer.write_all(&[if exported { 1 } else { 0 }])?;
        }

        // 7. Deleted flags
        for node in nodes {
            writer.write_all(&[if node.deleted { 1 } else { 0 }])?;
        }

        // 8. Metadata offsets (NEW)
        for &metadata_offset in &metadata_offsets {
            writer.write_all(&metadata_offset.to_le_bytes())?;
        }

        // Записываем StringTable
        let string_table_offset = writer.stream_position()?;
        string_table.write_to(&mut writer)?;

        // Обновляем header с правильным string_table_offset
        header.string_table_offset = string_table_offset;
        writer.seek(std::io::SeekFrom::Start(header_offset))?;
        self.write_header(&mut writer, &header)?;

        writer.flush()?;

        tracing::info!("Written {} nodes to {:?} with StringTable at offset {}",
            nodes.len(), nodes_path, string_table_offset);
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

        // Построить StringTable для edge types и metadata
        let mut string_table = StringTable::new();
        let mut edge_type_map: HashMap<String, u32> = HashMap::new();
        let mut metadata_map: HashMap<String, u32> = HashMap::new();

        // Собрать уникальные edge types и metadata
        for edge in edges {
            if let Some(ref edge_type) = edge.edge_type {
                if !edge_type_map.contains_key(edge_type) {
                    let offset = string_table.add(edge_type);
                    edge_type_map.insert(edge_type.clone(), offset);
                }
            }
            if let Some(ref metadata) = edge.metadata {
                if !metadata_map.contains_key(metadata) {
                    let offset = string_table.add(metadata);
                    metadata_map.insert(metadata.clone(), offset);
                }
            }
        }

        eprintln!("[WRITER] Writing {} edges with {} unique edge types, {} unique metadata",
            edges.len(), edge_type_map.len(), metadata_map.len());

        // Создать массивы edge_type_offsets и metadata_offsets
        let edge_type_offsets: Vec<u32> = edges.iter()
            .map(|e| {
                e.edge_type.as_ref()
                    .and_then(|t| edge_type_map.get(t).copied())
                    .unwrap_or(0)
            })
            .collect();

        let metadata_offsets: Vec<u32> = edges.iter()
            .map(|e| {
                e.metadata.as_ref()
                    .and_then(|m| metadata_map.get(m).copied())
                    .unwrap_or(0)
            })
            .collect();

        // Записываем header (пока с нулевым string_table_offset)
        let header_offset = writer.stream_position()? as u64;
        let mut header = SegmentHeader::new(
            0, // nodes count (в другом файле)
            edges.len() as u64,
            0, // string table offset (заполним позже)
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

        // 3. Edge type offsets (u32 offsets в StringTable, было etype u16)
        for &edge_type_offset in &edge_type_offsets {
            writer.write_all(&edge_type_offset.to_le_bytes())?;
        }

        // 4. Metadata offsets (u32 offsets в StringTable)
        for &metadata_offset in &metadata_offsets {
            writer.write_all(&metadata_offset.to_le_bytes())?;
        }

        // 5. Deleted flags
        for edge in edges {
            writer.write_all(&[if edge.deleted { 1 } else { 0 }])?;
        }

        // Записываем StringTable
        let string_table_offset = writer.stream_position()?;
        string_table.write_to(&mut writer)?;

        // Обновляем header с правильным string_table_offset
        header.string_table_offset = string_table_offset;
        writer.seek(std::io::SeekFrom::Start(header_offset))?;
        self.write_header(&mut writer, &header)?;

        writer.flush()?;

        tracing::info!("Written {} edges to {:?} with StringTable at offset {}",
            edges.len(), edges_path, string_table_offset);
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
                node_type: Some("FUNCTION".to_string()),
                file_id: 0,
                name_offset: 0,
                version: "main".to_string(),
                exported: true,
                replaces: None,
                deleted: false,
                name: Some("myFunction".to_string()),
                file: Some("src/test.js".to_string()),
                metadata: Some("{\"async\":true}".to_string()),
            },
            NodeRecord {
                id: 456,
                node_type: Some("CLASS".to_string()),
                file_id: 0,
                name_offset: 0,
                version: "main".to_string(),
                exported: false,
                replaces: None,
                deleted: false,
                name: Some("MyClass".to_string()),
                file: Some("src/test.js".to_string()),
                metadata: None,
            },
        ];

        // Записываем
        writer.write_nodes(&nodes).unwrap();

        // Читаем обратно
        let segment = NodesSegment::open(&dir.path().join("nodes.bin")).unwrap();

        assert_eq!(segment.node_count(), 2);
        assert_eq!(segment.get_id(0), Some(123));
        assert_eq!(segment.get_id(1), Some(456));
        assert_eq!(segment.get_node_type(0), Some("FUNCTION"));
        assert_eq!(segment.get_node_type(1), Some("CLASS"));
        assert!(!segment.is_deleted(0));
        assert!(!segment.is_deleted(1));

        // Проверяем что StringTable записалась
        assert_eq!(segment.get_name(0), Some("myFunction"));
        assert_eq!(segment.get_name(1), Some("MyClass"));
        assert_eq!(segment.get_file_path(0), Some("src/test.js"));
        assert_eq!(segment.get_file_path(1), Some("src/test.js"));
    }
}
