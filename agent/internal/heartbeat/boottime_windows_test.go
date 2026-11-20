//go:build windows

package heartbeat

import (
	"testing"
	"time"
)

func TestParseKernelBootEventTime(t *testing.T) {
	xml := `<Event><System><Provider Name='Microsoft-Windows-Kernel-Boot'/><EventID>27</EventID>` +
		`<TimeCreated SystemTime='2026-11-20T04:19:12.1234567Z'/></System></Event>`
	got := parseKernelBootEventTime(xml)
	want := time.Date(2026, 11, 20, 4, 19, 12, 123456700, time.UTC)
	if !got.Equal(want) {
		t.Fatalf("got %v, want %v", got, want)
	}
	if !parseKernelBootEventTime("no events").IsZero() {
		t.Fatal("expected zero time when no event is present")
	}
}
