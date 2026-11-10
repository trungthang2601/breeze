//go:build !windows

package updater

import (
	"fmt"
	"os"
	"path/filepath"
	"syscall"

	"github.com/breeze-rmm/agent/internal/procspawn"
)

// Restart tries service managers in order, then falls back to exec.
func Restart() error {
	// Per-user systemd service (Linux kiosk installs run the agent as the
	// desktop user under `systemctl --user`). The system-scope restart below
	// cannot see that unit and stalls ~2 minutes on polkit before failing, and
	// the exec fallback used to drop the unit's --config flag.
	if os.Geteuid() != 0 && os.Getenv("INVOCATION_ID") != "" {
		return restartUserSystemd()
	}

	// Try systemd first (Linux)
	if err := restartSystemd(); err == nil {
		return nil
	}

	// Try launchd (macOS)
	if err := restartLaunchd(); err == nil {
		return nil
	}

	// No service manager available
	log.Warn("no service manager detected, falling back to exec — agent will not auto-restart on crash")
	return restartExec()
}

func restartSystemd() error {
	out, err := procspawn.Command("systemctl", "restart", "breeze-agent").CombinedOutput()
	if err != nil {
		log.Warn("systemd restart failed", "error", err.Error(), "output", string(out))
		return err
	}
	log.Info("restarted via systemd")
	return nil
}

// restartUserSystemd restarts the per-user unit. --no-block queues the job in
// the user manager and returns at once (systemd stops this very process as
// part of the restart). If even that fails, exit and let the unit's
// Restart= policy start the freshly installed binary.
func restartUserSystemd() error {
	out, err := exec.Command("systemctl", "--user", "--no-block", "restart", "breeze-agent").CombinedOutput()
	if err == nil {
		log.Info("restart queued via systemd --user")
		return nil
	}
	log.Warn("systemd --user restart failed; exiting so the unit's Restart= policy relaunches the new binary",
		"error", err.Error(), "output", string(out))
	os.Exit(1)
	return nil
}

func restartLaunchd() error {
	out, err := procspawn.Command("launchctl", "kickstart", "-k", "system/com.breeze.agent").CombinedOutput()
	if err != nil {
		log.Warn("launchd restart failed", "error", err.Error(), "output", string(out))
		return err
	}
	log.Info("restarted via launchd")
	return nil
}

// RestartWithHelper is Windows-only; on Unix it's never called because
// updater.go gates on runtime.GOOS == "windows". The arguments are accepted
// to keep the signature aligned with the Windows build but are unused here
// (issue #816; backup follows the same pattern).
func RestartWithHelper(_ BinaryPair, _ *BinaryPair, _ *BinaryPair) error {
	return fmt.Errorf("RestartWithHelper is only supported on Windows")
}

func deferRollbackSwapToRestart() bool { return false }

func RestartAfterRollback(_ string) error { return Restart() }

// RestartSelf restarts the agent service from inside the service process.
// systemd and launchd run the restart job outside this process, so Restart()
// is safe here; Windows needs a detached helper (restart_windows.go).
func RestartSelf() error { return Restart() }

func recoverRollbackSwapPlatform(journalPath string) error {
	return recoverRollbackSwapInline(journalPath)
}

func replaceRollbackFile(stagedPath, livePath string) error {
	return os.Rename(stagedPath, livePath)
}

func syncRollbackDir(path string) error {
	dir, err := os.Open(filepath.Dir(path))
	if err != nil {
		return err
	}
	defer func() { _ = dir.Close() }()
	return dir.Sync()
}

func restartExec() error {
	binary, err := os.Executable()
	if err != nil {
		return fmt.Errorf("failed to get executable path: %w", err)
	}

	// Resolve symlinks
	binary, err = filepath.EvalSymlinks(binary)
	if err != nil {
		return fmt.Errorf("failed to resolve symlinks: %w", err)
	}

	log.Info("restarting via exec", "binary", binary)
	// Keep the original flags (e.g. --config for per-user installs); only
	// default to "run" when started without arguments.
	args := append([]string{binary}, os.Args[1:]...)
	if len(args) == 1 {
		args = append(args, "run")
	}
	env := os.Environ()

	return syscall.Exec(binary, args, env)
}
