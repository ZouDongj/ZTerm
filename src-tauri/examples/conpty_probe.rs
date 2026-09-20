// Minimal ConPTY harness probe: spawn a command, feed scripted input, and
// log output-arrival timestamps. Lets us measure app latency with NO ZTerm
// in the loop (nested ConPTY behavior of herdr + TUI clients).
//
// Usage: conpty_probe <script>  where script = semicolon-separated phases:
//   "wait:5000|send:herdr --session zterm-cp\\r|wait:4000|send:dsh-tui\\r|wait:6000|key:x:400|key:y:400|key:z:400|wait:6000"
// `\\r` in send is translated to CR.
use portable_pty::{native_pty_system, CommandBuilder};
use std::io::{Read, Write};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    if args.is_empty() {
        eprintln!("usage: conpty_probe <script>");
        std::process::exit(2);
    }
    let script = args[0].clone();
    let cols: u16 = std::env::args().nth(2).and_then(|s| s.parse().ok()).unwrap_or(80);
    let rows: u16 = std::env::args().nth(3).and_then(|s| s.parse().ok()).unwrap_or(24);
    let phases: Vec<&str> = script.split('|').collect();

    let pty_system = native_pty_system();
    let pair = pty_system
        .openpty(portable_pty::PtySize {
            rows,
            cols,
            pixel_width: 0,
            pixel_height: 0,
        })
        .expect("openpty");
    let mut cmd = CommandBuilder::new("bash.exe");
    cmd.args(["-i"]);
    let _child = pair.slave.spawn_command(cmd).expect("spawn");
    drop(pair.slave);

    let mut reader = pair.master.try_clone_reader().expect("reader");
    let start = Instant::now();
    let done = Arc::new(AtomicBool::new(false));
    let done_r = Arc::clone(&done);
    let t0 = start;
    // Mode arg 4: "direct" reads inline; "flusher" mimics ZTerm's
    // reader-thread -> shared outbox -> 4ms flusher architecture.
    let mode = std::env::args().nth(4).unwrap_or_else(|| "direct".into());
    if mode == "flusher" {
        use std::sync::Mutex;
        let outbox: Arc<Mutex<Vec<u8>>> = Arc::new(Mutex::new(Vec::new()));
        let finished = Arc::new(std::sync::atomic::AtomicBool::new(false));
        {
            let outbox = Arc::clone(&outbox);
            let finished = Arc::clone(&finished);
            std::thread::spawn(move || {
                let mut buf = [0u8; 8192];
                loop {
                    use std::io::Read;
                    match reader.read(&mut buf) {
                        Ok(0) => break,
                        Ok(n) => outbox.lock().expect("outbox").extend_from_slice(&buf[..n]),
                        Err(_) => break,
                    }
                }
                finished.store(true, std::sync::atomic::Ordering::Release);
            });
        }
        let ob = Arc::clone(&outbox);
        let fin = Arc::clone(&finished);
        std::thread::spawn(move || loop {
            std::thread::sleep(Duration::from_millis(4));
            let taken = {
                let mut guard = ob.lock().expect("outbox");
                if guard.is_empty() {
                    if fin.load(Ordering::Acquire) {
                        break;
                    }
                    continue;
                }
                std::mem::take(&mut *guard)
            };
            if !taken.is_empty() {
                println!("[t={:>7.0}ms] +{}B", t0.elapsed().as_millis(), taken.len());
                let _ = std::io::stdout().flush();
            }
        });
    } else {
        std::thread::spawn(move || {
            let mut buf = [0u8; 8192];
            loop {
                match reader.read(&mut buf) {
                    Ok(0) => break,
                    Ok(n) => {
                        println!("[t={:>7.0}ms] +{}B", t0.elapsed().as_millis(), n);
                        let _ = std::io::stdout().flush();
                    }
                    Err(_) => break,
                }
            }
            done_r.store(true, Ordering::SeqCst);
        });
    }

    let mut writer = pair.master.take_writer().expect("writer");
    for phase in phases {
        let mut parts = phase.splitn(2, ':');
        let kind = parts.next().unwrap_or("");
        let rest = parts.next().unwrap_or("");
        match kind {
            "wait" => {
                let ms: u64 = rest.parse().unwrap_or(0);
                std::thread::sleep(Duration::from_millis(ms));
            }
            "send" => {
                let text = rest.replace("\\r", "\r").replace("\\e", "\u{1b}");
                let _ = writer.write_all(text.as_bytes());
                let _ = writer.flush();
                println!("[t={:>7.0}ms] SENT {:?}", t0.elapsed().as_millis(), text);
            }
            "key" => {
                let mut kp = rest.split(':');
                let ch = kp.next().unwrap_or("");
                let gap: u64 = kp.next().and_then(|s| s.parse().ok()).unwrap_or(400);
                let _ = writer.write_all(ch.as_bytes());
                let _ = writer.flush();
                println!("[t={:>7.0}ms] KEY {:?}", t0.elapsed().as_millis(), ch);
                std::thread::sleep(Duration::from_millis(gap));
            }
            _ => {}
        }
    }
    println!("[t={:>7.0}ms] SCRIPT-DONE", t0.elapsed().as_millis());
    std::thread::sleep(Duration::from_millis(2000));
}
