# Service decomposition

Keep commands as compatibility facades during extraction. Move parsing, discovery,
statistics, persistence adapters and service lifecycle helpers into named child modules.
Use syntax item boundaries, explicit exports and parent-private types. Relocate ownership
only after compile/test convergence; do not mix behavior changes into the extraction.

History scenarios: local/WSL/SSH, catalog cache misses, concurrent refresh/cursor ordering,
all supported CLI parsers, usage deduplication, exact session identity, additive conversion,
scoped deletion and backup recovery. Preserve existing SQL and source-file mutation guards.

cc-connect scenarios: installed/not installed, Windows/WSL/SSH, start/stop/restart,
configuration/secrets and remote handoff. Read its specific contracts before those edits.

Tests are grouped by source domain and pipeline responsibility; shared fixtures move to
a dedicated module. Test fully qualified names may change, assertions and count may not.
