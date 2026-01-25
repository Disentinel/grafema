//! Immutable segment files (nodes.bin, edges.bin)

use std::path::Path;
use std::fs::File;
use memmap2::Mmap;
use crate::error::{GraphError, Result};
use crate::storage::string_table::StringTable;

/// Магическое число для валидации формата
pub const MAGIC: [u8; 4] = *b"SGRF"; // Semantic Graph Format

/// Версия формата
pub const FORMAT_VERSION: u16 = 1;

/// Заголовок сегмента
#[repr(C)]
#[derive(Debug, Clone, Copy)]
pub struct SegmentHeader {
    pub magic: [u8; 4],
    pub version: u16,
    pub node_count: u64,
    pub edge_count: u64,
    pub string_table_offset: u64,
}

/// Размер заголовка на диске (30 bytes, без padding)
pub const HEADER_SIZE_ON_DISK: usize = 4 + 2 + 8 + 8 + 8;

impl SegmentHeader {
    pub fn new(node_count: u64, edge_count: u64, string_table_offset: u64) -> Self {
        Self {
            magic: MAGIC,
            version: FORMAT_VERSION,
            node_count,
            edge_count,
            string_table_offset,
        }
    }

    pub fn validate(&self) -> Result<()> {
        if self.magic != MAGIC {
            return Err(GraphError::InvalidFormat(
                format!("Неверное магическое число: {:?}", self.magic)
            ));
        }
        // Copy to avoid unaligned reference
        let version = self.version;
        if version != FORMAT_VERSION {
            return Err(GraphError::InvalidFormat(
                format!("Неподдерживаемая версия формата: {}", version)
            ));
        }
        Ok(())
    }
}

/// Immutable сегмент нод (memory-mapped)
pub struct NodesSegment {
    mmap: Mmap,
    header: SegmentHeader,
    node_count: usize,

    // Offsets в mmap для колоночных массивов
    ids_offset: usize,
    type_offsets_offset: usize,  // Теперь u32 offsets в StringTable (было kinds u16)
    file_ids_offset: usize,
    name_offsets_offset: usize,
    version_offsets_offset: usize,
    exported_offset: usize,
    deleted_offset: usize,
    metadata_offsets_offset: usize,

    // String table для file paths, имён, версий, типов нод и metadata
    string_table: Option<StringTable>,
}

impl NodesSegment {
    /// Открыть существующий сегмент
    pub fn open(path: &Path) -> Result<Self> {
        let file = File::open(path)?;
        let mmap = unsafe { Mmap::map(&file)? };

        // Читаем и валидируем заголовок (используем размер на диске: 30 байт)
        if mmap.len() < HEADER_SIZE_ON_DISK {
            return Err(GraphError::InvalidFormat("Файл слишком мал".into()));
        }

        // Manually parse header from bytes (30 bytes on disk)
        let mut magic = [0u8; 4];
        magic.copy_from_slice(&mmap[0..4]);

        let version = u16::from_le_bytes([mmap[4], mmap[5]]);
        let node_count = u64::from_le_bytes(mmap[6..14].try_into().unwrap());
        let edge_count = u64::from_le_bytes(mmap[14..22].try_into().unwrap());
        let string_table_offset = u64::from_le_bytes(mmap[22..30].try_into().unwrap());

        let header = SegmentHeader {
            magic,
            version,
            node_count,
            edge_count,
            string_table_offset,
        };
        header.validate()?;

        // Вычисляем offsets для колоночных массивов
        let node_count = header.node_count as usize;
        let mut offset = HEADER_SIZE_ON_DISK;

        let ids_offset = offset;
        offset += node_count * std::mem::size_of::<u128>();

        // type_offsets: u32 offsets в StringTable (было kinds: u16)
        let type_offsets_offset = offset;
        offset += node_count * std::mem::size_of::<u32>();

        let file_ids_offset = offset;
        offset += node_count * std::mem::size_of::<u32>();

        let name_offsets_offset = offset;
        offset += node_count * std::mem::size_of::<u32>();

        let version_offsets_offset = offset;
        offset += node_count * std::mem::size_of::<u32>();

        let exported_offset = offset;
        offset += node_count * std::mem::size_of::<u8>();

        let deleted_offset = offset;
        offset += node_count * std::mem::size_of::<u8>();

        let metadata_offsets_offset = offset;

        // Попытка загрузить string table если он есть
        let string_table = if header.string_table_offset > 0
            && (header.string_table_offset as usize) < mmap.len()
        {
            // Создаём sub-mmap для string table
            let st_offset = header.string_table_offset as usize;
            let st_mmap = &mmap[st_offset..];

            // Пытаемся загрузить (может упасть если формат неверный)
            match StringTable::load_from_mmap_slice(st_mmap) {
                Ok(st) => Some(st),
                Err(_) => None, // Игнорируем ошибки, просто не будет string table
            }
        } else {
            None
        };

        Ok(Self {
            mmap,
            header,
            node_count,
            ids_offset,
            type_offsets_offset,
            file_ids_offset,
            name_offsets_offset,
            version_offsets_offset,
            exported_offset,
            deleted_offset,
            metadata_offsets_offset,
            string_table,
        })
    }

