//! Bounded, opt-in local transport metadata. Never stores terminal contents.
use parking_lot::Mutex;
use serde_json::{json, Value};
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, Instant};

static ENABLED: AtomicBool = AtomicBool::new(false);
static TRACE: Mutex<Option<Trace>> = Mutex::new(None);
static EPOCH: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);

#[derive(Clone, Copy)]
pub struct Ticket {
    pub epoch: u64,
    pub op: u64,
}

struct Trace {
    epoch: u64,
    tab_id: String,
    start: Instant,
    duration: Duration,
    capacity: usize,
    flush_ms: u64,
    stopped: bool,
    truncated: bool,
    events: Vec<Value>,
}

impl Trace {
    fn active(&self) -> bool {
        !self.stopped && !self.truncated && self.start.elapsed() < self.duration
    }
    fn record(
        &mut self,
        kind: &'static str,
        bytes: usize,
        op: Option<u64>,
        ok: Option<bool>,
    ) -> Option<Value> {
        if !self.active() {
            return None;
        }
        let seq = self.events.len() as u64 + 1;
        let stamp =
            json!({"epoch": self.epoch, "seq": seq, "us": self.start.elapsed().as_micros() as u64});
        let op = if kind == "input-invoke" {
            Some(op.unwrap_or(seq))
        } else {
            op
        };
        self.events.push(json!({"seq": seq, "us": stamp["us"], "kind": kind, "bytes": bytes, "op": op, "ok": ok}));
        if self.events.len() >= self.capacity {
            self.truncated = true;
        }
        Some(stamp)
    }
    fn snapshot(&self) -> Value {
        json!({"epoch": self.epoch, "flushMs": self.flush_ms, "enabled": self.active(), "truncated": self.truncated,
            "durationMs": self.duration.as_millis() as u64, "capacity": self.capacity, "events": self.events})
    }
}

pub fn control(
    action: &str,
    tab_id: &str,
    duration_ms: u64,
    capacity: usize,
    flush_ms: u64,
) -> Result<Value, String> {
    let mut guard = TRACE.lock();
    match action {
        "arm" => {
            let epoch = EPOCH.fetch_add(1, Ordering::Relaxed) + 1;
            *guard = Some(Trace {
                epoch,
                tab_id: tab_id.to_owned(),
                start: Instant::now(),
                duration: Duration::from_millis(duration_ms.clamp(1, 30000)),
                capacity: capacity.clamp(1, 8192),
                flush_ms,
                stopped: false,
                truncated: false,
                events: Vec::new(),
            });
        }
        "stop" => {
            if let Some(t) = guard.as_mut() {
                t.stopped = true;
            }
        }
        "clear" => {
            *guard = None;
        }
        "snapshot" => {}
        _ => return Err("unknown diagnostic action".into()),
    }
    ENABLED.store(guard.as_ref().is_some_and(Trace::active), Ordering::Relaxed);
    Ok(guard
        .as_ref()
        .map(Trace::snapshot)
        .unwrap_or_else(|| json!({"enabled": false, "events": []})))
}

pub fn record(
    tab_id: &str,
    kind: &'static str,
    bytes: usize,
    ticket: Option<Ticket>,
    op: Option<u64>,
    ok: Option<bool>,
) -> Option<Value> {
    if !ENABLED.load(Ordering::Relaxed) {
        return None;
    }
    let mut guard = TRACE.lock();
    let t = guard.as_mut()?;
    if !t.active() {
        ENABLED.store(false, Ordering::Relaxed);
        return None;
    }
    if t.tab_id != tab_id || ticket.is_some_and(|v| v.epoch != t.epoch) {
        return None;
    }
    let result = t.record(kind, bytes, ticket.map(|v| v.op).or(op), ok);
    if !t.active() {
        ENABLED.store(false, Ordering::Relaxed);
    }
    result
}

pub fn input(tab_id: &str, bytes: usize, requested_op: Option<u64>) -> Option<Ticket> {
    let stamp = record(tab_id, "input-invoke", bytes, None, requested_op, None)?;
    Some(Ticket {
        epoch: stamp["epoch"].as_u64()?,
        op: requested_op.unwrap_or(stamp["seq"].as_u64()?),
    })
}

pub fn input_stage(
    tab_id: &str,
    kind: &'static str,
    bytes: usize,
    ticket: Option<Ticket>,
    ok: Option<bool>,
) {
    if let Some(ticket) = ticket {
        record(tab_id, kind, bytes, Some(ticket), None, ok);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn native_trace_bounds_and_expiry() {
        let mut t = Trace {
            epoch: 7,
            tab_id: "local_test".into(),
            start: Instant::now(),
            duration: Duration::from_secs(1),
            capacity: 2,
            flush_ms: 40,
            stopped: false,
            truncated: false,
            events: vec![],
        };
        assert!(t.record("read", 10, None, None).is_some());
        assert!(t.record("emit", 10, None, Some(true)).is_some());
        assert!(t.record("read", 10, None, None).is_none());
        assert_eq!(t.events.len(), 2);
        assert!(t.truncated);
        t.truncated = false;
        t.start = Instant::now() - Duration::from_secs(2);
        assert!(t.record("read", 10, None, None).is_none());
        assert_eq!(t.snapshot()["enabled"], false);
        assert!(t.events.iter().all(|e| e
            .as_object()
            .unwrap()
            .keys()
            .all(|k| ["seq", "us", "kind", "bytes", "op", "ok"].contains(&k.as_str()))));
    }

    #[test]
    fn native_trace_lifecycle_and_generation_are_isolated() {
        control("clear", "", 1, 1, 4).unwrap();
        assert!(input("local_test", 5, Some(123)).is_none());
        let first = control("arm", "local_test", 30001, 9000, 40).unwrap();
        assert_eq!(first["capacity"], 8192);
        assert_eq!(first["durationMs"], 30000);
        assert_eq!(first["flushMs"], 40);
        assert!(input("other_tab", 5, None).is_none());
        let old = input("local_test", 5, Some(123)).unwrap();
        input_stage("local_test", "write-end", 5, Some(old), Some(true));
        let snapshot = control("snapshot", "", 0, 0, 0).unwrap();
        assert_eq!(snapshot["events"][0]["op"], 123);
        assert_eq!(snapshot["events"].as_array().unwrap().len(), 2);
        control("stop", "", 0, 0, 0).unwrap();
        assert!(record("local_test", "raw-read", 5, None, None, None).is_none());
        control("arm", "local_test", 10000, 2, 4).unwrap();
        input_stage("local_test", "write-end", 5, Some(old), Some(true));
        assert_eq!(
            control("snapshot", "", 0, 0, 0).unwrap()["events"],
            json!([])
        );
        assert!(record("local_test", "raw-read", 5, None, None, None).is_some());
        assert!(record("local_test", "output-emit", 5, None, None, None).is_some());
        assert!(record("local_test", "raw-read", 5, None, None, None).is_none());
        let end = control("clear", "", 0, 0, 0).unwrap();
        assert_eq!(end["events"], json!([]));
        assert_eq!(end["enabled"], false);
    }
}
