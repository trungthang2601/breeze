package agentapp

import (
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
)

// Fork: per-user Linux installs (the web one-liner's "Breeze RMM Agent (user)"
// unit in ~/.config/systemd/user) were written without TimeoutStopSec, so the
// user manager held every logout/poweroff for its 90s default while the
// agent's helper/capture children ignored SIGTERM. The installer now writes the
// bound into the unit itself; this heals units that were installed earlier, on
// the next agent start, with a drop-in (the unit file itself is left alone).

const userUnitStopDropIn = "[Service]\nTimeoutStopSec=20\nKillMode=mixed\n"

// userUnitDropInPaths returns the per-user unit and the drop-in to write for it,
// rooted at configHome ($XDG_CONFIG_HOME or ~/.config).
func userUnitDropInPaths(configHome string) (unit, dropIn string) {
	dir := filepath.Join(configHome, "systemd", "user")
	return filepath.Join(dir, "breeze-agent.service"),
		filepath.Join(dir, "breeze-agent.service.d", "stop-timeout.conf")
}

// ensureUserUnitStopDropIn writes the drop-in when the per-user unit exists and
// the drop-in is missing or different. Reports whether it changed anything.
func ensureUserUnitStopDropIn(configHome string) (bool, error) {
	unit, dropIn := userUnitDropInPaths(configHome)
	if _, err := os.Stat(unit); err != nil {
		return false, nil // not a per-user install: nothing to heal
	}
	if cur, err := os.ReadFile(dropIn); err == nil && string(cur) == userUnitStopDropIn {
		return false, nil
	}
	if err := os.MkdirAll(filepath.Dir(dropIn), 0o755); err != nil {
		return false, err
	}
	tmp := dropIn + ".tmp"
	if err := os.WriteFile(tmp, []byte(userUnitStopDropIn), 0o644); err != nil {
		return false, err
	}
	if err := os.Rename(tmp, dropIn); err != nil {
		_ = os.Remove(tmp)
		return false, err
	}
	return true, nil
}

// reconcileUserUnitStopTimeout heals a per-user install at startup. Only runs
// for a non-root agent started by a systemd (user) manager. Best-effort: a
// failure only warns. The new bound applies from the agent's next stop.
func reconcileUserUnitStopTimeout() {
	if os.Geteuid() == 0 || os.Getenv("INVOCATION_ID") == "" {
		return
	}
	configHome := os.Getenv("XDG_CONFIG_HOME")
	if configHome == "" {
		home, err := os.UserHomeDir()
		if err != nil || home == "" {
			return
		}
		configHome = filepath.Join(home, ".config")
	}
	changed, err := ensureUserUnitStopDropIn(configHome)
	if err != nil {
		fmt.Fprintf(os.Stderr, "Warning: could not write the breeze-agent user unit stop-timeout drop-in: %v\n", err)
		return
	}
	if !changed {
		return
	}
	if out, err := exec.Command("systemctl", "--user", "daemon-reload").CombinedOutput(); err != nil {
		fmt.Fprintf(os.Stderr, "Warning: wrote the stop-timeout drop-in but systemctl --user daemon-reload failed: %s\n",
			strings.TrimSpace(string(out)))
	}
}
