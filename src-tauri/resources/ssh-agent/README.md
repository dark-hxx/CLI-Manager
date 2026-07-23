# SSH Agent bundle staging

Release CI places the signed manifest, its signature, and both Linux Agent
binaries in this directory before the Tauri desktop packages are built.

The README keeps the resource glob valid in local development. When no Agent
files are present, the application falls back to the configured release URL.