    pub fn node_count(&self) -> usize {
        self.node_count
    }

    // Helper: read u128 from potentially unaligned bytes
    fn read_u128_at(&self, offset: usize) -> u128 {
        let bytes: [u8; 16] = self.mmap[offset..offset + 16].try_into().unwrap();
        u128::from_le_bytes(bytes)
    }

    // Helper: read u16 from potentially unaligned bytes
    fn read_u16_at(&self, offset: usize) -> u16 {
        let bytes: [u8; 2] = self.mmap[offset..offset + 2].try_into().unwrap();
        u16::from_le_bytes(bytes)
    }

    // Helper: read u32 from potentially unaligned bytes
    fn read_u32_at(&self, offset: usize) -> u32 {
        let bytes: [u8; 4] = self.mmap[offset..offset + 4].try_into().unwrap();
        u32::from_le_bytes(bytes)
    }

    /// Получить слайс deleted flags (single bytes, no alignment issue)
    fn deleted(&self) -> &[u8] {
        let start = self.deleted_offset;
        let end = start + self.node_count;
        &self.mmap[start..end]
    }

    /// Получить ID ноды по индексу
    pub fn get_id(&self, idx: usize) -> Option<u128> {
        if idx >= self.node_count {
            return None;
        }
        let offset = self.ids_offset + idx * std::mem::size_of::<u128>();
        Some(self.read_u128_at(offset))
    }

    /// Получить type_offset по индексу (offset в StringTable)
    pub fn get_type_offset(&self, idx: usize) -> Option<u32> {
        if idx >= self.node_count {
            return None;
        }
        let offset = self.type_offsets_offset + idx * std::mem::size_of::<u32>();
        Some(self.read_u32_at(offset))
    }

    /// Получить тип ноды по индексу (строка из StringTable)
    pub fn get_node_type(&self, idx: usize) -> Option<&str> {
        let type_offset = self.get_type_offset(idx)?;
        self.get_string(type_offset)
    }

    /// Получить file_id по индексу
    pub fn get_file_id(&self, idx: usize) -> Option<u32> {
        if idx >= self.node_count {
            return None;
        }
        let offset = self.file_ids_offset + idx * std::mem::size_of::<u32>();
        Some(self.read_u32_at(offset))
    }

    /// Получить name_offset по индексу
    pub fn get_name_offset(&self, idx: usize) -> Option<u32> {
        if idx >= self.node_count {
            return None;
        }
        let offset = self.name_offsets_offset + idx * std::mem::size_of::<u32>();
        Some(self.read_u32_at(offset))
    }

    /// Проверить удалена ли нода
    pub fn is_deleted(&self, idx: usize) -> bool {
        self.deleted().get(idx).copied().unwrap_or(0) != 0
    }

    /// Итератор по всем нодам (включая deleted)
    pub fn iter_indices(&self) -> impl Iterator<Item = usize> {
        0..self.node_count()
    }

    /// Найти индекс ноды по ID (линейный поиск, можно оптимизировать)
    pub fn find_index(&self, id: u128) -> Option<usize> {
        for idx in 0..self.node_count {
            if self.get_id(idx) == Some(id) {
                return Some(idx);
            }
        }
        None
    }

