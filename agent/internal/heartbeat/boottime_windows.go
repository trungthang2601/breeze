//go:build windows

package heartbeat

import (
	"context"
	"os/exec"
	"regexp"
	"sync"
	"syscall"
	"time"

	"github.com/shirou/gopsutil/v3/host"
)

// With Fast Startup (the Windows 10/11 default) "Shut down" hibernates the
// kernel session instead of ending it, so the kernel boot time — and with it
// the reported uptime — survives a power-off. Every power-on, cold or hybrid,
// still logs Microsoft-Windows-Kernel-Boot event 27, so the effective boot time
// is the later of the two. Sleep (S3) logs no event 27 and keeps counting.

const kernelBootEventTTL = 5 * time.Minute

var (
	kernelBootMu        sync.Mutex
	kernelBootCached    time.Time
	kernelBootCheckedAt time.Time
	systemTimeAttr      = regexp.MustCompile(`SystemTime=['"]([^'"]+)['"]`)
)

func effectiveBootTime() (uint64, error) {
	boot, err := host.BootTime()
	if err != nil {
		return boot, err
	}
	if last := lastKernelBootEvent(); !last.IsZero() && last.Before(time.Now().Add(time.Minute)) {
		if ev := uint64(last.Unix()); ev > boot {
			return ev, nil
		}
	}
	return boot, nil
}

func lastKernelBootEvent() time.Time {
	kernelBootMu.Lock()
	defer kernelBootMu.Unlock()
	if !kernelBootCheckedAt.IsZero() && time.Since(kernelBootCheckedAt) < kernelBootEventTTL {
		return kernelBootCached
	}
	kernelBootCheckedAt = time.Now()

	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	cmd := exec.CommandContext(ctx, "wevtutil.exe", "qe", "System",
		"/q:*[System[Provider[@Name='Microsoft-Windows-Kernel-Boot'] and (EventID=27)]]",
		"/c:1", "/rd:true", "/f:xml")
	cmd.SysProcAttr = &syscall.SysProcAttr{HideWindow: true, CreationFlags: 0x08000000} // CREATE_NO_WINDOW
	out, err := cmd.Output()
	if err != nil {
		return kernelBootCached
	}
	kernelBootCached = parseKernelBootEventTime(string(out))
	return kernelBootCached
}

func parseKernelBootEventTime(xml string) time.Time {
	m := systemTimeAttr.FindStringSubmatch(xml)
	if m == nil {
		return time.Time{}
	}
	t, err := time.Parse(time.RFC3339Nano, m[1])
	if err != nil {
		return time.Time{}
	}
	return t.UTC()
}
