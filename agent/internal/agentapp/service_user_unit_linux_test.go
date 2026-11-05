package agentapp

import (
	"os"
	"path/filepath"
	"testing"
)

func TestEnsureUserUnitStopDropIn(t *testing.T) {
	home := t.TempDir()
	unit, dropIn := userUnitDropInPaths(home)

	// No per-user unit: nothing written.
	changed, err := ensureUserUnitStopDropIn(home)
	if err != nil || changed {
		t.Fatalf("no unit: changed=%v err=%v", changed, err)
	}
	if _, err := os.Stat(dropIn); !os.IsNotExist(err) {
		t.Fatalf("drop-in written without a unit")
	}

	if err := os.MkdirAll(filepath.Dir(unit), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(unit, []byte("[Service]\nExecStart=/x\n"), 0o644); err != nil {
		t.Fatal(err)
	}

	changed, err = ensureUserUnitStopDropIn(home)
	if err != nil || !changed {
		t.Fatalf("first heal: changed=%v err=%v", changed, err)
	}
	got, err := os.ReadFile(dropIn)
	if err != nil || string(got) != userUnitStopDropIn {
		t.Fatalf("drop-in content = %q, err=%v", got, err)
	}

	// Idempotent.
	changed, err = ensureUserUnitStopDropIn(home)
	if err != nil || changed {
		t.Fatalf("second heal: changed=%v err=%v", changed, err)
	}

	// A drifted drop-in is rewritten.
	if err := os.WriteFile(dropIn, []byte("[Service]\nTimeoutStopSec=90\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	changed, err = ensureUserUnitStopDropIn(home)
	if err != nil || !changed {
		t.Fatalf("drift heal: changed=%v err=%v", changed, err)
	}
}
