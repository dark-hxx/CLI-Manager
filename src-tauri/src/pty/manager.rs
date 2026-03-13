use portable_pty::{native_pty_system, CommandBuilder, MasterPty, PtySize};
use serde::Serialize;
use std::collections::HashMap;
use std::io::{Read, Write};
use std::sync::{Arc, Mutex};
use tauri::{AppHandle, Emitter};

pub struct PtySession {
    writer: Box<dyn Write + Send>,
    master: Box<dyn MasterPty + Send>,
    child: Arc<Mutex<Box<dyn portable_pty::Child + Send + Sync>>>,
}

#[derive(Clone, Serialize)]
pub struct PtyProcessStatus {
    pub status: String,
    pub exit_code: Option<i32>,
}

pub struct PtyManager {
    sessions: Mutex<HashMap<String, PtySession>>,
    statuses: Arc<Mutex<HashMap<String, PtyProcessStatus>>>,
}

impl PtyManager {
    pub fn new() -> Self {
        Self {
            sessions: Mutex::new(HashMap::new()),
            statuses: Arc::new(Mutex::new(HashMap::new())),
        }
    }

    pub fn create(
        &self,
        session_id: &str,
        cwd: Option<&str>,
        env_vars: Option<HashMap<String, String>>,
        app_handle: AppHandle,
    ) -> Result<(), String> {
        let pty_system = native_pty_system();
        let pair = pty_system
            .openpty(PtySize {
                rows: 24,
                cols: 80,
                pixel_width: 0,
                pixel_height: 0,
            })
            .map_err(|e| e.to_string())?;

        let mut cmd = CommandBuilder::new("powershell.exe");
        cmd.arg("-NoLogo");

        if let Some(dir) = cwd {
            cmd.cwd(dir);
        }
        if let Some(vars) = env_vars {
            for (k, v) in vars {
                cmd.env(k, v);
            }
        }

        let child = pair.slave.spawn_command(cmd).map_err(|e| e.to_string())?;
        drop(pair.slave);

        let writer = pair.master.take_writer().map_err(|e| e.to_string())?;
        let mut reader = pair.master.try_clone_reader().map_err(|e| e.to_string())?;

        let child = Arc::new(Mutex::new(child));
        let output_event = format!("pty-output-{session_id}");
        let status_event = format!("pty-status-{session_id}");
        let status_map = self.statuses.clone();
        let child_for_thread = child.clone();
        let session_id_owned = session_id.to_string();

        self.statuses.lock().unwrap().insert(
            session_id.to_string(),
            PtyProcessStatus {
                status: "running".to_string(),
                exit_code: None,
            },
        );

        std::thread::spawn(move || {
            let mut buf = [0u8; 4096];
            loop {
                match reader.read(&mut buf) {
                    Ok(0) => break,
                    Ok(n) => {
                        let data = String::from_utf8_lossy(&buf[..n]).to_string();
                        let _ = app_handle.emit(&output_event, data);
                    }
                    Err(_) => break,
                }
            }

            // Process exited — check exit status
            let new_status = match child_for_thread.lock().unwrap().try_wait() {
                Ok(Some(exit)) => PtyProcessStatus {
                    status: "exited".to_string(),
                    exit_code: Some(exit.exit_code() as i32),
                },
                Ok(None) => PtyProcessStatus {
                    status: "exited".to_string(),
                    exit_code: None,
                },
                Err(_) => PtyProcessStatus {
                    status: "error".to_string(),
                    exit_code: None,
                },
            };

            if let Ok(mut statuses) = status_map.lock() {
                if let Some(entry) = statuses.get_mut(&session_id_owned) {
                    *entry = new_status.clone();
                }
            }

            let _ = app_handle.emit(&status_event, new_status);
        });

        let session = PtySession {
            writer,
            master: pair.master,
            child,
        };
        self.sessions
            .lock()
            .unwrap()
            .insert(session_id.to_string(), session);
        Ok(())
    }

    pub fn write(&self, session_id: &str, data: &str) -> Result<(), String> {
        let mut sessions = self.sessions.lock().unwrap();
        let session = sessions
            .get_mut(session_id)
            .ok_or_else(|| format!("Session {session_id} not found"))?;
        session
            .writer
            .write_all(data.as_bytes())
            .map_err(|e| e.to_string())?;
        session.writer.flush().map_err(|e| e.to_string())?;
        Ok(())
    }

    pub fn resize(&self, session_id: &str, cols: u16, rows: u16) -> Result<(), String> {
        let sessions = self.sessions.lock().unwrap();
        let session = sessions
            .get(session_id)
            .ok_or_else(|| format!("Session {session_id} not found"))?;
        session
            .master
            .resize(PtySize {
                rows,
                cols,
                pixel_width: 0,
                pixel_height: 0,
            })
            .map_err(|e| e.to_string())
    }

    pub fn close(&self, session_id: &str) -> Result<(), String> {
        let session = {
            let mut sessions = self.sessions.lock().unwrap();
            sessions.remove(session_id)
        };
        if let Some(session) = session {
            let _ = session.child.lock().unwrap().kill();
        }
        self.statuses.lock().unwrap().remove(session_id);
        Ok(())
    }

    pub fn status_all(&self) -> HashMap<String, PtyProcessStatus> {
        self.statuses.lock().unwrap().clone()
    }
}
