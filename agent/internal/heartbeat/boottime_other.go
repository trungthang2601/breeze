//go:build !windows

package heartbeat

import "github.com/shirou/gopsutil/v3/host"

// effectiveBootTime is the kernel boot time; only Windows (Fast Startup)
// needs the event-log correction in boottime_windows.go.
func effectiveBootTime() (uint64, error) {
	return host.BootTime()
}
