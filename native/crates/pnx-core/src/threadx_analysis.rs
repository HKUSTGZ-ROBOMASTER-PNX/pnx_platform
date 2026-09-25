//! Offline, bounded analysis of captured memory. Never opens or controls a probe.
use crate::{VariableDescriptor, load_elf_data_symbols};
use anyhow::{Context, Result, bail};
use object::{Object, ObjectSection};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    collections::{BTreeMap, HashSet},
    fs,
    path::Path,
};

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MemoryBlock {
    pub address: u64,
    pub bytes: Vec<u8>,
}
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Snapshot {
    pub elf_sha256: String,
    pub session_id: String,
    pub program_generation: u64,
    pub captured_at: String,
    pub blocks: Vec<MemoryBlock>,
}
impl Snapshot {
    fn validate(&self) -> Result<()> {
        if self.session_id.is_empty() || self.captured_at.is_empty() {
            bail!("snapshot provenance is required");
        }
        let mut total = 0usize;
        let mut ranges = Vec::new();
        for b in &self.blocks {
            let end = b
                .address
                .checked_add(b.bytes.len() as u64)
                .context("address overflow")?;
            total = total.checked_add(b.bytes.len()).context("size overflow")?;
            if total > 16 * 1024 * 1024 {
                bail!("snapshot exceeds 16 MiB budget");
            }
            if ranges
                .iter()
                .any(|&(start, stop)| b.address < stop && start < end)
            {
                bail!("overlapping memory blocks");
            }
            ranges.push((b.address, end));
        }
        Ok(())
    }
    fn read(&self, address: u64, width: u8) -> Result<u64> {
        if !matches!(width, 1 | 2 | 4 | 8) {
            bail!("unsupported scalar width {width}");
        }
        let end = address
            .checked_add(u64::from(width))
            .context("address overflow")?;
        for b in &self.blocks {
            if address >= b.address
                && end
                    <= b.address
                        .checked_add(b.bytes.len() as u64)
                        .context("address overflow")?
            {
                let offset = (address - b.address) as usize;
                let mut bytes = [0u8; 8];
                bytes[..width as usize].copy_from_slice(&b.bytes[offset..offset + width as usize]);
                return Ok(u64::from_le_bytes(bytes));
            }
        }
        bail!("uncaptured memory at 0x{address:x} ({width} bytes)")
    }
}
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ObjectRecord {
    pub address: String,
    pub fields: BTreeMap<String, u64>,
    pub observations: Vec<String>,
}
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ObjectList {
    pub kind: String,
    pub status: String,
    pub declared_count: Option<u64>,
    pub objects: Vec<ObjectRecord>,
    pub issues: Vec<String>,
}
fn root<'a>(catalog: &'a [VariableDescriptor], name: &str) -> Option<&'a VariableDescriptor> {
    catalog
        .iter()
        .find(|d| d.name == name || d.expression == name)
}
fn observations(kind: &str, f: &BTreeMap<String, u64>) -> Vec<String> {
    let mut notes = Vec::new();
    match kind {
        "threads" => {
            if let (Some(priority), Some(user)) = (
                f.get("tx_thread_priority"),
                f.get("tx_thread_user_priority"),
            ) {
                if priority != user {
                    notes.push(format!("Effective priority {priority} differs from configured priority {user}; inspect inheritance and priority changes."));
                }
            }
            notes.push("Stack pointer is saved context, not a peak watermark; stack-fill configuration must be independently verified.".into());
        }
        "mutexes" => {
            if let (Some(owner), Some(depth)) =
                (f.get("tx_mutex_owner"), f.get("tx_mutex_ownership_count"))
            {
                if (*owner == 0) != (*depth == 0) {
                    notes.push("Owner/recursion count are inconsistent; a running capture can tear. This is not proof of a lock defect.".into());
                }
            }
            if f.get("tx_mutex_inherit") == Some(&0)
                && f.get("tx_mutex_suspended_count").is_some_and(|v| *v > 0)
            {
                notes.push("Waiters observed with inheritance disabled; review cross-priority blocking. Snapshot alone cannot prove inversion duration.".into());
            }
        }
        "semaphores" => {
            if f.get("tx_semaphore_count").is_some_and(|v| *v > 0)
                && f.get("tx_semaphore_suspended_count")
                    .is_some_and(|v| *v > 0)
            {
                notes.push("Positive count and waiters coexist in this capture; retry a coherent capture before diagnosing corruption.".into());
            }
        }
        "bytePools" => {
            if let (Some(size), Some(available)) =
                (f.get("tx_byte_pool_size"), f.get("tx_byte_pool_available"))
            {
                if available <= size {
                    notes.push(format!("Pool bytes unavailable: {}; includes allocator overhead, not a heap peak or payload-only usage.", size - available));
                } else {
                    notes.push(
                        "Available bytes exceed pool size; inconsistent capture or layout.".into(),
                    );
                }
            }
        }
        _ => {}
    }
    notes
}

