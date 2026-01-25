//! String table для хранения файловых путей и имён

use std::collections::HashMap;
use std::path::Path;
use std::fs::File;
use std::io::{Write, BufWriter};
use memmap2::Mmap;
use crate::error::{GraphError, Result};

/// String table: все строки в одном blob + массив offset'ов
pub struct StringTable {
    data: Vec<u8>,
    offsets: Vec<u32>,
    index: HashMap<String, u32>, // String -> offset
}

impl StringTable {
    pub fn new() -> Self {
        Self {
            data: Vec::new(),
            offsets: Vec::new(),
            index: HashMap::new(),
        }
    }

    /// Добавить строку, вернуть offset
    pub fn intern(&mut self, s: &str) -> u32 {
        if let Some(&offset) = self.index.get(s) {
            return offset;
        }

        let offset = self.data.len() as u32;
        self.data.extend_from_slice(s.as_bytes());
        self.offsets.push(offset);
        self.index.insert(s.to_string(), offset);
        offset
    }

    /// Alias для intern (для совместимости с writer.rs)
    pub fn add(&mut self, s: &str) -> u32 {
        self.intern(s)
    }

    /// Получить строку по offset
    pub fn get(&self, offset: u32) -> Option<&str> {
        let start = offset as usize;

        // Найти следующий offset для определения длины
        let next_offset = self.offsets.iter()
            .find(|&&o| o > offset)
            .copied()
            .unwrap_or(self.data.len() as u32);

        let end = next_offset as usize;

        if start >= self.data.len() || end > self.data.len() {
            return None;
        }

        std::str::from_utf8(&self.data[start..end]).ok()
    }

    /// Сохранить в файл
    pub fn write_to_file(&self, path: &Path) -> Result<()> {
        let file = File::create(path)?;
        let mut writer = BufWriter::new(file);
        self.write_to(&mut writer)
    }

    /// Записать в Writer (для встраивания в segment)
    pub fn write_to<W: Write>(&self, writer: &mut W) -> Result<()> {
        // Записать длину data
        writer.write_all(&(self.data.len() as u64).to_le_bytes())?;

        // Записать data
        writer.write_all(&self.data)?;

        // Записать количество offsets
        writer.write_all(&(self.offsets.len() as u64).to_le_bytes())?;

        // Записать offsets
        for &offset in &self.offsets {
            writer.write_all(&offset.to_le_bytes())?;
        }

        Ok(())
    }

    /// Загрузить из mmap
    pub fn load_from_mmap(mmap: &Mmap) -> Result<Self> {
        Self::load_from_mmap_slice(&mmap[..])
    }

    /// Загрузить из slice (для sub-mmap)
    pub fn load_from_mmap_slice(slice: &[u8]) -> Result<Self> {
        let mut offset = 0;

        if slice.len() < 8 {
            return Err(GraphError::InvalidFormat("String table too small".into()));
        }

        // Читаем длину data
        let data_len = u64::from_le_bytes(
            slice[offset..offset + 8]
                .try_into()
                .map_err(|_| GraphError::InvalidFormat("Неверный размер data".into()))?
        ) as usize;
        offset += 8;

        if offset + data_len > slice.len() {
            return Err(GraphError::InvalidFormat("Invalid data length".into()));
        }

        // Читаем data
        let data = slice[offset..offset + data_len].to_vec();
        offset += data_len;

        if offset + 8 > slice.len() {
            return Err(GraphError::InvalidFormat("Missing offsets count".into()));
        }

        // Читаем количество offsets
        let offsets_count = u64::from_le_bytes(
            slice[offset..offset + 8]
                .try_into()
                .map_err(|_| GraphError::InvalidFormat("Неверный размер offsets".into()))?
        ) as usize;
        offset += 8;

        if offset + offsets_count * 4 > slice.len() {
            return Err(GraphError::InvalidFormat("Invalid offsets count".into()));
        }

        // Читаем offsets
        let mut offsets = Vec::with_capacity(offsets_count);
        for _ in 0..offsets_count {
            let o = u32::from_le_bytes(
                slice[offset..offset + 4]
                    .try_into()
                    .map_err(|_| GraphError::InvalidFormat("Неверный offset".into()))?
            );
            offsets.push(o);
            offset += 4;
        }

        // Строим индекс
        let mut index = HashMap::new();
        for (i, &offset) in offsets.iter().enumerate() {
            let next_offset = offsets.get(i + 1).copied().unwrap_or(data.len() as u32);
            if let Ok(s) = std::str::from_utf8(&data[offset as usize..next_offset as usize]) {
                index.insert(s.to_string(), offset);
            }
        }

        Ok(Self { data, offsets, index })
    }
}

impl Default for StringTable {
    fn default() -> Self {
        Self::new()
    }
}