    /// Получить строку по offset из string table
    pub fn get_string(&self, offset: u32) -> Option<&str> {
        self.string_table.as_ref()?.get(offset)
    }

    /// Получить file path по file_id (file_id это offset+1 в string table)
    /// 0 означает "нет значения" (узел без file)
    pub fn get_file_path(&self, idx: usize) -> Option<&str> {
        let file_id = self.get_file_id(idx)?;
        if file_id == 0 {
            return None;
        }
        self.get_string(file_id - 1)  // -1: writer stores offset+1
    }

    /// Получить name по name_offset из string table
    /// 0 означает "нет значения" (узел без name)
    pub fn get_name(&self, idx: usize) -> Option<&str> {
        let name_offset = self.get_name_offset(idx)?;
        if name_offset == 0 {
            return None;
        }
        self.get_string(name_offset - 1)  // -1: writer stores offset+1
    }

    /// Получить version_offset по индексу
    pub fn get_version_offset(&self, idx: usize) -> Option<u32> {
        if idx >= self.node_count {
            return None;
        }
        let offset = self.version_offsets_offset + idx * std::mem::size_of::<u32>();
        Some(self.read_u32_at(offset))
    }

    /// Получить version по version_offset из string table
    pub fn get_version(&self, idx: usize) -> Option<&str> {
        let version_offset = self.get_version_offset(idx)?;
        self.get_string(version_offset)
    }

    /// Получить metadata_offset по индексу
    pub fn get_metadata_offset(&self, idx: usize) -> Option<u32> {
        if idx >= self.node_count {
            return None;
        }
        let offset = self.metadata_offsets_offset + idx * std::mem::size_of::<u32>();
        Some(self.read_u32_at(offset))
    }

    /// Получить metadata JSON string из string table
    pub fn get_metadata(&self, idx: usize) -> Option<&str> {
        let metadata_offset = self.get_metadata_offset(idx)?;
        // Если offset == 0, значит metadata нет
        if metadata_offset == 0 {
            return None;
        }
        self.get_string(metadata_offset)
    }

    /// Получить exported flag по индексу
    pub fn get_exported(&self, idx: usize) -> Option<bool> {
        if idx >= self.node_count {
            return None;
        }
        let offset = self.exported_offset + idx;
        Some(self.mmap.get(offset).copied().unwrap_or(0) != 0)
    }
}

/// Immutable сегмент рёбер (memory-mapped)
pub struct EdgesSegment {
    mmap: Mmap,
    header: SegmentHeader,
    edge_count: usize,

    // Offsets в mmap
    src_offset: usize,
    dst_offset: usize,
    edge_type_offsets_offset: usize,  // u32 offsets в StringTable (было etypes u16)
    metadata_offsets_offset: usize,   // u32 offsets в StringTable для edge metadata
    deleted_offset: usize,

    // String table для edge types и metadata
    string_table: Option<StringTable>,
}

impl EdgesSegment {
    pub fn open(path: &Path) -> Result<Self> {
        let file = File::open(path)?;
        let mmap = unsafe { Mmap::map(&file)? };

        // Manually parse header from bytes (30 bytes on disk)
        if mmap.len() < HEADER_SIZE_ON_DISK {
            return Err(GraphError::InvalidFormat("Файл слишком мал".into()));
        }

        let mut magic = [0u8; 4];
        magic.copy_from_slice(&mmap[0..4]);

        let version = u16::from_le_bytes([mmap[4], mmap[5]]);
        let node_count = u64::from_le_bytes(mmap[6..14].try_into().unwrap());
        let edge_count_u64 = u64::from_le_bytes(mmap[14..22].try_into().unwrap());
        let string_table_offset = u64::from_le_bytes(mmap[22..30].try_into().unwrap());

        let header = SegmentHeader {
            magic,
            version,
            node_count,
            edge_count: edge_count_u64,
            string_table_offset,
        };
        header.validate()?;

        let edge_count = edge_count_u64 as usize;
        let mut offset = HEADER_SIZE_ON_DISK;

        let src_offset = offset;
        offset += edge_count * std::mem::size_of::<u128>();

        let dst_offset = offset;
        offset += edge_count * std::mem::size_of::<u128>();

        // edge_type_offsets: u32 offsets в StringTable (было etypes u16)
        let edge_type_offsets_offset = offset;
        offset += edge_count * std::mem::size_of::<u32>();

        // metadata_offsets: u32 offsets в StringTable для edge metadata
        let metadata_offsets_offset = offset;
        offset += edge_count * std::mem::size_of::<u32>();

        let deleted_offset = offset;

        // Загрузить string table если он есть
        let string_table = if header.string_table_offset > 0
            && (header.string_table_offset as usize) < mmap.len()
        {
            let st_offset = header.string_table_offset as usize;
            let st_mmap = &mmap[st_offset..];
            match StringTable::load_from_mmap_slice(st_mmap) {
                Ok(st) => Some(st),
                Err(_) => None,
            }
        } else {
            None
        };

        Ok(Self {
            mmap,
            header,
            edge_count,
            src_offset,
            dst_offset,
            edge_type_offsets_offset,
            metadata_offsets_offset,
            deleted_offset,
            string_table,
        })
    }