fn inspect_list(
    snapshot: &Snapshot,
    catalog: &[VariableDescriptor],
    kind: &str,
    prefix: &str,
) -> ObjectList {
    let mut out = ObjectList {
        kind: kind.into(),
        status: "unavailable".into(),
        declared_count: None,
        objects: Vec::new(),
        issues: Vec::new(),
    };
    let result = (|| -> Result<()> {
        let head = root(catalog, &format!("_{prefix}_created_ptr"))
            .context("missing list symbol/DWARF")?;
        let count =
            root(catalog, &format!("_{prefix}_created_count")).context("missing created count")?;
        if !matches!(head.byte_width, 4 | 8) {
            bail!("unsupported target pointer width");
        }
        let count_address = count
            .address
            .filter(|v| *v != 0)
            .context("count symbol absent from linked image")?;
        let count = snapshot.read(count_address, count.byte_width)?;
        out.declared_count = Some(count);
        if count > 256 {
            bail!("object count exceeds 256-object analysis budget");
        }
        let first = snapshot.read(
            head.address.context("head address unavailable")?,
            head.byte_width,
        )?;
        if count == 0 {
            if first != 0 {
                bail!("empty count with nonempty head");
            }
            return Ok(());
        }
        let next_name = format!("{prefix}_created_next");
        let next = head
            .children
            .iter()
            .find(|d| d.name == next_name)
            .context("missing DWARF next-link layout")?;
        let next_offset = next
            .pointer_offset
            .context("next-link offset unavailable")?;
        let mut ptr = first;
        let mut seen = HashSet::new();
        for _ in 0..count {
            if ptr == 0 || ptr % u64::from(head.byte_width) != 0 || !seen.insert(ptr) {
                bail!("null, unaligned or premature cyclic list");
            }
            let mut fields = BTreeMap::new();
            for field in &head.children {
                // Only direct integer fields, including pointer values; never dereference MMIO or strings.
                if !field.children.is_empty() || !matches!(field.byte_width, 1 | 2 | 4 | 8) {
                    continue;
                }
                let offset = field.pointer_offset.context("member layout unavailable")?;
                let address = ptr.checked_add(offset).context("field address overflow")?;
                fields.insert(
                    field.name.clone(),
                    snapshot.read(address, field.byte_width)?,
                );
            }
            let observations = observations(kind, &fields);
            out.objects.push(ObjectRecord {
                address: format!("0x{ptr:x}"),
                fields,
                observations,
            });
            ptr = snapshot.read(
                ptr.checked_add(next_offset).context("link overflow")?,
                next.byte_width,
            )?;
        }
        if ptr != first {
            bail!("list does not close at declared count");
        }
        Ok(())
    })();
    match result {
        Ok(()) => out.status = "parsed-best-effort".into(),
        Err(e) => out.issues.push(e.to_string()),
    }
    out
}

/// Layout comes from this ELF's typed pointer members; missing layouts are unsupported, never guessed.
pub fn analyze(elf: &Path, snapshot_path: &Path) -> Result<serde_json::Value> {
    let bytes = fs::read(elf).context("read ELF")?;
    let metadata = fs::metadata(snapshot_path)?;
    if metadata.len() > 80 * 1024 * 1024 {
        bail!("snapshot JSON exceeds input budget");
    }
    let snapshot: Snapshot = serde_json::from_slice(&fs::read(snapshot_path)?)?;
    snapshot.validate()?;
    let hash = format!("{:x}", Sha256::digest(&bytes));
    if snapshot.elf_sha256.to_lowercase() != hash {
        bail!("ELF SHA-256 mismatch");
    }
    let file = object::File::parse(bytes.as_slice())?;
    if !file.is_little_endian() {
        bail!("big-endian snapshots unsupported");
    }
    let catalog = load_elf_data_symbols(elf)?;
    let lists = [
        ("threads", "tx_thread"),
        ("semaphores", "tx_semaphore"),
        ("mutexes", "tx_mutex"),
        ("bytePools", "tx_byte_pool"),
        ("blockPools", "tx_block_pool"),
    ]
    .map(|(kind, prefix)| inspect_list(&snapshot, &catalog, kind, prefix));
    let sections: Vec<_> = file.sections().filter(|s| s.address() != 0 && s.size() != 0).map(|s| serde_json::json!({"name":s.name().unwrap_or("?"),"address":format!("0x{:x}",s.address()),"sizeBytes":s.size(),"kind":format!("{:?}",s.kind())})).collect();
    let mut warnings = vec![
        "Offline best-effort capture; matching ELF hash verifies the supplied artifact, not the running target identity.",
        "Run counts are not CPU utilization. No stack high-watermark or heap peak is inferred without capture/configuration evidence.",
        "Missing objects/layouts/captured ranges are unavailable, not zero. Integer values remain u64; UI consumers must preserve precision.",
    ];
    if lists.iter().any(|l| l.status != "parsed-best-effort") {
        warnings.push("One or more object lists could not be fully parsed; partial records are diagnostic only.");
    }
    Ok(
        serde_json::json!({"schemaVersion":1,"elfSha256":hash,"sessionId":snapshot.session_id,"programGeneration":snapshot.program_generation,"capturedAt":snapshot.captured_at,"consistency":"best-effort","memorySections":sections,"rtos":lists,"warnings":warnings}),
    )
}
