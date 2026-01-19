// Minimal Rust FFI example for testing RustAnalyzer with calls

use napi_derive::napi;

#[napi]
pub struct GraphEngine {
    nodes: Vec<String>,
}

#[napi]
impl GraphEngine {
    #[napi(constructor)]
    pub fn new() -> Self {
        GraphEngine { nodes: Vec::new() }
    }

    #[napi]
    pub fn add_node(&mut self, name: String) {
        self.validate_name(&name);
        self.nodes.push(name);
        self.notify_change();
    }

    #[napi]
    pub fn get_nodes(&self) -> Vec<String> {
        self.nodes.clone()
    }

    #[napi(js_name = "nodeCount")]
    pub fn get_node_count(&self) -> u32 {
        self.nodes.len() as u32
    }

    fn validate_name(&self, name: &str) -> bool {
        !name.is_empty()
    }

    fn notify_change(&self) {
        println!("Graph changed!");
    }

    #[napi]
    pub fn save_to_file(&self, path: String) {
        // Side effect: file system write
        std::fs::write(&path, self.serialize()).unwrap();
    }

    #[napi]
    pub fn load_from_file(&mut self, path: String) {
        // Side effect: file system read
        let content = std::fs::read_to_string(&path).expect("Failed to read");
        self.nodes = content.lines().map(String::from).collect();
    }

    #[napi]
    pub fn debug_print(&self) {
        // Side effect: console IO
        println!("Nodes: {:?}", self.nodes);
        dbg!(&self.nodes);
    }

    fn serialize(&self) -> String {
        self.nodes.join("\n")
    }
}

#[napi]
pub fn compute_hash(data: String) -> String {
    let len = data.len();
    format!("hash:{}", len)
}

pub fn internal_helper() -> bool {
    println!("Helper called");
    true
}

/// Example function with unsafe blocks for testing
pub fn unsafe_memory_op(ptr: *mut u8, len: usize) {
    // First unsafe block
    unsafe {
        *ptr = 42;
    }

    // Some safe code in between
    let x = len * 2;

    // Second unsafe block
    unsafe {
        std::ptr::write_bytes(ptr, 0, x);
    }
}