    pub fn edge_count(&self) -> usize {
        self.edge_count
    }

    // Helper: read u128 from potentially unaligned bytes
    fn read_u128_at(&self, offset: usize) -> u128 {
        let bytes: [u8; 16] = self.mmap[offset..offset + 16].try_into().unwrap();
        u128::from_le_bytes(bytes)
    }

    // Helper: read u32 from potentially unaligned bytes
    fn read_u32_at(&self, offset: usize) -> u32 {
        let bytes: [u8; 4] = self.mmap[offset..offset + 4].try_into().unwrap();
        u32::from_le_bytes(bytes)
    }

    fn deleted(&self) -> &[u8] {
        let start = self.deleted_offset;
        let end = start + self.edge_count;
        &self.mmap[start..end]
    }

    pub fn get_src(&self, idx: usize) -> Option<u128> {
        if idx >= self.edge_count {
            return None;
        }
        let offset = self.src_offset + idx * std::mem::size_of::<u128>();
        Some(self.read_u128_at(offset))
    }

    pub fn get_dst(&self, idx: usize) -> Option<u128> {
        if idx >= self.edge_count {
            return None;
        }
        let offset = self.dst_offset + idx * std::mem::size_of::<u128>();
        Some(self.read_u128_at(offset))
    }

    /// Получить offset типа ребра в StringTable
    pub fn get_edge_type_offset(&self, idx: usize) -> Option<u32> {
        if idx >= self.edge_count {
            return None;
        }
        let offset = self.edge_type_offsets_offset + idx * std::mem::size_of::<u32>();
        Some(self.read_u32_at(offset))
    }

    /// Получить тип ребра как строку из StringTable
    pub fn get_edge_type(&self, idx: usize) -> Option<&str> {
        let type_offset = self.get_edge_type_offset(idx)?;
        self.string_table.as_ref()?.get(type_offset)
    }

    /// Получить offset metadata ребра в StringTable
    pub fn get_metadata_offset(&self, idx: usize) -> Option<u32> {
        if idx >= self.edge_count {
            return None;
        }
        let offset = self.metadata_offsets_offset + idx * std::mem::size_of::<u32>();
        Some(self.read_u32_at(offset))
    }

    /// Получить metadata ребра как строку (JSON) из StringTable
    pub fn get_metadata(&self, idx: usize) -> Option<&str> {
        let metadata_offset = self.get_metadata_offset(idx)?;
        if metadata_offset == 0 {
            return None;  // 0 means no metadata
        }
        self.string_table.as_ref()?.get(metadata_offset)
    }

    pub fn is_deleted(&self, idx: usize) -> bool {
        self.deleted().get(idx).copied().unwrap_or(0) != 0
    }

    /// Найти все рёбра исходящие из ноды
    pub fn find_outgoing(&self, src_id: u128) -> Vec<usize> {
        (0..self.edge_count())
            .filter(|&idx| {
                self.get_src(idx) == Some(src_id) && !self.is_deleted(idx)
            })
            .collect()
    }
}
