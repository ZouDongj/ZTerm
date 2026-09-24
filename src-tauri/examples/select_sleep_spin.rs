//! Probe for the SSH-reader select! discipline (issue #15).
//!
//! A `tokio::time::Sleep` that is pinned OUTSIDE a `select!` loop and polled
//! by reference stays `Ready(())` forever once its deadline passes (the timer
//! entry settles in the fired/DEREGISTERED state and never resets), and
//! tokio's cooperative budget re-wakes a depleted task instead of parking it.
//! An unguarded timeout arm therefore turns the loop into a permanent hot
//! loop — the SSH reader burned a core per idle session this way until the
//! one-shot guard was added (zterm.rs, `inject_fired`).
//!
//! Run with: `cargo run --example select_sleep_spin`

use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::time::Duration;

#[tokio::main]
async fn main() {
    let unguarded_spins = Arc::new(AtomicU64::new(0));
    let guarded_spins = Arc::new(AtomicU64::new(0));

    // Unguarded shape (the historical bug): after the deadline the loop can
    // never park again. The mpsc sender stays alive so `recv()` pends forever,
    // mirroring the reader's never-closed resize channel.
    {
        let counter = Arc::clone(&unguarded_spins);
        tokio::spawn(async move {
            let (keep_open, mut events) = tokio::sync::mpsc::channel::<()>(1);
            let timeout = tokio::time::sleep(Duration::from_millis(50));
            tokio::pin!(timeout);
            loop {
                tokio::select! {
                    _ = &mut timeout => { counter.fetch_add(1, Ordering::Relaxed); }
                    _ = events.recv() => break,
                }
            }
            drop(keep_open);
        });
    }
    // Guarded shape (the fix): the arm is skipped after firing exactly once.
    {
        let counter = Arc::clone(&guarded_spins);
        tokio::spawn(async move {
            let (keep_open, mut events) = tokio::sync::mpsc::channel::<()>(1);
            let timeout = tokio::time::sleep(Duration::from_millis(50));
            tokio::pin!(timeout);
            let mut fired = false;
            loop {
                tokio::select! {
                    _ = &mut timeout, if !fired => {
                        fired = true;
                        counter.fetch_add(1, Ordering::Relaxed);
                    }
                    _ = events.recv() => break,
                }
            }
            drop(keep_open);
        });
    }

    tokio::time::sleep(Duration::from_millis(1500)).await;
    let spins = unguarded_spins.load(Ordering::Relaxed);
    let fires = guarded_spins.load(Ordering::Relaxed);
    println!("unguarded loop iterations in ~1.45s idle: {spins}");
    println!("guarded   arm fires in ~1.45s idle:      {fires}");
    assert!(fires <= 1, "the guarded arm must fire at most once");
    if spins > 100_000 {
        println!(
            "CONFIRMED: an unguarded pinned-Sleep select! arm busy-loops (one core per task)."
        );
    } else {
        println!("NOT reproduced on this tokio version — re-evaluate the reader guard.");
    }
}
